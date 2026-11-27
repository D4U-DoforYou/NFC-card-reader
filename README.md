# D4U NFC Card Reader

D4U 开源 NFC 通用透传硬件及配套软件仓库，包含 MCU代码、Python 主机工具和桌面浏览器应用。

## 对硬件支持情况


| 方案 | MCU |USB-HID| NXP CLRC663 | ST ST25R3916 | OTA 支持情况 | 硬件工程 | 3D打印工程 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | ESP32-C3 | ❌| ✅ | ⚠️暂缓支持 | ✅ 支持BLEOTA双分区 | [A01PCB](https://oshwhub.com/hbk444/project_yiqxocez) |[makerworld-全球](https://makerworld.com/zh/models/3657093-nfc-card-reader-a01)  [makerworld-CH](https://makerworld.com.cn/zh/models/3312487-nfc-card-reader-a01) |
| B01 | CH572D |✅ | ✅ | ❌ 无硬件设计 | ❌ ROM太小无法承载 |⚠️验证中|⚠️设计中|

AI 助手进行设备操作、使用 Python 主机工具或扩展功能时，参考[硬件操作 Skill](Doc/nfc-hardware-operator/SKILL.md)。

## 快速开始

### WEB浏览器应用

需要支持 Web Bluetooth / WebHID 的桌面版 Chrome 或 Edge。安装并启动开发服务器：

```bash
cd web
npm install
npm run dev
```

开发服务器默认地址为 `http://localhost:5180`。连接蓝牙或 USB 设备时，需要在浏览器弹窗中由用户选择设备。更多功能、兼容范围和部署方式见 [Web 应用说明](web/README.md)。

### Python 主机工具

需要 Python 3.11 或更新版本及 [uv](https://docs.astral.sh/uv/)。在仓库根目录运行：

```bash
cd script
uv sync --extra ble --extra web
uv run rf-device --help
```

可用 `uv run rf-device-display --help` 查看显示器工具选项，或运行 `uv run rf-device-web` 启动本地网页服务。详细安装、NFC 操作及 OTA 说明见 [Python 工具文档](script/README.md)。

### A01 ESP32-C3 固件

需要 ESP-IDF 6.1 及对应工具链。进入 `A01/` 并导出 ESP-IDF 环境后构建、烧录：

```bash
cd A01
idf.py set-target esp32c3
idf.py build
idf.py -p PORT flash monitor
```

将 `PORT` 替换为设备串口。固件构建目录及可移植核心的独立构建方式见 [A01 固件说明](A01/README.md)。

## 设备与连接

- A01 固件通过 BLE GATT 提供设备信息和 NFC 射频操作；USB 用于供电、烧录和调试。
- Python 工具通过 BLE 连接设备；浏览器应用支持 BLE 和 USB HID。
- 设备应已供电且可连接。当前固件一次只允许一个主机控制端连接。
- 浏览器 BLE / USB 连接由用户点击操作按钮后在系统对话框中选择设备。

具体协议、硬件能力和浏览器兼容范围以各子项目文档及对应固件版本为准。
