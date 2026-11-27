#ifndef RF_PLATFORM_CAPABILITY_HPP
#define RF_PLATFORM_CAPABILITY_HPP

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace rf_platform {

struct OperationDescriptor {
    std::string_view id;
    bool mutating;
    bool cancellable;
    std::uint32_t max_payload_size;
    bool requires_target_confirmation = false;
};

struct CapabilityRequirement {
    std::string_view id;
    std::uint16_t minimum_major;
};

struct CapabilityDescriptor {
    std::string_view id;
    std::uint16_t major_version;
    std::uint16_t minor_version;
    const OperationDescriptor* operations;
    std::size_t operation_count;
    const CapabilityRequirement* requirements;
    std::size_t requirement_count;
};

}  // namespace rf_platform

#endif
