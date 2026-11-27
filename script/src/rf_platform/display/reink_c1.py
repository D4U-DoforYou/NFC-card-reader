"""Reink Case C1 discovery, image preparation, and refresh workflow."""
from __future__ import annotations

import io
import math
from collections.abc import Callable
from dataclasses import dataclass

from PIL import Image, ImageOps

from ..nfc.iso_dep import IsoDepSession
from .huawei import DEFAULT_PIN
from .image_utils import fit_image
from .models import ImageAlgorithm, ImageOptions
from .session_utils import deactivate_quietly


READ_INFO = bytes.fromhex("00 D1 00 00 00")
READ_CUSTOM_INFO = bytes.fromhex("F0 D8 00 00 05 00 00 00 00 0E")
VERIFY_PIN_HEADER = bytes.fromhex("00 20 00 01 05")
REFRESH = bytes.fromhex("F0 D4 85 00 00")
WIDTH = 240
HEIGHT = 416
PACKED_BYTES = WIDTH * HEIGHT // 4
LZO_BLOCK_SIZE = 2000
MAX_D3_DATA = 246
PALETTE = {
    "00": (0, 0, 0),
    "01": (255, 255, 255),
    "02": (255, 0, 0),
    "03": (255, 255, 0),
}


class ReinkC1Error(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ReinkC1Screen:
    uid: bytes
    width: int
    height: int
    color_count: int
    firmware: int
    compression: bool
    scan_vertical: bool
    flip_horizontal: bool
    flip_vertical: bool
    color_codes: dict[str, int]


@dataclass(frozen=True, slots=True)
class PreparedReinkC1Image:
    packed: bytes
    packets: tuple[bytes, ...]
    preview_png: bytes


def parse_screen(response: bytes) -> ReinkC1Screen:
    if len(response) < 2 or response[-2:] != b"\x90\x00":
        status = response[-2:].hex().upper() if len(response) >= 2 else "missing"
        raise ReinkC1Error(f"C1 D1 read failed: SW={status}")
    fields = _parse_tlvs(response[:-2])
    for tag, size in {0xA0: 7, 0xA1: 7, 0xC0: 4, 0xC1: 4, 0xD1: 7}.items():
        if len(fields.get(tag, b"")) != size:
            raise ReinkC1Error(f"C1 D1 field {tag:02X} has an invalid length")

    profile = fields[0xA0]
    colors = profile[2] >> 4
    raw_height = int.from_bytes(profile[3:5], "big")
    raw_width = int.from_bytes(profile[5:7], "big")
    if colors == 2:
        if raw_width >= raw_height:
            raw_width //= 2
        else:
            raw_height //= 2
        colors = 4
    if raw_width == 0 or raw_height == 0:
        raise ReinkC1Error("C1 screen reports zero dimensions")

    encoded_version = fields[0xD1][1]
    high, low = encoded_version >> 4, encoded_version & 0x0F
    if high > 9 or low > 9:
        raise ReinkC1Error("C1 firmware version is not valid BCD")
    firmware = high * 10 + low
    scan_vertical = fields[0xA1][0] == 0
    if firmware == 10:
        # The first-generation C1 controller uses horizontal scanning even
        # when A1 advertises the newer controller's vertical scan flag.
        scan_vertical = False
    if (firmware != 10 or colors != 4 or
            (raw_width, raw_height) not in ((WIDTH, HEIGHT), (HEIGHT, WIDTH))):
        raise ReinkC1Error(
            f"unsupported Reink panel: {raw_width}x{raw_height}, "
            f"{colors} colors, firmware {firmware}"
        )
    if (raw_width, raw_height) == (HEIGHT, WIDTH):
        raise ReinkC1Error("landscape C1 panels are not supported yet")

    codes = {"00": 0, "01": 1, "02": 3, "03": 2}
    return ReinkC1Screen(
        uid=fields[0xC1],
        width=raw_width,
        height=raw_height,
        color_count=colors,
        firmware=firmware,
        compression=bool(fields[0xC0][3]),
        scan_vertical=scan_vertical,
        flip_horizontal=bool(profile[1] & 0x80),
        flip_vertical=bool(profile[1] & 0x40),
        color_codes=codes,
    )


async def read_reink_c1_screen(
    session: IsoDepSession,
) -> tuple[ReinkC1Screen, dict]:
    activation = await session.activate(0x26)
    uid = bytes(activation.uid)
    try:
        response = await session.exchange(uid, READ_INFO)
        screen = parse_screen(response)
        if screen.uid != uid:
            raise ReinkC1Error("C1 D1 UID does not match the activated tag")
        info = {
            "product": "Reink Case C1",
            "uid": screen.uid.hex().upper(),
            "width": screen.width,
            "height": screen.height,
            "colors": screen.color_count,
            "firmware": screen.firmware,
            "compression": screen.compression,
        }
        return screen, info
    except Exception:
        await deactivate_quietly(session)
        raise


def prepare_reink_c1_image(
    image_data: bytes,
    screen: ReinkC1Screen,
    options: ImageOptions,
) -> PreparedReinkC1Image:
    if not image_data:
        raise ValueError("image file is empty")
    if not screen.compression:
        raise ReinkC1Error("Reink Case C1 must report D3 compression support")

    image = _prepare_canvas(image_data, screen, options)
    if options.algorithm == ImageAlgorithm.GRAYSCALE:
        image = ImageOps.grayscale(image).convert("RGB")
    packed, preview = _quantize(image, screen, options.algorithm)
    if len(packed) != PACKED_BYTES:
        raise ReinkC1Error(f"packed C1 image must contain {PACKED_BYTES} bytes")
    packets = _build_d3_packets(packed)
    output = io.BytesIO()
    preview.save(output, format="PNG")
    return PreparedReinkC1Image(packed, packets, output.getvalue())


def prepare_reink_c1_preview(image_data: bytes,
                             options: ImageOptions) -> PreparedReinkC1Image:
    screen = ReinkC1Screen(
        uid=b"preview",
        width=WIDTH,
        height=HEIGHT,
        color_count=4,
        firmware=10,
        compression=True,
        scan_vertical=False,
        flip_horizontal=False,
        flip_vertical=False,
        color_codes={"00": 0, "01": 1, "02": 3, "03": 2},
    )
    return prepare_reink_c1_image(image_data, screen, options)


def _prepare_canvas(data: bytes, screen: ReinkC1Screen,
                    options: ImageOptions) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGBA")
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError("image file is unsupported or damaged") from exc
    return fit_image(
        image,
        (screen.width, screen.height),
        fit=options.fit,
        rotation=options.rotation,
    )


def _quantize(image: Image.Image, screen: ReinkC1Screen,
              algorithm: ImageAlgorithm) -> tuple[bytes, Image.Image]:
    palette = [(PALETTE[key], screen.color_codes[key])
               for key in screen.color_codes]
    pixels = [list(pixel) for pixel in image.getdata()]
    choices = []
    if algorithm != ImageAlgorithm.COLOR:
        for y in range(screen.height):
            for x in range(screen.width):
                index = y * screen.width + x
                choice = _nearest(tuple(pixels[index]), palette)
                choices.append(choice)
                error = [pixels[index][channel] - palette[choice][0][channel]
                         for channel in range(3)]
                if algorithm == ImageAlgorithm.ATKINSON:
                    neighbors = ((x + 1, y, 1 / 8), (x + 2, y, 1 / 8),
                                 (x - 1, y + 1, 1 / 8), (x, y + 1, 1 / 8),
                                 (x + 1, y + 1, 1 / 8), (x, y + 2, 1 / 8))
                elif algorithm in (ImageAlgorithm.FLOYD, ImageAlgorithm.GRAYSCALE):
                    neighbors = ((x + 1, y, 7 / 16), (x - 1, y + 1, 3 / 16),
                                 (x, y + 1, 5 / 16), (x + 1, y + 1, 1 / 16))
                    if algorithm == ImageAlgorithm.GRAYSCALE:
                        gray = round(sum(pixels[index][:3]) / 3)
                        error = [gray - palette[choice][0][channel]
                                 for channel in range(3)]
                else:
                    raise ValueError(f"unsupported image algorithm: {algorithm}")
                for nx, ny, weight in neighbors:
                    if 0 <= nx < screen.width and ny < screen.height:
                        target = pixels[ny * screen.width + nx]
                        for channel in range(3):
                            target[channel] = max(
                                0, min(255, target[channel] +
                                       _round(error[channel] * weight))
                            )

    packed = bytearray(PACKED_BYTES)
    preview_pixels = []
    index = 0
    for outer in range(screen.width if screen.scan_vertical else screen.height):
        for inner in range(screen.height if screen.scan_vertical else screen.width):
            original_x, original_y = ((outer, inner) if screen.scan_vertical
                                      else (inner, outer))
            x = screen.width - 1 - original_x if screen.flip_horizontal else original_x
            y = screen.height - 1 - original_y if screen.flip_vertical else original_y
            pixel_index = y * screen.width + x
            if algorithm == ImageAlgorithm.COLOR:
                choice = _nearest(tuple(pixels[pixel_index]), palette)
            else:
                choice = choices[pixel_index]
            color, code = palette[choice]
            preview_pixels.append(color)
            bit_offset = inner % 4
            byte_index = index // 4
            packed[byte_index] |= ((code >> 1) & 1) << (7 - bit_offset * 2)
            packed[byte_index] |= (code & 1) << (6 - bit_offset * 2)
            index += 1
    preview = Image.new("RGB", (screen.width, screen.height), "white")
    ordered = [None] * (screen.width * screen.height)
    for position, color in enumerate(preview_pixels):
        original_x, original_y = ((position // screen.height, position % screen.height)
                                  if screen.scan_vertical else
                                  (position % screen.width, position // screen.width))
        x = screen.width - 1 - original_x if screen.flip_horizontal else original_x
        y = screen.height - 1 - original_y if screen.flip_vertical else original_y
        ordered[y * screen.width + x] = color
    preview.putdata(ordered)
    return bytes(packed), preview


def _build_d3_packets(packed: bytes) -> tuple[bytes, ...]:
    try:
        import lzokay
    except ImportError as exc:
        raise ReinkC1Error("C1 upload needs lzokay; install host display extras") from exc
    packets = []
    for block_index, offset in enumerate(range(0, len(packed), LZO_BLOCK_SIZE)):
        block = packed[offset:offset + LZO_BLOCK_SIZE]
        compressed = lzokay.compress(block)
        if lzokay.decompress(compressed, len(block)) != block:
            raise ReinkC1Error(f"LZO round-trip failed for C1 block {block_index}")
        if len(compressed) > MAX_D3_DATA:
            raise ReinkC1Error(
                f"C1 block {block_index} compresses to {len(compressed)} bytes; "
                f"this firmware can send at most {MAX_D3_DATA} D3 bytes per "
                "ISO-DEP frame. Choose direct-color quantization or use a simpler image."
            )
        packets.append(bytes((0xF0, 0xD3, 0, 1, len(compressed) + 2,
                              block_index, 0)) + compressed)
    return tuple(packets)


async def refresh_reink_c1_screen(
    session: IsoDepSession,
    screen: ReinkC1Screen,
    prepared: PreparedReinkC1Image,
    *,
    pin: bytes = DEFAULT_PIN,
    upload_only: bool = False,
    progress: Callable[[str, int, int], None] | None = None,
) -> None:
    if len(pin) != 5:
        raise ValueError("C1 PIN must contain exactly 5 bytes")
    report = progress or (lambda _stage, _current, _total: None)
    custom = await session.exchange(screen.uid, READ_CUSTOM_INFO)
    if custom[-2:] == b"\x69\x85":
        verify = VERIFY_PIN_HEADER + pin
        require_success(await session.exchange(screen.uid, verify), "PIN")
    elif len(custom) < 2 or custom[-2:] != b"\x90\x00":
        raise ReinkC1Error(f"C1 D8 failed: SW={_status(custom)}")

    for index, packet in enumerate(prepared.packets, start=1):
        report("上传 C1 图像块", index - 1, len(prepared.packets))
        try:
            response = await session.exchange(screen.uid, packet)
        except Exception as exc:
            raise ReinkC1Error(
                f"D3 {index}/{len(prepared.packets)} result is uncertain; "
                "do not resend this packet"
            ) from exc
        require_success(response, f"D3 {index}/{len(prepared.packets)}")
    report("上传 C1 图像块", len(prepared.packets), len(prepared.packets))
    if upload_only:
        return

    report("请求 C1 屏幕刷新", 0, 1)
    try:
        response = await session.exchange(
            screen.uid, REFRESH, deadline_ms=190_000
        )
    except Exception as exc:
        raise ReinkC1Error(
            f"D4 refresh result is uncertain; do not resend: {exc}"
        ) from exc
    require_success(response, "D4 refresh")
    report("C1 刷新完成", 1, 1)


def require_success(response: bytes, context: str) -> bytes:
    if len(response) < 2 or response[-2:] != b"\x90\x00":
        raise ReinkC1Error(f"{context} failed: SW={_status(response)}")
    return response[:-2]


def _parse_tlvs(payload: bytes) -> dict[int, bytes]:
    fields = {}
    offset = 0
    while offset < len(payload):
        if offset + 2 > len(payload):
            raise ReinkC1Error("truncated C1 D1 TLV header")
        tag, length = payload[offset], payload[offset + 1]
        offset += 2
        if tag in fields or offset + length > len(payload):
            raise ReinkC1Error("duplicate or truncated C1 D1 TLV")
        fields[tag] = payload[offset:offset + length]
        offset += length
    return fields


def _nearest(pixel, palette) -> int:
    return min(range(len(palette)), key=lambda index: sum(
        (pixel[channel] - palette[index][0][channel]) ** 2
        for channel in range(3)
    ))


def _round(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def _status(response: bytes) -> str:
    return response[-2:].hex().upper() if len(response) >= 2 else "missing"
