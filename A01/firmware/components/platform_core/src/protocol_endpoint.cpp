#include "rf_platform/protocol_endpoint.hpp"

#include <algorithm>
#include <cstring>
#include <iterator>

#if defined(ESP_PLATFORM)
#include "esp_log.h"
#define RF_PROTO_LOGD(...) ESP_LOGD("RF_PROTO", __VA_ARGS__)
#else
#define RF_PROTO_LOGD(...) do { } while (0)
#endif

namespace rf_platform {
namespace {

template <std::size_t Size>
bool CopyText(char (&destination)[Size], std::string_view source)
{
    if (source.size() >= Size) {
        return false;
    }
    std::copy(source.begin(), source.end(), destination);
    destination[source.size()] = '\0';
    return true;
}

template <typename Bytes>
bool CopyBytes(Bytes& destination, const std::uint8_t* source,
               std::size_t source_size)
{
    if (source_size > sizeof(destination.bytes) ||
        (source_size != 0 && source == nullptr)) {
        return false;
    }
    destination.size = static_cast<pb_size_t>(source_size);
    if (source_size != 0) {
        std::copy(source, source + source_size, destination.bytes);
    }
    return true;
}

rfplatform_v1_JobState ToWireState(JobState state)
{
    switch (state) {
    case JobState::kAccepted:
        return rfplatform_v1_JobState_JOB_STATE_ACCEPTED;
    case JobState::kRunning:
        return rfplatform_v1_JobState_JOB_STATE_RUNNING;
    case JobState::kCompleted:
        return rfplatform_v1_JobState_JOB_STATE_COMPLETED;
    case JobState::kFailed:
        return rfplatform_v1_JobState_JOB_STATE_FAILED;
    case JobState::kCancelled:
        return rfplatform_v1_JobState_JOB_STATE_CANCELLED;
    case JobState::kResultUncertain:
        return rfplatform_v1_JobState_JOB_STATE_RESULT_UNCERTAIN;
    }
    return rfplatform_v1_JobState_JOB_STATE_UNSPECIFIED;
}

rfplatform_v1_ErrorCode ToWireError(CapabilityStatus status)
{
    switch (status) {
    case CapabilityStatus::kOk:
        return rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED;
    case CapabilityStatus::kUnsupportedOperation:
        return rfplatform_v1_ErrorCode_ERROR_CODE_UNSUPPORTED;
    case CapabilityStatus::kInvalidArgument:
        return rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
    case CapabilityStatus::kPermissionDenied:
        return rfplatform_v1_ErrorCode_ERROR_CODE_PERMISSION_DENIED;
    case CapabilityStatus::kBusy:
        return rfplatform_v1_ErrorCode_ERROR_CODE_BUSY;
    case CapabilityStatus::kCancelled:
        return rfplatform_v1_ErrorCode_ERROR_CODE_CANCELLED;
    case CapabilityStatus::kResultUncertain:
        return rfplatform_v1_ErrorCode_ERROR_CODE_RESULT_UNCERTAIN;
    case CapabilityStatus::kFailed:
        return rfplatform_v1_ErrorCode_ERROR_CODE_RF;
    }
    return rfplatform_v1_ErrorCode_ERROR_CODE_PROTOCOL;
}

rfplatform_v1_ErrorCode ToWireError(RouteStatus status)
{
    switch (status) {
    case RouteStatus::kInvalidArgument:
    case RouteStatus::kUnsupportedVersion:
        return rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
    case RouteStatus::kUnsupportedCapability:
    case RouteStatus::kUnsupportedOperation:
    case RouteStatus::kMissingRequirement:
        return rfplatform_v1_ErrorCode_ERROR_CODE_UNSUPPORTED;
    case RouteStatus::kConfirmationRequired:
        return rfplatform_v1_ErrorCode_ERROR_CODE_PERMISSION_DENIED;
    case RouteStatus::kBusy:
        return rfplatform_v1_ErrorCode_ERROR_CODE_BUSY;
    case RouteStatus::kAccepted:
        return rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED;
    }
    return rfplatform_v1_ErrorCode_ERROR_CODE_PROTOCOL;
}

const char* DetailFor(RouteStatus status)
{
    switch (status) {
    case RouteStatus::kInvalidArgument: return "invalid argument";
    case RouteStatus::kUnsupportedCapability: return "unsupported capability";
    case RouteStatus::kUnsupportedVersion: return "unsupported capability version";
    case RouteStatus::kUnsupportedOperation: return "unsupported operation";
    case RouteStatus::kMissingRequirement: return "missing capability requirement";
    case RouteStatus::kConfirmationRequired: return "target confirmation required";
    case RouteStatus::kBusy: return "job queue is full";
    case RouteStatus::kAccepted: return "accepted";
    }
    return "protocol error";
}

}  // namespace

DeviceProtocolEndpoint::DeviceProtocolEndpoint(
    CapabilityRegistry& registry,
    DeviceTransport& transport,
    SessionIdSource& session_id_source,
    const DeviceIdentity& identity,
    BulkTransferHandler* transfer_handler)
    : registry_(registry),
      transport_(transport),
      session_id_source_(session_id_source),
      transfer_handler_(transfer_handler),
      identity_(identity),
      scheduler_(*this),
      router_(registry_, scheduler_)
{
}

TransportStatus DeviceProtocolEndpoint::Start()
{
    if (started_) {
        return TransportStatus::kOk;
    }
    const auto status = transport_.Start(*this);
    started_ = status == TransportStatus::kOk;
    return status;
}

void DeviceProtocolEndpoint::Stop()
{
    if (!started_) {
        return;
    }
    transport_.Stop();
    started_ = false;
    session_id_ = 0;
}

bool DeviceProtocolEndpoint::RunNextJob()
{
    return scheduler_.RunNext();
}

void DeviceProtocolEndpoint::SendTransferAck(
    std::uint32_t request_id,
    const rfplatform_v1_TransferAck& ack)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_transfer_ack_tag;
    message_.body.transfer_ack = ack;
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::OnFrame(
    std::string_view transport_id,
    FrameView frame)
{
    if (transport_id != transport_.Id()) {
        return;
    }
    const auto decode_status = codec_.Decode(frame, message_);
    if (decode_status != CodecStatus::kOk || message_.request_id == 0) {
        RF_PROTO_LOGD("frame_rx_rejected bytes=%u codec_status=%u request_id=%u",
                      static_cast<unsigned>(frame.size),
                      static_cast<unsigned>(decode_status),
                      static_cast<unsigned>(message_.request_id));
        return;
    }
    RF_PROTO_LOGD("frame_rx transport=%.*s bytes=%u request_id=%u body=%u",
                  static_cast<int>(transport_id.size()), transport_id.data(),
                  static_cast<unsigned>(frame.size),
                  static_cast<unsigned>(message_.request_id),
                  static_cast<unsigned>(message_.which_body));
    if (message_.which_body == rfplatform_v1_Envelope_start_job_tag) {
        const auto& request = message_.body.start_job;
        RF_PROTO_LOGD(
            "job_request capability=%s operation=%s arguments=%u confirmed=%u uid_bytes=%u",
            request.capability_id, request.operation_id,
            static_cast<unsigned>(request.arguments.size),
            static_cast<unsigned>(request.user_confirmed),
            static_cast<unsigned>(request.confirmed_target_uid.size));
    }
    if (message_.which_body == rfplatform_v1_Envelope_hello_request_tag) {
        HandleHello(message_);
        return;
    }
    if (message_.protocol_major != kProtocolMajor || session_id_ == 0 ||
        message_.session_id != session_id_) {
        return;
    }

    const auto request_id = message_.request_id;
    switch (message_.which_body) {
    case rfplatform_v1_Envelope_capability_query_tag:
        HandleCapabilityQuery(request_id);
        break;
    case rfplatform_v1_Envelope_start_job_tag:
        HandleStartJob(message_.body.start_job, request_id);
        break;
    case rfplatform_v1_Envelope_cancel_job_tag:
        HandleCancelJob(message_.body.cancel_job.job_id, request_id);
        break;
    case rfplatform_v1_Envelope_query_job_tag:
        HandleQueryJob(message_.body.query_job.job_id, request_id);
        break;
    case rfplatform_v1_Envelope_transfer_begin_tag:
        if (transfer_handler_ != nullptr &&
            message_.body.transfer_begin.purpose[0] != '\0' &&
            std::strcmp(message_.body.transfer_begin.purpose, "firmware") == 0) {
            const auto accepted = transfer_handler_->Begin(
                message_.body.transfer_begin, session_id_);
            rfplatform_v1_TransferAck ack = rfplatform_v1_TransferAck_init_zero;
            ack.transfer_id = message_.body.transfer_begin.transfer_id;
            ack.receive_window = accepted ? 1 : 0;
            ack.error_code = accepted
                ? rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED
                : rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
            SendTransferAck(request_id, ack);
        } else {
            HandleUnsupportedTransfer(request_id,
                                      message_.body.transfer_begin.transfer_id);
        }
        break;
    case rfplatform_v1_Envelope_transfer_chunk_tag:
        if (transfer_handler_ != nullptr) {
            const auto accepted = transfer_handler_->Chunk(
                message_.body.transfer_chunk, session_id_);
            rfplatform_v1_TransferAck ack = rfplatform_v1_TransferAck_init_zero;
            ack.transfer_id = message_.body.transfer_chunk.transfer_id;
            ack.next_offset = transfer_handler_->NextOffset();
            ack.receive_window = 1;
            ack.error_code = accepted
                ? rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED
                : rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
            SendTransferAck(request_id, ack);
        } else {
            HandleUnsupportedTransfer(request_id,
                                      message_.body.transfer_chunk.transfer_id);
        }
        break;
    case rfplatform_v1_Envelope_transfer_finish_tag:
        if (transfer_handler_ != nullptr) {
            const auto transfer_id = message_.body.transfer_finish.transfer_id;
            const auto accepted = transfer_handler_->Finish(
                message_.body.transfer_finish, session_id_);
            rfplatform_v1_TransferAck ack = rfplatform_v1_TransferAck_init_zero;
            ack.transfer_id = transfer_id;
            ack.receive_window = 0;
            ack.error_code = accepted
                ? rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED
                : rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
            SendTransferAck(request_id, ack);
            if (accepted) {
                transfer_handler_->Reboot();
            }
        } else {
            HandleUnsupportedTransfer(request_id,
                                      message_.body.transfer_finish.transfer_id);
        }
        break;
    default:
        break;
    }
}

void DeviceProtocolEndpoint::OnJobEvent(
    const Job& job,
    const CapabilityResult* result)
{
    const auto stage = job.stage();
    RF_PROTO_LOGD(
        "job_event id=%u state=%u stage=%.*s progress=%u/%u result_bytes=%u",
        static_cast<unsigned>(job.id()),
        static_cast<unsigned>(job.state()), static_cast<int>(stage.size()),
        stage.data(), static_cast<unsigned>(job.progress_current()),
        static_cast<unsigned>(job.progress_total()),
        static_cast<unsigned>(result == nullptr ? 0 : result->payload_size));
    const auto request_id = job.state() == JobState::kAccepted
        ? active_request_id_
        : 0;
    SendJobEvent(job, result, request_id);
}

void DeviceProtocolEndpoint::HandleHello(
    const rfplatform_v1_Envelope& request)
{
    if (request.session_id != 0 ||
        request.which_body != rfplatform_v1_Envelope_hello_request_tag ||
        request.body.hello_request.min_protocol_major > kProtocolMajor ||
        request.body.hello_request.max_protocol_major < kProtocolMajor ||
        identity_.device_id_size == 0 || identity_.device_id_size > 16 ||
        identity_.boot_id_size == 0 || identity_.boot_id_size > 16) {
        return;
    }

    session_id_ = session_id_source_.NextSessionId();
    if (session_id_ == 0) {
        return;
    }
    const auto selected_minor = std::min(
        request.body.hello_request.max_protocol_minor, kProtocolMinor);
    RF_PROTO_LOGD("hello_accepted request_id=%u protocol=%u.%u",
                  static_cast<unsigned>(request.request_id), kProtocolMajor,
                  selected_minor);

    PrepareResponse(request.request_id);
    message_.which_body = rfplatform_v1_Envelope_hello_response_tag;
    auto& response = message_.body.hello_response;
    response.device_id.size = static_cast<pb_size_t>(identity_.device_id_size);
    response.boot_id.size = static_cast<pb_size_t>(identity_.boot_id_size);
    std::copy(identity_.device_id.begin(),
              identity_.device_id.begin() + identity_.device_id_size,
              response.device_id.bytes);
    std::copy(identity_.boot_id.begin(),
              identity_.boot_id.begin() + identity_.boot_id_size,
              response.boot_id.bytes);
    response.protocol_major = kProtocolMajor;
    response.protocol_minor = selected_minor;
    response.max_control_message = ProtocolCodec::kMaxEncodedSize;
    response.max_data_chunk = kMaxDataChunk;
    response.max_in_flight_jobs = kMaxInFlightJobs;
    response.transport_count = 1;
    CopyText(response.transport[0], transport_.Id());
    SendEnvelope(request.request_id);
}

void DeviceProtocolEndpoint::HandleCapabilityQuery(std::uint32_t request_id)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_capability_list_tag;
    auto& capabilities = message_.body.capability_list;
    capabilities = rfplatform_v1_CapabilityList{};

    for (std::size_t module_index = 0; module_index < registry_.size();
         ++module_index) {
        if (capabilities.capabilities_count >=
            std::size(capabilities.capabilities)) {
            break;
        }
        const auto* module = registry_.ModuleAt(module_index);
        if (module == nullptr) {
            continue;
        }
        const auto& descriptor = module->Descriptor();
        if (!registry_.RequirementsMet(descriptor)) {
            continue;
        }
        if (descriptor.operation_count >
                std::size(capabilities.capabilities[0].operations) ||
            descriptor.requirement_count >
                std::size(capabilities.capabilities[0].requirements)) {
            continue;
        }

        auto& output = capabilities.capabilities[
            capabilities.capabilities_count++];
        if (!CopyText(output.id, descriptor.id)) {
            --capabilities.capabilities_count;
            continue;
        }
        output.major_version = descriptor.major_version;
        output.minor_version = descriptor.minor_version;
        output.operations_count = static_cast<pb_size_t>(
            descriptor.operation_count);
        output.requirements_count = static_cast<pb_size_t>(
            descriptor.requirement_count);

        bool valid = true;
        for (std::size_t index = 0; index < descriptor.operation_count; ++index) {
            const auto& operation = descriptor.operations[index];
            auto& operation_output = output.operations[index];
            valid = valid && CopyText(operation_output.id, operation.id);
            operation_output.mutating = operation.mutating;
            operation_output.cancellable = operation.cancellable;
            operation_output.max_payload_size = operation.max_payload_size;
            operation_output.requires_target_confirmation =
                operation.requires_target_confirmation;
        }
        for (std::size_t index = 0; index < descriptor.requirement_count; ++index) {
            const auto& requirement = descriptor.requirements[index];
            auto& requirement_output = output.requirements[index];
            valid = valid && CopyText(requirement_output.id, requirement.id);
            requirement_output.minimum_major = requirement.minimum_major;
        }
        if (!valid) {
            --capabilities.capabilities_count;
        }
    }
    RF_PROTO_LOGD("capability_list count=%u",
                  static_cast<unsigned>(capabilities.capabilities_count));
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::HandleStartJob(
    const rfplatform_v1_StartJob& request,
    std::uint32_t request_id)
{
    auto job_id = next_job_id_++;
    if (job_id == 0) {
        job_id = next_job_id_++;
    }
    active_request_id_ = request_id;
    const StartJobRequest route_request{
        job_id,
        request.capability_id,
        static_cast<std::uint16_t>(request.capability_major),
        request.operation_id,
        request.arguments.bytes,
        request.arguments.size,
        request.user_confirmed,
        request.confirmed_target_uid.bytes,
        request.confirmed_target_uid.size,
    };
    const auto status = router_.Start(route_request);
    active_request_id_ = 0;
    RF_PROTO_LOGD("job_routed id=%u capability=%s operation=%s status=%u",
                  static_cast<unsigned>(job_id), request.capability_id,
                  request.operation_id, static_cast<unsigned>(status));
    if (status != RouteStatus::kAccepted) {
        SendRouteError(status, request_id, job_id);
    }
}

void DeviceProtocolEndpoint::HandleCancelJob(
    std::uint32_t job_id,
    std::uint32_t request_id)
{
    const auto status = scheduler_.Cancel(job_id);
    if (status != SchedulerStatus::kOk) {
        SendNotFound(request_id, job_id);
        return;
    }
    const auto* job = scheduler_.FindJob(job_id);
    if (job != nullptr) {
        SendJobEvent(*job, nullptr, request_id);
    }
}

void DeviceProtocolEndpoint::HandleQueryJob(
    std::uint32_t job_id,
    std::uint32_t request_id)
{
    const auto* job = scheduler_.FindJob(job_id);
    if (job == nullptr) {
        SendNotFound(request_id, job_id);
        return;
    }
    SendJobEvent(*job, nullptr, request_id);
}

void DeviceProtocolEndpoint::HandleUnsupportedTransfer(
    std::uint32_t request_id,
    std::uint32_t transfer_id)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_transfer_ack_tag;
    message_.body.transfer_ack.transfer_id = transfer_id;
    message_.body.transfer_ack.error_code =
        rfplatform_v1_ErrorCode_ERROR_CODE_UNSUPPORTED;
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::SendJobEvent(
    const Job& job,
    const CapabilityResult* result,
    std::uint32_t request_id)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_job_event_tag;
    auto& event = message_.body.job_event;
    event.job_id = job.id();
    event.state = ToWireState(job.state());
    CopyText(event.stage, job.stage());
    event.progress_current = job.progress_current();
    event.progress_total = job.progress_total();
    event.error_code = result == nullptr
        ? rfplatform_v1_ErrorCode_ERROR_CODE_UNSPECIFIED
        : ToWireError(result->status);
    if (job.state() == JobState::kFailed && result == nullptr) {
        event.error_code = rfplatform_v1_ErrorCode_ERROR_CODE_RF;
    }
    if (result != nullptr) {
        CopyBytes(event.result, result->payload.data(), result->payload_size);
    }
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::SendRouteError(
    RouteStatus status,
    std::uint32_t request_id,
    std::uint32_t job_id)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_job_event_tag;
    auto& event = message_.body.job_event;
    event.job_id = job_id;
    event.state = rfplatform_v1_JobState_JOB_STATE_FAILED;
    event.error_code = ToWireError(status);
    CopyText(event.detail, DetailFor(status));
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::SendNotFound(
    std::uint32_t request_id,
    std::uint32_t job_id)
{
    PrepareResponse(request_id);
    message_.which_body = rfplatform_v1_Envelope_job_event_tag;
    auto& event = message_.body.job_event;
    event.job_id = job_id;
    event.state = rfplatform_v1_JobState_JOB_STATE_FAILED;
    event.error_code = rfplatform_v1_ErrorCode_ERROR_CODE_INVALID_ARGUMENT;
    CopyText(event.detail, "job not found or not cancellable");
    SendEnvelope(request_id);
}

void DeviceProtocolEndpoint::PrepareResponse(std::uint32_t request_id)
{
    message_ = rfplatform_v1_Envelope{};
    message_.protocol_major = kProtocolMajor;
    message_.protocol_minor = kProtocolMinor;
    message_.session_id = session_id_;
    message_.request_id = request_id;
}

void DeviceProtocolEndpoint::SendEnvelope(std::uint32_t)
{
    std::size_t output_size = 0;
    if (codec_.Encode(message_, output_.data(), output_.size(), output_size) !=
        CodecStatus::kOk) {
        RF_PROTO_LOGD("frame_tx_rejected request_id=%u body=%u reason=encode",
                      static_cast<unsigned>(message_.request_id),
                      static_cast<unsigned>(message_.which_body));
        return;
    }
    const auto status = transport_.Send({output_.data(), output_size});
    RF_PROTO_LOGD("frame_tx request_id=%u body=%u bytes=%u status=%u",
                  static_cast<unsigned>(message_.request_id),
                  static_cast<unsigned>(message_.which_body),
                  static_cast<unsigned>(output_size),
                  static_cast<unsigned>(status));
}

}  // namespace rf_platform
