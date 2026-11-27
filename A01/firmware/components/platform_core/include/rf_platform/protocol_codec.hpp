#ifndef RF_PLATFORM_PROTOCOL_CODEC_HPP
#define RF_PLATFORM_PROTOCOL_CODEC_HPP

#include <array>
#include <cstddef>
#include <cstdint>

#include "device.pb.h"
#include "rf_platform/transport.hpp"

namespace rf_platform {

enum class CodecStatus : std::uint8_t {
    kOk = 0,
    kEmptyFrame,
    kFrameTooLarge,
    kMalformedFrame,
    kOutputTooSmall,
};

class ProtocolCodec final {
public:
    static constexpr std::size_t kMaxEncodedSize = rfplatform_v1_Envelope_size;

    CodecStatus Decode(FrameView frame, rfplatform_v1_Envelope& envelope) const;
    CodecStatus Encode(
        const rfplatform_v1_Envelope& envelope,
        std::uint8_t* output,
        std::size_t output_capacity,
        std::size_t& output_size) const;
};

}  // namespace rf_platform

#endif
