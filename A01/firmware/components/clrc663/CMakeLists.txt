idf_component_register(
    SRCS "clrc663_controller.cpp"
    INCLUDE_DIRS "include"
    REQUIRES mfrc630 esp_driver_gpio esp_driver_spi esp_timer log freertos esp_common)
