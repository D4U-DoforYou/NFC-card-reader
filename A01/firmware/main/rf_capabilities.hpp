#pragma once

#include "rf_platform/capability_registry.hpp"

namespace rf_platform {

struct DeviceIdentity;

RegistryStatus RegisterDeviceInfoCapability(
    CapabilityRegistry& registry, const DeviceIdentity& identity);
RegistryStatus RegisterRadioConfigCapability(CapabilityRegistry& registry);
RegistryStatus RegisterRawRfCapability(CapabilityRegistry& registry);

}  // namespace rf_platform
