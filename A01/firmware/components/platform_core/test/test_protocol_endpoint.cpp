#include "rf_platform/protocol_endpoint.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

constexpr rf_platform::OperationDescriptor kInfoOperations[] = {
    {"get", false, true, 0},
};
constexpr rf_platform::CapabilityDescriptor kInfoCapability{
    "org.example.device.info", 1, 0, kInfoOperations, 1, nullptr, 0,
};

class DeviceInfoModule final : public rf_platform::CapabilityModule {
public:
    const rf_platform::CapabilityDescriptor& Descriptor() const override
    {
        return kInfoCapability;
    }

    rf_platform::CapabilityResult Execute(
        std::string_view operation,
        const std::uint8_t*,
        std::size_t argument_size,
        rf_platform::Job& job) override
    {
        rf_platform::CapabilityResult result;
        if (operation != "get" || argument_size != 0) {
            result.status = rf_platform::CapabilityStatus::kInvalidArgument;
            return result;
        }
        job.ReportProgress("read", 1, 1);
        result.payload[0] = 'O';
        result.payload[1] = 'K';
        result.payload_size = 2;
        return result;
    }
};

class FakeTransport final : public rf_platform::DeviceTransport {
public:
    std::string_view Id() const override { return "test"; }

    rf_platform::TransportStatus Start(rf_platform::FrameReceiver& receiver)
        override
    {
        receiver_ = &receiver;
        return rf_platform::TransportStatus::kOk;
    }

    rf_platform::TransportStatus Send(rf_platform::FrameView frame) override
    {
        sent.emplace_back(frame.data, frame.data + frame.size);
        return rf_platform::TransportStatus::kOk;
    }

    void Stop() override { receiver_ = nullptr; }

    void Inject(rf_platform::FrameView frame)
    {
        assert(receiver_ != nullptr);
        receiver_->OnFrame(Id(), frame);
    }

    std::vector<std::vector<std::uint8_t>> sent;

private:
    rf_platform::FrameReceiver* receiver_ = nullptr;
};

class FixedSessionIdSource final : public rf_platform::SessionIdSource {
public:
    std::uint64_t NextSessionId() override { return 0x123456789ULL; }
};

std::vector<std::uint8_t> ReadHelloVector()
{
    std::ifstream input(RF_HELLO_VECTOR_PATH);
    std::string hex;
    input >> hex;
    std::vector<std::uint8_t> bytes;
    for (std::size_t index = 0; index + 1 < hex.size(); index += 2) {
        bytes.push_back(static_cast<std::uint8_t>(
            std::stoul(hex.substr(index, 2), nullptr, 16)));
    }
    return bytes;
}

std::vector<std::uint8_t> Encode(
    const rfplatform_v1_Envelope& envelope)
{
    rf_platform::ProtocolCodec codec;
    std::array<std::uint8_t, rf_platform::ProtocolCodec::kMaxEncodedSize> bytes{};
    std::size_t size = 0;
    assert(codec.Encode(envelope, bytes.data(), bytes.size(), size) ==
           rf_platform::CodecStatus::kOk);
    return {bytes.begin(), bytes.begin() + size};
}

rfplatform_v1_Envelope Decode(const std::vector<std::uint8_t>& bytes)
{
    rf_platform::ProtocolCodec codec;
    rfplatform_v1_Envelope envelope{};
    assert(codec.Decode({bytes.data(), bytes.size()}, envelope) ==
           rf_platform::CodecStatus::kOk);
    return envelope;
}

}  // namespace

int main()
{
    const auto shared_vector = ReadHelloVector();
    assert(shared_vector.size() == 13);
    auto hello = Decode(shared_vector);
    assert(hello.protocol_major == 1);
    assert(hello.request_id == 1);
    assert(hello.which_body == rfplatform_v1_Envelope_hello_request_tag);
    assert(hello.body.hello_request.min_protocol_major == 1);
    assert(hello.body.hello_request.max_protocol_major == 1);

    rf_platform::CapabilityRegistry registry;
    DeviceInfoModule info;
    assert(registry.Register(info) == rf_platform::RegistryStatus::kOk);

    FakeTransport transport;
    FixedSessionIdSource session_ids;
    rf_platform::DeviceIdentity identity;
    identity.device_id = {1, 2, 3, 4};
    identity.device_id_size = 4;
    identity.boot_id = {5, 6, 7, 8};
    identity.boot_id_size = 4;
    rf_platform::DeviceProtocolEndpoint endpoint(
        registry, transport, session_ids, identity);
    assert(endpoint.Start() == rf_platform::TransportStatus::kOk);

    transport.Inject({shared_vector.data(), shared_vector.size()});
    assert(endpoint.session_id() == 0x123456789ULL);
    assert(transport.sent.size() == 1);
    auto response = Decode(transport.sent.back());
    assert(response.which_body == rfplatform_v1_Envelope_hello_response_tag);
    assert(response.session_id == endpoint.session_id());
    assert(response.body.hello_response.device_id.size == 4);

    rfplatform_v1_Envelope capability_query{};
    capability_query.protocol_major = 1;
    capability_query.session_id = endpoint.session_id();
    capability_query.request_id = 2;
    capability_query.which_body = rfplatform_v1_Envelope_capability_query_tag;
    transport.sent.clear();
    const auto capability_frame = Encode(capability_query);
    transport.Inject({capability_frame.data(), capability_frame.size()});
    assert(transport.sent.size() == 1);
    response = Decode(transport.sent.back());
    assert(response.which_body == rfplatform_v1_Envelope_capability_list_tag);
    assert(response.body.capability_list.capabilities_count == 1);
    assert(std::string(response.body.capability_list.capabilities[0].id) ==
           "org.example.device.info");

    rfplatform_v1_Envelope start_job{};
    start_job.protocol_major = 1;
    start_job.session_id = endpoint.session_id();
    start_job.request_id = 3;
    start_job.which_body = rfplatform_v1_Envelope_start_job_tag;
    auto& job_request = start_job.body.start_job;
    std::copy_n("org.example.device.info", 24, job_request.capability_id);
    std::copy_n("get", 4, job_request.operation_id);
    job_request.capability_major = 1;
    transport.sent.clear();
    const auto start_frame = Encode(start_job);
    transport.Inject({start_frame.data(), start_frame.size()});
    assert(transport.sent.size() == 1);
    response = Decode(transport.sent.back());
    assert(response.which_body == rfplatform_v1_Envelope_job_event_tag);
    assert(response.request_id == 3);
    assert(response.body.job_event.state ==
           rfplatform_v1_JobState_JOB_STATE_ACCEPTED);
    const auto job_id = response.body.job_event.job_id;

    rfplatform_v1_Envelope query{};
    query.protocol_major = 1;
    query.session_id = endpoint.session_id();
    query.request_id = 4;
    query.which_body = rfplatform_v1_Envelope_query_job_tag;
    query.body.query_job.job_id = job_id;
    transport.sent.clear();
    const auto query_frame = Encode(query);
    transport.Inject({query_frame.data(), query_frame.size()});
    response = Decode(transport.sent.back());
    assert(response.request_id == 4);
    assert(response.body.job_event.state ==
           rfplatform_v1_JobState_JOB_STATE_ACCEPTED);

    transport.sent.clear();
    assert(endpoint.RunNextJob());
    assert(transport.sent.size() == 3);
    response = Decode(transport.sent.back());
    assert(response.request_id == 0);
    assert(response.body.job_event.state ==
           rfplatform_v1_JobState_JOB_STATE_COMPLETED);
    assert(response.body.job_event.result.size == 2);
    assert(response.body.job_event.result.bytes[0] == 'O');
    assert(response.body.job_event.result.bytes[1] == 'K');
    endpoint.Stop();
    return 0;
}
