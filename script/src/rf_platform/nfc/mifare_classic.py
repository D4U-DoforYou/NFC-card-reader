"""Host-side MIFARE Classic 1K access using CLRC663 chip primitives."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .backend import NfcBackend, RawRfFrame
from .iso_dep import _reselect_type_a, _select_type_a


CLRC663_CMD_LOADKEY = 0x02
CLRC663_CMD_MFAUTHENT = 0x03
CLRC663_STATUS_CRYPTO1_ON = 1 << 5
MF_AUTH_KEY_A = 0x60
MF_AUTH_KEY_B = 0x61
MF_READ = 0x30
MF_WRITE = 0xA0
MF_ACK = 0x0A
MFRC630_REG_STATUS = 0x0B
MIFARE_CLASSIC_1K_SAK = 0x08
BLOCK_COUNT = 64
BLOCK_SIZE = 16


class MifareClassicError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class MifareClassicTag:
    uid: bytes
    sak: int
    atqa: int


class MifareClassicSession:
    """A selected Classic 1K card session over the generic host RF backend."""

    def __init__(self, backend: NfcBackend):
        self._backend = backend
        self.tag: MifareClassicTag | None = None

    @property
    def uid(self) -> bytes:
        if self.tag is None:
            raise MifareClassicError("MIFARE Classic session is not active")
        return self.tag.uid

    async def open(self, expected_uid: bytes | None = None) -> MifareClassicTag:
        if self.tag is not None:
            await self.close()
        await self._backend.set_rf_field(False)
        await asyncio.sleep(0.05)
        await self._backend.set_rf_field(True)
        try:
            selected = await _select_type_a(self._backend, 0x52)
            if selected is None:
                raise MifareClassicError("no ISO14443-A card answered the wake request")
            atqa, uid, sak = selected
            if sak != MIFARE_CLASSIC_1K_SAK:
                raise MifareClassicError(
                    f"unsupported card SAK 0x{sak:02X}; expected MIFARE Classic 1K"
                )
            if expected_uid is not None and uid != expected_uid:
                raise MifareClassicError("card UID does not match the requested UID")
            self.tag = MifareClassicTag(uid=uid, sak=sak, atqa=atqa)
            return self.tag
        except Exception:
            await self._backend.set_rf_field(False)
            raise

    async def authenticate(
        self, block: int, key: bytes, *, key_type: str = "A"
    ) -> None:
        self._validate_block(block)
        if len(key) != 6:
            raise ValueError("MIFARE Classic keys must contain exactly 6 bytes")
        key_codes = {"A": MF_AUTH_KEY_A, "B": MF_AUTH_KEY_B}
        try:
            key_code = key_codes[key_type.upper()]
        except KeyError as exc:
            raise ValueError("key_type must be 'A' or 'B'") from exc

        uid = self.uid
        await self._reactivate_target(uid)
        await self._backend.write_chip_register(MFRC630_REG_STATUS, 0)
        await self._backend.execute_chip_command(
            CLRC663_CMD_LOADKEY,
            key,
            confirmed_target_uid=uid,
        )
        result = await self._backend.execute_chip_command(
            CLRC663_CMD_MFAUTHENT,
            bytes((key_code, block)) + uid[-4:],
            timeout_ms=100,
            confirmed_target_uid=uid,
        )
        if not result.status & CLRC663_STATUS_CRYPTO1_ON:
            raise MifareClassicError(
                f"authentication failed for block {block} with Key {key_type.upper()}"
            )

    async def _reactivate_target(self, expected_uid: bytes) -> None:
        selected = await _reselect_type_a(self._backend)
        if selected is None or selected[1] != expected_uid:
            raise MifareClassicError(
                "card UID changed during the MIFARE operation"
            )
        if selected[2] != MIFARE_CLASSIC_1K_SAK:
            raise MifareClassicError(
                f"unsupported card SAK 0x{selected[2]:02X}; "
                "expected MIFARE Classic 1K"
            )

    async def read_block(
        self, block: int, key: bytes, *, key_type: str = "A"
    ) -> bytes:
        self._validate_block(block)
        await self.authenticate(block, key, key_type=key_type)
        return await self._read_authenticated_block(block)

    async def _read_authenticated_block(self, block: int) -> bytes:
        frame = await self._backend.raw_transceive(
            bytes((MF_READ, block)),
            timeout_ms=50,
            crc_flags=3,
            confirmed_target_uid=self.uid,
        )
        if frame.error or len(frame.rx) != BLOCK_SIZE:
            raise MifareClassicError(
                f"MIFARE READ block {block} returned {len(frame.rx)} bytes "
                f"(error 0x{frame.error:02X})"
            )
        return frame.rx

    async def write_block(
        self,
        block: int,
        data: bytes,
        key: bytes,
        *,
        key_type: str = "A",
    ) -> bytes:
        self._validate_block(block)
        if block == 0 or block % 4 == 3:
            raise ValueError("writing the manufacturer block or sector trailer is forbidden")
        if len(data) != BLOCK_SIZE:
            raise ValueError("MIFARE Classic data blocks must contain exactly 16 bytes")

        await self.authenticate(block, key, key_type=key_type)
        command_ack = await self._backend.raw_transceive(
            bytes((MF_WRITE, block)),
            timeout_ms=50,
            crc_flags=1,
            confirmed_target_uid=self.uid,
        )
        self._require_ack(command_ack, "write command")
        data_ack = await self._backend.raw_transceive(
            data,
            timeout_ms=50,
            crc_flags=1,
            confirmed_target_uid=self.uid,
        )
        self._require_ack(data_ack, "write data")

        written = await self._read_authenticated_block(block)
        if written != data:
            raise MifareClassicError(f"MIFARE WRITE block {block} read-back mismatch")
        return written

    async def close(self) -> None:
        try:
            if self.tag is not None:
                uid = self.tag.uid
                await self._backend.write_chip_register(MFRC630_REG_STATUS, 0)
                await self._backend.execute_chip_command(
                    CLRC663_CMD_LOADKEY,
                    bytes(6),
                    confirmed_target_uid=uid,
                )
        finally:
            self.tag = None
            await self._backend.set_rf_field(False)

    @staticmethod
    def _require_ack(frame: RawRfFrame, stage: str) -> None:
        if (
            frame.error
            or len(frame.rx) != 1
            or frame.rx[0] & 0x0F != MF_ACK
            or frame.rx_last_bits not in (0, 4)
        ):
            raise MifareClassicError(
                f"MIFARE {stage} was rejected (response {frame.rx.hex().upper()})"
            )

    @staticmethod
    def _validate_block(block: int) -> None:
        if not 0 <= block < BLOCK_COUNT:
            raise ValueError("MIFARE Classic 1K block must be in range 0..63")

