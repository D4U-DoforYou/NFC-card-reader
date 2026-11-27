# Python 主机工具

主机端 Python 工具通过 BLE 控制 RF 设备，提供设备 CLI、NFC 操作、电子纸显示器工作流和网页界面。本文档中的命令均从 `script/` 目录运行。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `protocol/` | Protobuf 定义和协议测试向量 |
| `scripts/` | 开发及硬件压力测试脚本 |
| `src/rf_platform/` | Python 包和 Web 界面 |
| `test-images/` | 显示器测试图片 |
| `tests/` | 自动化测试 |

`protocol/device.proto` 是主机端生成 Protobuf 绑定的输入。构建后端会把生成文件写入 `src/rf_platform/protocol/`。

## 安装

需要 Python 3.11 或更新版本，以及 [uv](https://docs.astral.sh/uv/)。在本目录安装 BLE 和网页功能所需依赖：

```bash
uv sync --extra ble --extra web
```

CH572D 差分 OTA 可直接传入旧版和新版 APP BIN，CLI 会生成补丁并上传。以下示例假设 BIN 位于 `B01/output/`：

```bash
uv run rf-device --ota ../B01/output/old.bin ../B01/output/new.bin
```

旧版 BIN 必须与设备当前安装的 APP 完全一致，新版固件需递增版本号。也可直接上传已生成的补丁，例如 `uv run rf-device --ota ../B01/output/update.patch`。传输结束时设备可能在返回确认前重启；客户端会在 45 秒内尝试重连同一设备，只有读回的固件版本发生变化才报告安装成功。明确拒绝、版本未变化或无法重连均会报错。

默认安装包含 Protobuf 代码生成工具。只需运行时依赖时，运行 `uv sync --no-dev`。依赖范围见 `pyproject.toml`；更新依赖约束后重新同步环境。运行单元测试：

```bash
uv run python -m unittest discover -s tests -v
```

## 设备命令与网页

```bash
uv run rf-device --help
uv run rf-device-display --help
uv run rf-device-web
```

`rf-device` 提供设备信息、NFC 扫描/读写和 OTA 等命令，具体参数见 `--help`。`rf-device-web` 启动网页服务，默认地址为 `http://127.0.0.1:8000`。CLI、显示器工具和网页端均通过 BLE 连接设备；使用前请确保设备已供电且可连接。当前固件一次只允许一个主机连接。

## 显示器压力测试

脚本会交替发送两张高细节图片并记录 CSV 结果。运行前先扫描屏幕并确认 UID：

```bash
uv run rf-device-display --scan-only
uv run python scripts/stress_display_refresh.py --confirm-uid <屏幕UID> --rounds 2
```

图片默认从 `test-images/` 读取，日志写入 `logs/`。脚本需要已连接的 BLE 设备和实体屏幕；它是硬件压力测试，不是离线测试。
