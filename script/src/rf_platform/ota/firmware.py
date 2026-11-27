"""Firmware upload flow using the device transfer protocol."""
from __future__ import annotations

import asyncio
import hashlib
import secrets
import zlib
from typing import TYPE_CHECKING, Any, Callable

from ..client_errors import DeviceProtocolError
from ..core.jobs import JobState
from ..protocol import device_pb2

if TYPE_CHECKING:
    from ..client import DeviceClient


class FirmwareUpdater:
    """Uploads a firmware image and asks the device to activate it."""

    DELTA_PATCH_PURPOSE = "firmware_patch"
    DELTA_PATCH_MAX_CHUNK_SIZE = 256
    DELTA_PATCH_MAX_SIZE = 40 * 1024
    ACTIVATION_TIMEOUT = 45.0
    RECONNECT_INTERVAL = 1.0

    def __init__(self, client: DeviceClient) -> None:
        self._client = client

    async def upload(
        self,
        image: bytes,
        *,
        chunk_size: int = 512,
        purpose: str = "firmware",
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        if not image or not 1 <= chunk_size <= 512:
            raise ValueError("invalid firmware image or chunk size")
        if purpose not in ("firmware", self.DELTA_PATCH_PURPOSE):
            raise ValueError(f"unsupported firmware transfer purpose: {purpose}")
        if purpose == self.DELTA_PATCH_PURPOSE:
            if chunk_size > self.DELTA_PATCH_MAX_CHUNK_SIZE:
                raise ValueError("CH572D delta OTA chunks cannot exceed 256 bytes")
            if len(image) > self.DELTA_PATCH_MAX_SIZE:
                raise ValueError("CH572D delta OTA patches cannot exceed 40 KB")

        previous_version = None
        device_id = bytes(self._client.device_id)
        if purpose == self.DELTA_PATCH_PURPOSE:
            previous_version = await self._firmware_version()

        transfer_id = secrets.randbits(32) or 1
        await self._transfer_request(
            "transfer_begin",
            transfer_id,
            total_size=len(image),
            sha256=hashlib.sha256(image).digest(),
            purpose=purpose,
        )

        offset = 0
        while offset < len(image):
            chunk = image[offset:offset + chunk_size]
            ack = await self._transfer_request(
                "transfer_chunk",
                transfer_id,
                offset=offset,
                sequence=offset // chunk_size,
                crc32=zlib.crc32(chunk) & 0xFFFFFFFF,
                data=chunk,
            )
            expected_offset = offset + len(chunk)
            if ack.next_offset != expected_offset:
                raise DeviceProtocolError(
                    "OTA offset mismatch: "
                    f"expected {expected_offset}, got {ack.next_offset}"
                )
            offset = expected_offset
            if progress is not None:
                progress(offset, len(image))

        finish_error = None
        try:
            await self._transfer_request("transfer_finish", transfer_id)
        except (ConnectionError, OSError, TimeoutError) as error:
            if previous_version is None:
                raise
            finish_error = error
        if previous_version is not None:
            await self._verify_activation(previous_version, device_id, finish_error)

    async def _firmware_version(self) -> str:
        job = await self._client.start_job("org.example.device.info", "get")
        event = await job.wait()
        if event.state != JobState.COMPLETED:
            raise DeviceProtocolError("cannot read firmware version for OTA verification")
        info = device_pb2.DeviceInfoResult.FromString(event.result)
        if not info.firmware_version:
            raise DeviceProtocolError("device returned an empty firmware version")
        return info.firmware_version

    async def _verify_activation(
        self, previous_version: str, device_id: bytes,
        finish_error: Exception | None,
    ) -> None:
        await self._client.close()
        try:
            await asyncio.wait_for(
                self._wait_for_activation(previous_version, device_id),
                timeout=self.ACTIVATION_TIMEOUT,
            )
        except TimeoutError:
            await self._client.close()
            raise DeviceProtocolError(
                "OTA installation was not confirmed; "
                f"previous firmware version was {previous_version}"
            ) from finish_error

    async def _wait_for_activation(
        self, previous_version: str, device_id: bytes,
    ) -> None:
        while True:
            try:
                await self._client.connect()
                if bytes(self._client.device_id) != device_id:
                    raise DeviceProtocolError("OTA reconnected to a different device")
                if await self._firmware_version() != previous_version:
                    return
            except Exception:
                pass
            await self._client.close()
            await asyncio.sleep(self.RECONNECT_INTERVAL)

    async def _transfer_request(
        self, body_name: str, transfer_id: int, **fields: Any
    ) -> device_pb2.TransferAck:
        envelope = device_pb2.Envelope()
        body = getattr(envelope, body_name)
        body.transfer_id = transfer_id
        for name, value in fields.items():
            setattr(body, name, value)

        timeout = (
            max(self._client.request_timeout, 60.0)
            if body_name == "transfer_chunk"
            else None
        )
        response = await self._client._request(
            body_name, body, "transfer_ack", timeout=timeout
        )
        ack = response.transfer_ack
        if ack.error_code != device_pb2.ERROR_CODE_UNSPECIFIED:
            raise DeviceProtocolError(
                f"firmware transfer rejected with error {ack.error_code}"
            )
        return ack
