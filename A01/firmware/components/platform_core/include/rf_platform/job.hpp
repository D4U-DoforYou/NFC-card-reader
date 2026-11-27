#ifndef RF_PLATFORM_JOB_HPP
#define RF_PLATFORM_JOB_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace rf_platform {

class Job;

class JobObserver {
public:
    virtual ~JobObserver() = default;
    virtual void OnJobUpdated(const Job& job) = 0;
};

enum class JobState : std::uint8_t {
    kAccepted = 1,
    kRunning,
    kCompleted,
    kFailed,
    kCancelled,
    kResultUncertain,
};

enum class JobStatus : std::uint8_t {
    kOk = 0,
    kInvalidArgument,
    kInvalidTransition,
    kInvalidProgress,
};

class Job final {
public:
    static constexpr std::size_t kStageCapacity = 32;
    static constexpr std::size_t kMaxConfirmedUidSize = 16;

    Job() : Job(0) {}
    explicit Job(std::uint32_t id);

    JobStatus Start();
    JobStatus ReportProgress(
        std::string_view stage,
        std::uint32_t current,
        std::uint32_t total);
    JobStatus Finish(JobState terminal_state, std::uint32_t error_code = 0);
    JobStatus RequestCancel();
    void SetObserver(JobObserver* observer) { observer_ = observer; }
    bool SetConfirmedTargetUid(const std::uint8_t* uid, std::size_t size);

    std::uint32_t id() const { return id_; }
    JobState state() const { return state_; }
    std::string_view stage() const { return stage_.data(); }
    std::uint32_t progress_current() const { return progress_current_; }
    std::uint32_t progress_total() const { return progress_total_; }
    std::uint32_t error_code() const { return error_code_; }
    bool cancel_requested() const { return cancel_requested_; }
    const std::uint8_t* confirmed_target_uid() const
    {
        return confirmed_target_uid_.data();
    }
    std::size_t confirmed_target_uid_size() const { return confirmed_target_uid_size_; }

private:
    std::uint32_t id_;
    JobState state_;
    std::array<char, kStageCapacity> stage_{};
    std::uint32_t progress_current_ = 0;
    std::uint32_t progress_total_ = 0;
    std::uint32_t error_code_ = 0;
    bool cancel_requested_ = false;
    JobObserver* observer_ = nullptr;
    std::array<std::uint8_t, kMaxConfirmedUidSize> confirmed_target_uid_{};
    std::size_t confirmed_target_uid_size_ = 0;
};

}  // namespace rf_platform

#endif
