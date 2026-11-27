#include "clrc663_controller.hpp"

#include <algorithm>
#include <cstddef>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mfrc630.h"

namespace {
constexpr char kTag[] = "RF_CLRC663";
constexpr uint8_t kDriverTxEnable = 1U << 3;
constexpr uint8_t kTxContinuousWaveMax = 1U << 3;
constexpr uint8_t kTimer = 0;
constexpr uint32_t kTimerSliceMs = 10;
constexpr uint32_t kTimerClockHz = 211875;
constexpr uint32_t kMaxTimeoutMs = 300000;
constexpr uint16_t kMaxCommandFifo = 256;
constexpr uint16_t kMaxFrameSize = 512;
constexpr uint8_t kProtocolMax = MFRC630_PROTOCOL_COUNT - 1;

bool is_host_writable_register(uint8_t address)
{
    return address == MFRC630_REG_STATUS ||
           (address >= MFRC630_REG_T1CONTROL &&
            address <= MFRC630_REG_T4RELOADLO) ||
           (address >= MFRC630_REG_TXL && address <= MFRC630_REG_RXANA &&
            address != MFRC630_REG_TXDATANUM);
}
} // namespace

Clrc663Controller &clrc663_controller()
{
    static Clrc663Controller controller;
    return controller;
}

esp_err_t Clrc663Controller::init(spi_host_device_t host, gpio_num_t mosi_gpio,
                                  gpio_num_t miso_gpio, gpio_num_t sclk_gpio,
                                  gpio_num_t cs_gpio, int clock_hz)
{
    ESP_RETURN_ON_FALSE(!initialized_ && clock_hz > 0, ESP_ERR_INVALID_STATE,
                        kTag, "init_failed reason=invalid_or_repeated");
    spi_host_ = host;
    cs_gpio_ = cs_gpio;

    gpio_config_t cs_config = {};
    cs_config.pin_bit_mask = 1ULL << cs_gpio;
    cs_config.mode = GPIO_MODE_OUTPUT;
    cs_config.pull_up_en = GPIO_PULLUP_DISABLE;
    cs_config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    cs_config.intr_type = GPIO_INTR_DISABLE;
    ESP_RETURN_ON_ERROR(gpio_config(&cs_config), kTag,
                        "init_failed stage=chip_select");
    ESP_RETURN_ON_ERROR(gpio_set_level(cs_gpio, 1), kTag,
                        "init_failed stage=chip_select_idle");

    spi_bus_config_t bus_config = {};
    bus_config.mosi_io_num = mosi_gpio;
    bus_config.miso_io_num = miso_gpio;
    bus_config.sclk_io_num = sclk_gpio;
    bus_config.quadwp_io_num = -1;
    bus_config.quadhd_io_num = -1;
    bus_config.data4_io_num = -1;
    bus_config.data5_io_num = -1;
    bus_config.data6_io_num = -1;
    bus_config.data7_io_num = -1;
    bus_config.max_transfer_sz = 512;
    ESP_RETURN_ON_ERROR(spi_bus_initialize(host, &bus_config, SPI_DMA_DISABLED),
                        kTag, "init_failed stage=spi_bus");

    spi_device_interface_config_t device_config = {};
    device_config.mode = 0;
    device_config.clock_speed_hz = clock_hz;
    device_config.spics_io_num = -1;
    device_config.queue_size = 1;
    const esp_err_t result =
        spi_bus_add_device(host, &device_config, &spi_device_);
    if (result != ESP_OK) {
        spi_bus_free(host);
        ESP_LOGE(kTag, "init_failed stage=spi_device error=%s",
                 esp_err_to_name(result));
        return result;
    }
    rf_field_active_ = false;
    protocol_loaded_ = false;
    initialized_ = true;
    return ESP_OK;
}

void Clrc663Controller::deinit()
{
    if (!initialized_) {
        return;
    }
    gpio_set_level(cs_gpio_, 1);
    spi_bus_remove_device(spi_device_);
    spi_bus_free(spi_host_);
    spi_device_ = nullptr;
    protocol_loaded_ = false;
    rf_field_active_ = false;
    initialized_ = false;
}

void Clrc663Controller::select()
{
    ESP_ERROR_CHECK(gpio_set_level(cs_gpio_, 0));
}

void Clrc663Controller::unselect()
{
    ESP_ERROR_CHECK(gpio_set_level(cs_gpio_, 1));
}

void Clrc663Controller::transfer(const uint8_t *tx, uint8_t *rx,
                                 uint16_t length)
{
    if (!initialized_ || tx == nullptr || length == 0) {
        return;
    }
    uint8_t discard[64];
    uint16_t offset = 0;
    while (offset < length) {
        const uint16_t chunk_length = static_cast<uint16_t>(
            std::min<size_t>(length - offset, sizeof(discard)));
        spi_transaction_t transaction = {};
        transaction.length = static_cast<size_t>(chunk_length) * 8;
        transaction.tx_buffer = tx + offset;
        transaction.rx_buffer = rx != nullptr ? rx + offset : discard;
        ESP_ERROR_CHECK(spi_device_polling_transmit(spi_device_, &transaction));
        offset += chunk_length;
    }
}

bool Clrc663Controller::apply_tx_amplitude()
{
    if (!initialized_ || tx_amplitude_level_ > 3) {
        return false;
    }
    const uint8_t driver = mfrc630_read_reg(MFRC630_REG_DRVCON);
    mfrc630_write_reg(MFRC630_REG_DRVCON,
                      driver & static_cast<uint8_t>(~kTxContinuousWaveMax));
    const uint8_t amplitude = mfrc630_read_reg(MFRC630_REG_TXAMP);
    mfrc630_write_reg(MFRC630_REG_TXAMP,
                      (amplitude & 0x3FU) |
                          static_cast<uint8_t>(tx_amplitude_level_ << 6));
    return true;
}

void Clrc663Controller::set_timer_slice(uint8_t timer, uint32_t duration_ms)
{
    const uint16_t ticks = static_cast<uint16_t>(
        (duration_ms * kTimerClockHz + 999U) / 1000U);
    mfrc630_timer_set_reload(timer, ticks);
    mfrc630_timer_set_value(timer, ticks);
}

bool Clrc663Controller::wait_for_command(int64_t deadline_us,
                                         bool finish_on_rx_at_timer)
{
    for (;;) {
        const uint8_t irq0 = mfrc630_irq0();
        const uint8_t irq1 = mfrc630_irq1();
        const uint8_t error = (irq0 & MFRC630_IRQ0_ERR_IRQ)
                                  ? mfrc630_read_reg(MFRC630_REG_ERROR)
                                  : 0;
        if ((irq0 & MFRC630_IRQ0_IDLE_IRQ) ||
            ((irq0 & MFRC630_IRQ0_ERR_IRQ) &&
             error != MFRC630_ERROR_MINFRAMEERR)) {
            return true;
        }
        if ((irq1 & MFRC630_IRQ1_TIMER0_IRQ) != 0) {
            if (finish_on_rx_at_timer && (irq0 & MFRC630_IRQ0_RX_IRQ)) {
                return true;
            }
            const int64_t now_us = esp_timer_get_time();
            if (now_us >= deadline_us) {
                return false;
            }
            const uint32_t remaining_ms = static_cast<uint32_t>(
                (deadline_us - now_us + 999) / 1000);
            set_timer_slice(kTimer, std::min(remaining_ms, kTimerSliceMs));
            mfrc630_clear_irq1();
        }
        if (esp_timer_get_time() >= deadline_us) {
            return false;
        }
        vTaskDelay(1);
    }
}

void Clrc663Controller::set_rf_field(bool active)
{
    if (!active && initialized_) {
        mfrc630_write_reg(MFRC630_REG_STATUS, 0);
    }
    uint8_t driver_mode = mfrc630_read_reg(MFRC630_REG_DRVMOD);
    driver_mode = active ? (driver_mode | kDriverTxEnable)
                         : (driver_mode & static_cast<uint8_t>(~kDriverTxEnable));
    mfrc630_write_reg(MFRC630_REG_DRVMOD, driver_mode);
    rf_field_active_ = active;
}

bool Clrc663Controller::set_tx_amplitude(uint8_t level)
{
    if (level > 3 || !initialized_) {
        return false;
    }
    tx_amplitude_level_ = level;
    return apply_tx_amplitude();
}

bool Clrc663Controller::read_register(uint8_t address, uint8_t *value)
{
    if (!initialized_ || address > 0x7F || value == nullptr ||
        address == MFRC630_REG_FIFODATA) {
        return false;
    }
    *value = mfrc630_read_reg(address);
    return true;
}

bool Clrc663Controller::write_register(uint8_t address, uint8_t value)
{
    if (!initialized_ || !is_host_writable_register(address) ||
        (address == MFRC630_REG_STATUS && value != 0)) {
        return false;
    }
    mfrc630_write_reg(address, value);
    return true;
}

bool Clrc663Controller::execute_command(
    uint8_t command, const uint8_t *fifo_input, uint16_t fifo_input_length,
    uint32_t timeout_ms, uint8_t *fifo_output,
    uint32_t *fifo_output_length, uint8_t *command_status)
{
    if (!initialized_ || (fifo_input_length != 0 && fifo_input == nullptr) ||
        fifo_input_length > kMaxCommandFifo || timeout_ms == 0 ||
        timeout_ms > kMaxTimeoutMs || fifo_output == nullptr ||
        fifo_output_length == nullptr || command_status == nullptr) {
        return false;
    }
    const uint32_t output_capacity = *fifo_output_length;
    *fifo_output_length = 0;
    for (uint8_t index = 0; index < 4; ++index) {
        command_status[index] = 0;
    }

    mfrc630_cmd_idle();
    mfrc630_activate_timer(kTimer, 0);
    mfrc630_write_reg(MFRC630_REG_IRQ0EN,
                      MFRC630_IRQ0EN_IDLE_IRQEN | MFRC630_IRQ0EN_ERR_IRQEN);
    mfrc630_write_reg(MFRC630_REG_IRQ1EN, MFRC630_IRQ1EN_TIMER0_IRQEN);
    mfrc630_timer_set_control(
        kTimer, MFRC630_TCONTROL_CLK_211KHZ |
                    MFRC630_TCONTROL_START_TX_END |
                    MFRC630_TCONTROL_AUTO_RESTART);
    set_timer_slice(kTimer, std::min(timeout_ms, kTimerSliceMs));
    mfrc630_clear_irq0();
    mfrc630_clear_irq1();
    mfrc630_flush_fifo();
    if (fifo_input_length != 0) {
        mfrc630_write_fifo(fifo_input, fifo_input_length);
    }
    mfrc630_write_reg(MFRC630_REG_COMMAND, command);
    if (command == 0x0D) {
        protocol_loaded_ = false;
    }

    const int64_t deadline = esp_timer_get_time() +
                             static_cast<int64_t>(timeout_ms) * 1000;
    const bool completed = wait_for_command(deadline, false);
    if (!completed) {
        mfrc630_cmd_idle();
        mfrc630_write_reg(MFRC630_REG_STATUS, 0);
    }
    mfrc630_activate_timer(kTimer, 0);
    command_status[0] = mfrc630_irq0();
    command_status[1] = mfrc630_irq1();
    command_status[2] = (command_status[0] & MFRC630_IRQ0_ERR_IRQ)
                            ? mfrc630_read_reg(MFRC630_REG_ERROR)
                            : 0;
    command_status[3] = mfrc630_read_reg(MFRC630_REG_STATUS);

    const uint16_t fifo_length = mfrc630_fifo_length();
    if (fifo_length > output_capacity) {
        mfrc630_flush_fifo();
        return false;
    }
    if (fifo_length != 0) {
        mfrc630_read_fifo(fifo_output, fifo_length);
    }
    *fifo_output_length = fifo_length;
    return completed;
}

uint16_t Clrc663Controller::transceive(
    const uint8_t *tx, uint16_t tx_length, uint8_t rx_mode, uint8_t tx_mode,
    uint32_t timeout_ms, uint8_t tx_last_bits, uint8_t rx_align,
    uint8_t crc_flags, uint8_t *rx, uint32_t *rx_length,
    uint8_t *rx_last_bits, uint8_t *rx_status)
{
    if (!initialized_ || tx == nullptr || tx_length == 0 ||
        tx_length > kMaxFrameSize || rx_mode > kProtocolMax ||
        tx_mode > kProtocolMax || timeout_ms == 0 ||
        timeout_ms > kMaxTimeoutMs || tx_last_bits > 7 || rx_align > 7 ||
        rx == nullptr || rx_length == nullptr || (crc_flags & ~0x03U) != 0) {
        return 0;
    }
    if (!protocol_loaded_ || loaded_rx_mode_ != rx_mode ||
        loaded_tx_mode_ != tx_mode) {
        mfrc630_cmd_idle();
        mfrc630_cmd_load_protocol(rx_mode, tx_mode);
        vTaskDelay(1);
        loaded_rx_mode_ = rx_mode;
        loaded_tx_mode_ = tx_mode;
        protocol_loaded_ = true;
        set_rf_field(rf_field_active_);
        if (!apply_tx_amplitude()) {
            protocol_loaded_ = false;
            return 0;
        }
    }

    const uint32_t rx_capacity = *rx_length;
    *rx_length = 0;
    if (rx_last_bits != nullptr) {
        *rx_last_bits = 0;
    }
    if (rx_status != nullptr) {
        for (uint8_t index = 0; index < 4; ++index) {
            rx_status[index] = 0;
        }
    }
    const uint8_t tx_crc = (mfrc630_read_reg(MFRC630_REG_TXCRCPRESET) &
                            static_cast<uint8_t>(~MFRC630_CRC_ON)) |
                           ((crc_flags & 0x01U) ? MFRC630_CRC_ON
                                                : MFRC630_CRC_OFF);
    const uint8_t rx_crc = (mfrc630_read_reg(MFRC630_REG_RXCRCCON) &
                            static_cast<uint8_t>(~MFRC630_CRC_ON)) |
                           ((crc_flags & 0x02U) ? MFRC630_CRC_ON
                                                : MFRC630_CRC_OFF);
    mfrc630_write_reg(MFRC630_REG_TXCRCPRESET, tx_crc);
    mfrc630_write_reg(MFRC630_REG_RXCRCCON, rx_crc);
    mfrc630_write_reg(MFRC630_REG_TXDATANUM,
                      (tx_last_bits & 0x07U) | MFRC630_TXDATANUM_DATAEN);
    mfrc630_write_reg(MFRC630_REG_RXBITCTRL, (rx_align & 0x07U) << 4);

    mfrc630_activate_timer(kTimer, 0);
    mfrc630_write_reg(MFRC630_REG_IRQ0EN,
                      MFRC630_IRQ0EN_IDLE_IRQEN | MFRC630_IRQ0EN_ERR_IRQEN);
    mfrc630_write_reg(MFRC630_REG_IRQ1EN, MFRC630_IRQ1EN_TIMER0_IRQEN);
    mfrc630_timer_set_control(
        kTimer, MFRC630_TCONTROL_CLK_211KHZ |
                    MFRC630_TCONTROL_START_TX_END |
                    MFRC630_TCONTROL_AUTO_RESTART);
    const int64_t deadline = esp_timer_get_time() +
                             static_cast<int64_t>(timeout_ms) * 1000;
    set_timer_slice(kTimer, std::min(timeout_ms, kTimerSliceMs));
    mfrc630_clear_irq0();
    mfrc630_clear_irq1();
    mfrc630_cmd_transceive(tx, tx_length);
    wait_for_command(deadline, true);

    mfrc630_cmd_idle();
    mfrc630_activate_timer(kTimer, 0);
    const uint8_t final_irq0 = mfrc630_irq0();
    const uint8_t final_irq1 = mfrc630_irq1();
    const uint8_t final_error = (final_irq0 & MFRC630_IRQ0_ERR_IRQ)
                                    ? mfrc630_read_reg(MFRC630_REG_ERROR)
                                    : 0;
    const uint8_t collision = mfrc630_read_reg(MFRC630_REG_RXCOLL);
    const uint16_t fifo_length = mfrc630_fifo_length();
    const uint16_t copied_length = static_cast<uint16_t>(
        std::min<uint32_t>(fifo_length, rx_capacity));
    if (copied_length != 0) {
        mfrc630_read_fifo(rx, copied_length);
    }
    *rx_length = copied_length;
    if (rx_last_bits != nullptr) {
        *rx_last_bits = mfrc630_read_reg(MFRC630_REG_RXBITCTRL) & 0x07U;
    }
    if (rx_status != nullptr) {
        rx_status[0] = final_irq0;
        rx_status[1] = final_irq1;
        rx_status[2] = final_error;
        rx_status[3] = collision;
    }
    return copied_length;
}

extern "C" {
void mfrc630_SPI_select(void) { clrc663_controller().select(); }
void mfrc630_SPI_unselect(void) { clrc663_controller().unselect(); }
void mfrc630_SPI_transfer(const uint8_t *tx, uint8_t *rx, uint16_t length)
{
    clrc663_controller().transfer(tx, rx, length);
}

} // extern "C"
