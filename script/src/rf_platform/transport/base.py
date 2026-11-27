"""Transport port used by the device protocol client."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol


class ByteTransport(Protocol):
    """Carries complete logical frames; it does not interpret capabilities."""

    @property
    def name(self) -> str: ...

    async def connect(self) -> None: ...

    async def send_frame(self, frame: bytes) -> None: ...

    def receive_frames(self) -> AsyncIterator[bytes]: ...

    async def close(self) -> None: ...
