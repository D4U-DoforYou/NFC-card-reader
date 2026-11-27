idf_component_register(
    SRCS "main.cpp" "ble_gatt_transport.cpp" "firmware_ota.cpp"
         "rf_capabilities.cpp" "rf_led_indicator.cpp"
    INCLUDE_DIRS "."
    REQUIRES platform_core mfrc630 clrc663
             esp_driver_gpio esp_driver_spi esp_common esp_timer
             esp_hw_support bt nvs_flash app_update mbedtls platform_core)

idf_build_get_property(FIRMWARE_VERSION PROJECT_VER)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    RF_PLATFORM_FIRMWARE_VERSION="${FIRMWARE_VERSION}"
)
