"""Host-facing radio primitives shared by NFC protocol implementations."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class RawRfFrame:
    rx: bytes
    rx_last_bits: int
    irq0: int
    irq1: int
    error: int
    collision: int


@dataclass(frozen=True, slots=True)
class ChipCommandResult:
    fifo_output: bytes
    irq0: int
    irq1: int
    error: int
    status: int


class NfcBackend(Protocol):
    async def set_rf_field(self, enabled: bool) -> None: ...

    async def raw_transceive(
        self,
        tx: bytes,
        *,
        timeout_ms: int = 25,
        tx_last_bits: int = 0,
        rx_align: int = 0,
        crc_flags: int = 3,
        confirmed_target_uid: bytes = b"",
    ) -> RawRfFrame: ...

    async def execute_chip_command(
        self,
        command: int,
        fifo_input: bytes = b"",
        *,
        timeout_ms: int = 25,
        confirmed_target_uid: bytes,
    ) -> ChipCommandResult: ...

    async def read_chip_register(self, address: int) -> int: ...

    async def write_chip_register(self, address: int, value: int) -> None: ...

