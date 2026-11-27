#ifndef RF_PLATFORM_COBS_FRAME_CODEC_HPP
#define RF_PLATFORM_COBS_FRAME_CODEC_HPP

#include <array>
#include <cstddef>
#include <cstdint>

#include "rf_platform/protocol_codec.hpp"

namespace rf_platform {

enum class FrameCodecStatus : std::uint8_t {
    kOk = 0,
    kInvalidArgument,
    kFrameTooLarge,
    kMalformedFrame,
    kChecksumMismatch,
    kOutputTooSmall,
};

class CobsFrameCodec final {
public:
    static constexpr std::size_t kRawOverhead = 8;
    static constexpr std::size_t kMaxEncodedSize =
        ProtocolCodec::kMaxEncodedSize +
        (ProtocolCodec::kMaxEncodedSize / 254) + 16;
    static constexpr std::size_t kMaxRawSize =
        ProtocolCodec::kMaxEncodedSize + kRawOverhead;

    FrameCodecStatus Encode(
        FrameView payload,
        std::uint8_t* output,
        std::size_t output_capacity,
        std::size_t& output_size);
    FrameCodecStatus Decode(
        FrameView encoded,
        std::uint8_t* output,
        std::size_t output_capacity,
        std::size_t& output_size) const;

private:
    static std::uint32_t Crc32(const std::uint8_t* bytes, std::size_t size);
    std::array<std::uint8_t, kMaxRawSize> scratch_{};
};

}  // namespace rf_platform

#endif
