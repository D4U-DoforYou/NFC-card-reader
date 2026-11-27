#ifndef RF_PLATFORM_BLE_GATT_TRANSPORT_HPP
#define RF_PLATFORM_BLE_GATT_TRANSPORT_HPP

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "host/ble_gatt.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "rf_platform/cobs_frame_codec.hpp"
#include "rf_platform/transport.hpp"

class BleGattTransport final : public rf_platform::DeviceTransport {
public:
    static constexpr std::string_view kId = "ble_gatt";
    static constexpr std::size_t kTxQueueDepth = 4;

    std::string_view Id() const override { return kId; }
    rf_platform::TransportStatus Start(rf_platform::FrameReceiver& receiver) override;
    rf_platform::TransportStatus Send(rf_platform::FrameView frame) override;
    void Stop() override;
    bool Poll();

private:
    static int AccessCallback(
        std::uint16_t connection_handle,
        std::uint16_t attribute_handle,
        ble_gatt_access_ctxt* context,
        void* argument);
    static int GapEventCallback(ble_gap_event* event, void* argument);
    static void SyncCallback();
    static void ResetCallback(int reason);
    static void HostTask(void* argument);

    void ConfigureGatt();
    void StartAdvertising();
    int HandleAccess(
        std::uint16_t connection_handle,
        std::uint16_t attribute_handle,
        ble_gatt_access_ctxt* context);
    int HandleGapEvent(ble_gap_event* event);
    bool HandleByte(std::uint8_t byte);
    bool PumpTx();
    void ResetTxQueue();
    void FailTx(const char* reason, int status);

    struct TxFrame {
        std::array<std::uint8_t,
                   rf_platform::CobsFrameCodec::kMaxEncodedSize> bytes{};
        std::size_t size = 0;
        std::size_t offset = 0;
    };

    rf_platform::FrameReceiver* receiver_ = nullptr;
    rf_platform::CobsFrameCodec codec_;
    std::array<std::uint8_t, rf_platform::CobsFrameCodec::kMaxEncodedSize> rx_encoded_{};
    std::array<std::uint8_t, rf_platform::CobsFrameCodec::kMaxRawSize> rx_decoded_{};
    std::array<std::uint8_t, rf_platform::CobsFrameCodec::kMaxEncodedSize> rx_chunk_{};
    std::array<TxFrame, kTxQueueDepth> tx_queue_{};
    std::array<ble_gatt_svc_def, 2> services_{};
    std::array<ble_gatt_chr_def, 3> characteristics_{};
    std::array<char, 32> device_name_{};
    std::array<char, 13> advertising_name_{};
    ble_uuid16_t service_uuid_{};
    ble_uuid16_t rx_uuid_{};
    ble_uuid16_t tx_uuid_{};
    std::uint16_t rx_value_handle_ = 0;
    std::uint16_t tx_value_handle_ = 0;
    std::atomic<std::uint16_t> connection_handle_{BLE_HS_CONN_HANDLE_NONE};
    std::atomic<bool> indications_enabled_{false};
    std::atomic<std::size_t> pending_frame_size_{0};
    std::atomic<bool> tx_completion_pending_{false};
    std::atomic<int> tx_completion_status_{0};
    std::atomic<std::uint16_t> tx_completion_connection_{BLE_HS_CONN_HANDLE_NONE};
    std::atomic<bool> tx_queue_overflow_{false};
    std::size_t tx_head_ = 0;
    std::size_t tx_tail_ = 0;
    std::size_t tx_count_ = 0;
    std::size_t tx_last_chunk_size_ = 0;
    std::uint8_t tx_send_failures_ = 0;
    bool tx_indication_in_flight_ = false;
    std::uint8_t address_type_ = 0;
    std::size_t rx_size_ = 0;
    bool discarding_ = false;
    bool started_ = false;
    bool advertising_logged_ = false;
};

#endif
