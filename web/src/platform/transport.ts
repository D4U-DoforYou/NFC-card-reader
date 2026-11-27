/**
 * 传输层抽象。
 *
 * 小程序里只有一条路：微信蓝牙 API。网页端要同时支持**浏览器蓝牙**与
 * **USB HID**，所以把「连接 / 写入 / 收数据 / 状态」抽成这个接口，
 * 上层的设备会话（core/protocol）完全不感知底下走的是哪条路。
 *
 * 这一层只搬运**字节**，不认识帧格式、更不认识协议消息：
 * 帧的切分与消息的解析都在 core/protocol 里按硬件方案完成，
 * 这样以后换硬件方案、换协议都不用动传输层。
 */

import type { HardwareProfile, WriteOptions } from '@/core/protocol/types'

/** 传输状态，与小程序的 BleStatus 同义。 */
export type TransportStatus = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error'

/** 传输方式。 */
export type TransportKind = 'bluetooth' | 'usb'

/** 日志级别，与小程序的 BleTraceLevel 同义。 */
export type TraceLevel = 'info' | 'warn' | 'error' | 'success'

export interface Transport {
  /** 这条传输是什么方式。 */
  readonly kind: TransportKind
  /** 当前状态。 */
  readonly status: TransportStatus
  /** 单次写入最多承载多少字节（ATT MTU 减 3）。 */
  readonly chunkSize: number
  setVerifiedChunkSize?(size: number): void
  /** 某条链路连续丢帧时，要求切换为每片确认。 */
  setReliableWrites?(enabled: boolean): void
  /** 已连接设备名。 */
  readonly connectedName: string
  /** 已连接设备标识（蓝牙是 device.id，USB 是端口信息）。 */
  readonly connectedDeviceId: string
  /** 连接时刻。 */
  readonly connectedAt: number
  /** 识别出的硬件方案；未连接或认不出来时为 null。 */
  readonly hardwareProfile: HardwareProfile | null
  /**
   * 最近一次信号强度。
   *
   * 浏览器蓝牙 API 不提供 RSSI，这里如实给 null，
   * 界面上显示「信号未知」，不拿别的数字冒充。
   */
  readonly lastRssi: number | null
  /** 连接耗时（毫秒），用来估吞吐。 */
  readonly connectedDurationMs: number
  /**
   * 累计写入字节数。
   *
   * 刷完一次图想知道「到底往设备里写了多少字节」时用：
   * 取两次快照相减就是这一次的传输量（含协议分帧开销）。
   */
  readonly writtenBytes: number
  /** 累计写入次数（每次不超过 chunkSize）。 */
  readonly writeCount: number
  /** 可选的底层写入等待累计值（毫秒）。 */
  readonly writeDurationMs?: number

  connect(target?: string): Promise<void>
  disconnect(): Promise<void>
  /**
   * 写一段字节，单次不超过 chunkSize 即可。
   *
   * 分片由协议层负责：只有它知道帧的边界，才能在写失败时正确地重来。
   *
   * BLE 写入方式由协议层选定：有限窗口内允许无响应写，窗口边界等 ATT 确认；
   * USB HID 忽略确认选项，保持报告顺序。
   */
  writeChunk(bytes: Uint8Array, options?: WriteOptions): Promise<void>

  onStatus(listener: (status: TransportStatus, message: string) => void): () => void
  /** 订阅设备发来的字节流；返回取消订阅的函数。 */
  onData(listener: (bytes: Uint8Array) => void): () => void
  onTrace(listener: (message: string, level: TraceLevel) => void): void
  onError(listener: (message: string) => void): void
}

/** 把任意错误翻译成人能看的一句话。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/**
 * 传输管理器：持有当前生效的传输方式，并允许在蓝牙 / USB 之间切换。
 *
 * 页面上所有地方都用它，而不是直接用具体实现——切换方式时上层不需要改。
 */
class TransportManager implements Transport {
  kind: TransportKind = 'bluetooth'
  status: TransportStatus = 'idle'
  connectedName = ''
  connectedDeviceId = ''
  connectedAt = 0
  hardwareProfile: HardwareProfile | null = null
  lastRssi: number | null = null
  connectedDurationMs = 0

  /**
   * 跟随当前传输的实际分片大小。
   *
   * 蓝牙这一侧的上限会随设备协商结果变化（按设备发过来的分片长度反推），
   * 所以这里不能缓存一份快照——快照会停在连接开始时的保守值。
   */
  get chunkSize(): number {
    return this.active.chunkSize
  }

  /** 累计写入量跟随当前传输，换通道后自然从新通道的计数开始。 */
  get writtenBytes(): number {
    return this.active.writtenBytes
  }

  get writeCount(): number {
    return this.active.writeCount
  }

  get writeDurationMs(): number {
    return this.active.writeDurationMs ?? 0
  }

  setVerifiedChunkSize(size: number): void {
    this.active.setVerifiedChunkSize?.(size)
  }

  setReliableWrites(enabled: boolean): void {
    this.active.setReliableWrites?.(enabled)
  }

  private bindingVersion = 0
  private active: Transport
  private statusListeners: Array<(status: TransportStatus, message: string) => void> = []
  private dataListeners: Array<(bytes: Uint8Array) => void> = []
  private traceListeners: Array<(message: string, level: TraceLevel) => void> = []
  private errorListeners: Array<(message: string) => void> = []

  constructor(active: Transport) {
    this.active = active
    this.bindActive()
  }

  /** 换成另一条传输方式；先断开当前连接，再挂上新实现。 */
  use(next: Transport): void {
    const previous = this.active
    if (previous === next) {
      return
    }
    void previous.disconnect().catch(() => undefined)
    this.active = next
    this.kind = next.kind
    this.status = 'idle'
    this.connectedName = ''
    this.connectedDeviceId = ''
    this.connectedAt = 0
    this.hardwareProfile = null
    this.lastRssi = null
    this.connectedDurationMs = 0
    this.bindActive()
    this.emitStatus('idle', '')
  }

  private bindActive(): void {
    const source = this.active
    const version = ++this.bindingVersion
    source.onStatus((status, message) => {
      if (this.active !== source || this.bindingVersion !== version) return
      this.syncFromActive()
      this.status = status
      if (status === 'connected') {
        this.connectedAt = this.connectedAt || Date.now()
      }
      this.emitStatus(status, message)
    })
    source.onData(bytes => {
      if (this.active !== source || this.bindingVersion !== version) return
      this.dataListeners.forEach(listener => listener(bytes))
    })
    source.onTrace((message, level) => {
      if (this.active !== source || this.bindingVersion !== version) return
      this.traceListeners.forEach(listener => listener(message, level))
    })
    source.onError(message => {
      if (this.active !== source || this.bindingVersion !== version) return
      this.errorListeners.forEach(listener => listener(message))
    })
  }

  /** 把当前传输的运行时字段同步到管理器。 */
  private syncFromActive(): void {
    this.connectedName = this.active.connectedName
    this.connectedDeviceId = this.active.connectedDeviceId
    this.connectedAt = this.active.connectedAt
    this.hardwareProfile = this.active.hardwareProfile
    this.lastRssi = this.active.lastRssi
    this.connectedDurationMs = this.active.connectedDurationMs
  }

  async connect(target?: string): Promise<void> {
    await this.active.connect(target)
    this.syncFromActive()
  }

  async disconnect(): Promise<void> {
    await this.active.disconnect()
    this.syncFromActive()
    this.status = 'idle'
  }

  async writeChunk(bytes: Uint8Array, options?: WriteOptions): Promise<void> {
    await this.active.writeChunk(bytes, options)
  }

  onStatus(listener: (status: TransportStatus, message: string) => void): () => void {
    this.statusListeners.push(listener)
    return () => { this.statusListeners = this.statusListeners.filter(item => item !== listener) }
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.push(listener)
    return () => {
      this.dataListeners = this.dataListeners.filter(item => item !== listener)
    }
  }

  onTrace(listener: (message: string, level: TraceLevel) => void): void {
    this.traceListeners.push(listener)
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener)
  }

  private emitStatus(status: TransportStatus, message: string): void {
    this.statusListeners.forEach(listener => listener(status, message))
  }
}

export const transportManager = new TransportManager(
  // 真正的实现由 platform/index.ts 注入，避免这里出现循环依赖。
  createPlaceholderTransport(),
)

/**
 * 占位实现。
 *
 * 只在模块加载顺序上占个位：platform/index.ts 会在启动时用真实实现替换掉它。
 */
function createPlaceholderTransport(): Transport {
  const listeners: Array<(status: TransportStatus, message: string) => void> = []
  const noop = () => undefined
  const noopUnsubscribe = (_listener: (bytes: Uint8Array) => void) => () => undefined
  return {
    kind: 'bluetooth',
    status: 'idle',
    chunkSize: 20,
    connectedName: '',
    connectedDeviceId: '',
    connectedAt: 0,
    hardwareProfile: null,
    lastRssi: null,
    connectedDurationMs: 0,
    writtenBytes: 0,
    writeCount: 0,
    async connect() {
      listeners.forEach(listener => listener('error', '传输层尚未初始化'))
    },
    async disconnect() {},
    async writeChunk() {},
    onStatus(listener) {
      listeners.push(listener)
      return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) }
    },
    onData: noopUnsubscribe,
    onTrace: noop,
    onError: noop,
  }
}
