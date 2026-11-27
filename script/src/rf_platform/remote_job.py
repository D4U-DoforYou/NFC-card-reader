"""Lifecycle tracking for asynchronous device jobs."""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from .client_errors import DeviceProtocolError
from .core.jobs import JobEvent, JobState, JobTracker, TERMINAL_JOB_STATES
from .protocol import device_pb2

if TYPE_CHECKING:
    from .client import DeviceClient


class RemoteJob:
    def __init__(
        self,
        client: DeviceClient,
        accepted: JobEvent,
        events: asyncio.Queue[JobEvent | Exception],
        *,
        timeout: float,
    ):
        self.client = client
        self.accepted = accepted
        self.events = events
        self.timeout = timeout
        self.tracker = JobTracker()
        self.tracker.update(accepted)

    async def wait(self, *, timeout: float | None = None) -> JobEvent:
        wait_timeout = self.timeout if timeout is None else timeout
        deadline = (None if wait_timeout is None else
                    asyncio.get_running_loop().time() + wait_timeout)
        while True:
            remaining = (None if deadline is None else
                         deadline - asyncio.get_running_loop().time())
            if remaining is not None and remaining <= 0:
                raise TimeoutError("device job wait timed out")
            event = await asyncio.wait_for(self.events.get(), remaining)
            if isinstance(event, Exception):
                raise event
            if event.state == JobState.ACCEPTED:
                continue
            self.tracker.update(event)
            if event.state in TERMINAL_JOB_STATES:
                return event

    async def cancel(self) -> JobEvent:
        return await self.client.cancel_job(self.accepted.job_id)

    async def query(self) -> JobEvent:
        return await self.client.query_job(self.accepted.job_id)


def _to_job_event(message: device_pb2.JobEvent) -> JobEvent:
    state = {
        device_pb2.JOB_STATE_ACCEPTED: JobState.ACCEPTED,
        device_pb2.JOB_STATE_RUNNING: JobState.RUNNING,
        device_pb2.JOB_STATE_COMPLETED: JobState.COMPLETED,
        device_pb2.JOB_STATE_FAILED: JobState.FAILED,
        device_pb2.JOB_STATE_CANCELLED: JobState.CANCELLED,
        device_pb2.JOB_STATE_RESULT_UNCERTAIN: JobState.RESULT_UNCERTAIN,
    }.get(message.state)
    if state is None:
        raise DeviceProtocolError(f"unknown job state {message.state}")
    return JobEvent(
        job_id=message.job_id,
        state=state,
        stage=message.stage,
        progress_current=message.progress_current,
        progress_total=message.progress_total,
        error_code=message.error_code,
        detail=message.detail,
        result=bytes(message.result),
    )


def _require_completed(event: JobEvent) -> None:
    if event.state != JobState.COMPLETED:
        detail = event.detail or f"device job ended in {event.state.name}"
        raise DeviceProtocolError(detail)
