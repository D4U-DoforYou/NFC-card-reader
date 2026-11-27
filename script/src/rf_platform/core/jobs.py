"""Host-side validation for asynchronous device job events."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class JobState(str, Enum):
    ACCEPTED = "accepted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    RESULT_UNCERTAIN = "result_uncertain"


TERMINAL_JOB_STATES = frozenset({
    JobState.COMPLETED,
    JobState.FAILED,
    JobState.CANCELLED,
    JobState.RESULT_UNCERTAIN,
})
_ALLOWED_TRANSITIONS = {
    JobState.ACCEPTED: frozenset({
        JobState.RUNNING, JobState.FAILED, JobState.CANCELLED,
    }),
    JobState.RUNNING: TERMINAL_JOB_STATES,
}


@dataclass(frozen=True, slots=True)
class JobEvent:
    job_id: int
    state: JobState
    stage: str = ""
    progress_current: int = 0
    progress_total: int = 0
    error_code: int = 0
    detail: str = ""
    result: bytes = b""

    def __post_init__(self) -> None:
        if not 0 < self.job_id <= 0xFFFFFFFF:
            raise ValueError("job_id must be a non-zero uint32")
        if self.progress_current < 0 or self.progress_total < 0:
            raise ValueError("job progress must be non-negative")
        if self.progress_current > self.progress_total:
            raise ValueError("job progress cannot exceed its total")
        if self.state == JobState.RUNNING and not self.stage:
            raise ValueError("running job events must include a stage")


class JobTracker:
    """Reject stale or impossible job events from a device session."""

    def __init__(self) -> None:
        self._events: dict[int, JobEvent] = {}

    def update(self, event: JobEvent) -> None:
        previous = self._events.get(event.job_id)
        if previous is None:
            if event.state != JobState.ACCEPTED:
                raise ValueError("first event for a job must be accepted")
        else:
            allowed = _ALLOWED_TRANSITIONS.get(previous.state, frozenset())
            is_progress_update = (
                previous.state == JobState.RUNNING
                and event.state == JobState.RUNNING
            )
            if event.state not in allowed and not is_progress_update:
                raise ValueError(
                    f"invalid job transition {previous.state.value} -> "
                    f"{event.state.value}"
                )
            if (event.state == JobState.RUNNING
                    and event.stage == previous.stage
                    and event.progress_current < previous.progress_current):
                raise ValueError("job progress cannot go backwards within a stage")
        self._events[event.job_id] = event

    def get(self, job_id: int) -> JobEvent | None:
        return self._events.get(job_id)
