#include "rf_platform/job.hpp"

#include <algorithm>

namespace rf_platform {
namespace {

bool IsTerminal(JobState state)
{
    return state == JobState::kCompleted || state == JobState::kFailed ||
           state == JobState::kCancelled || state == JobState::kResultUncertain;
}

}  // namespace

Job::Job(std::uint32_t id)
    : id_(id), state_(JobState::kAccepted)
{
}

JobStatus Job::Start()
{
    if (id_ == 0) {
        return JobStatus::kInvalidArgument;
    }
    if (state_ != JobState::kAccepted) {
        return JobStatus::kInvalidTransition;
    }
    state_ = JobState::kRunning;
    constexpr char kStartingStage[] = "starting";
    std::copy(kStartingStage, kStartingStage + sizeof(kStartingStage),
              stage_.begin());
    return JobStatus::kOk;
}

JobStatus Job::ReportProgress(
    std::string_view stage,
    std::uint32_t current,
    std::uint32_t total)
{
    if (stage.empty()) {
        return JobStatus::kInvalidArgument;
    }
    if (state_ != JobState::kRunning) {
        return JobStatus::kInvalidTransition;
    }
    if (total == 0 || current > total ||
        stage.size() >= stage_.size() ||
        (stage == std::string_view(stage_.data()) && current < progress_current_)) {
        return JobStatus::kInvalidProgress;
    }
    std::copy(stage.begin(), stage.end(), stage_.begin());
    stage_[stage.size()] = '\0';
    progress_current_ = current;
    progress_total_ = total;
    if (observer_ != nullptr) {
        observer_->OnJobUpdated(*this);
    }
    return JobStatus::kOk;
}

JobStatus Job::Finish(JobState terminal_state, std::uint32_t error_code)
{
    if (id_ == 0) {
        return JobStatus::kInvalidArgument;
    }
    const bool accepted_failure = state_ == JobState::kAccepted &&
        (terminal_state == JobState::kFailed ||
         terminal_state == JobState::kCancelled);
    const bool running_terminal = state_ == JobState::kRunning &&
        IsTerminal(terminal_state);
    if (!accepted_failure && !running_terminal) {
        return JobStatus::kInvalidTransition;
    }
    state_ = terminal_state;
    error_code_ = error_code;
    if (observer_ != nullptr) {
        observer_->OnJobUpdated(*this);
    }
    return JobStatus::kOk;
}

JobStatus Job::RequestCancel()
{
    if (IsTerminal(state_)) {
        return JobStatus::kInvalidTransition;
    }
    cancel_requested_ = true;
    return JobStatus::kOk;
}

bool Job::SetConfirmedTargetUid(const std::uint8_t* uid, std::size_t size)
{
    if ((size != 0 && uid == nullptr) || size > confirmed_target_uid_.size() ||
        state_ != JobState::kAccepted) {
        return false;
    }
    if (size != 0) {
        std::copy(uid, uid + size, confirmed_target_uid_.begin());
    }
    confirmed_target_uid_size_ = size;
    return true;
}

}  // namespace rf_platform
