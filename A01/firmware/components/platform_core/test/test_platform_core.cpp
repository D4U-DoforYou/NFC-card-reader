#include "rf_platform/capability_registry.hpp"
#include "rf_platform/capability_module.hpp"
#include "rf_platform/job.hpp"
#include "rf_platform/job_router.hpp"
#include "rf_platform/job_scheduler.hpp"

#include <cassert>
#include <vector>

namespace {

static constexpr rf_platform::OperationDescriptor kNdefOperations[] = {
    {"read", false, true, 128},
    {"write", true, false, 128, true},
};
static constexpr rf_platform::CapabilityRequirement kNdefRequirements[] = {
    {"org.example.rf.raw", 1},
};
static constexpr rf_platform::CapabilityDescriptor kNdefDescriptor{
    "org.example.nfc.ndef", 1, 0, kNdefOperations, 2, nullptr, 0,
};
static constexpr rf_platform::CapabilityDescriptor kIsoDepDescriptor{
    "org.example.rf.raw", 1, 0, nullptr, 0, nullptr, 0,
};
static constexpr rf_platform::CapabilityDescriptor kDisplayDescriptor{
    "org.example.display.panel", 1, 0, nullptr, 0, kNdefRequirements, 1,
};
static constexpr rf_platform::OperationDescriptor kConfigOperations[] = {
    {"set_level", true, true, 1},
};
static constexpr rf_platform::CapabilityDescriptor kConfigDescriptor{
    "org.example.rf.clrc663.config", 1, 0, kConfigOperations, 1, nullptr, 0,
};

class TestModule final : public rf_platform::CapabilityModule {
public:
    explicit TestModule(const rf_platform::CapabilityDescriptor& descriptor)
        : descriptor_(descriptor) {}

    const rf_platform::CapabilityDescriptor& Descriptor() const override
    {
        return descriptor_;
    }

    rf_platform::CapabilityResult Execute(
        std::string_view,
        const std::uint8_t*,
        std::size_t,
        rf_platform::Job& job) override
    {
        last_confirmed_uid_size = job.confirmed_target_uid_size();
        job.ReportProgress("execute", 1, 1);
        return {};
    }

    std::size_t last_confirmed_uid_size = 0;

private:
    const rf_platform::CapabilityDescriptor& descriptor_;
};

class RecordingSink final : public rf_platform::JobEventSink {
public:
    void OnJobEvent(
        const rf_platform::Job& job,
        const rf_platform::CapabilityResult* result) override
    {
        ids.push_back(job.id());
        states.push_back(job.state());
        has_result.push_back(result != nullptr);
    }

    std::vector<std::uint32_t> ids;
    std::vector<rf_platform::JobState> states;
    std::vector<bool> has_result;
};

}  // namespace

int main()
{
    TestModule ndef(kNdefDescriptor);
    TestModule iso_dep(kIsoDepDescriptor);
    TestModule config(kConfigDescriptor);
    rf_platform::CapabilityRegistry registry;
    assert(registry.Register(ndef) == rf_platform::RegistryStatus::kOk);
    assert(registry.Register(iso_dep) == rf_platform::RegistryStatus::kOk);
    assert(registry.Register(config) == rf_platform::RegistryStatus::kOk);
    assert(registry.FindModule("org.example.nfc.ndef") == &ndef);
    assert(registry.FindOperation("org.example.nfc.ndef", "write")->mutating);
    assert(registry.RequirementsMet(kDisplayDescriptor));
    assert(registry.Register(ndef) ==
           rf_platform::RegistryStatus::kDuplicateCapability);

    rf_platform::Job job(9);
    assert(job.Start() == rf_platform::JobStatus::kOk);
    assert(job.stage() == "starting");
    assert(job.ReportProgress("scan", 1, 3) == rf_platform::JobStatus::kOk);
    assert(job.ReportProgress("scan", 0, 3) ==
           rf_platform::JobStatus::kInvalidProgress);
    assert(job.ReportProgress("read", 1, 2) == rf_platform::JobStatus::kOk);
    assert(job.Finish(rf_platform::JobState::kCompleted) ==
           rf_platform::JobStatus::kOk);
    assert(job.Start() == rf_platform::JobStatus::kInvalidTransition);

    RecordingSink sink;
    rf_platform::JobScheduler scheduler(sink);
    rf_platform::JobRouter router(registry, scheduler);
    const rf_platform::StartJobRequest read_request{
        10, "org.example.nfc.ndef", 1, "read", nullptr, 0,
    };
    assert(router.Start(read_request) == rf_platform::RouteStatus::kAccepted);
    auto write_request = rf_platform::StartJobRequest{
        11, "org.example.nfc.ndef", 1, "write", nullptr, 0,
    };
    assert(router.Start(write_request) ==
           rf_platform::RouteStatus::kConfirmationRequired);
    const std::uint8_t target_uid[] = {0x04, 0x01, 0x02, 0x03};
    write_request.user_confirmed = true;
    write_request.confirmed_target_uid = target_uid;
    write_request.confirmed_target_uid_size = sizeof(target_uid);
    assert(router.Start(write_request) == rf_platform::RouteStatus::kAccepted);
    assert(scheduler.outstanding() == 2);
    assert(scheduler.RunNext());
    assert(scheduler.RunNext());
    assert(!scheduler.RunNext());
    assert(scheduler.FindJob(10)->state() == rf_platform::JobState::kCompleted);
    assert(scheduler.FindJob(11)->state() == rf_platform::JobState::kCompleted);
    assert(ndef.last_confirmed_uid_size == sizeof(target_uid));
    assert(sink.states.size() == 8);
    assert(sink.states[0] == rf_platform::JobState::kAccepted);
    assert(sink.states[1] == rf_platform::JobState::kAccepted);
    assert(sink.states[2] == rf_platform::JobState::kRunning);
    assert(sink.states[3] == rf_platform::JobState::kRunning);
    assert(sink.states[4] == rf_platform::JobState::kCompleted);
    assert(sink.has_result[4]);
    const std::uint8_t amplitude_level = 1;
    assert(router.Start({13, "org.example.rf.clrc663.config", 1,
                         "set_level", &amplitude_level, 1}) ==
           rf_platform::RouteStatus::kAccepted);
    assert(scheduler.RunNext());
    assert(config.last_confirmed_uid_size == 0);

    assert(router.Start({12, "org.example.nfc.ndef", 1, "read"}) ==
           rf_platform::RouteStatus::kAccepted);
    assert(scheduler.Cancel(12) == rf_platform::SchedulerStatus::kOk);
    assert(scheduler.FindJob(12)->state() == rf_platform::JobState::kCancelled);
    assert(scheduler.Cancel(12) == rf_platform::SchedulerStatus::kNotFound);

    RecordingSink bounded_sink;
    rf_platform::JobScheduler bounded_scheduler(bounded_sink);
    rf_platform::JobRouter bounded_router(registry, bounded_scheduler);
    for (std::uint32_t id = 20; id < 24; ++id) {
        assert(bounded_router.Start({id, "org.example.nfc.ndef", 1, "read"}) ==
               rf_platform::RouteStatus::kAccepted);
    }
    assert(bounded_router.Start({24, "org.example.nfc.ndef", 1, "read"}) ==
           rf_platform::RouteStatus::kBusy);
    assert(bounded_scheduler.outstanding() ==
           rf_platform::JobScheduler::kQueueCapacity);
    return 0;
}
