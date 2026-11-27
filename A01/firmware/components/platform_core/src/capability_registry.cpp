#include "rf_platform/capability_registry.hpp"

namespace rf_platform {
namespace {

RegistryStatus ValidateDescriptor(const CapabilityDescriptor& descriptor)
{
    if (descriptor.id.empty() || descriptor.major_version == 0 ||
        (descriptor.operation_count > 0 && descriptor.operations == nullptr) ||
        (descriptor.requirement_count > 0 && descriptor.requirements == nullptr)) {
        return RegistryStatus::kInvalidArgument;
    }
    for (std::size_t index = 0; index < descriptor.operation_count; ++index) {
        if (descriptor.operations[index].id.empty() ||
            (descriptor.operations[index].requires_target_confirmation &&
             !descriptor.operations[index].mutating)) {
            return RegistryStatus::kInvalidArgument;
        }
        for (std::size_t previous = 0; previous < index; ++previous) {
            if (descriptor.operations[previous].id == descriptor.operations[index].id) {
                return RegistryStatus::kDuplicateOperation;
            }
        }
    }
    for (std::size_t index = 0; index < descriptor.requirement_count; ++index) {
        if (descriptor.requirements[index].id.empty() ||
            descriptor.requirements[index].minimum_major == 0) {
            return RegistryStatus::kInvalidArgument;
        }
    }
    return RegistryStatus::kOk;
}

}  // namespace

RegistryStatus CapabilityRegistry::Register(
    CapabilityModule& module)
{
    const auto& descriptor = module.Descriptor();
    const auto validation = ValidateDescriptor(descriptor);
    if (validation != RegistryStatus::kOk) {
        return validation;
    }
    if (Find(descriptor.id) != nullptr) {
        return RegistryStatus::kDuplicateCapability;
    }
    if (size_ == modules_.size()) {
        return RegistryStatus::kCapacityExceeded;
    }
    modules_[size_++] = &module;
    return RegistryStatus::kOk;
}

const CapabilityDescriptor* CapabilityRegistry::Find(
    std::string_view capability_id) const
{
    for (std::size_t index = 0; index < size_; ++index) {
        if (modules_[index]->Descriptor().id == capability_id) {
            return &modules_[index]->Descriptor();
        }
    }
    return nullptr;
}

CapabilityModule* CapabilityRegistry::FindModule(
    std::string_view capability_id)
{
    for (std::size_t index = 0; index < size_; ++index) {
        if (modules_[index]->Descriptor().id == capability_id) {
            return modules_[index];
        }
    }
    return nullptr;
}

CapabilityModule* CapabilityRegistry::ModuleAt(std::size_t index)
{
    return index < size_ ? modules_[index] : nullptr;
}

const OperationDescriptor* CapabilityRegistry::FindOperation(
    std::string_view capability_id,
    std::string_view operation_id) const
{
    const auto* descriptor = Find(capability_id);
    if (descriptor == nullptr) {
        return nullptr;
    }
    for (std::size_t index = 0; index < descriptor->operation_count; ++index) {
        if (descriptor->operations[index].id == operation_id) {
            return &descriptor->operations[index];
        }
    }
    return nullptr;
}

bool CapabilityRegistry::RequirementsMet(
    const CapabilityDescriptor& descriptor) const
{
    for (std::size_t index = 0; index < descriptor.requirement_count; ++index) {
        const auto& requirement = descriptor.requirements[index];
        const auto* available = Find(requirement.id);
        if (available == nullptr ||
            available->major_version < requirement.minimum_major) {
            return false;
        }
    }
    return true;
}

}  // namespace rf_platform
