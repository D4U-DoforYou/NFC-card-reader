---
name: nfc-hardware-operator
description: Operate D4U NFC reader hardware through this repository's Python host tools, or extend the host software and device protocol for a requested hardware feature.
metadata:
  short-description: Operate and extend D4U NFC hardware
---

# D4U NFC 硬件操作与开发

使用本 Skill 完成 D4U NFC 读写器的主机端操作、设备协议排查，或为 Python 主机工具增加功能。先查清设备方案、当前固件能力和标签类型，再选择已有命令或实现路径。

## 获取代码

官方仓库：<https://github.com/D4U-DoforYou/NFC-card-reader>

```bash
git clone https://github.com/D4U-DoforYou/NFC-card-reader.git
cd NFC-card-reader
```

如果仓库已存在，先检查 `git status`、当前分支和远端地址。仅在需要同步上游且工作区没有待保留改动时，才执行 `git pull --ff-only`；不要覆盖用户修改，也不要推送代码，除非用户明确要求。

## 仓库结构与设备边界

- `A01/`：ESP32-C3 固件、协议定义和 CLRC663 射频驱动。设备通过 BLE GATT 控制；USB 主要用于供电、烧录和调试。
- `script/`：Python 主机工具，通过 BLE 连接设备，包含 `rf-device` CLI、显示器工具和本地 Web 服务。
- `web/`：独立的桌面浏览器应用，支持 Web Bluetooth 和 USB HID。
- `B01/`：先检查目录内容和说明。若没有固件源码，不能把计划中的 CH572D 能力当作当前可操作能力；差分 OTA 也必须由实际设备固件支持。

以仓库内的 `README.md`、`A01/README.md`、`A01/protocol/README.md`、`script/README.md` 和固件能力注册代码为准。读写器的射频原语不等于每种卡片型号都已支持或验证；遇到未知标签，应报告已知协议能力和验证状态，不要推断芯片型号。

## 安装和运行 Python 工具

要求 Python 3.11+ 和 `uv`。在仓库根目录执行：

```bash
cd script
uv sync --extra ble --extra web
uv run rf-device --help
```

CLI 通过 BLE 操作设备。可先用 `--device` 指定广播名或地址，并使用 `--info` 查看设备信息：

```bash
uv run rf-device --device D4U-NFCA01-XXXX --info
```

按需使用 `--scan-type-a`、`--type2-read`、`--type2-write TEXT`、`--mifare-read BLOCK` 或 `--mifare-write BLOCK HEX_DATA`。具体参数和前置条件以 `uv run rf-device --help` 为准。`--type2-write` 和 `--mifare-write` 会修改实体标签；只有在用户明确要求写入并确认目标标签后才执行。写入前读取并核对 UID，按 CLI 要求提供 `--confirm-uid`；不要对未知标签或未经确认的块执行写入。

显示器操作：

```bash
uv run rf-device-display --help
```

本地 Web 控制台：

```bash
uv run rf-device-web
```

Python 工具目前通过 BLE 工作；需要 USB HID 时使用 `web/` 浏览器应用，不要把 Python BLE 命令描述成 USB 控制。

## OTA

- 单文件 `.bin` 是完整固件上传；先确认镜像对应目标设备和固件槽位。
- `uv run rf-device --ota OLD.bin NEW.bin` 会生成并上传 CH572D 差分补丁。基线文件必须与设备当前安装的 APP 完全一致；不匹配时停止，不要用版本号相同的重编译产物代替。
- 只有设备端实现并启用了对应 OTA 接收流程时，上传才可用。升级后应按工具反馈重连设备并确认固件版本。

更多限制见 `script/README.md` 和 `B01/README.md`。OTA 会改变设备固件；用户要求升级前，应核对目标方案、基线与目标镜像，并清楚说明升级对象。

## 扩展主机功能

先确认请求属于 Python CLI / NFC 协议，还是浏览器 Web 应用。Python 常见扩展位置：

- 命令行参数和分发：`script/src/rf_platform/__main__.py`
- 设备操作与客户端：`script/src/rf_platform/client_operations.py`、`client.py`
- 标签协议：`script/src/rf_platform/nfc/`
- BLE 传输与帧封装：`script/src/rf_platform/transport/`
- 设备消息定义：`A01/protocol/device.proto`；主机副本：`script/protocol/device.proto`

新增协议消息或字段时，检查并同步固件与主机定义，遵循 Nanopb 选项和现有协议测试契约；不要只改一端，也不要假设设备已经实现新命令。先找出固件已注册的能力和操作名，再决定主机如何调用。新增 Web 功能应在 `web/src/` 及其 `core/protocol/`、`platform/` 层按现有硬件方案隔离设计，不要把浏览器专属 API 引入 Python 包。

改完后按改动范围运行相关检查。Python 单元测试命令：

```bash
cd script
uv run python -m unittest discover -s tests -v
```

只有在实际连接设备和标签后才能声称完成了实机验证；离线测试通过应明确标为软件测试。
