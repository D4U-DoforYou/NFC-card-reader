import asyncio
import hashlib
import unittest
import zlib

from rf_platform.client import DeviceClient, DeviceProtocolError
from rf_platform.core.jobs import JobState
from rf_platform.protocol import device_pb2


class FakeTransport:
    def __init__(self, *, raw_capability_minor=1):
        self.frames = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.raw_capability_minor = raw_capability_minor

    @property
    def name(self):
        return "fake"

    async def connect(self):
        return None

    async def send_frame(self, frame):
        request = device_pb2.Envelope.FromString(frame)
        self.sent.append(request)
        body = request.WhichOneof("body")
        response = device_pb2.Envelope(
            protocol_major=1,
            protocol_minor=0,
            session_id=73,
            request_id=request.request_id,
        )
        if body == "hello_request":
            response.hello_response.device_id = b"device-1"
            response.hello_response.boot_id = b"boot-1"
            response.hello_response.protocol_major = 1
            response.hello_response.max_control_message = 512
            response.hello_response.max_data_chunk = 128
            response.hello_response.max_in_flight_jobs = 1
            response.hello_response.transport.append("fake")
        elif body == "capability_query":
            capability = response.capability_list.capabilities.add()
            capability.id = "org.example.nfc.ndef"
            capability.major_version = 1
            operation = capability.operations.add()
            operation.id = "write"
            operation.mutating = True
            operation.max_payload_size = 128
            operation.requires_target_confirmation = True
            raw_capability = response.capability_list.capabilities.add()
            raw_capability.id = "org.example.rf.raw"
            raw_capability.major_version = 1
            raw_capability.minor_version = self.raw_capability_minor
        elif body == "start_job":
            result = b"verified"
            start = request.start_job
            if start.operation_id == "set_tx_amplitude":
                amplitude = device_pb2.TxAmplitudeRequest.FromString(
                    start.arguments
                )
                result = device_pb2.TxAmplitudeResult(
                    level=amplitude.level
                ).SerializeToString()
            elif start.operation_id == "get_tx_amplitude":
                result = device_pb2.TxAmplitudeResult(level=1).SerializeToString()
            elif start.operation_id == "transceive":
                result = device_pb2.RawRfTransceiveResult(
                    rx=b"\x04"
                ).SerializeToString()
            response.job_event.job_id = 9
            response.job_event.state = device_pb2.JOB_STATE_ACCEPTED
            await self.frames.put(response.SerializeToString())
            await self._put_job_event(request.request_id, 9,
                                      device_pb2.JOB_STATE_RUNNING,
                                      stage="write", current=1, total=2)
            await self._put_job_event(request.request_id, 9,
                                      device_pb2.JOB_STATE_COMPLETED,
                                      result=result)
            return
        await self.frames.put(response.SerializeToString())

    async def _put_job_event(
        self, request_id, job_id, state, *, stage="", current=0, total=0,
        result=b"",
    ):
        event = device_pb2.Envelope(
            protocol_major=1,
            protocol_minor=0,
            session_id=73,
            request_id=request_id,
        )
        event.job_event.job_id = job_id
        event.job_event.state = state
        event.job_event.stage = stage
        event.job_event.progress_current = current
        event.job_event.progress_total = total
        event.job_event.result = result
        await self.frames.put(event.SerializeToString())

    async def receive_frames(self):
        while True:
            frame = await self.frames.get()
            if frame is None:
                return
            yield frame

    async def close(self):
        self.closed = True
        await self.frames.put(None)


class DropFirstHelloTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.dropped_hello = False

    async def send_frame(self, frame):
        request = device_pb2.Envelope.FromString(frame)
        if request.WhichOneof("body") == "hello_request" and not self.dropped_hello:
            self.sent.append(request)
            self.dropped_hello = True
            return
        await super().send_frame(frame)


class TransferTransport(FakeTransport):
    async def send_frame(self, frame):
        request = device_pb2.Envelope.FromString(frame)
        body = request.WhichOneof("body")
        if body not in ("transfer_begin", "transfer_chunk", "transfer_finish"):
            await super().send_frame(frame)
            return
        self.sent.append(request)
        ack = device_pb2.Envelope(
            protocol_major=1,
            session_id=73,
            request_id=request.request_id,
        ).transfer_ack
        if body == "transfer_begin":
            ack.transfer_id = request.transfer_begin.transfer_id
            ack.receive_window = 1
        elif body == "transfer_chunk":
            chunk = request.transfer_chunk
            ack.transfer_id = chunk.transfer_id
            ack.next_offset = chunk.offset + len(chunk.data)
            ack.receive_window = 1
        else:
            ack.transfer_id = request.transfer_finish.transfer_id
        response = device_pb2.Envelope(
            protocol_major=1,
            session_id=73,
            request_id=request.request_id,
        )
        response.transfer_ack.CopyFrom(ack)
        await self.frames.put(response.SerializeToString())


class FailTransferTransport(TransferTransport):
    async def send_frame(self, frame):
        request = device_pb2.Envelope.FromString(frame)
        if request.WhichOneof("body") == "transfer_begin":
            raise OSError("simulated BLE write failure")
        await super().send_frame(frame)


class DeviceClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_firmware_upload_uses_supported_chunks_and_reports_progress(self):
        transport = TransferTransport()
        client = DeviceClient(transport)
        await client.connect()
        image = bytes(range(256)) * 5
        progress = []

        await client.upload_firmware(
            image, progress=lambda sent, total: progress.append((sent, total))
        )

        chunks = [
            request.transfer_chunk
            for request in transport.sent
            if request.WhichOneof("body") == "transfer_chunk"
        ]
        self.assertEqual([len(chunk.data) for chunk in chunks], [512, 512, 256])
        self.assertEqual([chunk.offset for chunk in chunks], [0, 512, 1024])
        self.assertTrue(all(
            chunk.crc32 == zlib.crc32(chunk.data) & 0xFFFFFFFF
            for chunk in chunks
        ))
        begin = next(
            request.transfer_begin for request in transport.sent
            if request.WhichOneof("body") == "transfer_begin"
        )
        self.assertEqual(begin.sha256, hashlib.sha256(image).digest())
        self.assertEqual(
            progress,
            [(512, len(image)), (1024, len(image)), (1280, len(image))],
        )
        await client.close()

    async def test_transfer_send_failure_cleans_pending_future(self):
        transport = FailTransferTransport()
        client = DeviceClient(transport)
        await client.connect()

        with self.assertRaisesRegex(OSError, "simulated BLE write failure"):
            await client.upload_firmware(b"firmware")

        self.assertEqual(client._pending, {})
        await client.close()

    async def test_handshake_capabilities_and_job_lifecycle(self):
        transport = FakeTransport()
        client = DeviceClient(transport)
        await client.connect()

        self.assertEqual(client.device_id, b"device-1")
        self.assertEqual(client.session_id, 73)
        self.assertEqual(client.capabilities[0].id, "org.example.nfc.ndef")
        self.assertTrue(
            client.capabilities[0].operations[0].requires_target_confirmation
        )

        job = await client.start_job(
            "org.example.nfc.ndef",
            "write",
            b"ndef-bytes",
            confirmed_target_uid=bytes.fromhex("11223344"),
        )
        terminal = await job.wait(timeout=1)

        self.assertEqual(job.accepted.state, JobState.ACCEPTED)
        self.assertEqual(terminal.state, JobState.COMPLETED)
        self.assertEqual(terminal.result, b"verified")
        start_request = next(
            message.start_job
            for message in transport.sent
            if message.WhichOneof("body") == "start_job"
        )
        self.assertTrue(start_request.user_confirmed)
        self.assertEqual(start_request.confirmed_target_uid, bytes.fromhex("11223344"))

        await client.close()
        self.assertTrue(transport.closed)

    async def test_handshake_retries_a_lost_hello(self):
        transport = DropFirstHelloTransport()
        client = DeviceClient(transport, request_timeout=1.1)
        await client.connect()

        hello_requests = [
            request for request in transport.sent
            if request.WhichOneof("body") == "hello_request"
        ]
        self.assertEqual(len(hello_requests), 2)
        self.assertEqual(
            hello_requests[0].hello_request.host_nonce,
            hello_requests[1].hello_request.host_nonce,
        )
        await client.close()

    async def test_tx_amplitude_helpers_validate_and_round_trip_level(self):
        transport = FakeTransport()
        client = DeviceClient(transport)
        await client.connect()

        self.assertEqual(await client.get_tx_amplitude(), 1)
        self.assertEqual(await client.set_tx_amplitude(3), 3)
        with self.assertRaises(ValueError):
            await client.set_tx_amplitude(4)

        request = next(
            message.start_job
            for message in transport.sent
            if message.WhichOneof("body") == "start_job"
            and message.start_job.operation_id == "set_tx_amplitude"
        )
        self.assertEqual(
            device_pb2.TxAmplitudeRequest.FromString(request.arguments).level,
            3,
        )
        await client.close()

    async def test_raw_transceive_selects_explicit_rx_and_tx_modes(self):
        from rf_platform import RfRxMode, RfTxMode

        self.assertEqual([mode.value for mode in RfRxMode], list(range(19)))
        self.assertEqual([mode.value for mode in RfTxMode], list(range(19)))

        transport = FakeTransport()
        client = DeviceClient(transport)
        await client.connect()

        await client.raw_transceive(b"\x26")
        await client.raw_transceive(
            b"\x00", rx_mode=RfRxMode.ISO18000_3_EPC_V2_2_424
        )
        await client.raw_transceive(
            b"\x02",
            rx_mode=RfRxMode.ISO15693_52_SSC,
            tx_mode=RfTxMode.ISO15693_1_OF_4_26_ID_10,
        )
        with self.assertRaises(ValueError):
            await client.raw_transceive(b"\x00", rx_mode=19)

        requests = [
            device_pb2.RawRfTransceiveRequest.FromString(message.start_job.arguments)
            for message in transport.sent
            if message.WhichOneof("body") == "start_job"
            and message.start_job.operation_id == "transceive"
        ]
        self.assertEqual(requests[0].rx_mode, device_pb2.RF_RX_MODE_ISO14443A_106)
        self.assertFalse(requests[0].HasField("tx_mode"))
        self.assertEqual(
            requests[1].rx_mode,
            device_pb2.RF_RX_MODE_ISO18000_3_EPC_V2_2_424,
        )
        self.assertEqual(
            requests[2].rx_mode, device_pb2.RF_RX_MODE_ISO15693_52_SSC
        )
        self.assertTrue(requests[2].HasField("tx_mode"))
        self.assertEqual(
            requests[2].tx_mode,
            device_pb2.RF_TX_MODE_ISO15693_1_OF_4_26_ID_10,
        )
        await client.close()

    async def test_raw_transceive_rejects_modes_on_old_firmware(self):
        from rf_platform import RfRxMode

        transport = FakeTransport(raw_capability_minor=0)
        client = DeviceClient(transport)
        await client.connect()

        with self.assertRaises(DeviceProtocolError):
            await client.raw_transceive(
                b"\x00", rx_mode=RfRxMode.FELICA_212
            )
        self.assertFalse(any(
            message.WhichOneof("body") == "start_job"
            for message in transport.sent
        ))
        await client.close()


if __name__ == "__main__":
    unittest.main()
