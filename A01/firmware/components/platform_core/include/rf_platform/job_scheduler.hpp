#ifndef RF_PLATFORM_JOB_SCHEDULER_HPP
#define RF_PLATFORM_JOB_SCHEDULER_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "rf_platform/capability_module.hpp"

namespace rf_platform {

class JobEventSink {
public:
    virtual ~JobEventSink() = default;
    virtual void OnJobEvent(const Job& job, const CapabilityResult* result) = 0;
};

enum class SchedulerStatus : std::uint8_t {
    kOk = 0,
    kInvalidArgument,
    kQueueFull,
    kDuplicateJob,
    kNotFound,
    kNotCancellable,
};

class JobScheduler final : public JobObserver {
public:
    static constexpr std::size_t kQueueCapacity = 4;
    static constexpr std::size_t kHistoryCapacity = 8;
    static constexpr std::size_t kMaxArgumentSize = 512;
    static constexpr std::size_t kMaxOperationIdSize = 48;

    explicit JobScheduler(JobEventSink& event_sink) : event_sink_(event_sink) {}

    // Calls must be serialized on the platform's scheduler owner task.
    SchedulerStatus Submit(
        std::uint32_t job_id,
        CapabilityModule& module,
        const OperationDescriptor& operation,
        const std::uint8_t* arguments,
        std::size_t argument_size,
        const std::uint8_t* confirmed_target_uid = nullptr,
        std::size_t confirmed_target_uid_size = 0);
    SchedulerStatus Cancel(std::uint32_t job_id);
    bool RunNext();
    const Job* FindJob(std::uint32_t job_id) const;
    std::size_t outstanding() const;
    void OnJobUpdated(const Job& job) override;

private:
    struct Slot {
        Job job{0};
        CapabilityModule* module = nullptr;
        std::array<char, kMaxOperationIdSize + 1> operation_id{};
        std::array<std::uint8_t, kMaxArgumentSize> arguments{};
        std::size_t argument_size = 0;
        std::uint64_t sequence = 0;
        bool occupied = false;
        bool running = false;
    };

    Slot* FindSlot(std::uint32_t job_id);
    const Slot* FindSlot(std::uint32_t job_id) const;
    Slot* OldestQueued();
    void Retain(const Job& job);
    void Notify(const Job& job, const CapabilityResult* result = nullptr);

    JobEventSink& event_sink_;
    std::array<Slot, kQueueCapacity> slots_{};
    std::array<Job, kHistoryCapacity> history_{};
    std::array<bool, kHistoryCapacity> history_valid_{};
    std::size_t history_cursor_ = 0;
    std::uint64_t next_sequence_ = 1;
};

}  // namespace rf_platform

#endif
