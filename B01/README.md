# B01 · CH572D 固件移植

> **状态：暂缓提供。** 本目录目前只有本文档，固件工程尚未随仓库发布。下文记录目标硬件映射、构建和升级方案，相关命令须待工程文件发布后使用；硬件验证也尚未完成。

计划中的 CH572D 移植将复用 A01 的协议、能力路由、任务调度、Nanopb 和 CLRC663 逻辑，并支持 BLE GATT 与 USB HID 通信。

## 目录

- [硬件引脚](#硬件引脚)
- [Flash 分区与差分 OTA](#flash-分区与差分-ota)
- [首次烧录](#首次烧录)
- [构建](#构建)
- [验证状态](#验证状态)

## 硬件引脚

| 功能 | CH572D 引脚 | 用途 |
| --- | --- | --- |
| RF 状态 LED | PA4 | 射频场亮灯，收发期间按活动闪烁 |
| CLRC663 CS | PA3 | SPI 片选，软件控制 |
| CLRC663 SCK | PA5 | CH572 SPI 时钟 |
| CLRC663 MISO | PA6 | SPI 输入 |
| CLRC663 MOSI | PA7 | SPI 输出 |
| CLRC663 PDOWN (RESET) | PA8 | 高电平掉电，拉低后启动 |
| CLRC663 IRQ | PA9 | 上拉输入，当前供后续中断调度使用 |

SPI 时钟和数据脚与 `EVT/EXAM/SPI/SPI_8bit` 例程一致。本板按原理图使用 PA3 作为软件控制的片选；不要把 PA3 当作 UART TX 使用。

PA8 同时可复用为 CH572D 外部复位输入。由于本板用 PA8 驱动 CLRC663 的 PDOWN，固件启动时会检测并关闭占用 PA8 的复位输入配置，使该脚可作为 GPIO 输出。


## Flash 分区与差分 OTA

| 分区 | 起始地址 | 大小 |
| --- | --- | ---: |
| Boot / IAP | `0x00000000` | 12 KB |
| APP | `0x00003000` | 176 KB |
| BLE SNV | `0x0002F000` | 4 KB |
| Patch | `0x00030000` | 44 KB |
| META | `0x0003B000` | 4 KB |
| 系统 Boot / Info（保留） | `0x0003C000` | 16 KB |

应用链接到 APP 区。Patch 区首个 4 KB 擦除块作掉电恢复暂存，差分文件最多 40 KB；META 保存更新状态和逐页恢复记录。CH572 擦除后的空闲字读回为 `0xF3F9BDA9`，状态和进度日志按此值找空位；状态变化追加到新位置，避免重复编程同一个字。差分生成器也用此值填充镜像末页。BLE SNV 独占 `0x2F000` 擦除块；`0x3C000` 及以上为芯片系统保留区，不可用于 OTA。

差分格式按 4 KB 页编码 XOR 变更段。APP 接收结束时先校验补丁基线，拒绝与当前固件不匹配的补丁。Boot 再校验当前 APP，再把待改页备份到 Patch 暂存区、重建 APP 页并记录进度；中途复位后会重做未完成页。安装失败时按页倒序回滚，先恢复占用暂存区的未完成页，再复用暂存区。生成 Patch：

```sh
python3 tools/make_delta_patch.py old.bin new.bin update.patch
```

`old.bin` 必须与设备当前安装的 APP 二进制一致，`new.bin` 是新 APP 二进制。请保存每次实际烧录的 BIN；工具链、构建参数及生成器（Make/Ninja）也应保持一致，不能仅按版本号重新编译旧固件来当基线。每次发布需递增 `RF_FIRMWARE_VERSION`，电脑端会在重启后重连同一设备并确认版本变化，未确认安装则报错。主机以 `firmware_patch` 作为 `TransferBegin.purpose`，发送 Patch 文件长度和文件 SHA-256，并按 256 字节或更小数据块传输。若差分大于 40 KB，生成器会拒绝；需要更小的更新或使用 USB 烧录完整镜像。

也可以让 Python 命令行自动生成差分并上传：`uv run rf-device --ota old.bin new.bin`。这里的 `old.bin` 必须是设备当前固件的精确构建产物，`new.bin` 是目标固件；原有 `--ota update.patch` 用法仍可直接上传已生成的补丁。

## 首次烧录

首次烧录时，IAP 镜像写入 `0x00000000`，APP 镜像写入 `0x00003000`。两个 MounRiver 工程都应关闭 `Erase All`，避免单独烧录时擦除另一个镜像；APP 工程的编程地址和 HEX 数据地址均为 `0x3000`。

当前 SHA-256 只检查传输内容是否一致，不验证镜像签名；BLE 写特征和 USB HID 均没有应用层客户端鉴权。因此 OTA 只应在可信的 BLE 或 USB 连接上使用，不能用来确认固件来源。

## 构建

构建需要 MounRiver Studio 所带的 WCH RISC-V 工具链，使用默认 `-Os`、不开 LTO。链接器同时检查 Flash 和 RAM 边界，APP 为运行栈预留 1 KB；SRAM 仅 12 KB，新增静态对象或扩大缓冲区时必须重新评估内存。

也可以使用 CMake 构建。工具链配置会按程序名在系统 `PATH` 中搜索 WCH GCC，不写死 MounRiver 安装目录；Windows 会自动搜索 `.exe` 文件。请先安装 MounRiver Studio 自带的 WCH RISC-V GCC，并确保其 `bin` 目录在 `PATH` 中：

协议绑定由 Nanopb 的 Python generator 从 `protocol/device.proto` 生成。首次构建前，在运行 CMake 所用的 Python 环境中安装 Nanopb：

```sh
python3 -m pip install nanopb
```

如果装在另一个 Python 环境，设置 `RF_PROTOCOL_PYTHON` 指向该 Python 可执行文件后再运行 CMake。例如 macOS/Linux：

```sh
RF_PROTOCOL_PYTHON=/path/to/python cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wch-riscv-toolchain.cmake
```

Windows PowerShell 可先运行 `$env:RF_PROTOCOL_PYTHON = "C:\\path\\to\\python.exe"`，再执行下面的 CMake 命令。缺少 generator 时，CMake 也会打印对应的安装和重跑命令。

```sh
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wch-riscv-toolchain.cmake
cmake --build build --parallel
```

如果不想修改 `PATH`，可选用 `-DWCH_TOOLCHAIN_BIN=<bin目录>` 或环境变量 `WCH_TOOLCHAIN_BIN` 指定工具目录。Windows、Linux、macOS 都需要安装 CMake 和 Make 或 Ninja 等构建工具。

构建产物统一放在工程根目录的 `output/`，文件名带纯语义版本号（默认 `0.0.112`）。APP 与完整镜像分别是 `rf_device_platform_CH572D_v0.0.112.bin`、`rf_device_platform_CH572D_full_v0.0.112.hex`。发布下一个版本时递增 `RF_FIRMWARE_VERSION`；如用 MounRiver 构建，需同步修改 `.wvproj` 中的版本化产物名。如只构建 APP 或 Bootloader，可配置 `-DRF_BUILD_IAP=OFF` 或 `-DRF_BUILD_APP=OFF`。

为适配 12 KB SRAM，APP 的 `.highcode_lp` 放在 Flash；中断向量、高优先级代码和 Flash ROM 操作函数仍放在 RAM。此配置依赖 `HAL_SLEEP=FALSE`；若开启低功耗睡眠，需恢复 `.highcode_lp` 的 RAM 放置并重新评估内存。本次已验证实板 BLE 连接及差分 OTA；掉电恢复覆盖主机模拟测试，尚未进行实板断电测试。

## 验证状态

设计记录称已在实板验证 BLE 连接和差分 OTA；掉电恢复只覆盖主机模拟，尚未进行实板断电测试。由于本目录当前未包含固件源码和测试脚本，以下命令需待工程发布后再运行。OTA Bootloader 主机回归测试需要 C 编译器，覆盖安装、错误基线、目标校验失败、写入失败和安装/回滚期间的 70 个掉电位置：

```sh
python3 tests/ota/run_tests.py
```
