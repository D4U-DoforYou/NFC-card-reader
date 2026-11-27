"""Command line entry point for talking to one RF device over BLE."""
from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
import time
from pathlib import Path

from .client import DeviceClient
from .core.jobs import JobState
from .ota.delta_patch import build_patch
from .protocol import device_pb2
from .transport.ble_gatt import BleGattTransport
from .nfc.type2 import (
    Type2Session,
    decode_text_record,
    decode_uri_record,
)
from .nfc.mifare_classic import MifareClassicSession
from .nfc.iso_dep import scan_type_a


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="rf-device")
    parser.add_argument("--device", help="BLE device name or address")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--info", action="store_true")
    actions.add_argument(
        "--ota",
        nargs="+",
        type=Path,
        metavar="FILE",
        help=(
            "one .bin/.patch for direct OTA, or OLD.bin NEW.bin to "
            "build and upload a CH572D delta"
        ),
    )
    actions.add_argument("--get-tx-amplitude", action="store_true")
    actions.add_argument("--set-tx-amplitude", type=int, choices=range(4))
    actions.add_argument("--scan-type-a", action="store_true")
    actions.add_argument("--type2-read", action="store_true")
    actions.add_argument("--type2-write", metavar="TEXT")
    actions.add_argument("--mifare-read", type=int, metavar="BLOCK")
    actions.add_argument(
        "--mifare-write", nargs=2, metavar=("BLOCK", "HEX_DATA")
    )
    parser.add_argument("--uid", help="MIFARE Classic 卡片 UID")
    parser.add_argument("--key", help="MIFARE Classic 六字节扇区密钥")
    parser.add_argument("--key-type", choices=("A", "B"), default="A")
    parser.add_argument("--confirm-uid", help="写入时确认完整卡片 UID")
    return parser.parse_args()


def _confirm_target_uid(expected_uid: str, supplied_uid: str | None) -> str:
    if supplied_uid is not None:
        return supplied_uid
    if not sys.stdin.isatty():
        raise ValueError(
            f"确认写入目标 UID，请传入 --confirm-uid {expected_uid}"
        )
    return input(f"输入卡片 UID {expected_uid} 以确认写入：").strip()


async def _run_type2(client: DeviceClient, args: argparse.Namespace) -> None:
    session = Type2Session(client)
    try:
        tag = await session.open()
        uid = tag.uid.hex().upper()
        version = tag.version.hex().upper() if tag.version else "不可用"
        capacity = tag.capability_container[2] * 8
        print(f"Type 2 UID: {uid} · SAK 0x{tag.sak:02X} · ATQA 0x{tag.atqa:04X}")
        print(f"GET_VERSION: {version}")
        print(
            f"Capability Container: {tag.capability_container.hex().upper()} "
            f"· 用户区 {capacity} bytes · 写权限 {tag.capability_container[3] & 0x0F}"
        )

        backup = Path(tempfile.gettempdir()) / (
            f"rf-device-type2-{uid}-{time.time_ns()}.bin"
        )
        backup.write_bytes(tag.user_memory)
        print(f"用户区备份: {backup}")
        if tag.ndef_tlv is None:
            print("NDEF: 未发现 NDEF TLV")
        else:
            message = tag.ndef_tlv.value
            print(f"NDEF ({len(message)} bytes): {message.hex().upper()}")
            text = decode_text_record(message)
            if text is not None:
                print(f"NDEF 文本: {text}")
            uri = decode_uri_record(message)
            if uri is not None:
                print(f"NDEF URI: {uri}")

        if args.type2_write is not None:
            confirm_uid = _confirm_target_uid(uid, args.confirm_uid)
            message = await session.write_text(args.type2_write, confirm_uid)
            print(f"NDEF 写入并读回验证成功: {decode_text_record(message)}")
    finally:
        await session.close()


async def _run_mifare_classic(client: DeviceClient, args: argparse.Namespace) -> None:
    if not args.uid or not args.key:
        raise ValueError("MIFARE Classic 操作必须提供 --uid 和 --key")
    try:
        uid = bytes.fromhex(args.uid)
        key = bytes.fromhex(args.key)
    except ValueError as exc:
        raise ValueError("UID 和密钥必须是十六进制字符串") from exc
    if len(uid) not in (4, 7, 10):
        raise ValueError("UID 必须是 4、7 或 10 字节")
    if len(key) != 6:
        raise ValueError("MIFARE Classic 密钥必须是 6 字节")

    session = MifareClassicSession(client)
    try:
        tag = await session.open(expected_uid=uid)
        print(
            f"MIFARE Classic 1K · UID {tag.uid.hex().upper()} · "
            f"SAK 0x{tag.sak:02X} · ATQA 0x{tag.atqa:04X}"
        )
        if args.mifare_read is not None:
            data = await session.read_block(
                args.mifare_read, key, key_type=args.key_type
            )
            print(f"Block {args.mifare_read}: {data.hex().upper()}")
            return

        block_text, data_text = args.mifare_write
        try:
            block = int(block_text, 0)
            data = bytes.fromhex(data_text)
        except ValueError as exc:
            raise ValueError("块号必须是整数，数据必须是十六进制") from exc
        confirm_uid = _confirm_target_uid(
            tag.uid.hex().upper(), args.confirm_uid
        )
        if confirm_uid.replace(" ", "").upper() != tag.uid.hex().upper():
            raise ValueError("确认 UID 与当前卡片 UID 不匹配")
        written = await session.write_block(
            block, data, key, key_type=args.key_type
        )
        print(f"Block {block} 写入并回读验证成功: {written.hex().upper()}")
    finally:
        await session.close()


async def _run(args: argparse.Namespace) -> None:
    ota_purpose = "firmware"
    ota_chunk_size = 512
    ota_progress_interval = 64 * 1024
    ota_label = None
    ota_image = None
    if args.ota is not None:
        if len(args.ota) == 2:
            base_path, target_path = args.ota
            if base_path.suffix.lower() != ".bin" or target_path.suffix.lower() != ".bin":
                raise ValueError("旧版和新版固件都必须是 .bin 文件")
            ota_image = build_patch(base_path.read_bytes(), target_path.read_bytes())
            ota_label = f"{base_path} -> {target_path}（自动生成差分包）"
            ota_purpose = "firmware_patch"
            ota_chunk_size = 256
            ota_progress_interval = 4 * 1024
        elif len(args.ota) == 1:
            ota_path = args.ota[0]
            extension = ota_path.suffix.lower()
            if extension == ".patch":
                ota_purpose = "firmware_patch"
                ota_chunk_size = 256
                ota_progress_interval = 4 * 1024
            elif extension != ".bin":
                raise ValueError("OTA 文件必须是 .bin 或 .patch")
            ota_image = ota_path.read_bytes()
            ota_label = str(ota_path)
        else:
            raise ValueError("--ota 用法：--ota 旧版.bin 新版.bin")

    client = DeviceClient(BleGattTransport(args.device))
    await client.connect()
    try:
        if args.set_tx_amplitude is not None:
            level = await client.set_tx_amplitude(args.set_tx_amplitude)
            print(f"TxAmp level: {level}")
        elif ota_image is not None:
            print(f"上传固件: {ota_label} ({len(ota_image)} bytes)", flush=True)
            last_progress = 0

            def report_progress(sent: int, total: int) -> None:
                nonlocal last_progress
                if sent == total or sent - last_progress >= ota_progress_interval:
                    print(f"OTA 进度: {sent}/{total} bytes", flush=True)
                    last_progress = sent
                if sent == total and ota_purpose == "firmware_patch":
                    print("传输完成，等待设备安装并重连确认…", flush=True)

            await client.upload_firmware(
                ota_image,
                chunk_size=ota_chunk_size,
                purpose=ota_purpose,
                progress=report_progress,
            )
            if ota_purpose == "firmware_patch":
                print("CH572D 差分固件已安装，已重连并确认版本更新")
            else:
                print("固件已校验并切换启动槽，设备正在重启")
        elif args.get_tx_amplitude:
            print(f"TxAmp level: {await client.get_tx_amplitude()}")
        elif args.scan_type_a:
            result = await scan_type_a(client)
            if result.found:
                print(f"ISO14443-A UID: {bytes(result.uid).hex().upper()}")
                print(f"SAK: 0x{result.sak:02X}; ATQA: 0x{result.atqa:04X}")
            else:
                print("No ISO14443-A card found")
        elif args.type2_read or args.type2_write is not None:
            await _run_type2(client, args)
        elif args.mifare_read is not None or args.mifare_write is not None:
            await _run_mifare_classic(client, args)
        else:
            job = await client.start_job("org.example.device.info", "get")
            event = await job.wait()
            if event.state != JobState.COMPLETED:
                raise RuntimeError(event.detail or "device info request failed")
            info = device_pb2.DeviceInfoResult.FromString(event.result)
            print(f"Firmware: {info.firmware_name} {info.firmware_version}")
            print(f"Radio: {info.radio_controller}")
            print(f"Bluetooth MAC: {bytes(info.bluetooth_mac).hex(':')}")
            print(f"Device ID: {bytes(info.device_id).hex()}")
    finally:
        await client.close()


def main() -> None:
    asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    main()
