/**
 * 协议层的公共接口。
 *
 * 这一层刻意不认识蓝牙：它只认「字节进、字节出」的通道。
 * 硬件方案（A01 及以后的方案）各自的 GATT UUID、帧格式、消息契约
 * 都封装在自己的目录里，差异不外泄。
 */

/** 单次 BLE 写入的流控选项。 */
export interface WriteOptions {
  /** 等待 ATT 确认；帧内受限批次中的确认用于流控，帧尾必定确认。 */
  confirm?: boolean
}

/** 字节通道：协议层与传输层之间的唯一契约。 */
export interface ProtocolByteChannel {
  /** 单次写入的最大字节数（ATT MTU 减 3）。 */
  readonly chunkSize: number
  /** 记录完整只读协议回包验证过的分片长度。 */
  setVerifiedChunkSize?(size: number): void
  /** 某条链路连续丢帧时，要求切换为每片确认。 */
  setReliableWrites?(enabled: boolean): void
  /**
   * 写一段字节，单次不超过 chunkSize 即可。
   *
   * 分片与失败重试由协议层负责——只有它知道帧的边界在哪，
   * 传输层不参与帧的语义。
   *
   * BLE 可按协议层选项使用有限窗口无响应写，窗口边界和帧尾等待 ATT 确认；
   * USB HID 忽略此选项，按报告顺序发送。
   */
  writeChunk(bytes: Uint8Array, options?: WriteOptions): Promise<void>
  /** 订阅设备发来的字节流。 */
  onData(listener: (bytes: Uint8Array) => void): () => void
}

/** 操作描述符。 */
export interface OperationDescriptor {
  id: string
  /** 是否会改变设备或标签状态。 */
  mutating: boolean
  cancellable: boolean
  maxPayloadSize: number
  /** 是否需要绑定用户确认过的目标 UID。 */
  requiresTargetConfirmation: boolean
}

/** 能力描述符。 */
export interface CapabilityDescriptor {
  id: string
  majorVersion: number
  minorVersion: number
  operations: OperationDescriptor[]
}

/** 作业事件。 */
export interface JobEvent {
  jobId: number
  /** 作业状态码。 */
  state: number
  /** 阶段说明。 */
  stage: string
  progressCurrent: number
  progressTotal: number
  /** 错误码。 */
  errorCode: number
  /** 失败详情。 */
  detail: string
  /** 结果负载。 */
  result: Uint8Array
}

/** 会话握手信息。 */
export interface SessionHello {
  deviceId: Uint8Array
  bootId: Uint8Array
  protocolMajor: number
  protocolMinor: number
  maxControlMessage: number
  maxDataChunk: number
  maxInFlightJobs: number
  /** 设备支持的传输名。 */
  transports: string[]
}

/** 设备信息。 */
export interface DeviceInfo {
  deviceId: Uint8Array
  bootId: Uint8Array
  firmwareName: string
  firmwareVersion: string
  radioController: string
  /** 蓝牙 MAC；旧固件未提供时为空。 */
  bluetoothMac?: Uint8Array
}

/** 一次原始射频收发的结果。 */
export interface RawRfFrame {
  /** 收到的字节。 */
  rx: Uint8Array
  /** 最后一个接收字节的有效位数。 */
  rxLastBits: number
  /** IRQ0 状态。 */
  irq0: number
  /** IRQ1 状态。 */
  irq1: number
  /** 射频错误寄存器。 */
  error: number
  /** 冲突寄存器。 */
  collision: number
}

/** 一次原始射频收发的选项。 */
export interface RawRfOptions {
  /** 单次射频等待上限（毫秒）。 */
  timeoutMs?: number
  /** 最后一个发送字节的有效位数，0 表示 8 位。 */
  txLastBits?: number
  /** 接收位对齐设置。 */
  rxAlign?: number
  /** CRC 标志：bit0 由读卡器补发送 CRC，bit1 由读卡器校验并剥离接收 CRC。 */
  crcFlags?: number
  /** 接收模式编号。 */
  rxMode?: number
  /** 发送模式编号；不填则与接收模式相同。 */
  txMode?: number
  /** 用户确认过的目标 UID，写操作必须带上。 */
  confirmedTargetUid?: Uint8Array
}

export interface ChipCommandResult {
  fifoOutput: Uint8Array
  irq0: number
  irq1: number
  error: number
  status: number
}

export interface FirmwareProgress {
  stage: 'preparing' | 'uploading' | 'finalizing' | 'rebooting'
  sent: number
  total: number
}
export interface FirmwareImageInfo { chipId?: number; version: string; project: string }

export interface FirmwareUploadOptions {
  signal?: AbortSignal
  onProgress?: (progress: FirmwareProgress) => void
}

/** 设备会话：协议层对外的统一入口。 */
/** 主机观测的协议阶段累计值；各阶段不代表纯空口或纯射频时间。 */
export interface ProtocolTransferStats {
  requests: number
  submitMs: number
  firstReceiveWaitMs: number
  responseReceiveMs: number
  terminalWaitMs: number
  receivedChunks: number
  receivedBytes: number
  /** 帧没送到设备、整帧重发的次数。 */
  frameReplays: number
}

export interface DeviceSession {
  readonly transferStats?: ProtocolTransferStats
  /** 本次会话对应的硬件方案。 */
  readonly profile: HardwareProfile
  /** 设备广播的能力列表。 */
  readonly capabilities: CapabilityDescriptor[]
  /** 握手信息；未连接时为 null。 */
  readonly hello: SessionHello | null
  /** 握手并拉取能力列表。 */
  connect(): Promise<SessionHello>
  /** 关闭会话。 */
  close(): Promise<void>
  /** 读取设备信息。 */
  getDeviceInfo(): Promise<DeviceInfo>
  /** 读取当前发射功率档位。 */
  getTxAmplitude(): Promise<number>
  /** 设置发射功率档位（0..3）。 */
  setTxAmplitude(level: number): Promise<number>
  /** 开关射频场。 */
  setRfField(enabled: boolean): Promise<void>
  /** 收发一帧原始射频数据。 */
  rawTransceive(tx: Uint8Array, options?: RawRfOptions): Promise<RawRfFrame>
  /** 可选硬件原语：按设备声明的能力使用。 */
  executeChipCommand?(command: number, fifoInput: Uint8Array, options: { timeoutMs?: number; confirmedTargetUid: Uint8Array }): Promise<ChipCommandResult>
  readChipRegister?(address: number): Promise<number>
  writeChipRegister?(address: number, value: number): Promise<void>
  /** Apply board-specific Classic reception settings and return their cleanup. */
  prepareClassicRf?(): Promise<() => Promise<void>>
  /** OTA 只上传应用镜像；完成后设备会重启。 */
  uploadFirmware?(image: Uint8Array, options?: FirmwareUploadOptions): Promise<void>
  inspectFirmware?(image: Uint8Array): FirmwareImageInfo
  readonly firmwareUpdating?: boolean
  readonly firmwareRequiresReconnect?: boolean
}

/** 硬件方案档案。 */
export interface HardwareProfile {
  /** 方案编号，例如 'A01'。 */
  readonly scheme: string
  /** 展示名。 */
  readonly label: string
  /** 广播名前缀。 */
  readonly namePrefix: string
  /** GATT 服务 UUID。 */
  readonly serviceUuid: string
  /** 主机→设备的特征 UUID。 */
  readonly rxUuid: string
  /** 设备→主机的特征 UUID。 */
  readonly txUuid: string
  readonly firmwareTarget?: { chipId: number; label: string }
  /**
   * 这个方案的硬件是否支持「自动休眠」。
   *
   * 有些硬件的升压电路在射频场关闭时负载太轻，供电会自行断掉，
   * 设备随即掉电。这类设备不能把射频场一关就不管，得用短脉冲保活
   * （见 core/rf/autoSleep.ts）。没声明这个能力的方案按老办法处理：
   * 空闲关场即可，不要去脉冲它。
   */
  readonly supportsAutoSleep?: boolean
  /** Scheme-specific controller presets; upper layers must not assume numeric IDs. */
  readonly rfPresets?: {
    rxModes: ReadonlyArray<{ id: number; label: string }>
    txModes: ReadonlyArray<{ id: number; label: string }>
    typeA: { rx: number; tx: number }
    typeB: { rx: number; tx: number }
    felica: { rx: number; tx: number }
    typeV: { rx: number; tx: number }
  }
  /** 用给定通道建立会话。 */
  createSession(channel: ProtocolByteChannel): DeviceSession
}
