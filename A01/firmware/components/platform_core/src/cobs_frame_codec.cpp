#include "rf_platform/cobs_frame_codec.hpp"

#include <cstring>

namespace rf_platform {
namespace {

constexpr std::uint32_t kCrcPolynomial = 0xEDB88320U;

void Store32Le(std::uint8_t* output, std::uint32_t value)
{
    output[0] = static_cast<std::uint8_t>(value);
    output[1] = static_cast<std::uint8_t>(value >> 8);
    output[2] = static_cast<std::uint8_t>(value >> 16);
    output[3] = static_cast<std::uint8_t>(value >> 24);
}

std::uint32_t Load32Le(const std::uint8_t* bytes)
{
    return static_cast<std::uint32_t>(bytes[0]) |
        (static_cast<std::uint32_t>(bytes[1]) << 8) |
        (static_cast<std::uint32_t>(bytes[2]) << 16) |
        (static_cast<std::uint32_t>(bytes[3]) << 24);
}

}  // namespace

FrameCodecStatus CobsFrameCodec::Encode(
    FrameView payload,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t& output_size)
{
    output_size = 0;
    if (payload.data == nullptr || output == nullptr || payload.size == 0) {
        return FrameCodecStatus::kInvalidArgument;
    }
    if (payload.size > ProtocolCodec::kMaxEncodedSize) {
        return FrameCodecStatus::kFrameTooLarge;
    }

    const auto raw_size = payload.size + kRawOverhead;
    if (output_capacity < raw_size + raw_size / 254 + 2) {
        return FrameCodecStatus::kOutputTooSmall;
    }

    std::size_t raw_index = 0;
    Store32Le(scratch_.data(), static_cast<std::uint32_t>(payload.size));
    raw_index += 4;
    std::memmove(scratch_.data() + raw_index, payload.data, payload.size);
    raw_index += payload.size;
    Store32Le(scratch_.data() + raw_index, Crc32(payload.data, payload.size));
    raw_index += 4;

    std::size_t read_index = 0;
    std::size_t write_index = 1;
    std::size_t code_index = 0;
    std::uint8_t code = 1;
    while (read_index < raw_index) {
        if (scratch_[read_index] == 0) {
            output[code_index] = code;
            code = 1;
            code_index = write_index++;
            ++read_index;
        } else {
            output[write_index++] = scratch_[read_index++];
            ++code;
            if (code == 0xFF) {
                output[code_index] = code;
                code = 1;
                code_index = write_index++;
            }
        }
    }
    output[code_index] = code;
    output[write_index++] = 0;
    output_size = write_index;
    return FrameCodecStatus::kOk;
}

FrameCodecStatus CobsFrameCodec::Decode(
    FrameView encoded,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t& output_size) const
{
    output_size = 0;
    if (encoded.data == nullptr || output == nullptr || encoded.size == 0) {
        return FrameCodecStatus::kInvalidArgument;
    }
    if (encoded.size > kMaxEncodedSize ||
        output_capacity < kRawOverhead + ProtocolCodec::kMaxEncodedSize) {
        return FrameCodecStatus::kOutputTooSmall;
    }

    std::size_t input_index = 0;
    std::size_t decoded_size = 0;
    while (input_index < encoded.size) {
        const auto code = encoded.data[input_index++];
        if (code == 0) {
            return FrameCodecStatus::kMalformedFrame;
        }
        const auto count = static_cast<std::size_t>(code - 1);
        if (input_index + count > encoded.size ||
            decoded_size + count > output_capacity) {
            return FrameCodecStatus::kMalformedFrame;
        }
        for (std::size_t index = 0; index < count; ++index) {
            output[decoded_size++] = encoded.data[input_index++];
        }
        if (code != 0xFF && input_index < encoded.size) {
            if (decoded_size == output_capacity) {
                return FrameCodecStatus::kOutputTooSmall;
            }
            output[decoded_size++] = 0;
        }
    }
    if (decoded_size < kRawOverhead) {
        return FrameCodecStatus::kMalformedFrame;
    }

    const auto payload_size = Load32Le(output);
    if (payload_size > ProtocolCodec::kMaxEncodedSize ||
        decoded_size != payload_size + kRawOverhead) {
        return FrameCodecStatus::kMalformedFrame;
    }
    const auto expected_crc = Load32Le(output + 4 + payload_size);
    const auto actual_crc = Crc32(output + 4, payload_size);
    if (expected_crc != actual_crc) {
        return FrameCodecStatus::kChecksumMismatch;
    }
    std::memmove(output, output + 4, payload_size);
    output_size = payload_size;
    return FrameCodecStatus::kOk;
}

std::uint32_t CobsFrameCodec::Crc32(
    const std::uint8_t* bytes,
    std::size_t size)
{
    std::uint32_t crc = 0xFFFFFFFFU;
    for (std::size_t index = 0; index < size; ++index) {
        crc ^= bytes[index];
        for (std::uint8_t bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ (kCrcPolynomial & (0U - (crc & 1U)));
        }
    }
    return ~crc;
}

}  // namespace rf_platform
