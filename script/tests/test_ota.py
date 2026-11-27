import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from rf_platform.client_errors import DeviceConnectionError, DeviceProtocolError
from rf_platform.core.jobs import JobState
from rf_platform.ota.firmware import FirmwareUpdater
from rf_platform.protocol import device_pb2
from rf_platform.transport.ble_gatt import BleGattTransport


class OtaClient:
    def __init__(self, *, finish_error=None, new_version="0.0.2", foreign=False):
        self.device_id = b"original-device"
        self.request_timeout = 1
        self.finish_error = finish_error
        self.new_version = new_version
        self.foreign = foreign
        self.requests = []
        self.reconnections = 0
        self.closes = 0

    async def start_job(self, capability, operation):
        assert (capability, operation) == ("org.example.device.info", "get")
        version = self.new_version if self.reconnections else "0.0.1"
        info = device_pb2.DeviceInfoResult(firmware_version=version)
        event = SimpleNamespace(state=JobState.COMPLETED, result=info.SerializeToString())
        return SimpleNamespace(wait=AsyncMock(return_value=event))

    async def _request(self, name, body, expected, **kwargs):
        self.requests.append(name)
        if name == "transfer_finish" and self.finish_error:
            raise self.finish_error
        response = device_pb2.Envelope()
        response.transfer_ack.transfer_id = body.transfer_id
        if name == "transfer_chunk":
            response.transfer_ack.next_offset = body.offset + len(body.data)
        return response

    async def close(self):
        self.closes += 1

    async def connect(self):
        self.reconnections += 1
        if self.foreign:
            self.device_id = b"different-device"


class FirmwareActivationTests(unittest.IsolatedAsyncioTestCase):
    def updater(self, **kwargs):
        client = OtaClient(**kwargs)
        updater = FirmwareUpdater(client)
        updater.ACTIVATION_TIMEOUT = 0.02
        updater.RECONNECT_INTERVAL = 0
        return client, updater

    async def upload(self, updater):
        await updater.upload(b"patch bytes", chunk_size=256, purpose="firmware_patch")

    async def test_reboot_disconnect_is_success_only_after_new_version(self):
        client, updater = self.updater(finish_error=DeviceConnectionError("reboot"))
        await self.upload(updater)
        self.assertEqual(client.reconnections, 1)
        self.assertEqual(client.requests[-1], "transfer_finish")

    async def test_acknowledged_upload_still_verifies_installation(self):
        client, updater = self.updater()
        await self.upload(updater)
        self.assertEqual(client.reconnections, 1)

    async def test_unchanged_version_is_not_success(self):
        client, updater = self.updater(new_version="0.0.1")
        with self.assertRaisesRegex(DeviceProtocolError, "not confirmed"):
            await self.upload(updater)
        self.assertGreater(client.closes, 0)

    async def test_changed_version_on_another_device_is_not_success(self):
        _, updater = self.updater(foreign=True)
        with self.assertRaisesRegex(DeviceProtocolError, "not confirmed"):
            await self.upload(updater)

    async def test_explicit_rejection_does_not_try_to_verify_success(self):
        client, updater = self.updater(finish_error=DeviceProtocolError("rejected"))
        with self.assertRaisesRegex(DeviceProtocolError, "rejected"):
            await self.upload(updater)
        self.assertEqual(client.reconnections, 0)

    async def test_ble_write_failure_uses_connection_error(self):
        transport = BleGattTransport()
        failure = RuntimeError("BLE reboot disconnect")
        transport._client = SimpleNamespace(
            is_connected=True, mtu_size=23,
            write_gatt_char=AsyncMock(side_effect=failure),
        )
        with self.assertRaises(DeviceConnectionError) as caught:
            await transport.send_frame(b"request")
        self.assertIs(caught.exception.__cause__, failure)


if __name__ == "__main__":
    unittest.main()
