#include "rf_capabilities.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "device_identity.hpp"
#include "rf_led_indicator.hpp"
#include "clrc663_controller.hpp"
#include "mfrc630.h"
#include "pb_decode.h"
#include "pb_encode.h"
#include "rf_platform/protocol_endpoint.hpp"
#include "esp_log.h"

namespace {
namespace rf_led = rf_platform::rf_led;
constexpr char kTag[] = "RF_PLATFORM";
constexpr rf_platform::OperationDescriptor kInfoOperations[] = {
    {"get", false, true, 0},
};
constexpr rf_platform::CapabilityDescriptor kInfoCapability{
    "org.example.device.info", 1, 0, kInfoOperations, 1, nullptr, 0,
};

constexpr rf_platform::OperationDescriptor kAmplitudeOperations[] = {
    {"get_tx_amplitude", false, true, 0},
    {"set_tx_amplitude", true, false,
     rfplatform_v1_TxAmplitudeRequest_size},
};
constexpr rf_platform::CapabilityDescriptor kAmplitudeCapability{
    "org.example.rf.clrc663.config", 1, 0,
    kAmplitudeOperations, 2, nullptr, 0,
};

constexpr rf_platform::OperationDescriptor kRawRfOperations[] = {
    {"set_field", true, false, rfplatform_v1_RfFieldRequest_size},
    {"transceive", true, false,
     rfplatform_v1_RawRfTransceiveRequest_size},
    {"execute_command", true, false,
     rfplatform_v1_Clrc663CommandRequest_size, true},
    {"read_register", false, true,
     rfplatform_v1_Clrc663RegisterRequest_size},
    {"write_register", true, false,
     rfplatform_v1_Clrc663RegisterRequest_size},
};
constexpr rf_platform::CapabilityDescriptor kRawRfCapability{
    "org.example.rf.raw", 1, 2, kRawRfOperations, 5, nullptr, 0,
};

bool IsAllowedClrc663Command(
    std::uint32_t command,
    std::uint32_t fifo_size,
    const std::uint8_t* fifo_input)
{
    switch (command) {
    case 0x00:  // IDLE
    case 0x05:  // RECEIVE
    case 0x1C:  // READRNR
        return fifo_size == 0;
    case 0x02:  // LOADKEY
        return fifo_size == 6;
    case 0x03:  // MFAUTHENT
        return fifo_size == 6 &&
               (fifo_input[0] == 0x60 || fifo_input[0] == 0x61);
    case 0x06:  // TRANSMIT
    case 0x07:  // TRANSCEIVE
        return fifo_size > 0 && fifo_size <= 256;
    case 0x0D:  // LOADPROTOCOL
        return fifo_size == 2 && fifo_input[0] < MFRC630_PROTOCOL_COUNT &&
               fifo_input[1] < MFRC630_PROTOCOL_COUNT;
    default:
        return false;
    }
}

bool EncodeDeviceInfo(
    const rfplatform_v1_DeviceInfoResult& message,
    rf_platform::CapabilityResult& result)
{
    auto stream = pb_ostream_from_buffer(
        result.payload.data(), result.payload.size());
    if (!pb_encode(&stream, rfplatform_v1_DeviceInfoResult_fields, &message)) {
        result.status = rf_platform::CapabilityStatus::kFailed;
        return false;
    }
    result.payload_size = stream.bytes_written;
    return true;
}

template <typename Message>
bool DecodeArguments(
    const std::uint8_t* bytes,
    std::size_t size,
    const pb_msgdesc_t* fields,
    Message& message)
{
    auto stream = pb_istream_from_buffer(bytes, size);
    return pb_decode(&stream, fields, &message) && stream.bytes_left == 0;
}

template <typename Message>
bool EncodeResult(
    const pb_msgdesc_t* fields,
    const Message& message,
    rf_platform::CapabilityResult& result)
{
    auto stream = pb_ostream_from_buffer(
        result.payload.data(), result.payload.size());
    if (!pb_encode(&stream, fields, &message)) {
        result.status = rf_platform::CapabilityStatus::kFailed;
        return false;
    }
    result.payload_size = stream.bytes_written;
    return true;
}

class DeviceInfoModule final : public rf_platform::CapabilityModule {
public:
    explicit DeviceInfoModule(const rf_platform::DeviceIdentity& identity)
        : identity_(identity) {}

    const rf_platform::CapabilityDescriptor& Descriptor() const override
    {
        return kInfoCapability;
    }

    rf_platform::CapabilityResult Execute(
        std::string_view operation_id,
        const std::uint8_t* arguments,
        std::size_t argument_size,
        rf_platform::Job&) override
    {
        rf_platform::CapabilityResult result;
        if (operation_id != "get") {
            result.status = rf_platform::CapabilityStatus::kUnsupportedOperation;
            return result;
        }
        if (argument_size != 0) {
            result.status = rf_platform::CapabilityStatus::kInvalidArgument;
            return result;
        }

        rfplatform_v1_DeviceInfoResult message =
            rfplatform_v1_DeviceInfoResult_init_zero;
        message.device_id.size = static_cast<pb_size_t>(identity_.device_id_size);
        message.boot_id.size = static_cast<pb_size_t>(identity_.boot_id_size);
        std::copy_n(identity_.device_id.begin(), identity_.device_id_size,
                    message.device_id.bytes);
        std::copy_n(identity_.boot_id.begin(), identity_.boot_id_size,
                    message.boot_id.bytes);
        message.bluetooth_mac.size =
            static_cast<pb_size_t>(identity_.bluetooth_mac_size);
        std::copy_n(identity_.bluetooth_mac.begin(),
                    identity_.bluetooth_mac_size,
                    message.bluetooth_mac.bytes);
        CopyText(message.firmware_name,
                 rf_platform::device_identity::kProductName);
        CopyText(message.firmware_version, RF_PLATFORM_FIRMWARE_VERSION);
        CopyText(message.radio_controller,
                 rf_platform::device_identity::kRadioControllerName);
        EncodeDeviceInfo(message, result);
        return result;
    }

private:
    template <std::size_t Size>
    static void CopyText(char (&destination)[Size], std::string_view value)
    {
        std::copy(value.begin(), value.end(), destination);
        destination[value.size()] = '\0';
    }

    const rf_platform::DeviceIdentity& identity_;
};

class Clrc663ConfigModule final : public rf_platform::CapabilityModule {
public:
    const rf_platform::CapabilityDescriptor& Descriptor() const override
    {
        return kAmplitudeCapability;
    }

    rf_platform::CapabilityResult Execute(
        std::string_view operation_id,
        const std::uint8_t* arguments,
        std::size_t argument_size,
        rf_platform::Job&) override
    {
        rf_platform::CapabilityResult result;
        if (operation_id == "set_tx_amplitude") {
            rfplatform_v1_TxAmplitudeRequest request =
                rfplatform_v1_TxAmplitudeRequest_init_zero;
            if (!DecodeArguments(arguments, argument_size,
                                 rfplatform_v1_TxAmplitudeRequest_fields,
                                 request) || !request.has_level ||
                request.level > 3) {
                result.status = rf_platform::CapabilityStatus::kInvalidArgument;
                return result;
            }
            if (!clrc663_controller().set_tx_amplitude(
                    static_cast<std::uint8_t>(request.level))) {
                result.status = rf_platform::CapabilityStatus::kInvalidArgument;
                return result;
            }
            ESP_LOGD(kTag, "txamp_set level=%u",
                     static_cast<unsigned>(request.level));
        } else if (operation_id != "get_tx_amplitude" || argument_size != 0) {
            result.status = rf_platform::CapabilityStatus::kUnsupportedOperation;
            return result;
        }

        rfplatform_v1_TxAmplitudeResult response =
            rfplatform_v1_TxAmplitudeResult_init_zero;
        response.level = clrc663_controller().tx_amplitude_level();
        ESP_LOGD(kTag, "txamp_get level=%u",
                 static_cast<unsigned>(response.level));
        EncodeResult(rfplatform_v1_TxAmplitudeResult_fields, response, result);
        return result;
    }
};

class RawRfModule final : public rf_platform::CapabilityModule {
public:
    const rf_platform::CapabilityDescriptor& Descriptor() const override
    {
        return kRawRfCapability;
    }

    rf_platform::CapabilityResult Execute(
        std::string_view operation_id,
        const std::uint8_t* arguments,
        std::size_t argument_size,
        rf_platform::Job& job) override
    {
        rf_platform::CapabilityResult result;
        if (operation_id == "set_field") {
            rfplatform_v1_RfFieldRequest request =
                rfplatform_v1_RfFieldRequest_init_zero;
            if (!DecodeArguments(arguments, argument_size,
                                 rfplatform_v1_RfFieldRequest_fields,
                                 request)) {
                result.status = rf_platform::CapabilityStatus::kInvalidArgument;
                return result;
            }
            if (!request.enabled) {
                mfrc630_cmd_idle();
            }
            clrc663_controller().set_rf_field(request.enabled);
            rf_led::SetFieldEnabled(request.enabled);
            ESP_LOGD(kTag, "rf_field=%s", request.enabled ? "on" : "off");
            return result;
        }

        if (operation_id != "transceive") {
            if (operation_id == "execute_command") {
                rfplatform_v1_Clrc663CommandRequest request =
                    rfplatform_v1_Clrc663CommandRequest_init_zero;
                if (!DecodeArguments(
                        arguments, argument_size,
                        rfplatform_v1_Clrc663CommandRequest_fields, request) ||
                    !clrc663_controller().rf_field_active() ||
                    !IsAllowedClrc663Command(request.command,
                                             request.fifo_input.size,
                                             request.fifo_input.bytes) ||
                    request.fifo_input.size > 256 ||
                    request.timeout_ms == 0 || request.timeout_ms > 300000) {
                    result.status =
                        rf_platform::CapabilityStatus::kInvalidArgument;
                    return result;
                }

                ESP_LOGD(kTag,
                         "chip_command_start command=0x%02X timeout_ms=%u fifo_in=%u",
                         static_cast<unsigned>(request.command),
                         static_cast<unsigned>(request.timeout_ms),
                         static_cast<unsigned>(request.fifo_input.size));
                if (request.command == 0x02) {
                    ESP_LOGD(kTag, "chip_command_fifo_in=redacted reason=loadkey");
                } else {
                    rf_led::LogBytes("chip_fifo_tx", request.fifo_input.bytes,
                               request.fifo_input.size);
                }

                rf_led::Activity led_activity(request.fifo_input.size);
                std::array<std::uint8_t, 256> fifo_output{};
                std::uint32_t fifo_output_size = fifo_output.size();
                std::uint8_t command_status[4] = {};
                if (!clrc663_controller().execute_command(
                        static_cast<std::uint8_t>(request.command),
                        request.fifo_input.bytes,
                        static_cast<std::uint16_t>(request.fifo_input.size),
                        request.timeout_ms, fifo_output.data(),
                        &fifo_output_size, command_status)) {
                    ESP_LOGD(kTag,
                             "chip_command_failed command=0x%02X irq0=0x%02X irq1=0x%02X error=0x%02X status=0x%02X",
                             static_cast<unsigned>(request.command),
                             command_status[0], command_status[1],
                             command_status[2], command_status[3]);
                    result.status = rf_platform::CapabilityStatus::kFailed;
                    return result;
                }
                ESP_LOGD(kTag,
                         "chip_command_done command=0x%02X fifo_out=%u irq0=0x%02X irq1=0x%02X error=0x%02X status=0x%02X",
                         static_cast<unsigned>(request.command),
                         static_cast<unsigned>(fifo_output_size),
                         command_status[0], command_status[1],
                         command_status[2], command_status[3]);
                rf_led::LogBytes("chip_fifo_rx", fifo_output.data(),
                           fifo_output_size);
                rf_led::RecordBytes(fifo_output_size);

                rfplatform_v1_Clrc663CommandResult response =
                    rfplatform_v1_Clrc663CommandResult_init_zero;
                response.fifo_output.size = fifo_output_size;
                std::copy_n(fifo_output.begin(), fifo_output_size,
                            response.fifo_output.bytes);
                response.irq0 = command_status[0];
                response.irq1 = command_status[1];
                response.error = command_status[2];
                response.status = command_status[3];
                job.ReportProgress("chip_command", 1, 1);
                EncodeResult(rfplatform_v1_Clrc663CommandResult_fields,
                             response, result);
                return result;
            }

            if (operation_id == "read_register" ||
                operation_id == "write_register") {
                rfplatform_v1_Clrc663RegisterRequest request =
                    rfplatform_v1_Clrc663RegisterRequest_init_zero;
                if (!DecodeArguments(
                        arguments, argument_size,
                        rfplatform_v1_Clrc663RegisterRequest_fields, request) ||
                    request.address > 0x7F || request.value > 0xFF) {
                    result.status =
                        rf_platform::CapabilityStatus::kInvalidArgument;
                    return result;
                }

                rf_led::Activity led_activity(1);
                if (operation_id == "write_register") {
                    ESP_LOGD(kTag, "register_write address=0x%02X value=0x%02X",
                             static_cast<unsigned>(request.address),
                             static_cast<unsigned>(request.value));
                    if (!clrc663_controller().write_register(
                            static_cast<std::uint8_t>(request.address),
                            static_cast<std::uint8_t>(request.value))) {
                        result.status =
                            rf_platform::CapabilityStatus::kInvalidArgument;
                    }
                    return result;
                }

                std::uint8_t value = 0;
                if (!clrc663_controller().read_register(
                        static_cast<std::uint8_t>(request.address), &value)) {
                    result.status = rf_platform::CapabilityStatus::kInvalidArgument;
                    return result;
                }
                ESP_LOGD(kTag, "register_read address=0x%02X value=0x%02X",
                         static_cast<unsigned>(request.address), value);
                rfplatform_v1_Clrc663RegisterResult response =
                    rfplatform_v1_Clrc663RegisterResult_init_zero;
                response.value = value;
                EncodeResult(rfplatform_v1_Clrc663RegisterResult_fields,
                             response, result);
                return result;
            }

            result.status = rf_platform::CapabilityStatus::kUnsupportedOperation;
            return result;
        }

        rfplatform_v1_RawRfTransceiveRequest request =
            rfplatform_v1_RawRfTransceiveRequest_init_zero;
        if (!DecodeArguments(arguments, argument_size,
                             rfplatform_v1_RawRfTransceiveRequest_fields,
                             request) ||
            !clrc663_controller().rf_field_active() || request.tx.size == 0 ||
            request.tx.size > 256 || request.timeout_ms == 0 ||
            request.timeout_ms > 300000 ||
            static_cast<std::uint32_t>(request.rx_mode) >=
                MFRC630_PROTOCOL_COUNT ||
            (request.has_tx_mode &&
             static_cast<std::uint32_t>(request.tx_mode) >=
                MFRC630_PROTOCOL_COUNT) ||
            request.tx_last_bits > 7 ||
            request.rx_align > 7 || request.crc_flags > 3) {
            result.status = rf_platform::CapabilityStatus::kInvalidArgument;
            return result;
        }

        rf_led::Activity led_activity(request.tx.size);
        std::array<std::uint8_t, 256> rx{};
        std::uint32_t rx_size = rx.size();
        std::uint8_t rx_last_bits = 0;
        std::uint8_t rx_status[4] = {};
        const auto tx_mode = request.has_tx_mode
            ? static_cast<std::uint8_t>(request.tx_mode)
            : static_cast<std::uint8_t>(request.rx_mode);
        ESP_LOGD(kTag,
                 "rf_transceive_start rx_mode=%u tx_mode=%u timeout_ms=%u tx_last_bits=%u rx_align=%u crc_flags=%u",
                 static_cast<unsigned>(request.rx_mode),
                 static_cast<unsigned>(tx_mode),
                 static_cast<unsigned>(request.timeout_ms),
                 static_cast<unsigned>(request.tx_last_bits),
                 static_cast<unsigned>(request.rx_align),
                 static_cast<unsigned>(request.crc_flags));
        rf_led::LogBytes("tx", request.tx.bytes, request.tx.size);
        const auto received = clrc663_controller().transceive(
            request.tx.bytes, static_cast<std::uint16_t>(request.tx.size),
            static_cast<std::uint8_t>(request.rx_mode), tx_mode,
            request.timeout_ms,
            static_cast<std::uint8_t>(request.tx_last_bits),
            static_cast<std::uint8_t>(request.rx_align),
            static_cast<std::uint8_t>(request.crc_flags), rx.data(), &rx_size,
            &rx_last_bits, rx_status);
        rf_led::RecordBytes(std::min<std::size_t>(received, rx.size()));
        if (received != rx_size || received > rx.size()) {
            ESP_LOGD(kTag,
                     "rf_transceive_failed received=%u reported=%u irq0=0x%02X irq1=0x%02X error=0x%02X collision=0x%02X",
                     static_cast<unsigned>(received),
                     static_cast<unsigned>(rx_size), rx_status[0],
                     rx_status[1], rx_status[2], rx_status[3]);
            rf_led::LogBytes("rx_partial", rx.data(),
                       std::min<std::size_t>(received, rx.size()));
            result.status = rf_platform::CapabilityStatus::kFailed;
            return result;
        }
        ESP_LOGD(kTag,
                 "rf_transceive_done rx_bytes=%u rx_last_bits=%u irq0=0x%02X irq1=0x%02X error=0x%02X collision=0x%02X",
                 static_cast<unsigned>(received),
                 static_cast<unsigned>(rx_last_bits), rx_status[0],
                 rx_status[1], rx_status[2], rx_status[3]);
        rf_led::LogBytes("rx", rx.data(), received);

        rfplatform_v1_RawRfTransceiveResult response =
            rfplatform_v1_RawRfTransceiveResult_init_zero;
        response.rx.size = received;
        std::copy_n(rx.begin(), received, response.rx.bytes);
        response.rx_last_bits = rx_last_bits;
        response.irq0 = rx_status[0];
        response.irq1 = rx_status[1];
        response.error = rx_status[2];
        response.collision = rx_status[3];
        job.ReportProgress("transceive", 1, 1);
        EncodeResult(rfplatform_v1_RawRfTransceiveResult_fields, response, result);
        return result;
    }
};


}  // namespace

namespace rf_platform {
RegistryStatus RegisterDeviceInfoCapability(
    CapabilityRegistry& registry, const DeviceIdentity& identity)
{
    static DeviceInfoModule module(identity);
    return registry.Register(module);
}

RegistryStatus RegisterRadioConfigCapability(CapabilityRegistry& registry)
{
    static Clrc663ConfigModule module;
    return registry.Register(module);
}

RegistryStatus RegisterRawRfCapability(CapabilityRegistry& registry)
{
    static RawRfModule module;
    return registry.Register(module);
}
}  // namespace rf_platform
