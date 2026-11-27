#include "ble_gatt_transport.hpp"
#include "device_identity.hpp"

#include <algorithm>
#include <cstring>
#include <string_view>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/dis/ble_svc_dis.h"
#include "services/gatt/ble_svc_gatt.h"

namespace {

constexpr char kTag[] = "RF_BLE";
constexpr char kHexDigits[] = "0123456789ABCDEF";
constexpr std::uint16_t kServiceUuid = 0xFF10;
constexpr std::uint16_t kRxCharacteristicUuid = 0xFF11;
constexpr std::uint16_t kTxCharacteristicUuid = 0xFF12;

BleGattTransport* g_transport = nullptr;

template <std::size_t Size>
bool FormatBleName(std::array<char, Size>& output,
                   std::string_view prefix,
                   const std::array<std::uint8_t, 6>& mac)
{
    std::size_t offset = 0;
    if (!prefix.empty()) {
        if (prefix.size() + 1 >= output.size()) {
            return false;
        }
        std::copy(prefix.begin(), prefix.end(), output.begin());
        offset = prefix.size();
        output[offset++] = '-';
    }

    for (const auto byte : mac) {
        if (offset + 2 >= output.size()) {
            return false;
        }
        output[offset++] = kHexDigits[byte >> 4];
        output[offset++] = kHexDigits[byte & 0x0F];
    }
    output[offset] = '\0';
    return true;
}

}  // namespace

rf_platform::TransportStatus BleGattTransport::Start(
    rf_platform::FrameReceiver& receiver)
{
    if (started_) {
        receiver_ = &receiver;
        return rf_platform::TransportStatus::kOk;
    }
    if (g_transport != nullptr && g_transport != this) {
        return rf_platform::TransportStatus::kIoError;
    }

    std::array<std::uint8_t, 6> device_id{};
    if (esp_read_mac(device_id.data(), ESP_MAC_WIFI_STA) != ESP_OK) {
        ESP_LOGE(kTag, "init_failed stage=device_id error=read_failed");
        return rf_platform::TransportStatus::kIoError;
    }
    if (!FormatBleName(device_name_,
                       rf_platform::device_identity::kProductName,
                       device_id) ||
        !FormatBleName(advertising_name_, {}, device_id)) {
        ESP_LOGE(kTag, "init_failed stage=device_name error=format_failed");
        return rf_platform::TransportStatus::kIoError;
    }

    const auto nvs_status = nvs_flash_init();
    if (nvs_status != ESP_OK) {
        ESP_LOGE(kTag, "init_failed stage=nvs error=%s",
                 esp_err_to_name(nvs_status));
        return rf_platform::TransportStatus::kIoError;
    }
    const auto nimble_status = nimble_port_init();
    if (nimble_status != ESP_OK) {
        ESP_LOGE(kTag, "init_failed stage=nimble error=%s",
                 esp_err_to_name(nimble_status));
        return rf_platform::TransportStatus::kIoError;
    }
    receiver_ = &receiver;
    g_transport = this;
    ConfigureGatt();

    ble_hs_cfg.reset_cb = ResetCallback;
    ble_hs_cfg.sync_cb = SyncCallback;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_dis_init();

    auto status = ble_svc_dis_manufacturer_name_set(
        rf_platform::device_identity::kManufacturerName);
    if (status != 0) {
        ESP_LOGE(kTag, "init_failed stage=gatt_manufacturer status=%d", status);
        g_transport = nullptr;
        receiver_ = nullptr;
        return rf_platform::TransportStatus::kIoError;
    }

    status = ble_svc_gap_device_name_set(device_name_.data());
    if (status != 0) {
        ESP_LOGE(kTag, "init_failed stage=gatt_device_name status=%d", status);
        g_transport = nullptr;
        receiver_ = nullptr;
        return rf_platform::TransportStatus::kIoError;
    }
    status = ble_gatts_count_cfg(services_.data());
    if (status == 0) {
        status = ble_gatts_add_svcs(services_.data());
    }
    if (status != 0) {
        ESP_LOGE(kTag, "init_failed stage=gatt_service status=%d", status);
        g_transport = nullptr;
        receiver_ = nullptr;
        return rf_platform::TransportStatus::kIoError;
    }

    nimble_port_freertos_init(HostTask);
    started_ = true;
    return rf_platform::TransportStatus::kOk;
}

rf_platform::TransportStatus BleGattTransport::Send(
    rf_platform::FrameView frame)
{
    const auto connection = connection_handle_.load();
    if (!started_ || connection == BLE_HS_CONN_HANDLE_NONE ||
        !indications_enabled_.load()) {
        return rf_platform::TransportStatus::kNotConnected;
    }

    if (tx_count_ == tx_queue_.size()) {
        tx_queue_overflow_.store(true, std::memory_order_release);
        return rf_platform::TransportStatus::kNoCapacity;
    }

    auto& queued = tx_queue_[tx_tail_];
    std::size_t encoded_size = 0;
    const auto encode_status = codec_.Encode(
        frame, queued.bytes.data(), queued.bytes.size(), encoded_size);
    if (encode_status != rf_platform::FrameCodecStatus::kOk) {
        return rf_platform::TransportStatus::kIoError;
    }

    queued.size = encoded_size;
    queued.offset = 0;
    tx_tail_ = (tx_tail_ + 1) % tx_queue_.size();
    ++tx_count_;
    ESP_LOGD(kTag, "frame_tx_queued payload_bytes=%u encoded_bytes=%u depth=%u",
             static_cast<unsigned>(frame.size),
             static_cast<unsigned>(encoded_size),
             static_cast<unsigned>(tx_count_));
    return rf_platform::TransportStatus::kOk;
}

void BleGattTransport::Stop()
{
    receiver_ = nullptr;
    indications_enabled_.store(false);
    connection_handle_.store(BLE_HS_CONN_HANDLE_NONE);
    ResetTxQueue();
    if (started_) {
        ble_gap_adv_stop();
    }
    started_ = false;
}

bool BleGattTransport::Poll()
{
    bool did_work = false;
    if (tx_queue_overflow_.exchange(false, std::memory_order_acq_rel)) {
        FailTx("queue_overflow", BLE_HS_ENOMEM);
        did_work = true;
    }
    if (tx_completion_pending_.exchange(false, std::memory_order_acq_rel)) {
        const auto status = tx_completion_status_.load(std::memory_order_acquire);
        const auto completion_connection =
            tx_completion_connection_.load(std::memory_order_acquire);
        if (!tx_indication_in_flight_) {
            // Ignore a completion posted after a queue reset or disconnect.
        } else if (status == BLE_HS_EDONE && tx_count_ != 0 &&
                   completion_connection == connection_handle_.load()) {
            auto& frame = tx_queue_[tx_head_];
            frame.offset += tx_last_chunk_size_;
            tx_indication_in_flight_ = false;
            tx_send_failures_ = 0;
            if (frame.offset == frame.size) {
                ESP_LOGD(kTag, "frame_tx_confirmed bytes=%u",
                         static_cast<unsigned>(frame.size));
                tx_head_ = (tx_head_ + 1) % tx_queue_.size();
                --tx_count_;
            }
        } else {
            FailTx("indication_unconfirmed", status);
        }
        did_work = true;
    }

    if (connection_handle_.load(std::memory_order_acquire) ==
        BLE_HS_CONN_HANDLE_NONE && tx_count_ != 0) {
        ResetTxQueue();
        did_work = true;
    }

    const auto frame_size = pending_frame_size_.load(std::memory_order_acquire);
    if (frame_size != 0 && receiver_ != nullptr) {
        ESP_LOGD(kTag, "frame_rx payload_bytes=%u",
                 static_cast<unsigned>(frame_size));
        receiver_->OnFrame(Id(), {rx_decoded_.data(), frame_size});
        pending_frame_size_.store(0, std::memory_order_release);
        did_work = true;
    }
    return PumpTx() || did_work;
}

void BleGattTransport::ResetTxQueue()
{
    tx_head_ = 0;
    tx_tail_ = 0;
    tx_count_ = 0;
    tx_last_chunk_size_ = 0;
    tx_send_failures_ = 0;
    tx_indication_in_flight_ = false;
    tx_completion_pending_.store(false, std::memory_order_release);
    tx_queue_overflow_.store(false, std::memory_order_release);
}

void BleGattTransport::FailTx(const char* reason, int status)
{
    const auto connection = connection_handle_.load(std::memory_order_acquire);
    ESP_LOGW(kTag, "frame_tx_failed reason=%s status=%d queued=%u",
             reason, status, static_cast<unsigned>(tx_count_));
    ResetTxQueue();
    if (connection != BLE_HS_CONN_HANDLE_NONE) {
        const auto terminate_status = ble_gap_terminate(
            connection, BLE_ERR_REM_USER_CONN_TERM);
        if (terminate_status != 0) {
            ESP_LOGW(kTag, "connection_terminate_failed status=%d",
                     terminate_status);
        }
    }
}

bool BleGattTransport::PumpTx()
{
    const auto connection = connection_handle_.load(std::memory_order_acquire);
    if (tx_count_ == 0 || tx_indication_in_flight_ ||
        connection == BLE_HS_CONN_HANDLE_NONE ||
        !indications_enabled_.load(std::memory_order_acquire)) {
        return false;
    }

    auto& frame = tx_queue_[tx_head_];
    const auto mtu = ble_att_mtu(connection);
    const auto chunk_size = mtu > 3 ? static_cast<std::size_t>(mtu - 3) : 20U;
    tx_last_chunk_size_ = std::min(chunk_size, frame.size - frame.offset);
    ESP_LOGD(kTag, "gatt_tx_indication offset=%u bytes=%u depth=%u",
             static_cast<unsigned>(frame.offset),
             static_cast<unsigned>(tx_last_chunk_size_),
             static_cast<unsigned>(tx_count_));
    auto* packet = ble_hs_mbuf_from_flat(
        frame.bytes.data() + frame.offset, tx_last_chunk_size_);
    if (packet == nullptr) {
        if (++tx_send_failures_ >= 3) {
            FailTx("mbuf_exhausted", BLE_HS_ENOMEM);
        }
        return false;
    }

    const auto status = ble_gatts_indicate_custom(
        connection, tx_value_handle_, packet);
    if (status != 0) {
        if (++tx_send_failures_ >= 3) {
            FailTx("indication_submit_failed", status);
        }
        return false;
    }
    tx_send_failures_ = 0;
    tx_indication_in_flight_ = true;
    return true;
}

int BleGattTransport::AccessCallback(
    std::uint16_t connection_handle,
    std::uint16_t attribute_handle,
    ble_gatt_access_ctxt* context,
    void* argument)
{
    auto* transport = static_cast<BleGattTransport*>(argument);
    return transport == nullptr
        ? BLE_ATT_ERR_UNLIKELY
        : transport->HandleAccess(connection_handle, attribute_handle, context);
}

int BleGattTransport::GapEventCallback(ble_gap_event* event, void* argument)
{
    auto* transport = static_cast<BleGattTransport*>(argument);
    return transport == nullptr ? 0 : transport->HandleGapEvent(event);
}

void BleGattTransport::SyncCallback()
{
    if (g_transport == nullptr) {
        return;
    }
    const auto status = ble_hs_id_infer_auto(0, &g_transport->address_type_);
    if (status != 0) {
        ESP_LOGE(kTag, "init_failed stage=address_type status=%d", status);
        return;
    }
    g_transport->StartAdvertising();
}

void BleGattTransport::ResetCallback(int reason)
{
    ESP_LOGW(kTag, "host_reset reason=%d", reason);
}

void BleGattTransport::HostTask(void*)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void BleGattTransport::ConfigureGatt()
{
    service_uuid_.u.type = BLE_UUID_TYPE_16;
    service_uuid_.value = kServiceUuid;
    rx_uuid_.u.type = BLE_UUID_TYPE_16;
    rx_uuid_.value = kRxCharacteristicUuid;
    tx_uuid_.u.type = BLE_UUID_TYPE_16;
    tx_uuid_.value = kTxCharacteristicUuid;

    characteristics_[0].uuid = &rx_uuid_.u;
    characteristics_[0].access_cb = AccessCallback;
    characteristics_[0].arg = this;
    characteristics_[0].val_handle = &rx_value_handle_;
    characteristics_[0].flags = BLE_GATT_CHR_F_WRITE |
                                 BLE_GATT_CHR_F_WRITE_NO_RSP;
    characteristics_[1].uuid = &tx_uuid_.u;
    characteristics_[1].access_cb = AccessCallback;
    characteristics_[1].arg = this;
    characteristics_[1].val_handle = &tx_value_handle_;
    characteristics_[1].flags = BLE_GATT_CHR_F_INDICATE;

    services_[0].type = BLE_GATT_SVC_TYPE_PRIMARY;
    services_[0].uuid = &service_uuid_.u;
    services_[0].characteristics = characteristics_.data();
}

void BleGattTransport::StartAdvertising()
{
    ble_hs_adv_fields fields{};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = reinterpret_cast<std::uint8_t*>(advertising_name_.data());
    fields.name_len = std::strlen(advertising_name_.data());
    fields.name_is_complete = 0;
    fields.uuids16 = &service_uuid_;
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;

    auto status = ble_gap_adv_set_fields(&fields);
    if (status != 0) {
        ESP_LOGE(kTag, "advertising_failed stage=setup status=%d", status);
        return;
    }

    ble_gap_adv_params parameters{};
    parameters.conn_mode = BLE_GAP_CONN_MODE_UND;
    parameters.disc_mode = BLE_GAP_DISC_MODE_GEN;
    status = ble_gap_adv_start(
        address_type_, nullptr, BLE_HS_FOREVER, &parameters,
        GapEventCallback, this);
    if (status != 0) {
        ESP_LOGE(kTag, "advertising_failed stage=start status=%d", status);
        return;
    }
    if (!advertising_logged_) {
        ESP_LOGI(kTag, "advertising=started name=%s", device_name_.data());
        advertising_logged_ = true;
    } else {
        ESP_LOGD(kTag, "advertising=restarted name=%s", device_name_.data());
    }
}

int BleGattTransport::HandleAccess(
    std::uint16_t connection_handle,
    std::uint16_t attribute_handle,
    ble_gatt_access_ctxt* context)
{
    if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR ||
        attribute_handle != rx_value_handle_ || context->om == nullptr) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    const auto packet_size = OS_MBUF_PKTLEN(context->om);
    if (packet_size > rx_chunk_.size()) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    std::uint16_t copied = 0;
    const auto status = ble_hs_mbuf_to_flat(
        context->om, rx_chunk_.data(), rx_chunk_.size(), &copied);
    if (status != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    ESP_LOGD(kTag, "gatt_rx_chunk connection=%u bytes=%u",
             static_cast<unsigned>(connection_handle),
             static_cast<unsigned>(copied));
    for (std::size_t index = 0; index < copied; ++index) {
        if (HandleByte(rx_chunk_[index])) {
            (void)connection_handle;
        }
    }
    return 0;
}

int BleGattTransport::HandleGapEvent(ble_gap_event* event)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            connection_handle_.store(event->connect.conn_handle);
            indications_enabled_.store(false);
            ESP_LOGD(kTag, "connection=up");
        } else {
            StartAdvertising();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        connection_handle_.store(BLE_HS_CONN_HANDLE_NONE);
        indications_enabled_.store(false);
        rx_size_ = 0;
        discarding_ = false;
        ESP_LOGD(kTag, "connection=down reason=%d", event->disconnect.reason);
        StartAdvertising();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == tx_value_handle_) {
            indications_enabled_.store(event->subscribe.cur_indicate != 0,
                                       std::memory_order_release);
        }
        break;
    case BLE_GAP_EVENT_NOTIFY_TX:
        if (event->notify_tx.indication != 0 &&
            event->notify_tx.attr_handle == tx_value_handle_ &&
            event->notify_tx.status != 0) {
            tx_completion_status_.store(event->notify_tx.status,
                                        std::memory_order_release);
            tx_completion_connection_.store(event->notify_tx.conn_handle,
                                            std::memory_order_release);
            tx_completion_pending_.store(true, std::memory_order_release);
        }
        break;
    default:
        break;
    }
    return 0;
}

bool BleGattTransport::HandleByte(std::uint8_t byte)
{
    if (pending_frame_size_.load(std::memory_order_acquire) != 0) {
        return false;
    }
    if (byte == 0) {
        bool received = false;
        if (!discarding_ && rx_size_ != 0) {
            std::size_t frame_size = 0;
            const auto status = codec_.Decode(
                {rx_encoded_.data(), rx_size_}, rx_decoded_.data(),
                rx_decoded_.size(), frame_size);
            if (status == rf_platform::FrameCodecStatus::kOk) {
                ESP_LOGD(kTag, "frame_rx_decoded encoded_bytes=%u payload_bytes=%u",
                         static_cast<unsigned>(rx_size_),
                         static_cast<unsigned>(frame_size));
                pending_frame_size_.store(frame_size, std::memory_order_release);
                received = true;
            } else {
                ESP_LOGD(kTag,
                         "frame_rx_rejected encoded_bytes=%u codec_status=%u",
                         static_cast<unsigned>(rx_size_),
                         static_cast<unsigned>(status));
            }
        }
        rx_size_ = 0;
        discarding_ = false;
        return received;
    }
    if (discarding_) {
        return false;
    }
    if (rx_size_ == rx_encoded_.size()) {
        rx_size_ = 0;
        discarding_ = true;
        return false;
    }
    rx_encoded_[rx_size_++] = byte;
    return false;
}
