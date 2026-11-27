"""Host-side NFC Forum Type 2 Tag access over raw RF frames."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .backend import NfcBackend, RawRfFrame
from .iso_dep import _reselect_type_a, _select_type_a


NTAG_I2C_PRODUCT_TYPE = 0x05
MAX_STATIC_LOCK_PAGE = 15


class Type2Error(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class _NdefTlv:
    start: int
    length_offset: int
    length_width: int
    value_offset: int
    value: bytes
    end: int


@dataclass(frozen=True, slots=True)
class Type2TagInfo:
    uid: bytes
    sak: int
    atqa: int
    version: bytes | None
    capability_container: bytes
    user_memory: bytes
    ndef_tlv: _NdefTlv | None
    append_offset: int
    has_control_tlv: bool
    has_tlv_after_ndef: bool


def crc_a(data: bytes) -> bytes:
    crc = 0x6363
    for value in data:
        value ^= crc & 0xFF
        value ^= (value << 4) & 0xFF
        crc = ((crc >> 8) ^ (value << 8) ^ (value << 3) ^ (value >> 4)) & 0xFFFF
    return crc.to_bytes(2, "little")


def _scan_tlvs(memory: bytes) -> tuple[_NdefTlv | None, int, bool, bool]:
    offset = 0
    append_offset = 0
    ndef: _NdefTlv | None = None
    has_control_tlv = False
    has_tlv_after_ndef = False

    while offset < len(memory):
        tag = memory[offset]
        if tag == 0x00:
            offset += 1
            continue
        if tag == 0xFE:
            break

        start = offset
        offset += 1
        if offset >= len(memory):
            raise Type2Error("truncated Type 2 TLV length")
        length = memory[offset]
        length_offset = offset
        offset += 1
        length_width = 1
        if length == 0xFF:
            if offset + 2 > len(memory):
                raise Type2Error("truncated extended Type 2 TLV length")
            length = int.from_bytes(memory[offset:offset + 2], "big")
            length_width = 3
            offset += 2
        end = offset + length
        if end > len(memory):
            raise Type2Error("Type 2 TLV exceeds advertised user memory")

        if tag in (0x01, 0x02):
            has_control_tlv = True
        if tag == 0x03:
            if ndef is None:
                ndef = _NdefTlv(
                    start, length_offset, length_width, offset,
                    memory[offset:end], end,
                )
            else:
                has_tlv_after_ndef = True
        elif ndef is not None:
            has_tlv_after_ndef = True
        else:
            append_offset = end
        offset = end

    return ndef, append_offset, has_control_tlv, has_tlv_after_ndef


def _encode_text_record(text: str) -> bytes:
    text_bytes = text.encode("utf-8")
    payload = b"\x02en" + text_bytes
    if len(payload) > 255:
        raise ValueError("Type 2 test text must fit in a short NDEF record")
    return bytes((0xD1, 0x01, len(payload), 0x54)) + payload


def decode_text_record(message: bytes) -> str | None:
    if len(message) < 7 or message[0] != 0xD1 or message[1] != 1:
        return None
    payload_length = message[2]
    if message[3] != 0x54 or len(message) != 4 + payload_length:
        return None
    payload = message[4:]
    if not payload:
        return None
    language_length = payload[0] & 0x3F
    if 1 + language_length > len(payload):
        return None
    charset = "utf-16" if payload[0] & 0x80 else "utf-8"
    try:
        return payload[1 + language_length:].decode(charset)
    except UnicodeDecodeError:
        return None


def decode_uri_record(message: bytes) -> str | None:
    if len(message) < 5 or message[0] != 0xD1 or message[1] != 1:
        return None
    payload_length = message[2]
    if message[3] != 0x55 or len(message) != 4 + payload_length:
        return None
    prefixes = {
        0x00: "",
        0x01: "http://www.",
        0x02: "https://",
        0x03: "http://",
        0x04: "https://www.",
    }
    payload = message[4:]
    prefix = prefixes.get(payload[0])
    if prefix is None:
        return None
    try:
        return prefix + payload[1:].decode("utf-8")
    except UnicodeDecodeError:
        return None


def _encode_ndef_tlv(message: bytes, *, extended: bool = False) -> bytes:
    if extended or len(message) >= 0xFF:
        if len(message) > 0xFFFF:
            raise ValueError("NDEF message exceeds Type 2 Tag capacity")
        return b"\x03\xFF" + len(message).to_bytes(2, "big") + message + b"\xFE"
    return b"\x03" + bytes((len(message),)) + message + b"\xFE"


class Type2Session:
    def __init__(self, backend: NfcBackend):
        self._backend = backend
        self._active = False
        self.info: Type2TagInfo | None = None

    async def open(self) -> Type2TagInfo:
        if self._active:
            await self.close()
        await self._backend.set_rf_field(False)
        await asyncio.sleep(0.05)
        await self._backend.set_rf_field(True)
        self._active = True
        try:
            await asyncio.sleep(0.05)
            selected = await _select_type_a(self._backend, 0x52)
            if selected is None:
                raise Type2Error("no ISO14443-A tag answered")
            atqa, uid, sak = selected
            if sak & 0x20:
                raise Type2Error("selected card supports ISO-DEP, not Type 2")

            version = await self._read_version()
            cc_page = await self.read_page(3)
            cc = cc_page[:4]
            if len(cc) != 4 or cc[0] != 0xE1:
                raise Type2Error("tag has no NFC Forum Type 2 Capability Container")
            user_bytes = cc[2] * 8
            if user_bytes < 4 or user_bytes > 1008:
                raise Type2Error(f"invalid Type 2 user memory size: {user_bytes}")

            memory = await self._read_user_memory(user_bytes)
            ndef, append, control, trailing = _scan_tlvs(memory)
            self.info = Type2TagInfo(
                uid=uid,
                sak=sak,
                atqa=atqa,
                version=version,
                capability_container=cc,
                user_memory=memory,
                ndef_tlv=ndef,
                append_offset=append,
                has_control_tlv=control,
                has_tlv_after_ndef=trailing,
            )
            return self.info
        except Exception:
            await self.close()
            raise

    async def close(self) -> None:
        self._active = False
        self.info = None
        await self._backend.set_rf_field(False)

    async def _exchange(self, command: bytes, *, timeout_ms: int = 50,
                        confirmed_target_uid: bytes = b"") -> RawRfFrame:
        frame = await self._backend.raw_transceive(
            command + crc_a(command),
            timeout_ms=timeout_ms,
            crc_flags=0,
            confirmed_target_uid=confirmed_target_uid,
        )
        if frame.collision & 0x04:
            raise Type2Error("multiple Type 2 tags collided during exchange")
        return frame

    async def _read_version(self) -> bytes | None:
        try:
            frame = await self._exchange(b"\x60", timeout_ms=50)
        except Type2Error:
            return None
        if frame.error or frame.rx_last_bits or len(frame.rx) != 10:
            return None
        if crc_a(frame.rx[:-2]) != frame.rx[-2:]:
            return None
        return frame.rx[:8]

    async def read_page(self, page: int) -> bytes:
        if not 0 <= page <= 0xFF:
            raise ValueError("Type 2 page must be in range 0..255")
        frame = await self._exchange(bytes((0x30, page)))
        if frame.error or frame.rx_last_bits or len(frame.rx) != 18:
            raise Type2Error(
                f"Type 2 READ page {page} returned an incomplete response "
                f"(error=0x{frame.error:02X}, bytes={len(frame.rx)})"
            )
        if crc_a(frame.rx[:-2]) != frame.rx[-2:]:
            raise Type2Error(f"Type 2 READ page {page} CRC_A check failed")
        return frame.rx[:16]

    async def _read_user_memory(self, size: int) -> bytes:
        memory = bytearray()
        while len(memory) < size:
            page = 4 + len(memory) // 4
            data = await self.read_page(page)
            memory.extend(data[:min(16, size - len(memory))])
        return bytes(memory)

    async def _require_target(self, expected_uid: bytes) -> None:
        selected = await _reselect_type_a(self._backend)
        if selected is None or selected[1] != expected_uid:
            raise Type2Error("card UID changed during the Type 2 operation")

    async def _write_page(self, page: int, data: bytes, uid: bytes) -> None:
        if len(data) != 4:
            raise ValueError("Type 2 page writes require exactly four bytes")
        await self._require_target(uid)
        frame = await self._exchange(
            bytes((0xA2, page)) + data,
            timeout_ms=100,
            confirmed_target_uid=uid,
        )
        if (
            frame.error & 0x0E
            or frame.rx_last_bits != 4
            or len(frame.rx) != 1
            or frame.rx[0] & 0x0F != 0x0A
        ):
            raise Type2Error(f"Type 2 WRITE page {page} was rejected")
        await self._require_target(uid)
        if (await self.read_page(page))[:4] != data:
            raise Type2Error(f"Type 2 WRITE page {page} read-back failed")

    @staticmethod
    def _require_ntag_i2c(info: Type2TagInfo) -> None:
        version = info.version
        if (
            version is None
            or len(version) != 8
            or version[:3] != bytes.fromhex("000404")
            or version[3] != NTAG_I2C_PRODUCT_TYPE
            or version[7] != 0x03
        ):
            raise Type2Error(
                "GET_VERSION did not identify NTAG I2C; automatic writes refused"
            )

    async def write_text(self, text: str, confirm_uid: str) -> bytes:
        info = self.info
        if info is None or not self._active:
            raise Type2Error("Type 2 session is not active")
        try:
            confirmed_uid = bytes.fromhex(confirm_uid.replace(":", "").replace("-", ""))
        except ValueError as exc:
            raise ValueError("confirmation UID must be hexadecimal") from exc
        if confirmed_uid != info.uid:
            raise Type2Error("confirmation UID does not match the selected card")

        cc = info.capability_container
        if cc[3] & 0x0F:
            raise Type2Error("Capability Container marks the tag read-only")
        if info.has_control_tlv:
            raise Type2Error("lock or memory-control TLV found; automatic write refused")
        if info.has_tlv_after_ndef:
            raise Type2Error("additional TLVs follow NDEF; automatic write refused")
        self._require_ntag_i2c(info)

        message = _encode_text_record(text)
        current = info.user_memory
        old = info.ndef_tlv
        start = old.start if old is not None else info.append_offset
        encoded = _encode_ndef_tlv(
            message,
            extended=old is not None and old.length_width == 3,
        )
        write_end = start + len(encoded)
        if write_end > len(current):
            raise Type2Error("test text exceeds the tag's advertised user memory")

        first_page = 4 + start // 4
        last_page = 4 + (write_end - 1) // 4
        if last_page > MAX_STATIC_LOCK_PAGE:
            raise Type2Error(
                "NDEF is outside pages 4..15; dynamic-lock handling is required"
            )

        static_locks = (await self.read_page(2))[2:4]
        for page in range(first_page, last_page + 1):
            if page <= 7 and static_locks[0] & (1 << page):
                raise Type2Error(f"Type 2 page {page} is statically locked")
            if 8 <= page <= 15 and static_locks[1] & (1 << (page - 8)):
                raise Type2Error(f"Type 2 page {page} is statically locked")

        updated = bytearray(current)
        updated[start:start + len(encoded)] = encoded

        length_offset = start + 1
        staged = bytearray(updated)
        if encoded[1] == 0xFF:
            staged[length_offset + 1:length_offset + 3] = b"\x00\x00"
        else:
            staged[length_offset] = 0
        commit_page = 4 + length_offset // 4

        def page_data(memory: bytes | bytearray, page: int) -> bytes:
            offset = (page - 4) * 4
            return bytes(memory[offset:offset + 4])

        pages = list(range(first_page, last_page + 1))
        staged_commit = page_data(staged, commit_page)
        if page_data(current, commit_page) != staged_commit:
            await self._write_page(commit_page, staged_commit, info.uid)
        for page in pages:
            if page == commit_page:
                continue
            data = page_data(staged, page)
            if page_data(current, page) != data:
                await self._write_page(page, data, info.uid)
        final_commit = page_data(updated, commit_page)
        if staged_commit != final_commit:
            await self._write_page(commit_page, final_commit, info.uid)

        verified = await self._read_user_memory(len(current))
        parsed, _, _, _ = _scan_tlvs(verified)
        if parsed is None or parsed.value != message:
            raise Type2Error("NDEF write verification failed")
        return message
