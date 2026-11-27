#ifndef RF_PLATFORM_CAPABILITY_MODULE_HPP
#define RF_PLATFORM_CAPABILITY_MODULE_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "rf_platform/capability.hpp"
#include "rf_platform/job.hpp"

namespace rf_platform {

enum class CapabilityStatus : std::uint8_t {
    kOk = 0,
    kUnsupportedOperation,
    kInvalidArgument,
    kPermissionDenied,
    kBusy,
    kCancelled,
    kFailed,
    kResultUncertain,
};

struct CapabilityResult {
    static constexpr std::size_t kMaxInlinePayload = 512;

    CapabilityStatus status = CapabilityStatus::kOk;
    std::array<std::uint8_t, kMaxInlinePayload> payload{};
    std::size_t payload_size = 0;
};

class CapabilityModule {
public:
    virtual ~CapabilityModule() = default;

    virtual const CapabilityDescriptor& Descriptor() const = 0;
    virtual CapabilityResult Execute(
        std::string_view operation_id,
        const std::uint8_t* arguments,
        std::size_t argument_size,
        Job& job) = 0;
};

}  // namespace rf_platform

#endif
