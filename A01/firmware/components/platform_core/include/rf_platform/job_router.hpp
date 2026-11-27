#ifndef RF_PLATFORM_JOB_ROUTER_HPP
#define RF_PLATFORM_JOB_ROUTER_HPP

#include <cstddef>
#include <cstdint>
#include <string_view>

#include "rf_platform/capability_registry.hpp"
#include "rf_platform/job_scheduler.hpp"

namespace rf_platform {

struct StartJobRequest {
    std::uint32_t job_id = 0;
    std::string_view capability_id;
    std::uint16_t capability_major = 0;
    std::string_view operation_id;
    const std::uint8_t* arguments = nullptr;
    std::size_t argument_size = 0;
    bool user_confirmed = false;
    const std::uint8_t* confirmed_target_uid = nullptr;
    std::size_t confirmed_target_uid_size = 0;
};

enum class RouteStatus : std::uint8_t {
    kAccepted = 0,
    kInvalidArgument,
    kUnsupportedCapability,
    kUnsupportedVersion,
    kUnsupportedOperation,
    kMissingRequirement,
    kConfirmationRequired,
    kBusy,
};

class JobRouter final {
public:
    JobRouter(CapabilityRegistry& registry, JobScheduler& scheduler)
        : registry_(registry), scheduler_(scheduler) {}

    RouteStatus Start(const StartJobRequest& request);

private:
    CapabilityRegistry& registry_;
    JobScheduler& scheduler_;
};

}  // namespace rf_platform

#endif
