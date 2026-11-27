#ifndef RF_PLATFORM_CAPABILITY_REGISTRY_HPP
#define RF_PLATFORM_CAPABILITY_REGISTRY_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "rf_platform/capability.hpp"
#include "rf_platform/capability_module.hpp"

namespace rf_platform {

enum class RegistryStatus : std::uint8_t {
    kOk = 0,
    kInvalidArgument,
    kDuplicateCapability,
    kDuplicateOperation,
    kCapacityExceeded,
};

class CapabilityRegistry final {
public:
    static constexpr std::size_t kMaxCapabilities = 12;

    RegistryStatus Register(CapabilityModule& module);
    const CapabilityDescriptor* Find(std::string_view capability_id) const;
    CapabilityModule* FindModule(std::string_view capability_id);
    CapabilityModule* ModuleAt(std::size_t index);
    const OperationDescriptor* FindOperation(
        std::string_view capability_id,
        std::string_view operation_id) const;
    bool RequirementsMet(const CapabilityDescriptor& descriptor) const;
    std::size_t size() const { return size_; }

private:
    std::array<CapabilityModule*, kMaxCapabilities> modules_{};
    std::size_t size_ = 0;
};

}  // namespace rf_platform

#endif
