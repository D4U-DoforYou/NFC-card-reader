#include "rf_led_indicator.hpp"

#include <algorithm>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_log_buffer.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"

namespace rf_platform::rf_led {
namespace {
constexpr char kTag[] = "RF_PLATFORM";
constexpr gpio_num_t kPin = GPIO_NUM_0;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
bool s_field_enabled = false;
bool s_level = false;
bool s_activity = false;
unsigned s_hold_ticks = 0;
unsigned s_recent_bytes = 0;
unsigned s_phase_ticks = 0;
esp_timer_handle_t s_timer = nullptr;

void Blink(void*)
{
    portENTER_CRITICAL(&s_mux);
    if (s_activity || s_hold_ticks != 0) {
        const unsigned interval = s_recent_bytes >= 512 ? 1 :
            (s_recent_bytes >= 64 ? 2 : 3);
        if (++s_phase_ticks >= interval) {
            s_phase_ticks = 0;
            s_level = !s_level;
            gpio_set_level(kPin, s_level ? 1 : 0);
        }
        if (!s_activity) {
            --s_hold_ticks;
        }
    } else {
        if (s_level != s_field_enabled) {
            s_level = s_field_enabled;
            gpio_set_level(kPin, s_level ? 1 : 0);
        }
        s_phase_ticks = 0;
    }
    s_recent_bytes -= std::min(s_recent_bytes,
                               std::max(1U, s_recent_bytes / 6));
    portEXIT_CRITICAL(&s_mux);
}
}  // namespace

void RecordBytes(std::size_t size)
{
    portENTER_CRITICAL(&s_mux);
    s_recent_bytes += static_cast<unsigned>(
        std::min<std::size_t>(size, 4096U - s_recent_bytes));
    portEXIT_CRITICAL(&s_mux);
}

Activity::Activity(std::size_t bytes)
{
    RecordBytes(bytes);
    portENTER_CRITICAL(&s_mux);
    if (s_hold_ticks == 0) {
        s_level = false;
        gpio_set_level(kPin, 0);
        s_phase_ticks = 0;
    }
    s_activity = true;
    s_hold_ticks = 6;
    portEXIT_CRITICAL(&s_mux);
}

Activity::~Activity()
{
    portENTER_CRITICAL(&s_mux);
    s_activity = false;
    s_hold_ticks = 6;
    portEXIT_CRITICAL(&s_mux);
}

void SetFieldEnabled(bool enabled)
{
    portENTER_CRITICAL(&s_mux);
    s_field_enabled = enabled;
    s_hold_ticks = 0;
    s_recent_bytes = 0;
    s_phase_ticks = 0;
    s_level = enabled;
    gpio_set_level(kPin, enabled ? 1 : 0);
    portEXIT_CRITICAL(&s_mux);
}

esp_err_t Init()
{
    ESP_RETURN_ON_ERROR(gpio_set_level(kPin, 0), kTag,
                        "init_failed stage=rf_led_off");
    gpio_config_t config{};
    config.pin_bit_mask = 1ULL << kPin;
    config.mode = GPIO_MODE_OUTPUT;
    config.pull_up_en = GPIO_PULLUP_DISABLE;
    config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    config.intr_type = GPIO_INTR_DISABLE;
    ESP_RETURN_ON_ERROR(gpio_config(&config), kTag,
                        "init_failed stage=rf_led_config");
    esp_timer_create_args_t timer_args{};
    timer_args.callback = Blink;
    timer_args.name = "rf_led";
    timer_args.skip_unhandled_events = true;
    ESP_RETURN_ON_ERROR(esp_timer_create(&timer_args, &s_timer), kTag,
                        "init_failed stage=rf_led_timer");
    return esp_timer_start_periodic(s_timer, 50'000);
}

void LogBytes(const char* direction, const std::uint8_t* bytes,
              std::size_t size)
{
    ESP_LOGD(kTag, "rf_%s bytes=%u", direction,
             static_cast<unsigned>(size));
    if (size != 0) {
        ESP_LOG_BUFFER_HEXDUMP(kTag, bytes, size, ESP_LOG_DEBUG);
    }
}

}  // namespace rf_platform::rf_led
