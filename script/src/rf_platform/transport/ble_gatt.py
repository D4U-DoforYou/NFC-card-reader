"""BLE GATT byte-stream transport using the platform's shared frame format."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from ..client_errors import DeviceConnectionError
from .base import ByteTransport
from .framing import FrameStreamDecoder, encode_frame


SERVICE_UUID = "0000ff10-0000-1000-8000-00805f9b34fb"
RX_CHARACTERISTIC_UUID = "0000ff11-0000-1000-8000-00805f9b34fb"
TX_CHARACTERISTIC_UUID = "0000ff12-0000-1000-8000-00805f9b34fb"
DEFAULT_DEVICE_NAME = "rf-device-platform"
DEVICE_NAME_PREFIXES = ("D4U-NFCA01-", "D4U-NFCB01-")


def _is_rf_platform_device(device, advertisement) -> bool:
    names = (advertisement.local_name, device.name)
    for name in names:
        if name == DEFAULT_DEVICE_NAME:
            return True
        if name and name.startswith(DEVICE_NAME_PREFIXES):
            return True
    return not any(names) and SERVICE_UUID in advertisement.service_uuids


class BleGattTransport(ByteTransport):
    MAX_PENDING_NOTIFICATIONS = 64

    def __init__(
        self,
        device: str | None = None,
        *,
        scan_timeout: float = 5.0,
        max_frame_size: int = 10_541,
        write_timeout: float = 10.0,
    ) -> None:
        self.device = device
        self.scan_timeout = scan_timeout
        self.max_frame_size = max_frame_size
        self.write_timeout = write_timeout
        self._client = None
        self._rx_characteristic = None
        self._tx_characteristic = None
        self._notifications: asyncio.Queue[bytes | Exception | None] = (
            asyncio.Queue(maxsize=self.MAX_PENDING_NOTIFICATIONS)
        )
        self._notification_overflowed = False
        self._write_lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "ble_gatt"

    async def connect(self) -> None:
        self._drain_notifications()
        self._notification_overflowed = False
        try:
            from bleak import BleakClient, BleakScanner
        except ImportError as exc:
            raise RuntimeError(
                "BLE support requires the 'ble' extra: uv sync --extra ble"
            ) from exc

        target = self.device
        if target is None:
            devices = await BleakScanner.discover(
                timeout=self.scan_timeout, return_adv=True
            )
            match = next(
                (item for item, advertisement in devices.values()
                 if _is_rf_platform_device(item, advertisement)),
                None,
            )
            if match is None:
                names = sorted({
                    name
                    for device, advertisement in devices.values()
                    for name in (advertisement.local_name, device.name)
                    if name
                })
                scanned = ", ".join(names[:8]) or "none"
                raise ConnectionError(
                    "BLE RF device was not found; expected D4U-NFCA01-* or "
                    f"D4U-NFCB01-*. Scanned device names: {scanned}"
                )
            target = match

        self._client = BleakClient(
            target, disconnected_callback=self._on_disconnect
        )
        await self._client.connect()
        services = self._client.services
        self._rx_characteristic = services.get_characteristic(
            RX_CHARACTERISTIC_UUID
        )
        self._tx_characteristic = services.get_characteristic(
            TX_CHARACTERISTIC_UUID
        )
        if self._rx_characteristic is None or self._tx_characteristic is None:
            await self.close()
            raise ConnectionError("BLE device is missing RF platform characteristics")

        await self._client.start_notify(
            self._tx_characteristic, self._on_notification
        )

    async def send_frame(self, frame: bytes) -> None:
        if self._client is None or not self._client.is_connected:
            raise ConnectionError("BLE transport is not connected")
        encoded = encode_frame(frame, max_size=self.max_frame_size)
        payload_size = max(1, getattr(self._client, "mtu_size", 23) - 3)
        async with self._write_lock:
            for offset in range(0, len(encoded), payload_size):
                try:
                    await asyncio.wait_for(
                        self._client.write_gatt_char(
                            self._rx_characteristic,
                            encoded[offset:offset + payload_size],
                            response=True,
                        ),
                        timeout=self.write_timeout,
                    )
                except TimeoutError:
                    raise
                except Exception as error:
                    raise DeviceConnectionError("BLE frame write failed") from error

    async def receive_frames(self) -> AsyncIterator[bytes]:
        decoder = FrameStreamDecoder(max_size=self.max_frame_size)
        while True:
            chunk = await self._notifications.get()
            if chunk is None:
                return
            if isinstance(chunk, Exception):
                raise chunk
            for frame in decoder.feed(chunk):
                yield frame

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None and client.is_connected:
            if self._tx_characteristic is not None:
                try:
                    await client.stop_notify(self._tx_characteristic)
                except Exception:
                    pass
            await client.disconnect()
        self._rx_characteristic = None
        self._tx_characteristic = None
        self._signal_receiver(None)

    def _on_notification(self, _characteristic, data: bytearray) -> None:
        if self._notification_overflowed:
            return
        try:
            self._notifications.put_nowait(bytes(data))
        except asyncio.QueueFull:
            self._notification_overflowed = True
            self._signal_receiver(
                DeviceConnectionError("BLE notification queue overflow")
            )
            if self._client is not None:
                asyncio.create_task(self._disconnect_after_overflow(self._client))

    def _on_disconnect(self, client) -> None:
        if client is not self._client:
            return
        if not self._notification_overflowed:
            self._signal_receiver(None)

    def _signal_receiver(self, signal: Exception | None) -> None:
        self._drain_notifications()
        self._notifications.put_nowait(signal)

    def _drain_notifications(self) -> None:
        while not self._notifications.empty():
            self._notifications.get_nowait()

    async def _disconnect_after_overflow(self, client) -> None:
        if client is self._client and client.is_connected:
            try:
                await client.disconnect()
            except Exception:
                pass
