#include "rf_platform/protocol_codec.hpp"

#include "pb_decode.h"
#include "pb_encode.h"

namespace rf_platform {

CodecStatus ProtocolCodec::Decode(
    FrameView frame,
    rfplatform_v1_Envelope& envelope) const
{
    if (frame.data == nullptr || frame.size == 0) {
        return CodecStatus::kEmptyFrame;
    }
    if (frame.size > kMaxEncodedSize) {
        return CodecStatus::kFrameTooLarge;
    }

    envelope = rfplatform_v1_Envelope{};
    auto stream = pb_istream_from_buffer(frame.data, frame.size);
    if (!pb_decode(&stream, rfplatform_v1_Envelope_fields, &envelope) ||
        stream.bytes_left != 0) {
        return CodecStatus::kMalformedFrame;
    }
    return CodecStatus::kOk;
}

CodecStatus ProtocolCodec::Encode(
    const rfplatform_v1_Envelope& envelope,
    std::uint8_t* output,
    std::size_t output_capacity,
    std::size_t& output_size) const
{
    output_size = 0;
    if (output == nullptr || output_capacity == 0) {
        return CodecStatus::kOutputTooSmall;
    }
    if (output_capacity > kMaxEncodedSize) {
        output_capacity = kMaxEncodedSize;
    }

    auto stream = pb_ostream_from_buffer(output, output_capacity);
    if (!pb_encode(&stream, rfplatform_v1_Envelope_fields, &envelope)) {
        return CodecStatus::kOutputTooSmall;
    }
    output_size = stream.bytes_written;
    return CodecStatus::kOk;
}

}  // namespace rf_platform
