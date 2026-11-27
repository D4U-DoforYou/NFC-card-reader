from pathlib import Path
import unittest

from rf_platform.transport.framing import (
    FrameError,
    FrameStreamDecoder,
    decode_frame,
    encode_frame,
)


class UsbFramingTests(unittest.TestCase):
    def setUp(self):
        vector_dir = (
            Path(__file__).resolve().parents[1]
            / "protocol"
            / "test_vectors"
        )
        self.protobuf = bytes.fromhex(
            (vector_dir / "hello_request.hex").read_text().strip()
        )
        self.encoded = bytes.fromhex(
            (vector_dir / "usb_hello.hex").read_text().strip()
        )

    def test_matches_shared_cobs_crc_vector(self):
        self.assertEqual(encode_frame(self.protobuf), self.encoded)
        self.assertEqual(decode_frame(self.encoded[:-1]), self.protobuf)

    def test_stream_decoder_handles_fragmentation_and_multiple_frames(self):
        decoder = FrameStreamDecoder()
        first = decoder.feed(self.encoded[:7])
        second = decoder.feed(self.encoded[7:] + self.encoded)

        self.assertEqual(first, [])
        self.assertEqual(second, [self.protobuf, self.protobuf])

    def test_bad_checksum_is_rejected_and_next_frame_recovers(self):
        corrupted = bytearray(self.encoded)
        corrupted[-3] ^= 0x01
        with self.assertRaises(FrameError):
            decode_frame(bytes(corrupted[:-1]))

        decoder = FrameStreamDecoder()
        self.assertEqual(
            decoder.feed(bytes(corrupted) + self.encoded), [self.protobuf]
        )


if __name__ == "__main__":
    unittest.main()
