from pathlib import Path
import unittest

from rf_platform.protocol import device_pb2


class SharedProtocolVectorTests(unittest.TestCase):
    def test_hello_frame_vector_decodes(self):
        vector_path = (
            Path(__file__).resolve().parents[1]
            / "protocol"
            / "test_vectors"
            / "hello_request.hex"
        )
        frame = bytes.fromhex(vector_path.read_text().strip())
        envelope = device_pb2.Envelope.FromString(frame)

        self.assertEqual(envelope.protocol_major, 1)
        self.assertEqual(envelope.request_id, 1)
        self.assertEqual(envelope.WhichOneof("body"), "hello_request")
        self.assertEqual(envelope.hello_request.min_protocol_major, 1)
        self.assertEqual(envelope.hello_request.max_protocol_major, 1)


if __name__ == "__main__":
    unittest.main()
