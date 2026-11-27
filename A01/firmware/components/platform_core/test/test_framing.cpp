#include "rf_platform/cobs_frame_codec.hpp"

#include <array>
#include <cassert>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace {

std::vector<std::uint8_t> ReadHex(const char* path)
{
    std::ifstream input(path);
    std::string hex;
    input >> hex;
    std::vector<std::uint8_t> bytes;
    for (std::size_t index = 0; index + 1 < hex.size(); index += 2) {
        bytes.push_back(static_cast<std::uint8_t>(
            std::stoul(hex.substr(index, 2), nullptr, 16)));
    }
    return bytes;
}

}  // namespace

int main()
{
    constexpr std::array<std::uint8_t, 9> payload{
        0x08, 0x01, 0x25, 0x00, 0x00, 0x00, 0x52, 0x04, 0x00,
    };
    rf_platform::CobsFrameCodec codec;
    std::array<std::uint8_t,
        rf_platform::CobsFrameCodec::kMaxEncodedSize> encoded{};
    std::array<std::uint8_t,
        rf_platform::CobsFrameCodec::kMaxRawSize> decoded{};
    std::size_t encoded_size = 0;
    std::size_t decoded_size = 0;

    assert(codec.Encode({payload.data(), payload.size()}, encoded.data(),
                        encoded.size(), encoded_size) ==
           rf_platform::FrameCodecStatus::kOk);
    assert(encoded[encoded_size - 1] == 0);
    assert(codec.Decode({encoded.data(), encoded_size - 1}, decoded.data(),
                        decoded.size(), decoded_size) ==
           rf_platform::FrameCodecStatus::kOk);
    assert(decoded_size == payload.size());
    for (std::size_t index = 0; index < payload.size(); ++index) {
        assert(decoded[index] == payload[index]);
    }

    const auto protobuf = ReadHex(RF_HELLO_VECTOR_PATH);
    const auto expected = ReadHex(RF_USB_VECTOR_PATH);
    assert(codec.Encode({protobuf.data(), protobuf.size()}, encoded.data(),
                        encoded.size(), encoded_size) ==
           rf_platform::FrameCodecStatus::kOk);
    assert(encoded_size == expected.size());
    for (std::size_t index = 0; index < encoded_size; ++index) {
        assert(encoded[index] == expected[index]);
    }

    encoded[encoded_size / 2] ^= 0x01;
    assert(codec.Decode({encoded.data(), encoded_size - 1}, decoded.data(),
                        decoded.size(), decoded_size) !=
           rf_platform::FrameCodecStatus::kOk);
    return 0;
}
