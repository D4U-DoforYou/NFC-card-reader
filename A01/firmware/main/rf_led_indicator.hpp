#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

namespace rf_platform::rf_led {

esp_err_t Init();
void SetFieldEnabled(bool enabled);
void RecordBytes(std::size_t size);
void LogBytes(const char* direction, const std::uint8_t* bytes,
              std::size_t size);

class Activity final {
public:
    explicit Activity(std::size_t bytes);
    ~Activity();

    Activity(const Activity&) = delete;
    Activity& operator=(const Activity&) = delete;
};

}  // namespace rf_platform::rf_led
