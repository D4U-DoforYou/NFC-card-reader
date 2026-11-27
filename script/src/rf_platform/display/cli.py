"""CLI for scanning and updating supported NFC displays."""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from ..client import DeviceClient
from ..nfc.iso_dep import IsoDepSession
from ..transport.ble_gatt import BleGattTransport
from .detect import read_display_screen
from .models import ImageAlgorithm, ImageOptions
from .profiles import DISPLAY_PROFILES
from .huawei import DEFAULT_PIN, refresh_uploaded_huawei_screen


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rf-device-display")
    parser.add_argument("image", nargs="?", type=Path)
    parser.add_argument("--device", help="BLE device name or address")
    parser.add_argument(
        "--profile", choices=("auto", "huawei", "reink-c1"), default="auto",
        help="屏幕型号；默认根据只读 D1 信息自动识别",
    )
    parser.add_argument("--scan-only", action="store_true")
    parser.add_argument(
        "--confirm-uid", help="可选：校验完整屏幕 UID（十六进制）"
    )
    parser.add_argument("--pin", help="5 字节 PIN（十六进制）")
    parser.add_argument("--fit", choices=("contain", "cover"), default="contain")
    parser.add_argument("--rotation", type=int, choices=(0, 90, 180, 270), default=0)
    parser.add_argument(
        "--algorithm",
        choices=tuple(item.value for item in ImageAlgorithm),
        help="图像算法；C1 默认 color，Huawei 默认 atkinson",
    )
    parser.add_argument("--upload-only", action="store_true")
    parser.add_argument(
        "--refresh-uploaded-only",
        action="store_true",
        help="只刷新之前已完整上传到屏幕的图像，不重传图像包",
    )
    return parser


def _hex_bytes(value: str, name: str, length: int | None = None) -> bytes:
    try:
        result = bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be hexadecimal") from exc
    if length is not None and len(result) != length:
        raise ValueError(f"{name} must contain exactly {length} bytes")
    return result


async def _run(args: argparse.Namespace) -> None:
    if args.scan_only and (args.image is not None or args.refresh_uploaded_only):
        raise ValueError("--scan-only cannot be combined with image update options")
    if args.refresh_uploaded_only and args.image is not None:
        raise ValueError("--refresh-uploaded-only does not take an image")
    if args.refresh_uploaded_only and args.upload_only:
        raise ValueError("--refresh-uploaded-only cannot be combined with --upload-only")
    if args.profile == "reink-c1" and args.refresh_uploaded_only:
        raise ValueError("--refresh-uploaded-only is only supported for Huawei")
    if not args.scan_only and not args.refresh_uploaded_only and args.image is None:
        raise ValueError("provide an image or use --scan-only")
    pin = DEFAULT_PIN if not args.pin else _hex_bytes(args.pin, "PIN", 5)

    client = DeviceClient(BleGattTransport(args.device))
    await client.connect()
    session = IsoDepSession(client)
    try:
        profile, screen, info = await read_display_screen(session, args.profile)
        product = info.get("product", "Huawei")
        print(
            f"{product} {screen.width}x{screen.height} · "
            f"{screen.color_count} 色 · UID {screen.uid.hex().upper()} · "
            f"固件 {screen.firmware}"
        )
        if args.scan_only:
            return

        if args.confirm_uid is not None:
            _verify_uid(args.confirm_uid, screen.uid)
        display_profile = DISPLAY_PROFILES[profile]
        algorithm = ImageAlgorithm(
            args.algorithm or display_profile.default_algorithm
        )
        options = ImageOptions(algorithm=algorithm, fit=args.fit,
                               rotation=args.rotation)

        if args.refresh_uploaded_only:
            await refresh_uploaded_huawei_screen(
                session, screen, pin=pin, progress=_report_progress
            )
        else:
            prepared = display_profile.prepare(
                args.image.read_bytes(), screen, options
            )
            await display_profile.refresh(
                session,
                screen,
                prepared,
                pin=pin,
                upload_only=args.upload_only,
                progress=_report_progress,
            )
    finally:
        try:
            await session.deactivate()
        except Exception:
            pass
        await client.close()


def _verify_uid(value: str, expected_uid: bytes) -> None:
    expected = expected_uid.hex().upper()
    confirmed = _hex_bytes(value, "UID")
    if confirmed != expected_uid:
        raise ValueError(f"UID mismatch: current display is {expected}")


def _report_progress(stage: str, current: int, total: int) -> None:
    suffix = f" {current}/{total}" if total else ""
    print(f"{stage}{suffix}", flush=True)


def main() -> None:
    args = _parser().parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
