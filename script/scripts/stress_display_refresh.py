"""对华为 552×768 显示器执行 A/B 交替刷图压力测试。"""
from __future__ import annotations

import argparse
import asyncio
import csv
import sys
import time
from datetime import datetime
from pathlib import Path

from rf_platform.client import DeviceClient
from rf_platform.display.detect import read_display_screen
from rf_platform.display.huawei import (
    DEFAULT_PIN,
    ImageAlgorithm,
    ImageOptions,
    HuaweiScreen,
    prepare_huawei_image,
    refresh_huawei_screen,
)
from rf_platform.nfc.iso_dep import IsoDepSession
from rf_platform.transport.ble_gatt import BleGattTransport

DEFAULT_IMAGES = (
    Path(__file__).resolve().parents[1] / "test-images" / "复杂纹理-A.png",
    Path(__file__).resolve().parents[1] / "test-images" / "复杂纹理-B.png",
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="以两张复杂图片交替刷新华为 552×768 屏幕"
    )
    parser.add_argument("--device", help="BLE 设备名称或地址")
    parser.add_argument("--confirm-uid", required=True, help="屏幕 UID，十六进制")
    parser.add_argument("--rounds", type=int, default=100, help="刷图轮数，默认 100")
    parser.add_argument("--interval", type=float, default=0,
                        help="每轮完成后的等待秒数，默认 0")
    parser.add_argument("--image-a", type=Path, default=DEFAULT_IMAGES[0])
    parser.add_argument("--image-b", type=Path, default=DEFAULT_IMAGES[1])
    parser.add_argument("--log", type=Path,
                        help="CSV 日志路径，默认保存在 logs 目录")
    parser.add_argument(
        "--algorithm",
        choices=tuple(item.value for item in ImageAlgorithm),
        default=ImageAlgorithm.ATKINSON.value,
        help="量化算法；默认 Atkinson",
    )
    return parser


def _report_progress(stage: str, current: int, total: int) -> None:
    suffix = f" {current}/{total}" if total else ""
    print(f"  {stage}{suffix}", flush=True)


def _is_uncertain_result(error: Exception) -> bool:
    return "uncertain" in str(error).lower() or "不确定" in str(error)


async def _run(args: argparse.Namespace) -> int:
    if args.rounds < 1:
        raise ValueError("--rounds 必须大于 0")
    if args.interval < 0:
        raise ValueError("--interval 不能小于 0")
    if len(args.confirm_uid) % 2:
        raise ValueError("--confirm-uid 必须是偶数个十六进制字符")
    try:
        expected_uid = bytes.fromhex(args.confirm_uid)
    except ValueError as exc:
        raise ValueError("--confirm-uid 必须是十六进制") from exc

    image_paths = (args.image_a, args.image_b)
    prepared_images = []
    for path in image_paths:
        if not path.is_file():
            raise FileNotFoundError(f"找不到测试图：{path}")
        prepared_images.append(prepare_huawei_image(
            path.read_bytes(), ImageOptions(algorithm=ImageAlgorithm(args.algorithm))
        ))
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_path = args.log or Path("logs") / f"屏幕刷图压力测试-{timestamp}.csv"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    client = DeviceClient(BleGattTransport(args.device))
    session = IsoDepSession(client)
    succeeded = 0
    failed = 0
    uncertain = 0
    needs_reactivation = False
    try:
        await client.connect()
        profile, screen, info = await read_display_screen(session, "huawei")
        if profile != "huawei" or not isinstance(screen, HuaweiScreen):
            raise RuntimeError("当前脚本只支持华为 552×768 屏幕")
        if screen.uid != expected_uid:
            raise RuntimeError(
                f"UID 不匹配：当前屏幕 {screen.uid.hex().upper()}，"
                f"指定屏幕 {expected_uid.hex().upper()}"
            )

        print(
            f"目标：Huawei {info['width']}×{info['height']}，"
            f"UID {info['uid']}，固件 {info['firmware']}"
        )
        print(f"轮数：{args.rounds}；图像数据包：A={len(prepared_images[0].packets)}，"
              f"B={len(prepared_images[1].packets)}")
        print(f"日志：{log_path}")

        with log_path.open("w", newline="", encoding="utf-8-sig") as log_file:
            writer = csv.writer(log_file)
            writer.writerow(("轮次", "图像", "开始时间", "结果", "耗时秒", "数据包数", "错误"))
            log_file.flush()
            for round_number in range(1, args.rounds + 1):
                image_index = (round_number - 1) % 2
                image_name = "A" if image_index == 0 else "B"
                prepared = prepared_images[image_index]
                started_at = datetime.now().astimezone().isoformat(timespec="seconds")
                started = time.monotonic()
                print(f"第 {round_number}/{args.rounds} 轮：图像 {image_name}")
                error = ""
                try:
                    if needs_reactivation:
                        activation = await session.activate()
                        if activation.uid != screen.uid:
                            raise RuntimeError(
                                "重新激活后发现的屏幕 UID 与目标不一致"
                            )
                        needs_reactivation = False
                    await refresh_huawei_screen(
                        session, screen, prepared, pin=DEFAULT_PIN,
                        progress=_report_progress,
                    )
                    result = "成功"
                    succeeded += 1
                except asyncio.CancelledError:
                    result = "中断"
                    error = "收到中断信号；本轮写入结果可能不确定"
                    elapsed = time.monotonic() - started
                    writer.writerow((round_number, image_name, started_at, result,
                                     f"{elapsed:.2f}", len(prepared.packets), error))
                    log_file.flush()
                    raise
                except Exception as exc:
                    needs_reactivation = True
                    if _is_uncertain_result(exc):
                        result = "结果不确定"
                        uncertain += 1
                    else:
                        result = "失败"
                    failed += 1
                    error = f"{type(exc).__name__}: {exc}"

                elapsed = time.monotonic() - started
                writer.writerow((round_number, image_name, started_at, result,
                                 f"{elapsed:.2f}", len(prepared.packets), error))
                log_file.flush()
                print(f"  {result}，耗时 {elapsed:.1f} 秒")
                if error:
                    print(f"  错误：{error}", file=sys.stderr)
                if args.interval and round_number < args.rounds:
                    await asyncio.sleep(args.interval)
    finally:
        try:
            await session.deactivate()
        except Exception:
            pass
        await client.close()

    print(
        f"测试结束：成功 {succeeded}/{args.rounds} 轮，失败 {failed} 轮，"
        f"结果不确定 {uncertain} 轮；日志：{log_path}"
    )
    return 0 if failed == 0 else 1


def main() -> None:
    args = _parser().parse_args()
    try:
        exit_code = asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("测试已中断；请重新扫描屏幕确认当前显示状态。", file=sys.stderr)
        exit_code = 130
    except Exception as exc:
        print(f"测试未能启动：{type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = 2
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
