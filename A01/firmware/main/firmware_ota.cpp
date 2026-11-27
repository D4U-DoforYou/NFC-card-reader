#include "firmware_ota.hpp"

#include <algorithm>
#include <array>
#include <cstring>

#include "esp_app_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {

constexpr char kTag[] = "RF_OTA";
constexpr std::size_t kChunkLimit = 512;

std::uint32_t Crc32(const std::uint8_t* data, std::size_t size)
{
    std::uint32_t crc = 0xFFFFFFFF;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ (0xEDB88320U & (0U - (crc & 1U)));
        }
    }
    return ~crc;
}

}  // namespace

void FirmwareOta::ConfirmRunningImage()
{
    esp_ota_img_states_t state;
    const auto* running = esp_ota_get_running_partition();
    if (running != nullptr &&
        esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        const auto status = esp_ota_mark_app_valid_cancel_rollback();
        if (status != ESP_OK) {
            ESP_LOGE(kTag, "image_confirmation_failed error=%s",
                     esp_err_to_name(status));
        } else {
            ESP_LOGI(kTag, "image_confirmed");
        }
    }
}

bool FirmwareOta::Begin(const rfplatform_v1_TransferBegin& request,
                        std::uint64_t session_id)
{
    if (active_ && session_id != session_id_) {
        Reset();
    }
    if (active_ || request.transfer_id == 0 || request.total_size == 0 ||
        request.sha256.size != expected_sha256_.size() ||
        request.purpose[0] == '\0' ||
        std::strcmp(request.purpose, "firmware") != 0) {
        return false;
    }
    partition_ = esp_ota_get_next_update_partition(nullptr);
    if (partition_ == nullptr || request.total_size > partition_->size) {
        partition_ = nullptr;
        return false;
    }
    const auto status = esp_ota_begin(partition_, request.total_size, &handle_);
    if (status != ESP_OK) {
        partition_ = nullptr;
        return false;
    }
    std::copy_n(request.sha256.bytes, expected_sha256_.size(),
                expected_sha256_.begin());
    session_id_ = session_id;
    transfer_id_ = request.transfer_id;
    total_size_ = request.total_size;
    received_size_ = 0;
    sha256_ = PSA_HASH_OPERATION_INIT;
    if (psa_hash_setup(&sha256_, PSA_ALG_SHA_256) != PSA_SUCCESS) {
        Reset();
        return false;
    }
    active_ = true;
    ESP_LOGI(kTag, "transfer_started id=%u bytes=%u",
             static_cast<unsigned>(transfer_id_),
             static_cast<unsigned>(total_size_));
    return true;
}

bool FirmwareOta::Chunk(const rfplatform_v1_TransferChunk& request,
                        std::uint64_t session_id)
{
    const bool valid = active_ && session_id == session_id_ &&
        request.transfer_id == transfer_id_ &&
        request.offset == received_size_ && request.data.size != 0 &&
        request.data.size <= kChunkLimit &&
        request.data.size <= total_size_ - received_size_ &&
        Crc32(request.data.bytes, request.data.size) == request.crc32;
    if (!valid) {
        return false;
    }
    if (received_size_ == 0 &&
        (request.data.size < sizeof(esp_image_header_t) ||
         request.data.bytes[0] != ESP_IMAGE_HEADER_MAGIC)) {
        return false;
    }
    const auto status = esp_ota_write(handle_, request.data.bytes,
                                      request.data.size);
    if (status != ESP_OK) {
        Reset();
        return false;
    }
    received_size_ += request.data.size;
    if (psa_hash_update(&sha256_, request.data.bytes, request.data.size) !=
        PSA_SUCCESS) {
        Reset();
        return false;
    }
    return true;
}

bool FirmwareOta::Finish(const rfplatform_v1_TransferFinish& request,
                         std::uint64_t session_id)
{
    if (!active_ || session_id != session_id_ ||
        request.transfer_id != transfer_id_ || received_size_ != total_size_) {
        return false;
    }
    std::array<std::uint8_t, 32> actual_sha256{};
    std::size_t hash_size = 0;
    const auto hash_status = psa_hash_finish(
        &sha256_, actual_sha256.data(), actual_sha256.size(), &hash_size);
    if (hash_status != PSA_SUCCESS || hash_size != actual_sha256.size()) {
        Reset();
        return false;
    }
    if (actual_sha256 != expected_sha256_) {
        Reset();
        return false;
    }
    auto status = esp_ota_end(handle_);
    active_ = false;
    handle_ = 0;
    if (status == ESP_OK) {
        status = esp_ota_set_boot_partition(partition_);
    }
    partition_ = nullptr;
    if (status == ESP_OK) {
        ESP_LOGI(kTag, "transfer_complete rebooting=1");
        return true;
    }
    return false;
}

void FirmwareOta::Reboot()
{
    vTaskDelay(pdMS_TO_TICKS(100));
    esp_restart();
}

void FirmwareOta::Reset()
{
    if (active_) {
        esp_ota_abort(handle_);
    }
    psa_hash_abort(&sha256_);
    active_ = false;
    handle_ = 0;
    partition_ = nullptr;
    session_id_ = 0;
    transfer_id_ = 0;
    total_size_ = 0;
    received_size_ = 0;
}
