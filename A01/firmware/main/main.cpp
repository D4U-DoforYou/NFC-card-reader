#include "ble_gatt_transport.hpp"
#include "device_identity.hpp"
#include "firmware_ota.hpp"
#include "rf_capabilities.hpp"
#include "rf_led_indicator.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "clrc663_controller.hpp"
#include "mfrc630.h"
#include "rf_platform/capability_registry.hpp"
#include "rf_platform/protocol_endpoint.hpp"

namespace {

constexpr char kTag[] = "RF_PLATFORM";
constexpr std::uint8_t kDefaultAmplitude =
    kClrc663DefaultTxAmplitudeLevel;
constexpr gpio_num_t kClrc663ResetGpio = GPIO_NUM_1;

class EspSessionIdSource final : public rf_platform::SessionIdSource {
public:
    std::uint64_t NextSessionId() override
    {
        const auto high = static_cast<std::uint64_t>(esp_random());
        const auto low = static_cast<std::uint64_t>(esp_random());
        const auto result = (high << 32) | low;
        return result == 0 ? 1 : result;
    }
};

esp_err_t InitClrc663(std::uint8_t& version)
{
    gpio_config_t reset_config{};
    reset_config.pin_bit_mask = 1ULL << kClrc663ResetGpio;
    reset_config.mode = GPIO_MODE_OUTPUT;
    reset_config.pull_up_en = GPIO_PULLUP_DISABLE;
    reset_config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    reset_config.intr_type = GPIO_INTR_DISABLE;
    ESP_RETURN_ON_ERROR(gpio_config(&reset_config), kTag,
                        "init_failed stage=reset_gpio_config");
    ESP_RETURN_ON_ERROR(gpio_set_level(kClrc663ResetGpio, 1), kTag,
                        "init_failed stage=reset_assert");
    vTaskDelay(pdMS_TO_TICKS(5));
    ESP_RETURN_ON_ERROR(gpio_set_level(kClrc663ResetGpio, 0), kTag,
                        "init_failed stage=reset_release");
    vTaskDelay(pdMS_TO_TICKS(5));

    ESP_RETURN_ON_ERROR(clrc663_controller().init(
        SPI2_HOST, GPIO_NUM_6, GPIO_NUM_5, GPIO_NUM_4, GPIO_NUM_7, 1'000'000),
        kTag, "init_failed stage=clrc663_spi");
    version = mfrc630_read_reg(MFRC630_REG_VERSION);
    if (version == 0 || version == 0xFF) {
        return ESP_ERR_NOT_FOUND;
    }
    mfrc630_AN1102_recommended_registers(
        MFRC630_PROTO_ISO14443A_106_MILLER_MANCHESTER);
    return ESP_OK;
}

void ConfigureLogging()
{
    esp_log_level_set("*", ESP_LOG_WARN);
    esp_log_level_set(kTag, ESP_LOG_DEBUG);
    esp_log_level_set("RF_PROTO", ESP_LOG_DEBUG);
    esp_log_level_set("RF_BLE", ESP_LOG_DEBUG);
    esp_log_level_set("RF_CLRC663", ESP_LOG_DEBUG);
}

}  // namespace

extern "C" void app_main(void)
{
    ConfigureLogging();
    ESP_ERROR_CHECK(rf_platform::rf_led::Init());
    static FirmwareOta firmware_ota;
    firmware_ota.ConfirmRunningImage();
    ESP_LOGI(kTag, "boot firmware=%s version=%s",
             rf_platform::device_identity::kProductName,
             RF_PLATFORM_FIRMWARE_VERSION);
    static rf_platform::DeviceIdentity identity;
    std::array<std::uint8_t, 6> mac{};
    if (esp_read_mac(mac.data(), ESP_MAC_WIFI_STA) != ESP_OK) {
        ESP_LOGE(kTag, "init_failed stage=device_identity error=mac_read");
        return;
    }
    std::copy(mac.begin(), mac.end(), identity.device_id.begin());
    identity.device_id_size = mac.size();
    std::array<std::uint8_t, 6> bluetooth_mac{};
    if (esp_read_mac(bluetooth_mac.data(), ESP_MAC_BT) != ESP_OK) {
        ESP_LOGE(kTag, "init_failed stage=device_identity error=bluetooth_mac_read");
        return;
    }
    std::copy(bluetooth_mac.begin(), bluetooth_mac.end(),
              identity.bluetooth_mac.begin());
    identity.bluetooth_mac_size = bluetooth_mac.size();
    for (std::size_t index = 0; index < identity.boot_id.size(); index += 4) {
        const auto random = esp_random();
        std::memcpy(identity.boot_id.data() + index, &random, sizeof(random));
    }
    identity.boot_id_size = identity.boot_id.size();

    static rf_platform::CapabilityRegistry registry;
    if (rf_platform::RegisterDeviceInfoCapability(registry, identity) !=
        rf_platform::RegistryStatus::kOk) {
        ESP_LOGE(kTag, "init_failed stage=capability_registry capability=device_info");
        return;
    }

    std::uint8_t radio_version = 0;
    const auto radio_status = InitClrc663(radio_version);
    if (radio_status == ESP_OK) {
        if (!clrc663_controller().set_tx_amplitude(kDefaultAmplitude)) {
            ESP_LOGW(kTag, "setting_failed name=txamp level=%u",
                     static_cast<unsigned>(kDefaultAmplitude));
        }
        clrc663_controller().set_rf_field(false);
        rf_platform::rf_led::SetFieldEnabled(false);
        const auto config_status =
            rf_platform::RegisterRadioConfigCapability(registry);
        const auto raw_status =
            rf_platform::RegisterRawRfCapability(registry);
        if (config_status != rf_platform::RegistryStatus::kOk) {
            ESP_LOGE(kTag,
                     "capability_register_failed capability=radio_config status=%u",
                     static_cast<unsigned>(config_status));
        }
        if (raw_status != rf_platform::RegistryStatus::kOk) {
            ESP_LOGE(kTag,
                     "capability_register_failed capability=raw_rf status=%u",
                     static_cast<unsigned>(raw_status));
        }
        ESP_LOGI(kTag,
                 "nfc=ready controller=%s version=0x%02X txamp_default=%u",
                 rf_platform::device_identity::kRadioControllerName,
                 radio_version,
                 static_cast<unsigned>(kDefaultAmplitude));
    } else {
        ESP_LOGW(kTag,
                 "nfc=disabled mode=device_info_only version=0x%02X error=%s",
                 radio_version, esp_err_to_name(radio_status));
    }

    static BleGattTransport ble_transport;
    static EspSessionIdSource session_ids;
    static std::optional<rf_platform::DeviceProtocolEndpoint> ble_endpoint;
    ble_endpoint.emplace(registry, ble_transport, session_ids, identity,
                         &firmware_ota);
    if (ble_endpoint->Start() != rf_platform::TransportStatus::kOk) {
        ESP_LOGE(kTag, "init_failed stage=ble_endpoint error=start_failed");
        return;
    }

    while (true) {
        ble_transport.Poll();
        if (!ble_endpoint->RunNextJob()) {
            vTaskDelay(1);
        }
    }
}
