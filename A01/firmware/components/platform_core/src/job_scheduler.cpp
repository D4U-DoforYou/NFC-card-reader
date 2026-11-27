#include "rf_platform/job_scheduler.hpp"

#include <algorithm>

namespace rf_platform {
namespace {

JobState StateFor(CapabilityStatus status)
{
    switch (status) {
    case CapabilityStatus::kOk:
        return JobState::kCompleted;
    case CapabilityStatus::kCancelled:
        return JobState::kCancelled;
    case CapabilityStatus::kResultUncertain:
        return JobState::kResultUncertain;
    default:
        return JobState::kFailed;
    }
}

}  // namespace

SchedulerStatus JobScheduler::Submit(
    std::uint32_t job_id,
    CapabilityModule& module,
    const OperationDescriptor& operation,
    const std::uint8_t* arguments,
    std::size_t argument_size,
    const std::uint8_t* confirmed_target_uid,
    std::size_t confirmed_target_uid_size)
{
    if (job_id == 0 || operation.id.empty() ||
        operation.id.size() > kMaxOperationIdSize ||
        argument_size > kMaxArgumentSize ||
        argument_size > operation.max_payload_size ||
        (argument_size != 0 && arguments == nullptr) ||
        confirmed_target_uid_size > Job::kMaxConfirmedUidSize ||
        (confirmed_target_uid_size != 0 && confirmed_target_uid == nullptr)) {
        return SchedulerStatus::kInvalidArgument;
    }
    if (FindSlot(job_id) != nullptr || FindJob(job_id) != nullptr) {
        return SchedulerStatus::kDuplicateJob;
    }

    Slot* free_slot = nullptr;
    for (auto& slot : slots_) {
        if (!slot.occupied) {
            free_slot = &slot;
            break;
        }
    }
    if (free_slot == nullptr) {
        return SchedulerStatus::kQueueFull;
    }

    auto& slot = *free_slot;
    slot.job = Job(job_id);
    slot.job.SetConfirmedTargetUid(confirmed_target_uid,
                                   confirmed_target_uid_size);
    slot.job.SetObserver(this);
    slot.module = &module;
    std::copy(operation.id.begin(), operation.id.end(), slot.operation_id.begin());
    slot.operation_id[operation.id.size()] = '\0';
    if (argument_size != 0) {
        std::copy(arguments, arguments + argument_size, slot.arguments.begin());
    }
    slot.argument_size = argument_size;
    slot.sequence = next_sequence_++;
    slot.running = false;
    slot.occupied = true;
    Notify(slot.job);
    return SchedulerStatus::kOk;
}

SchedulerStatus JobScheduler::Cancel(std::uint32_t job_id)
{
    auto* slot = FindSlot(job_id);
    if (slot == nullptr) {
        return SchedulerStatus::kNotFound;
    }
    const auto& descriptor = slot->module->Descriptor();
    bool cancellable = false;
    for (std::size_t index = 0; index < descriptor.operation_count; ++index) {
        if (descriptor.operations[index].id == slot->operation_id.data()) {
            cancellable = descriptor.operations[index].cancellable;
            break;
        }
    }
    if (!cancellable) {
        return SchedulerStatus::kNotCancellable;
    }
    if (slot->running) {
        return slot->job.RequestCancel() == JobStatus::kOk
            ? SchedulerStatus::kOk
            : SchedulerStatus::kNotFound;
    }

    slot->job.SetObserver(nullptr);
    slot->job.Finish(JobState::kCancelled);
    Retain(slot->job);
    Notify(slot->job);
    slot->occupied = false;
    return SchedulerStatus::kOk;
}

bool JobScheduler::RunNext()
{
    auto* slot = OldestQueued();
    if (slot == nullptr) {
        return false;
    }
    slot->running = true;
    slot->job.Start();
    Notify(slot->job);

    auto result = slot->module->Execute(
        slot->operation_id.data(), slot->arguments.data(),
        slot->argument_size, slot->job);
    if (result.payload_size > result.payload.size()) {
        result.status = CapabilityStatus::kFailed;
        result.payload_size = 0;
    }
    slot->job.SetObserver(nullptr);
    slot->job.Finish(StateFor(result.status),
                     result.status == CapabilityStatus::kOk ? 0U :
                     static_cast<std::uint32_t>(result.status));
    Retain(slot->job);
    Notify(slot->job, &result);
    slot->occupied = false;
    return true;
}

const Job* JobScheduler::FindJob(std::uint32_t job_id) const
{
    if (const auto* slot = FindSlot(job_id)) {
        return &slot->job;
    }
    for (std::size_t index = 0; index < history_.size(); ++index) {
        if (history_valid_[index] && history_[index].id() == job_id) {
            return &history_[index];
        }
    }
    return nullptr;
}

std::size_t JobScheduler::outstanding() const
{
    std::size_t count = 0;
    for (const auto& slot : slots_) {
        if (slot.occupied) {
            ++count;
        }
    }
    return count;
}

void JobScheduler::OnJobUpdated(const Job& job)
{
    Notify(job);
}

JobScheduler::Slot* JobScheduler::FindSlot(std::uint32_t job_id)
{
    for (auto& slot : slots_) {
        if (slot.occupied && slot.job.id() == job_id) {
            return &slot;
        }
    }
    return nullptr;
}

const JobScheduler::Slot* JobScheduler::FindSlot(std::uint32_t job_id) const
{
    for (const auto& slot : slots_) {
        if (slot.occupied && slot.job.id() == job_id) {
            return &slot;
        }
    }
    return nullptr;
}

JobScheduler::Slot* JobScheduler::OldestQueued()
{
    Slot* oldest = nullptr;
    for (auto& slot : slots_) {
        if (slot.occupied && !slot.running &&
            (oldest == nullptr || slot.sequence < oldest->sequence)) {
            oldest = &slot;
        }
    }
    return oldest;
}

void JobScheduler::Retain(const Job& job)
{
    history_[history_cursor_] = job;
    history_[history_cursor_].SetObserver(nullptr);
    history_valid_[history_cursor_] = true;
    history_cursor_ = (history_cursor_ + 1) % history_.size();
}

void JobScheduler::Notify(const Job& job, const CapabilityResult* result)
{
    event_sink_.OnJobEvent(job, result);
}

}  // namespace rf_platform
