#ifndef RF_PLATFORM_FIRMWARE_OTA_HPP
#define RF_PLATFORM_FIRMWARE_OTA_HPP

#include <array>
#include <cstddef>
#include <cstdint>

#include "esp_ota_ops.h"
#include "psa/crypto.h"
#include "rf_platform/protocol_endpoint.hpp"

class FirmwareOta final : public rf_platform::BulkTransferHandler {
public:
    void ConfirmRunningImage();
    bool Begin(const rfplatform_v1_TransferBegin& request,
               std::uint64_t session_id) override;
    bool Chunk(const rfplatform_v1_TransferChunk& request,
               std::uint64_t session_id) override;
    std::uint64_t NextOffset() const override { return received_size_; }
    bool Finish(const rfplatform_v1_TransferFinish& request,
                std::uint64_t session_id) override;
    void Reboot() override;

private:
    void Reset();

    const esp_partition_t* partition_ = nullptr;
    esp_ota_handle_t handle_ = 0;
    std::uint64_t session_id_ = 0;
    std::uint64_t total_size_ = 0;
    std::uint64_t received_size_ = 0;
    std::uint32_t transfer_id_ = 0;
    std::array<std::uint8_t, 32> expected_sha256_{};
    psa_hash_operation_t sha256_ = PSA_HASH_OPERATION_INIT;
    bool active_ = false;
};

#endif
