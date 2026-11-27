#include "rf_platform/job_router.hpp"

namespace rf_platform {

RouteStatus JobRouter::Start(const StartJobRequest& request)
{
    if (request.job_id == 0 || request.capability_id.empty() ||
        request.operation_id.empty() ||
        (request.argument_size != 0 && request.arguments == nullptr) ||
        (request.confirmed_target_uid_size != 0 &&
         request.confirmed_target_uid == nullptr) ||
        request.confirmed_target_uid_size > Job::kMaxConfirmedUidSize) {
        return RouteStatus::kInvalidArgument;
    }

    const auto* descriptor = registry_.Find(request.capability_id);
    auto* module = registry_.FindModule(request.capability_id);
    if (descriptor == nullptr || module == nullptr) {
        return RouteStatus::kUnsupportedCapability;
    }
    if (descriptor->major_version != request.capability_major) {
        return RouteStatus::kUnsupportedVersion;
    }
    if (!registry_.RequirementsMet(*descriptor)) {
        return RouteStatus::kMissingRequirement;
    }

    const auto* operation = registry_.FindOperation(
        request.capability_id, request.operation_id);
    if (operation == nullptr) {
        return RouteStatus::kUnsupportedOperation;
    }
    if (request.argument_size > operation->max_payload_size) {
        return RouteStatus::kInvalidArgument;
    }
    if (operation->requires_target_confirmation &&
        (!request.user_confirmed || request.confirmed_target_uid_size == 0)) {
        return RouteStatus::kConfirmationRequired;
    }

    const auto status = scheduler_.Submit(
        request.job_id, *module, *operation,
        request.arguments, request.argument_size,
        request.confirmed_target_uid, request.confirmed_target_uid_size);
    if (status == SchedulerStatus::kQueueFull) {
        return RouteStatus::kBusy;
    }
    if (status != SchedulerStatus::kOk) {
        return RouteStatus::kInvalidArgument;
    }
    return RouteStatus::kAccepted;
}

}  // namespace rf_platform
