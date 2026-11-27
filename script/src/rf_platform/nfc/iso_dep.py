"""ISO14443-A activation and ISO-DEP state machine over raw RF frames."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from .backend import ChipCommandResult, NfcBackend, RawRfFrame


ISO14443A_CASCADE_SELECT = (0x93, 0x95, 0x97)
ISO14443A_CASCADE_TAG = 0x88
ISO14443A_SAK_ISO_DEP = 0x20
ISO14443A_SAK_CASCADE = 0x04
ISO_DEP_CARRIER_HZ = 13_560_000

IRQ0_RX = 1 << 2
ERROR_COLLISION = 1 << 2
ERROR_MINFRAME = 1 << 4

MAX_ATS_SIZE = 20
MAX_WTX_COUNT = 50
MAX_NAK_RETRIES = 2
FSC_BY_FSCI = (16, 24, 32, 40, 48, 64, 96, 128, 256)


class NfcProtocolError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class TypeAScanResult:
    found: bool
    uid: bytes
    sak: int
    atqa: int


@dataclass(frozen=True, slots=True)
class IsoDepActivation:
    uid: bytes
    sak: int
    atqa: int


def _parse_ats(ats: bytes) -> tuple[int, int]:
    if len(ats) < 2 or len(ats) > MAX_ATS_SIZE or ats[0] != len(ats):
        raise NfcProtocolError(f"invalid ATS length {len(ats)}")

    t0 = ats[1]
    fsci = t0 & 0x0F
    if t0 & 0x80 or fsci > 8:
        raise NfcProtocolError("ATS contains unsupported T0 bits")

    offset = 2
    if t0 & 0x10:
        if offset >= len(ats):
            raise NfcProtocolError("ATS is missing TA(1)")
        offset += 1

    fwi = 4
    if t0 & 0x20:
        if offset >= len(ats):
            raise NfcProtocolError("ATS is missing TB(1)")
        fwi = ats[offset] >> 4
        sfgi = ats[offset] & 0x0F
        if fwi == 15 or sfgi == 15:
            raise NfcProtocolError("ATS contains a reserved FWI or SFGI")
        offset += 1

    if t0 & 0x40:
        if offset >= len(ats):
            raise NfcProtocolError("ATS is missing TC(1)")
        offset += 1
    if offset > len(ats):
        raise NfcProtocolError("ATS interface bytes exceed its length")
    return fwi, FSC_BY_FSCI[fsci]


def _frame_wait_ms(fwi: int, multiplier: int = 1) -> int:
    ticks = 4096 * (1 << fwi) * multiplier
    return (ticks * 1000 + ISO_DEP_CARRIER_HZ - 1) // ISO_DEP_CARRIER_HZ + 4


async def _select_type_a(
    backend: NfcBackend, wake_command: int
) -> tuple[int, bytes, int] | None:
    request = await backend.raw_transceive(
        bytes((wake_command,)),
        timeout_ms=10,
        tx_last_bits=7,
        crc_flags=0,
    )
    if len(request.rx) < 2:
        return None
    atqa = int.from_bytes(request.rx[:2], "little")

    uid = bytearray()
    sak = 0
    for select_code in ISO14443A_CASCADE_SELECT:
        anticollision = await backend.raw_transceive(
            bytes((select_code, 0x20)), timeout_ms=25, crc_flags=0
        )
        if anticollision.error & ERROR_COLLISION:
            raise NfcProtocolError(
                "multiple Type A cards collided during UID selection"
            )
        if len(anticollision.rx) != 5:
            raise NfcProtocolError(
                f"invalid anticollision response length {len(anticollision.rx)}"
            )
        uid_block = anticollision.rx
        bcc = uid_block[0] ^ uid_block[1] ^ uid_block[2] ^ uid_block[3]
        if bcc != uid_block[4]:
            raise NfcProtocolError("Type A UID block has an invalid BCC")

        selected = await backend.raw_transceive(
            bytes((select_code, 0x70)) + uid_block,
            timeout_ms=25,
            crc_flags=3,
        )
        if len(selected.rx) != 1:
            raise NfcProtocolError(
                f"invalid SAK response length {len(selected.rx)}"
            )
        sak = selected.rx[0]

        if sak & ISO14443A_SAK_CASCADE:
            if select_code == ISO14443A_CASCADE_SELECT[-1]:
                raise NfcProtocolError("UID cascade exceeded three levels")
            if uid_block[0] != ISO14443A_CASCADE_TAG:
                raise NfcProtocolError("cascade SAK did not include CT")
            uid.extend(uid_block[1:4])
            continue

        uid.extend(uid_block[:4])
        if len(uid) not in (4, 7, 10):
            raise NfcProtocolError(f"invalid Type A UID length {len(uid)}")
        return atqa, bytes(uid), sak

    raise NfcProtocolError("Type A UID selection did not finish")


async def _reselect_type_a(
    backend: NfcBackend,
) -> tuple[int, bytes, int] | None:
    await backend.set_rf_field(False)
    await asyncio.sleep(0.05)
    await backend.set_rf_field(True)
    await asyncio.sleep(0.05)
    return await _select_type_a(backend, 0x52)


async def scan_type_a(backend: NfcBackend) -> TypeAScanResult:
    await backend.set_rf_field(True)
    try:
        selected = await _select_type_a(backend, 0x52)
        if selected is None:
            return TypeAScanResult(False, b"", 0, 0)
        atqa, uid, sak = selected
        return TypeAScanResult(True, uid, sak, atqa)
    finally:
        await backend.set_rf_field(False)


class IsoDepSession:
    def __init__(self, backend: NfcBackend):
        self._backend = backend
        self.uid = b""
        self.sak = 0
        self.atqa = 0
        self._fwi = 4
        self._max_inf = FSC_BY_FSCI[-1] - 3
        self._tx_block_number = 0
        self._active = False

    async def activate(self, wake_command: int = 0x7A) -> IsoDepActivation:
        if wake_command not in (0x26, 0x52, 0x7A):
            raise ValueError("wake command must be REQA, WUPA, or Huawei 0x7A")
        if self._active:
            await self.deactivate()

        await self._backend.set_rf_field(False)
        await asyncio.sleep(0.3)
        await self._backend.set_rf_field(True)
        try:
            await asyncio.sleep(0.1)
            selected = await _select_type_a(self._backend, wake_command)
            if selected is None:
                raise NfcProtocolError("no Type A card answered the wake request")
            self.atqa, self.uid, self.sak = selected
            if not self.sak & ISO14443A_SAK_ISO_DEP:
                raise NfcProtocolError("selected Type A card does not support ISO-DEP")

            ats = await self._backend.raw_transceive(
                b"\xE0\x80",
                timeout_ms=100,
                crc_flags=3,
                confirmed_target_uid=self.uid,
            )
            self._fwi, fsc = _parse_ats(ats.rx)
            self._max_inf = fsc - 3
            self._tx_block_number = 0
            self._active = True
            return IsoDepActivation(self.uid, self.sak, self.atqa)
        except Exception:
            await self._backend.set_rf_field(False)
            self.uid = b""
            self._active = False
            raise

    async def exchange(
        self, uid: bytes, apdu: bytes, *, deadline_ms: int = 15_000
    ) -> bytes:
        if not self._active or uid != self.uid:
            raise NfcProtocolError("ISO-DEP session is not active for this UID")
        if not 4 <= len(apdu) <= 260:
            raise ValueError("ISO-DEP APDU must contain 4..260 bytes")
        if deadline_ms <= 0:
            raise ValueError("ISO-DEP deadline must be positive")
        deadline = time.monotonic() + deadline_ms / 1000
        chunks = [apdu[offset:offset + self._max_inf]
                  for offset in range(0, len(apdu), self._max_inf)]
        for chunk_index, chunk in enumerate(chunks):
            chaining = chunk_index + 1 < len(chunks)
            request_block_number = self._tx_block_number
            tx = bytes((0x02 | request_block_number | (0x10 if chaining else 0),)) + chunk
            timeout_ms = _frame_wait_ms(self._fwi)
            wtx_count = 0
            nak_retries = 0
            link_retries = 0

            while True:
                remaining_ms = int((deadline - time.monotonic()) * 1000)
                if remaining_ms <= 0:
                    raise NfcProtocolError(
                        "ISO-DEP exchange reached its deadline; result is uncertain"
                    )
                frame = await self._backend.raw_transceive(
                    tx,
                    timeout_ms=min(timeout_ms, remaining_ms),
                    crc_flags=3,
                    confirmed_target_uid=self.uid,
                )
                fatal_error = frame.error & ~ERROR_MINFRAME
                if not frame.rx or fatal_error or frame.rx_last_bits or frame.collision:
                    if link_retries >= MAX_NAK_RETRIES:
                        raise NfcProtocolError(
                            "ISO-DEP link recovery limit exceeded; "
                            "APDU result is uncertain; do not resend the APDU "
                            f"(rx={frame.rx.hex().upper()}, "
                            f"irq0=0x{frame.irq0:02X}, "
                            f"irq1=0x{frame.irq1:02X}, "
                            f"error=0x{frame.error:02X}, "
                            f"collision=0x{frame.collision:02X})"
                        )
                    link_retries += 1
                    tx = (
                        tx if tx[:1] == b"\xF2"
                        else bytes((0xB2 | request_block_number,))
                    )
                    timeout_ms = _frame_wait_ms(self._fwi)
                    continue

                pcb = frame.rx[0]
                if pcb & 0xC0 == 0:
                    if chaining:
                        raise NfcProtocolError(
                            "expected an R-block after a chained I-block"
                        )
                    if pcb & 0x2C or (pcb & 1) != request_block_number:
                        raise NfcProtocolError(
                            f"invalid ISO-DEP I-block PCB 0x{pcb:02X}"
                        )
                    if pcb & 0x10:
                        raise NfcProtocolError(
                            "chained ISO-DEP response is unsupported"
                        )
                    self._tx_block_number ^= 1
                    return frame.rx[1:]

                if pcb & 0xC0 == 0x80:
                    if len(frame.rx) != 1 or pcb & 0xE6 != 0xA2:
                        raise NfcProtocolError(
                            f"invalid ISO-DEP R-block PCB 0x{pcb:02X}"
                        )
                    block_number = pcb & 1
                    is_nak = bool(pcb & 0x10)
                    if is_nak and block_number == request_block_number:
                        if nak_retries >= MAX_NAK_RETRIES:
                            raise NfcProtocolError(
                                "ISO-DEP R-block retry limit exceeded"
                            )
                        nak_retries += 1
                        tx = bytes((
                            0x02 | request_block_number | (0x10 if chaining else 0),
                        )) + chunk
                        timeout_ms = _frame_wait_ms(self._fwi)
                        continue
                    if (
                        chaining
                        and not is_nak
                        and block_number == request_block_number
                    ):
                        self._tx_block_number ^= 1
                        break
                    raise NfcProtocolError(
                        f"unexpected ISO-DEP R-block PCB 0x{pcb:02X}"
                    )

                if pcb & 0xF0 == 0xF0:
                    if len(frame.rx) != 2 or pcb & 0xCF != 0xC2:
                        raise NfcProtocolError(
                            f"invalid ISO-DEP S-block PCB 0x{pcb:02X}"
                        )
                    multiplier = frame.rx[1]
                    if not 1 <= multiplier <= 59 or wtx_count >= MAX_WTX_COUNT:
                        raise NfcProtocolError("invalid ISO-DEP WTX multiplier")
                    tx = bytes((0xF2, multiplier))
                    timeout_ms = _frame_wait_ms(self._fwi, multiplier)
                    wtx_count += 1
                    continue

                if pcb == 0xC2 and len(frame.rx) == 1:
                    await self._backend.raw_transceive(
                        b"\xC2",
                        timeout_ms=_frame_wait_ms(self._fwi),
                        crc_flags=3,
                        confirmed_target_uid=self.uid,
                    )
                raise NfcProtocolError(
                    f"unexpected ISO-DEP block PCB 0x{pcb:02X}"
                )

        raise NfcProtocolError("ISO-DEP chained APDU ended without a response")

    async def deactivate(self) -> None:
        if self._active:
            try:
                await self._backend.raw_transceive(
                    b"\xC2",
                    timeout_ms=_frame_wait_ms(self._fwi),
                    crc_flags=3,
                    confirmed_target_uid=self.uid,
                )
            finally:
                self._active = False
                self.uid = b""
                await self._backend.set_rf_field(False)
        else:
            await self._backend.set_rf_field(False)
