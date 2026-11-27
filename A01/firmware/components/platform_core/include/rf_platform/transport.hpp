#ifndef RF_PLATFORM_TRANSPORT_HPP
#define RF_PLATFORM_TRANSPORT_HPP

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace rf_platform {

struct FrameView {
    const std::uint8_t* data;
    std::size_t size;
};

enum class TransportStatus : std::uint8_t {
    kOk = 0,
    kNotConnected,
    kNoCapacity,
    kIoError,
};

class FrameReceiver {
public:
    virtual ~FrameReceiver() = default;
    virtual void OnFrame(std::string_view transport_id, FrameView frame) = 0;
};

class DeviceTransport {
public:
    virtual ~DeviceTransport() = default;

    virtual std::string_view Id() const = 0;
    virtual TransportStatus Start(FrameReceiver& receiver) = 0;
    virtual TransportStatus Send(FrameView frame) = 0;
    virtual void Stop() = 0;
};

}  // namespace rf_platform

#endif
