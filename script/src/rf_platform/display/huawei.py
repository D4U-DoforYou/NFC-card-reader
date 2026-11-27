"""Huawei C2 display discovery, image preparation, and refresh workflow."""
from __future__ import annotations

import asyncio
import hashlib
import io
import math
import time
from collections.abc import Callable
from dataclasses import dataclass

from PIL import Image, ImageEnhance, ImageOps

from ..nfc.iso_dep import IsoDepSession, NfcProtocolError
from .image_utils import fit_image
from .models import ImageAlgorithm, ImageOptions
from .session_utils import deactivate_quietly


WIDTH = 552
HEIGHT = 768
PACKED_BYTES = WIDTH * HEIGHT // 4
PALETTE = ((0, 0, 0), (255, 255, 255), (245, 205, 0), (200, 0, 0))
DEFAULT_PIN = bytes.fromhex("52 65 69 99 19")
READ_INFO = bytes.fromhex("00 D1 00 00 00")
READ_STATUS = bytes.fromhex("F0 DE 00 00 01")
REFRESH = bytes.fromhex("F0 D4 94 80 00")
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_SOURCE_PIXELS = 40_000_000
MAX_COMPRESSED_CHUNK = 250


class HuaweiError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class HuaweiScreen:
    uid: bytes
    width: int
    height: int
    colors: int
    raw_width: int
    raw_height: int
    raw_colors: int
    profile_a0: bytes
    compression: bool
    firmware: int

    @property
    def color_count(self) -> int:
        """Return the color count using the common display interface."""
        return self.colors


@dataclass(frozen=True, slots=True)
class PreparedHuaweiImage:
    packed: bytes
    packets: tuple[bytes, ...]
    preview_png: bytes
    source_sha256: str


def parse_device_info(response: bytes) -> HuaweiScreen:
    payload = require_success(response, "D1")
    fields: dict[int, bytes] = {}
    offset = 0
    while offset < len(payload):
        if offset + 2 > len(payload):
            raise HuaweiError("D1 TLV header is truncated")
        tag, size = payload[offset], payload[offset + 1]
        offset += 2
        if tag in fields or offset + size > len(payload):
            raise HuaweiError("D1 TLV is duplicated or truncated")
        fields[tag] = payload[offset:offset + size]
        offset += size

    for tag, size in ((0xA0, 7), (0xB1, 1), (0xB2, 1),
                      (0xC0, 4), (0xC1, 4)):
        if len(fields.get(tag, b"")) != size:
            raise HuaweiError(f"D1 field {tag:02X} has an invalid length")

    raw_width = int.from_bytes(fields[0xA0][5:7], "big")
    raw_height = int.from_bytes(fields[0xA0][3:5], "big")
    raw_colors = fields[0xB1][0]
    if (raw_width, raw_height, raw_colors) != (WIDTH, HEIGHT * 2, 2):
        raise HuaweiError(
            f"Unsupported Huawei screen format: "
            f"{raw_width}x{raw_height}, {raw_colors} colors"
        )
    return HuaweiScreen(
        uid=fields[0xC1],
        width=WIDTH,
        height=HEIGHT,
        colors=4,
        raw_width=raw_width,
        raw_height=raw_height,
        raw_colors=raw_colors,
        profile_a0=fields[0xA0],
        compression=bool(fields[0xC0][3]),
        firmware=fields[0xB2][0],
    )


async def read_huawei_screen(session: IsoDepSession) -> tuple[HuaweiScreen, dict]:
    activation = await session.activate()
    uid = bytes(activation.uid)
    if not uid or activation.atqa != 0x0004 or not activation.sak & 0x20:
        await deactivate_quietly(session)
        raise HuaweiError("No Huawei ISO14443-A display answered its wake command")
    try:
        response = await session.exchange(uid, READ_INFO)
        screen = parse_device_info(response)
        if screen.uid != uid:
            raise HuaweiError("D1 UID does not match the activated NFC tag")
        if not screen.compression:
            raise HuaweiError("Display does not report compressed D3 support")
        return screen, {
            "uid": uid.hex().upper(),
            "sak": activation.sak,
            "atqa": activation.atqa,
            "width": screen.width,
            "height": screen.height,
            "colors": screen.colors,
            "firmware": screen.firmware,
            "compression": screen.compression,
        }
    except Exception:
        await deactivate_quietly(session)
        raise


def prepare_huawei_image(
    image_data: bytes,
    options: ImageOptions | None = None,
) -> PreparedHuaweiImage:
    options = options or ImageOptions()
    if not image_data or len(image_data) > MAX_IMAGE_BYTES:
        raise ValueError(f"image file must be 1..{MAX_IMAGE_BYTES} bytes")
    try:
        with Image.open(io.BytesIO(image_data)) as source:
            if source.width * source.height > MAX_SOURCE_PIXELS:
                raise ValueError("source image has too many pixels")
            image = ImageOps.exif_transpose(source).convert("RGBA")
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError("unsupported or damaged image file") from exc

    prepared = _fit_image(image, options)
    codes = _quantize(prepared, options)
    packed = _pack_codes(codes)
    if len(packed) != PACKED_BYTES:
        raise AssertionError("packed image size does not match the screen")

    preview = Image.frombytes("P", (WIDTH, HEIGHT), codes)
    preview.putpalette([value for color in PALETTE for value in color] + [0] * 756)
    preview_buffer = io.BytesIO()
    preview.convert("RGB").save(preview_buffer, format="PNG", optimize=True)
    packets = _build_d3_packets(packed)
    return PreparedHuaweiImage(
        packed=packed,
        packets=packets,
        preview_png=preview_buffer.getvalue(),
        source_sha256=hashlib.sha256(image_data).hexdigest(),
    )


async def refresh_huawei_screen(
    session: IsoDepSession,
    screen: HuaweiScreen,
    prepared: PreparedHuaweiImage,
    *,
    pin: bytes = DEFAULT_PIN,
    upload_only: bool = False,
    progress: Callable[[str, int, int], None] | None = None,
    refresh_timeout: float = 120.0,
) -> None:
    if len(pin) != 5:
        raise ValueError("Huawei PIN must be exactly 5 bytes")
    if len(prepared.packed) != PACKED_BYTES or not prepared.packets:
        raise ValueError("prepared image is incomplete")
    if screen.width != WIDTH or screen.height != HEIGHT or screen.colors != 4:
        raise HuaweiError("The selected display is not a supported 4-color panel")

    uid = screen.uid
    report = progress or (lambda _stage, _current, _total: None)
    await _verify_pin(session, uid, pin, report)

    packet_total = len(prepared.packets)
    report("上传图像", 0, packet_total)
    last_percent = 0
    for index, packet in enumerate(prepared.packets, start=1):
        try:
            response = await session.exchange(
                uid, packet, deadline_ms=20_000
            )
        except NfcProtocolError as exc:
            raise HuaweiError(
                f"D3 packet {index}/{packet_total} "
                f"block={packet[5]} subpacket={packet[6]} "
                f"last={bool(packet[3])} data_bytes={len(packet) - 7} "
                f"failed; it was not replayed: {exc}"
            ) from exc
        require_success(response, f"D3 {index}/{packet_total}")
        percent = index * 100 // packet_total
        if percent > last_percent:
            report("上传图像", index, packet_total)
            last_percent = percent

    if upload_only:
        return

    await _trigger_refresh(session, uid, report, refresh_timeout)


async def refresh_uploaded_huawei_screen(
    session: IsoDepSession,
    screen: HuaweiScreen,
    *,
    pin: bytes = DEFAULT_PIN,
    progress: Callable[[str, int, int], None] | None = None,
    refresh_timeout: float = 120.0,
) -> None:
    """Trigger refresh for image data already uploaded to the same display."""
    if len(pin) != 5:
        raise ValueError("Huawei PIN must be exactly 5 bytes")
    if screen.width != WIDTH or screen.height != HEIGHT or screen.colors != 4:
        raise HuaweiError("The selected display is not a supported 4-color panel")

    report = progress or (lambda _stage, _current, _total: None)
    await _verify_pin(session, screen.uid, pin, report)
    await _trigger_refresh(session, screen.uid, report, refresh_timeout)


async def _verify_pin(
    session: IsoDepSession,
    uid: bytes,
    pin: bytes,
    report: Callable[[str, int, int], None],
) -> None:
    verify = bytes.fromhex("00 20 00 01 05") + pin
    for attempt in range(2):
        require_success(await session.exchange(uid, verify), "PIN")
        report("验证屏幕 PIN", attempt + 1, 2)


async def _trigger_refresh(
    session: IsoDepSession,
    uid: bytes,
    report: Callable[[str, int, int], None],
    refresh_timeout: float,
) -> None:
    report("请求屏幕刷新", 0, 1)
    try:
        response = await session.exchange(
            uid, REFRESH, deadline_ms=int(refresh_timeout * 1000)
        )
    except NfcProtocolError as exc:
        raise HuaweiError(
            f"D4 result is uncertain; do not send the refresh command again: {exc}"
        ) from exc
    require_success(response, "D4")

    report("等待屏幕刷新完成", 0, 1)
    deadline = time.monotonic() + refresh_timeout
    while time.monotonic() < deadline:
        response = await session.exchange(uid, READ_STATUS, deadline_ms=20_000)
        status = require_success(response, "DE status")
        if status == b"\x00":
            report("刷新完成", 1, 1)
            return
        if status != b"\x01":
            raise HuaweiError(f"Unknown DE refresh status: {status.hex().upper()}")
        await asyncio.sleep(0.5)
    raise TimeoutError("Huawei display refresh did not finish before timeout")


def require_success(response: bytes, context: str) -> bytes:
    if len(response) < 2 or response[-2:] != b"\x90\x00":
        sw = response[-2:].hex().upper() if len(response) >= 2 else "missing"
        reason = {
            "6992": "LZO decompression failed",
            "6993": "decompressed size mismatch",
            "68CA": "low voltage",
            "68CB": "screen refresh timeout",
        }.get(sw, "")
        raise HuaweiError(f"{context} failed: SW={sw} {reason}".rstrip())
    return response[:-2]


def _fit_image(image: Image.Image, options: ImageOptions) -> Image.Image:
    if options.fit not in ("contain", "cover"):
        raise ValueError("fit must be contain or cover")
    if options.rotation not in (0, 90, 180, 270):
        raise ValueError("rotation must be 0, 90, 180, or 270")
    if not 0.5 <= options.brightness <= 1.5:
        raise ValueError("brightness must be in 0.5..1.5")
    if not 0.5 <= options.contrast <= 1.5:
        raise ValueError("contrast must be in 0.5..1.5")
    if not math.isfinite(options.scale) or not 10 <= options.scale <= 300:
        raise ValueError("scale must be in 10..300")

    fitted = fit_image(
        image, (WIDTH, HEIGHT), fit=options.fit, rotation=options.rotation
    )

    if options.scale != 100:
        size = (max(1, round(WIDTH * options.scale / 100)),
                max(1, round(HEIGHT * options.scale / 100)))
        scaled = fitted.resize(size, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (WIDTH, HEIGHT), "white")
        canvas.paste(scaled, ((WIDTH - size[0]) // 2,
                              (HEIGHT - size[1]) // 2))
        fitted = canvas

    return ImageEnhance.Contrast(
        ImageEnhance.Brightness(fitted).enhance(options.brightness)
    ).enhance(options.contrast)


def _quantize(image: Image.Image, options: ImageOptions) -> bytes:
    algorithm = options.algorithm
    grayscale = algorithm == ImageAlgorithm.GRAYSCALE
    if algorithm == ImageAlgorithm.ATKINSON:
        source = ImageOps.grayscale(image).convert("RGB") if options.black_white else image
        return _atkinson(source, PALETTE[:2] if options.black_white else PALETTE)
    if algorithm not in (ImageAlgorithm.FLOYD, ImageAlgorithm.COLOR,
                         ImageAlgorithm.GRAYSCALE):
        raise ValueError(f"unsupported image algorithm: {algorithm}")
    if grayscale:
        image = ImageOps.grayscale(image).convert("RGB")
    if options.black_white or grayscale:
        dither = (Image.Dither.FLOYDSTEINBERG
                  if algorithm == ImageAlgorithm.FLOYD else Image.Dither.NONE)
        mono = image.convert("L").convert("1", dither=dither).convert("L")
        return bytes(1 if value else 0 for value in mono.tobytes())

    palette = Image.new("P", (1, 1))
    palette.putpalette([value for color in PALETTE for value in color] + [0] * 756)
    dither = (Image.Dither.FLOYDSTEINBERG
              if algorithm == ImageAlgorithm.FLOYD else Image.Dither.NONE)
    quantized = image.quantize(palette=palette, dither=dither)
    return bytes(value if value < 4 else 0 for value in quantized.tobytes())


def _atkinson(image: Image.Image, palette: tuple[tuple[int, int, int], ...]) -> bytes:
    width, height = image.size
    pixels = bytearray(image.tobytes())
    codes = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            index = y * width + x
            offset = index * 3
            source = tuple(pixels[offset:offset + 3])
            code = min(range(len(palette)), key=lambda n: sum(
                (a - b) ** 2 for a, b in zip(source, palette[n])
            ))
            codes[index] = code
            error = tuple(source[c] - palette[code][c] for c in range(3))
            delta = tuple((abs(value) // 8) * (1 if value >= 0 else -1)
                          for value in error)
            targets = []
            if x + 1 < width:
                targets.append(index + 1)
            if x + 2 < width:
                targets.append(index + 2)
            if y + 1 < height:
                targets.extend((index + width - 1, index + width))
                if x + 1 < width:
                    targets.append(index + width + 1)
            if y + 2 < height:
                targets.append(index + 2 * width)
            for target in targets:
                for channel in range(3):
                    position = target * 3 + channel
                    pixels[position] = max(
                        0, min(255, pixels[position] + delta[channel])
                    )
    return bytes(codes)


def _pack_codes(codes: bytes) -> bytes:
    if len(codes) != WIDTH * HEIGHT or any(code > 3 for code in codes):
        raise ValueError("invalid 2-bit pixel buffer")
    packed = bytearray(PACKED_BYTES)
    offset = 0
    for x in range(WIDTH - 1, -1, -1):
        for y in range(HEIGHT - 1, -1, -4):
            packed[offset] = sum(
                codes[(y - bit) * WIDTH + x] << (6 - 2 * bit)
                for bit in range(4)
            )
            offset += 1
    return bytes(packed)


def _build_d3_packets(packed: bytes) -> tuple[bytes, ...]:
    if len(packed) != PACKED_BYTES:
        raise ValueError(f"packed image must contain {PACKED_BYTES} bytes")
    try:
        import lzokay
    except ImportError as exc:
        raise HuaweiError("D3 image upload requires the display dependencies") from exc

    packets = []
    for block_index, start in enumerate(range(0, len(packed), 2000)):
        block = packed[start:start + 2000]
        compressed = lzokay.compress(block)
        if lzokay.decompress(compressed, len(block)) != block:
            raise HuaweiError(f"LZO round-trip check failed for image block {block_index}")
        pieces = [compressed[index:index + MAX_COMPRESSED_CHUNK]
                  for index in range(0, len(compressed), MAX_COMPRESSED_CHUNK)]
        if len(pieces) > 256:
            raise HuaweiError(f"too many D3 sub-packets in image block {block_index}")
        for subpacket, piece in enumerate(pieces):
            is_last = subpacket == len(pieces) - 1
            packets.append(bytes((
                0xF0, 0xD3, 0, int(is_last), len(piece) + 2,
                block_index, subpacket,
            )) + piece)
    return tuple(packets)
