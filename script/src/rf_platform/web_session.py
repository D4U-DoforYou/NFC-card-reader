"""Device connection and display session state for the local web app."""
from __future__ import annotations

import asyncio

from .client import DeviceClient
from .core.jobs import JobState
from .display.detect import read_display_screen
from .display.models import ImageAlgorithm, ImageOptions
from .display.profiles import (
    DISPLAY_PROFILES,
    DisplayProfile,
    DisplayScreen,
    PreparedDisplayImage,
)
from .nfc.iso_dep import IsoDepSession, scan_type_a as scan_type_a_protocol
from .protocol import device_pb2
from .transport.ble_gatt import BleGattTransport


class DeviceSession:
    def __init__(self) -> None:
        self.client: DeviceClient | None = None
        self.iso_dep_session: IsoDepSession | None = None
        self.device_info: device_pb2.DeviceInfoResult | None = None
        self.amplitude: int | None = None
        self.transport_name: str | None = None
        self.display_handler: DisplayProfile | None = None
        self.display_screen: DisplayScreen | None = None
        self.display_progress: dict = {
            "running": False,
            "stage": "",
            "current": 0,
            "total": 0,
            "error": None,
        }
        self._display_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def connect(self, device: str | None) -> dict:
        async with self._lock:
            await self._close_unlocked()
            client = DeviceClient(BleGattTransport(device))
            try:
                await client.connect()
                job = await client.start_job("org.example.device.info", "get")
                event = await job.wait()
                if event.state != JobState.COMPLETED:
                    raise RuntimeError(event.detail or "device info request failed")
                self.device_info = device_pb2.DeviceInfoResult.FromString(
                    event.result
                )
                self.amplitude = await client.get_tx_amplitude()
                self.client = client
                self.iso_dep_session = IsoDepSession(client)
                self.transport_name = "ble"
                return self.status()
            except Exception:
                await client.close()
                raise

    async def disconnect(self) -> dict:
        async with self._lock:
            await self._close_unlocked()
            return self.status()

    async def read_amplitude(self) -> int:
        async with self._lock:
            return await self._require_client().get_tx_amplitude()

    async def set_amplitude(self, level: int) -> int:
        async with self._lock:
            self.amplitude = await self._require_client().set_tx_amplitude(level)
            return self.amplitude

    async def scan_type_a(self) -> dict:
        async with self._lock:
            await self._deactivate_active_display()
            self.display_handler = None
            self.display_screen = None
            result = await scan_type_a_protocol(self._require_client())
            return {
                "found": result.found,
                "uid": bytes(result.uid).hex().upper(),
                "sak": result.sak,
                "atqa": result.atqa,
            }

    async def scan_display(self, requested_profile: str = "auto") -> dict:
        async with self._lock:
            self._require_client()
            await self._deactivate_active_display()
            self.display_handler = None
            self.display_screen = None
            profile, screen, info = await read_display_screen(
                self._require_iso_dep_session(), requested_profile
            )
            self.display_handler = DISPLAY_PROFILES[profile]
            info.setdefault("product", self.display_handler.product_name)
            self.display_screen = screen
            return {**info, "profile": profile}

    def prepare_display_preview(
        self, image: bytes, options: ImageOptions
    ) -> bytes:
        if self.display_handler is None or self.display_screen is None:
            raise RuntimeError("scan a display before preparing its image preview")
        prepared = self.display_handler.prepare(
            image, self.display_screen, options
        )
        return prepared.preview_png

    def start_display_refresh(
        self,
        *,
        profile: str,
        image: bytes,
        confirmed_uid: str,
        pin: bytes,
        fit: str,
        rotation: int,
        algorithm: ImageAlgorithm,
        upload_only: bool,
    ) -> dict:
        if self._display_task is not None and not self._display_task.done():
            raise RuntimeError("a display update is already running")
        handler = DISPLAY_PROFILES.get(profile)
        if handler is None:
            raise ValueError("profile must be huawei or reink-c1")
        screen = self.display_screen
        if (
            self.display_profile != profile
            or self.display_handler is not handler
            or screen is None
        ):
            raise RuntimeError(f"scan the {profile} display before updating it")
        if confirmed_uid.upper() != screen.uid.hex().upper():
            raise ValueError("confirmed UID does not match the scanned display")
        prepared = handler.prepare(
            image,
            screen,
            ImageOptions(algorithm=algorithm, fit=fit, rotation=rotation),
        )
        self.display_progress = {
            "running": True,
            "stage": "准备连接",
            "current": 0,
            "total": 0,
            "error": None,
        }
        self._display_task = asyncio.create_task(
            self._run_display_refresh(
                handler, screen, prepared, pin, upload_only
            )
        )
        return dict(self.display_progress)

    async def _run_display_refresh(
        self,
        handler: DisplayProfile,
        screen: DisplayScreen,
        prepared: PreparedDisplayImage,
        pin: bytes,
        upload_only: bool,
    ) -> None:
        failure = None
        try:
            async with self._lock:
                def report(stage: str, current: int, total: int) -> None:
                    self.display_progress.update(
                        stage=stage, current=current, total=total
                    )

                await handler.refresh(
                    self._require_iso_dep_session(),
                    screen,
                    prepared,
                    pin=pin,
                    upload_only=upload_only,
                    progress=report,
                )
        except Exception as exc:
            failure = exc
        finally:
            async with self._lock:
                session = self.iso_dep_session
                if session is not None:
                    try:
                        await session.deactivate()
                    except Exception:
                        pass
                self.display_handler = None
                self.display_screen = None
        if failure is not None:
            self.display_progress.update(
                running=False, stage="失败", error=str(failure)
            )
        else:
            self.display_progress.update(
                running=False,
                stage="仅上传完成" if upload_only else "刷新完成",
                current=1,
                total=1,
            )

    async def deactivate_display(self) -> None:
        async with self._lock:
            client = self.client
            session = self.iso_dep_session
            self.display_handler = None
            self.display_screen = None
            if client is not None and client.connected and session is not None:
                await session.deactivate()

    def display_status(self) -> dict:
        return dict(self.display_progress)

    @property
    def display_profile(self) -> str | None:
        return self.display_handler.name if self.display_handler is not None else None

    def status(self) -> dict:
        info = self.device_info
        connected = self.client is not None and self.client.connected
        return {
            "connected": connected,
            "transport": self.transport_name if connected else None,
            "device_id": bytes(info.device_id).hex() if info else None,
            "firmware": (
                f"{info.firmware_name} {info.firmware_version}" if info else None
            ),
            "radio": info.radio_controller if info else None,
            "tx_amplitude": self.amplitude if connected else None,
        }

    def _require_client(self) -> DeviceClient:
        if self.client is None or not self.client.connected:
            raise RuntimeError("connect to a device first")
        return self.client

    def _require_iso_dep_session(self) -> IsoDepSession:
        self._require_client()
        if self.iso_dep_session is None:
            raise RuntimeError("ISO-DEP session is unavailable")
        return self.iso_dep_session

    async def _deactivate_active_display(self) -> None:
        if self.display_screen is not None and self.iso_dep_session is not None:
            await self.iso_dep_session.deactivate()

    async def _close_unlocked(self) -> None:
        client, self.client = self.client, None
        session, self.iso_dep_session = self.iso_dep_session, None
        screen_was_active = self.display_screen is not None
        self.device_info = None
        self.amplitude = None
        self.transport_name = None
        self.display_handler = None
        self.display_screen = None
        if client is not None:
            if screen_was_active and client.connected and session is not None:
                try:
                    await session.deactivate()
                except Exception:
                    pass
            await client.close()

