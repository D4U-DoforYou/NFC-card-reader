#ifndef RF_PLATFORM_PROTOCOL_ENDPOINT_HPP
#define RF_PLATFORM_PROTOCOL_ENDPOINT_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "rf_platform/capability_registry.hpp"
#include "rf_platform/job_router.hpp"
#include "rf_platform/job_scheduler.hpp"
#include "rf_platform/protocol_codec.hpp"
#include "rf_platform/transport.hpp"

namespace rf_platform {

struct DeviceIdentity {
    std::array<std::uint8_t, 16> device_id{};
    std::size_t device_id_size = 0;
    std::array<std::uint8_t, 6> bluetooth_mac{};
    std::size_t bluetooth_mac_size = 0;
    std::array<std::uint8_t, 16> boot_id{};
    std::size_t boot_id_size = 0;
};

class SessionIdSource {
public:
    virtual ~SessionIdSource() = default;
    virtual std::uint64_t NextSessionId() = 0;
};

class BulkTransferHandler {
public:
    virtual ~BulkTransferHandler() = default;
    virtual bool Begin(const rfplatform_v1_TransferBegin& request,
                       std::uint64_t session_id) = 0;
    virtual bool Chunk(const rfplatform_v1_TransferChunk& request,
                       std::uint64_t session_id) = 0;
    virtual std::uint64_t NextOffset() const = 0;
    virtual bool Finish(const rfplatform_v1_TransferFinish& request,
                        std::uint64_t session_id) = 0;
    virtual void Reboot() = 0;
};

class DeviceProtocolEndpoint final : public FrameReceiver, public JobEventSink {
public:
    static constexpr std::uint32_t kProtocolMajor = 1;
    static constexpr std::uint32_t kProtocolMinor = 0;
    static constexpr std::uint32_t kMaxDataChunk = 512;
    static constexpr std::uint32_t kMaxInFlightJobs = 1;

    DeviceProtocolEndpoint(
        CapabilityRegistry& registry,
        DeviceTransport& transport,
        SessionIdSource& session_id_source,
        const DeviceIdentity& identity,
        BulkTransferHandler* transfer_handler = nullptr);

    TransportStatus Start();
    void Stop();
    bool RunNextJob();
    std::uint64_t session_id() const { return session_id_; }
    void SendTransferAck(std::uint32_t request_id,
                        const rfplatform_v1_TransferAck& ack);

    void OnFrame(std::string_view transport_id, FrameView frame) override;
    void OnJobEvent(const Job& job, const CapabilityResult* result) override;

private:
    void HandleHello(const rfplatform_v1_Envelope& request);
    void HandleCapabilityQuery(std::uint32_t request_id);
    void HandleStartJob(const rfplatform_v1_StartJob& request,
                        std::uint32_t request_id);
    void HandleCancelJob(std::uint32_t job_id, std::uint32_t request_id);
    void HandleQueryJob(std::uint32_t job_id, std::uint32_t request_id);
    void HandleUnsupportedTransfer(std::uint32_t request_id,
                                   std::uint32_t transfer_id);
    void SendJobEvent(const Job& job, const CapabilityResult* result,
                      std::uint32_t request_id);
    void SendRouteError(RouteStatus status, std::uint32_t request_id,
                        std::uint32_t job_id);
    void SendNotFound(std::uint32_t request_id, std::uint32_t job_id);
    void SendEnvelope(std::uint32_t request_id);
    void PrepareResponse(std::uint32_t request_id);

    CapabilityRegistry& registry_;
    DeviceTransport& transport_;
    SessionIdSource& session_id_source_;
    BulkTransferHandler* transfer_handler_ = nullptr;
    DeviceIdentity identity_;
    JobScheduler scheduler_;
    JobRouter router_;
    ProtocolCodec codec_;
    rfplatform_v1_Envelope message_{};
    std::array<std::uint8_t, ProtocolCodec::kMaxEncodedSize> output_{};
    std::uint64_t session_id_ = 0;
    std::uint32_t active_request_id_ = 0;
    std::uint32_t next_job_id_ = 1;
    bool started_ = false;
};

}  // namespace rf_platform

#endif
