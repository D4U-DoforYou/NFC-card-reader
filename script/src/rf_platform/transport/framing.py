"""Length, COBS, and CRC framing for device protocol messages."""
from __future__ import annotations

import struct
import zlib


MAX_CONTROL_FRAME = 10_541
_HEADER_SIZE = 4
_CRC_SIZE = 4


class FrameError(ValueError):
    pass


def encode_frame(payload: bytes, *, max_size: int = MAX_CONTROL_FRAME) -> bytes:
    if not payload or len(payload) > max_size:
        raise FrameError("invalid payload length")
    raw = struct.pack("<I", len(payload)) + payload
    raw += struct.pack("<I", zlib.crc32(payload) & 0xFFFFFFFF)
    return _cobs_encode(raw) + b"\x00"


def decode_frame(encoded: bytes, *, max_size: int = MAX_CONTROL_FRAME) -> bytes:
    if not encoded:
        raise FrameError("empty frame")
    raw = _cobs_decode(encoded)
    if len(raw) < _HEADER_SIZE + _CRC_SIZE:
        raise FrameError("frame is too short")
    payload_size, = struct.unpack_from("<I", raw)
    if payload_size == 0 or payload_size > max_size:
        raise FrameError("payload length is out of range")
    expected_size = _HEADER_SIZE + payload_size + _CRC_SIZE
    if len(raw) != expected_size:
        raise FrameError("frame length does not match its header")
    payload = raw[_HEADER_SIZE:_HEADER_SIZE + payload_size]
    expected_crc, = struct.unpack_from("<I", raw, _HEADER_SIZE + payload_size)
    if zlib.crc32(payload) & 0xFFFFFFFF != expected_crc:
        raise FrameError("frame checksum mismatch")
    return payload


class FrameStreamDecoder:
    """Reassembles zero-delimited COBS frames from arbitrary byte chunks."""

    def __init__(self, *, max_size: int = MAX_CONTROL_FRAME) -> None:
        self.max_size = max_size
        self._encoded = bytearray()
        self._discarding = False
        self._max_encoded_size = max_size + max_size // 254 + 16

    def feed(self, data: bytes) -> list[bytes]:
        frames = []
        for byte in data:
            if byte == 0:
                if self._encoded and not self._discarding:
                    try:
                        frames.append(decode_frame(
                            self._encoded, max_size=self.max_size
                        ))
                    except FrameError:
                        pass
                self._encoded.clear()
                self._discarding = False
            elif not self._discarding:
                self._encoded.append(byte)
                if len(self._encoded) > self._max_encoded_size:
                    self._encoded.clear()
                    self._discarding = True
        return frames


def _cobs_encode(raw: bytes) -> bytes:
    encoded = bytearray(b"\x00")
    code_index = 0
    code = 1
    for byte in raw:
        if byte == 0:
            encoded[code_index] = code
            code_index = len(encoded)
            encoded.append(0)
            code = 1
        else:
            encoded.append(byte)
            code += 1
            if code == 0xFF:
                encoded[code_index] = code
                code_index = len(encoded)
                encoded.append(0)
                code = 1
    encoded[code_index] = code
    return bytes(encoded)


def _cobs_decode(encoded: bytes) -> bytes:
    decoded = bytearray()
    index = 0
    while index < len(encoded):
        code = encoded[index]
        index += 1
        if code == 0:
            raise FrameError("zero byte in COBS frame")
        count = code - 1
        end = index + count
        if end > len(encoded):
            raise FrameError("truncated COBS block")
        decoded.extend(encoded[index:end])
        index = end
        if code != 0xFF and index < len(encoded):
            decoded.append(0)
    return bytes(decoded)
