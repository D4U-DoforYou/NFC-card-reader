"""Asynchronous client for the versioned device protocol."""
from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from typing import Any, Callable

from .client_errors import DeviceConnectionError, DeviceProtocolError
from .client_operations import DeviceOperationsMixin
from .core.jobs import JobEvent, JobState, TERMINAL_JOB_STATES
from .ota import FirmwareUpdater
from .protocol import device_pb2
from .remote_job import RemoteJob, _to_job_event
from .transport.base import ByteTransport

__all__ = [
    "DeviceClient",
    "DeviceConnectionError",
    "DeviceProtocolError",
    "RemoteJob",
]


@dataclass(slots=True)
class _PendingRequest:
    expected_body: str
    future: asyncio.Future[Any]


@dataclass(slots=True)
class _JobEvents:
    queue: asyncio.Queue[JobEvent | Exception]
    claimed: bool = False
    terminal: bool = False


class DeviceClient(DeviceOperationsMixin):
    """Owns one protocol session over any complete-frame transport."""

    PROTOCOL_MAJOR = 1
    PROTOCOL_MINOR = 0
    MAX_JOB_EVENTS = 64

    def __init__(self, transport: ByteTransport, *, request_timeout: float = 10.0):
        self.transport = transport
        self.request_timeout = request_timeout
        self.device_id = b""
        self.boot_id = b""
        self.session_id = 0
        self.capabilities = ()
        self._request_id = 0
        self._pending: dict[int, _PendingRequest] = {}
        self._job_queues: dict[int, _JobEvents] = {}
        self._reader_task: asyncio.Task | None = None
        self._request_lock = asyncio.Lock()
        self._connected = False
        self._closing = False
        self._firmware_updater = FirmwareUpdater(self)

    @property
    def connected(self) -> bool:
        return (
            self._connected
            and not self._closing
            and self._reader_task is not None
            and not self._reader_task.done()
        )

    async def connect(self) -> None:
        if self._connected:
            return
        self._fail_job_queues(DeviceConnectionError("device session replaced"))
        await self.transport.connect()
        self._closing = False
        self.session_id = 0
        self._reader_task = asyncio.create_task(self._read_loop())
        try:
            hello = device_pb2.HelloRequest(
                min_protocol_major=self.PROTOCOL_MAJOR,
                max_protocol_major=self.PROTOCOL_MAJOR,
                max_protocol_minor=self.PROTOCOL_MINOR,
                host_nonce=secrets.token_bytes(16),
            )
            hello_deadline = (
                asyncio.get_running_loop().time() + self.request_timeout
            )
            while True:
                remaining = (
                    hello_deadline - asyncio.get_running_loop().time()
                )
                if remaining <= 0:
                    raise TimeoutError("device hello timed out")
                try:
                    envelope = await self._request(
                        "hello_request",
                        hello,
                        "hello_response",
                        session_id=0,
                        timeout=min(1.0, remaining),
                    )
                    break
                except TimeoutError:
                    if asyncio.get_running_loop().time() >= hello_deadline:
                        raise
            body = envelope.hello_response
            if envelope.protocol_major != self.PROTOCOL_MAJOR:
                raise DeviceProtocolError(
                    f"unsupported protocol major {envelope.protocol_major}"
                )
            if envelope.session_id == 0:
                raise DeviceProtocolError("device returned an empty session ID")
            self.session_id = envelope.session_id
            self.device_id = bytes(body.device_id)
            self.boot_id = bytes(body.boot_id)
            self._connected = True
            result = await self._request(
                "capability_query",
                device_pb2.CapabilityQuery(),
                "capability_list",
            )
            self.capabilities = tuple(result.capability_list.capabilities)
        except Exception:
            try:
                await self.close()
            except Exception:
                pass
            raise

    async def close(self) -> None:
        self._closing = True
        self._connected = False
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            self._reader_task = None
        self._fail_pending(DeviceConnectionError("device client closed"))
        self._fail_job_queues(DeviceConnectionError("device client closed"))
        await self.transport.close()

    async def upload_firmware(
        self,
        image: bytes,
        *,
        chunk_size: int = 512,
        purpose: str = "firmware",
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        await self._firmware_updater.upload(
            image, chunk_size=chunk_size, purpose=purpose, progress=progress
        )

    async def _request(
        self,
        body_name: str,
        body: Any,
        expected_body: str,
        *,
        session_id: int | None = None,
        timeout: float | None = None,
    ) -> device_pb2.Envelope:
        if self._reader_task is None or self._reader_task.done():
            raise DeviceConnectionError("device receive loop is not running")
        async with self._request_lock:
            request_id = self._next_request_id()
            future = asyncio.get_running_loop().create_future()
            self._pending[request_id] = _PendingRequest(expected_body, future)
            envelope = device_pb2.Envelope(
                protocol_major=self.PROTOCOL_MAJOR,
                protocol_minor=self.PROTOCOL_MINOR,
                session_id=(self.session_id if session_id is None else session_id),
                request_id=request_id,
            )
            getattr(envelope, body_name).CopyFrom(body)
            try:
                await self.transport.send_frame(envelope.SerializeToString())
                return await asyncio.wait_for(
                    future,
                    self.request_timeout if timeout is None else timeout,
                )
            except BaseException:
                self._pending.pop(request_id, None)
                if not future.done():
                    future.cancel()
                raise

    def _next_request_id(self) -> int:
        for _ in range(0xFFFFFFFF):
            self._request_id = (self._request_id + 1) & 0xFFFFFFFF
            if self._request_id and self._request_id not in self._pending:
                return self._request_id
        raise DeviceConnectionError("all request IDs are in use")

    async def _read_loop(self) -> None:
        try:
            async for frame in self.transport.receive_frames():
                envelope = device_pb2.Envelope()
                try:
                    envelope.ParseFromString(frame)
                except Exception as exc:
                    raise DeviceProtocolError("invalid protobuf envelope") from exc
                self._dispatch(envelope)
            if not self._closing:
                raise DeviceConnectionError("transport ended unexpectedly")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._connected = False
            self._fail_pending(exc)
            self._fail_job_queues(exc)
            try:
                await self.transport.close()
            except Exception:
                pass

    def _dispatch(self, envelope: device_pb2.Envelope) -> None:
        if envelope.protocol_major != self.PROTOCOL_MAJOR:
            raise DeviceProtocolError(
                f"unsupported protocol major {envelope.protocol_major}"
            )
        if self.session_id and envelope.session_id != self.session_id:
            raise DeviceProtocolError("received a frame from a stale session")
        if envelope.request_id:
            pending = self._pending.pop(envelope.request_id, None)
            if pending is not None:
                body_name = envelope.WhichOneof("body")
                if body_name != pending.expected_body:
                    pending.future.set_exception(DeviceProtocolError(
                        f"expected {pending.expected_body}, received {body_name}"
                    ))
                    return
                if body_name == "job_event":
                    accepted = _to_job_event(envelope.job_event)
                    if accepted.state == JobState.ACCEPTED:
                        self._job_queues.setdefault(
                            accepted.job_id,
                            _JobEvents(asyncio.Queue(
                                maxsize=self.MAX_JOB_EVENTS
                            )),
                        )
                pending.future.set_result(envelope)
        if envelope.WhichOneof("body") == "job_event":
            event = _to_job_event(envelope.job_event)
            job_events = self._job_queues.get(event.job_id)
            if job_events is not None:
                if job_events.queue.full():
                    raise DeviceProtocolError(
                        f"job event queue overflow for job {event.job_id}"
                    )
                job_events.queue.put_nowait(event)
                if event.state in TERMINAL_JOB_STATES:
                    job_events.terminal = True
                    if job_events.claimed:
                        self._job_queues.pop(event.job_id, None)

    def _fail_pending(self, error: Exception) -> None:
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(error)
        self._pending.clear()

    def _fail_job_queues(self, error: Exception) -> None:
        for job_events in self._job_queues.values():
            while not job_events.queue.empty():
                job_events.queue.get_nowait()
            job_events.queue.put_nowait(error)
        self._job_queues.clear()

    def _claim_job_events(
        self, job_id: int
    ) -> asyncio.Queue[JobEvent | Exception]:
        job_events = self._job_queues.setdefault(
            job_id,
            _JobEvents(asyncio.Queue(maxsize=self.MAX_JOB_EVENTS)),
        )
        job_events.claimed = True
        if job_events.terminal:
            self._job_queues.pop(job_id, None)
        return job_events.queue
