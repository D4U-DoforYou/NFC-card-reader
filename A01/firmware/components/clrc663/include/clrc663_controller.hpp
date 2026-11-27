#pragma once

#include <cstdint>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_err.h"

inline constexpr uint8_t kClrc663DefaultTxAmplitudeLevel = 1;

class Clrc663Controller {
public:
    esp_err_t init(spi_host_device_t host, gpio_num_t mosi_gpio,
                   gpio_num_t miso_gpio, gpio_num_t sclk_gpio,
                   gpio_num_t cs_gpio, int clock_hz);
    void deinit();
    void select();
    void unselect();
    void transfer(const uint8_t *tx, uint8_t *rx, uint16_t length);

    void set_rf_field(bool active);
    bool rf_field_active() const { return rf_field_active_; }
    bool set_tx_amplitude(uint8_t level);
    uint8_t tx_amplitude_level() const { return tx_amplitude_level_; }
    bool read_register(uint8_t address, uint8_t *value);
    bool write_register(uint8_t address, uint8_t value);
    bool execute_command(uint8_t command, const uint8_t *fifo_input,
                         uint16_t fifo_input_length, uint32_t timeout_ms,
                         uint8_t *fifo_output,
                         uint32_t *fifo_output_length,
                         uint8_t *command_status);
    uint16_t transceive(const uint8_t *tx, uint16_t tx_length,
                        uint8_t rx_mode, uint8_t tx_mode,
                        uint32_t timeout_ms, uint8_t tx_last_bits,
                        uint8_t rx_align, uint8_t crc_flags, uint8_t *rx,
                        uint32_t *rx_length, uint8_t *rx_last_bits,
                        uint8_t *rx_status);

private:
    bool apply_tx_amplitude();
    void set_timer_slice(uint8_t timer, uint32_t duration_ms);
    bool wait_for_command(int64_t deadline_us, bool finish_on_rx_at_timer);

    spi_device_handle_t spi_device_ = nullptr;
    spi_host_device_t spi_host_ = SPI2_HOST;
    gpio_num_t cs_gpio_ = GPIO_NUM_7;
    bool initialized_ = false;
    bool rf_field_active_ = false;
    bool protocol_loaded_ = false;
    uint8_t loaded_rx_mode_ = 0;
    uint8_t loaded_tx_mode_ = 0;
    uint8_t tx_amplitude_level_ = kClrc663DefaultTxAmplitudeLevel;
};

Clrc663Controller &clrc663_controller();
