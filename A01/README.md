# A01 · ESP32-C3 固件

本目录包含 RF 设备的 ESP32-C3 固件、共享协议和设计文档。固件通过 BLE GATT 与主机通信，并驱动 CLRC663 执行射频操作；主机端实现位于 [`script/`](../script/)。

## 目录

- `firmware/`：ESP-IDF 应用、板级代码、可移植核心和芯片 SDK。
- `protocol/`：Protobuf 消息定义、Nanopb 选项和协议测试向量。
- `sdkconfig`、`sdkconfig.defaults`：ESP-IDF 项目配置。

协议会话、消息格式和 BLE 特征说明见 [协议约定](protocol/README.md)。

## 构建固件

完整固件需要 ESP-IDF 6.1 及对应工具链。安装并导出 ESP-IDF 环境后，在本目录（`A01/`）运行：

```bash
idf.py set-target esp32c3
idf.py build
idf.py -p PORT flash monitor
```

CMake 中间文件位于 `build/`，固件产物位于 `output/`。固件使用双 OTA 分区；设备会校验新镜像，并在新固件未确认有效时回滚。

不安装 ESP-IDF 时，可以单独构建可移植平台核心：

```bash
cmake -S firmware/components/platform_core -B /tmp/rf-platform-core-cxx
cmake --build /tmp/rf-platform-core-cxx
ctest --test-dir /tmp/rf-platform-core-cxx --output-on-failure
```

## 当前范围

固件通过 BLE GATT 提供设备信息和 CLRC663 射频能力，所有射频访问由固件调度器串行管理。USB 用于供电、烧录和 JTAG 调试，不承载设备控制。
