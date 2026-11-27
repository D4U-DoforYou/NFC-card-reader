/**
 * 射频桥：把一帧原始射频数据交给读卡器收发，并等待完整响应。
 *
 * 底层换成 A01 的版本化协议（core/protocol）之后，这一层对外的形状保持不变：
 * `exchange(frame, options)` 收一帧、`setRfField(enabled)` 开关载波。
 * 上层的 ISO-DEP、MIFARE、Type 2 与墨水屏流程因此可以原样复用。
 *
 * 协议没有事务编号，因此同一时间只能有一帧在途；本类用串行队列保证这一点。
 */

import { transportManager } from '../../platform/transport'
import { Transport } from '../../platform/transport'
import { deviceSession } from '../protocol'
import { DeviceSession, ChipCommandResult } from '../protocol/types'
import { crcA, describeErrorBits } from './crc'
import { AutoSleepScheduler, AutoSleepState } from './autoSleep'
import { readerLogs } from '../ble/readerLogs'

/**
 * 空闲多久后自动关闭射频场（毫秒）。
 *
 * 足够长，刷图/读卡的连续操作不会被打断；又足够短，读完卡不会一直辐射。
 */
export const RF_IDLE_OFF_MS = 8000

/**
 * 手动打开射频场后维持多久（毫秒）。
 *
 * 射频场一直开着会让读卡器发热，所以手动打开只维持一分钟；
 * 到点自动关闭，界面上倒计时能让用户知道还剩多久。
 */
export const MANUAL_FIELD_MS = 60 * 1000

/** 射频场状态。 */
export interface FieldState {
  /** 射频场是否开着。 */
  on: boolean
  /** 是否手动开启（手动模式会显示倒计时）。 */
  manual: boolean
  /** 剩余时间（毫秒）；非手动模式为 0。 */
  remainingMs: number
}

/** 一次射频收发的选项。 */
export interface RfFrameOptions {
  /** Accept only a valid Type 2 WRITE 4-bit ACK with optional MINFRAMEERR. */
  allowType2Ack?: boolean
  allowMifareAck?: boolean
  /** Only accept a complete validated short response for Type A activation. */
  shortResponse?: 'atqa' | 'sak'
  /** ISO-DEP: tolerate only MINFRAMEERR on a complete CRC-valid frame. */
  isoDepResponse?: boolean
  /** 最后一个发送字节的有效位数，0 表示 8 位。 */
  txLastBits?: number
  /** 接收位对齐设置。 */
  rxAlign?: number
  /** 由读卡器自动添加发送 CRC。 */
  crcTx?: boolean
  /** 由读卡器校验并剥离接收 CRC。 */
  crcRx?: boolean
  /** 单次射频等待时长（毫秒）。 */
  timeoutMs?: number
  /** 接收模式（CLRC663 预设编号）。 */
  rxMode?: number
  /** 发送模式（CLRC663 预设编号）；不填则与接收模式相同。 */
  txMode?: number
  /** 用户确认过的目标 UID；写操作必须带上。 */
  confirmedTargetUid?: Uint8Array
}

/** 一次射频收发的结果。 */
export interface RfReply {
  /** 收到的字节。 */
  data: Uint8Array
  /** 最后一个接收字节的有效位数。 */
  rxLastBits: number
  /** IRQ0 状态。 */
  irq0Status: number
  /** IRQ1 状态。 */
  irq1Status: number
  /** 射频错误寄存器。 */
  errorStatus: number
  /** 冲突寄存器。 */
  collisionStatus: number
}

/** 射频错误的细节。 */
export interface RfErrorDetail {
  /** 状态码。 */
  status: number
  irq0Status?: number
  irq1Status?: number
  errorStatus?: number
  collisionStatus?: number
  timeoutMs?: number
}

export class RfError extends Error {
  readonly detail: RfErrorDetail

  constructor(message: string, detail: RfErrorDetail) {
    super(message)
    this.name = 'RfError'
    this.detail = detail
  }
}

/** IRQ0 的错误中断位。 */
const IRQ0_ERROR = 0x02

export class RfBridge {
  private fieldHolds = 0

  /** Keep activation alive during image processing and display refresh. */
  retainField(): () => void {
    this.fieldHolds++
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = 0 }
    this.markActivity()
    let released = false
    return () => {
      if (released) return
      released = true
      this.fieldHolds--
      if (this.fieldHolds === 0) this.scheduleIdleOff()
    }
  }

  private readonly transport: Transport
  private chain: Promise<unknown> = Promise.resolve()
  /** 射频场当前是否开着。 */
  private fieldEnabled = false
  /** 空闲关场定时器。 */
  private idleTimer: number = 0
  /** 手动开场的到期时间戳，0 表示不是手动模式。 */
  private manualUntil = 0
  /** 手动关场定时器。 */
  private manualTimer: number = 0
  /** 射频场状态监听。 */
  private fieldListeners: Array<(state: FieldState) => void> = []
  /** 最近一次射频活动的时间戳。 */
  private lastActivityAt = 0
  /** 自动休眠调度器；只在支持的方案上启动。 */
  private readonly autoSleep: AutoSleepScheduler
  /** 自动休眠状态监听。 */
  private autoSleepListeners: Array<(state: AutoSleepState) => void> = []
  /** 上一次记录的深睡状态，用来只记状态跃迁。 */
  private autoSleepAsleep = false

  constructor(transport: Transport = transportManager) {
    this.transport = transport
    this.autoSleep = new AutoSleepScheduler({
      connected: () => this.transport.status === 'connected',
      fieldOn: () => this.fieldEnabled,
      busy: () => this.fieldHolds > 0,
      manual: () => this.manualUntil > Date.now(),
      lastActivityAt: () => this.lastActivityAt,
      setField: on => this.setRfField(on),
    })
    this.autoSleep.onChange(state => {
      this.autoSleepListeners.forEach(listener => listener(state))
      this.noteAutoSleep(state)
    })
    transport.onStatus(status => {
      if (status === 'connected') {
        void this.setRfField(false).catch(() => undefined)
        this.startAutoSleep()
      } else if (status === 'idle' || status === 'error') {
        this.fieldEnabled = false
        this.manualUntil = 0
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = 0
        if (this.manualTimer) clearTimeout(this.manualTimer)
        this.manualTimer = 0
        this.autoSleep.stop()
        this.emitField()
      }
    })
  }

  /**
   * 记一次射频活动。
   *
   * 自动休眠靠这个判断「设备是不是刚被用过」：刚用过就不该急着睡，
   * 深睡窗口从这里重新计时。脉冲自己开关场不算活动，
   * 否则设备会永远醒着。
   */
  private markActivity(): void {
    this.lastActivityAt = Date.now()
    this.autoSleep.notifyActivity()
  }

  /**
   * 深睡与唤醒是状态跃迁，记一笔。
   *
   * 对着连接日志就能看出设备什么时候睡的、什么时候被叫醒的，
   * 排查「传输卡住」时这条线很有用。
   */
  private noteAutoSleep(state: AutoSleepState): void {
    if (state.asleep === this.autoSleepAsleep) return
    this.autoSleepAsleep = state.asleep
    readerLogs.add(
      'info',
      state.asleep
        ? '自动休眠：十分钟没有操作，已停掉唤醒脉冲，设备进入深睡'
        : '自动休眠：设备被唤醒，重新计时',
      'app',
    )
  }

  /** 当前连接的方案是否支持自动休眠。 */
  get autoSleepSupported(): boolean {
    return Boolean(this.transport.hardwareProfile?.supportsAutoSleep)
  }

  /** 自动休眠的状态快照。 */
  get autoSleepState(): AutoSleepState {
    return this.autoSleep.state
  }

  /** 订阅自动休眠状态变化。 */
  onAutoSleep(listener: (state: AutoSleepState) => void): () => void {
    this.autoSleepListeners.push(listener)
    return () => {
      this.autoSleepListeners = this.autoSleepListeners.filter(item => item !== listener)
    }
  }

  /** 开关自动休眠。 */
  setAutoSleepEnabled(enabled: boolean): void {
    this.autoSleep.setEnabled(enabled)
  }

  /** 启动自动休眠调度；不支持的方案按老办法空闲关场。 */
  private startAutoSleep(): void {
    if (!this.autoSleepSupported) {
      this.autoSleep.stop()
      return
    }
    this.autoSleep.start()
  }

  /** 射频场是否开着。 */
  get isFieldOn(): boolean {
    return this.fieldEnabled
  }

  /** 当前射频场状态。 */
  get fieldState(): FieldState {
    return {
      on: this.fieldEnabled,
      manual: this.manualUntil > Date.now(),
      remainingMs: this.manualUntil > Date.now() ? Math.max(0, this.manualUntil - Date.now()) : 0,
    }
  }

  /** 订阅射频场状态变化。 */
  onField(listener: (state: FieldState) => void): () => void {
    this.fieldListeners.push(listener)
    return () => {
      this.fieldListeners = this.fieldListeners.filter(item => item !== listener)
    }
  }

  /** 广播一次射频场状态。 */
  private emitField(): void {
    const state = this.fieldState
    this.fieldListeners.forEach(listener => listener(state))
  }

  /** 串行执行一段任务，避免并发射频帧。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task)
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * 安排一次空闲关场。
   *
   * 射频场一直开着会持续辐射也耗电，没有射频帧在途时就该关掉。
   * 每次收发射频帧都会重新计时，所以刷图、读卡的连续操作不受影响。
   * 手动模式下由手动定时器负责关场，空闲定时器不参与。
   */
  private scheduleIdleOff(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = 0
    }
    if (this.fieldHolds > 0 || this.manualUntil > Date.now()) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = 0
      void this.turnOffField().catch(() => undefined)
    }, RF_IDLE_OFF_MS) as unknown as number
  }

  /**
   * 关闭射频场（幂等）。
   *
   * 连上读卡器但还没用到射频场时就该关掉；用完之后也应该关掉。
   */
  async turnOffField(): Promise<void> {
    if (this.transport.status !== 'connected') return
    this.clearManualTimer()
    this.manualUntil = 0
    this.emitField()
    await this.setRfField(false)
  }

  /**
   * 手动打开射频场，默认一分钟后自动关闭。
   *
   * 手动模式期间空闲关场不生效，倒计时走完才关——
   * 这样用户能持续把卡贴近读卡器，而不会因为几秒没动静就被掐掉。
   */
  async turnOnFieldManually(durationMs = MANUAL_FIELD_MS): Promise<void> {
    // 先标记手动模式，开场流程里的空闲定时器才会让路。
    this.manualUntil = Date.now() + durationMs
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = 0
    }
    this.markActivity()
    try {
      await this.setRfField(true)
    } catch (error) {
      this.clearManualTimer()
      this.manualUntil = 0
      this.emitField()
      throw error
    }
    this.clearManualTimer()
    this.manualTimer = setTimeout(() => {
      this.manualTimer = 0
      this.manualUntil = 0
      if (this.fieldHolds === 0) void this.turnOffField().catch(() => undefined)
      this.emitField()
    }, durationMs) as unknown as number
    this.emitField()
  }

  /** 清掉手动关场定时器（不动手动模式的到期时间）。 */
  private clearManualTimer(): void {
    if (this.manualTimer) {
      clearTimeout(this.manualTimer)
      this.manualTimer = 0
    }
  }

  /** 发送一帧原始射频数据并等待完整响应。 */
  exchange(frame: Uint8Array, options: RfFrameOptions = {}): Promise<RfReply> {
    return this.run(async () => {
      // 有射频帧在途就别急着关场，重新计时即可。
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.markActivity()
      if (!this.fieldEnabled) {
        await this.doSetRfField(true)
        await delay(100)
      }
      try {
        return await this.doExchange(frame, options)
      } finally {
        this.scheduleIdleOff()
      }
    })
  }

  private async doExchange(frame: Uint8Array, options: RfFrameOptions): Promise<RfReply> {
    if (frame.length < 1 || frame.length > 256) {
      throw new Error('射频帧长度必须为 1..256 字节')
    }
    const session = await deviceSession.require()
    const timeoutMs = options.timeoutMs ?? 100
    const crcFlags = (options.crcTx ? 0x01 : 0) | (options.crcRx ? 0x02 : 0)

    const request: Record<string, unknown> = {
      timeoutMs,
      txLastBits: options.txLastBits ?? 0,
      rxAlign: options.rxAlign ?? 0,
      crcFlags,
    }
    if (options.rxMode !== undefined) {
      request.rxMode = options.rxMode
    }
    if (options.txMode !== undefined) {
      request.txMode = options.txMode
    }
    if (options.confirmedTargetUid) {
      request.confirmedTargetUid = options.confirmedTargetUid
    }

    const result = await session.rawTransceive(frame, request)
    const reply: RfReply = {
      data: result.rx,
      rxLastBits: result.rxLastBits,
      irq0Status: result.irq0,
      irq1Status: result.irq1,
      errorStatus: result.error,
      collisionStatus: result.collision,
    }
    const shortWriteAck = options.allowType2Ack && frame[0] === 0xa2 &&
      ((frame.length === 6 && options.crcTx) || (frame.length === 8 && !options.crcTx)) && !options.txLastBits &&
      !options.crcRx && reply.rxLastBits === 4 && reply.data.length === 1 &&
      (reply.data[0] & 15) === 0x0a && (reply.errorStatus & ~0x10) === 0
    const crcValid = (bytes: Uint8Array): boolean => {
      if (bytes.length < 3) return false
      const crc = crcA(bytes.slice(0, -2))
      return crc[0] === bytes[bytes.length - 2] && crc[1] === bytes[bytes.length - 1]
    }
    const validAtqa = options.shortResponse === 'atqa' && frame.length === 1 &&
      [0x26, 0x52, 0x7a].includes(frame[0]) && options.txLastBits === 7 &&
      (reply.data.length === 2 || (reply.data.length === 4 && crcValid(reply.data)))
    const validSak = options.shortResponse === 'sak' && [0x93, 0x95, 0x97].includes(frame[0]) && frame[1] === 0x70 &&
      ((frame.length === 9 && !options.crcTx) || (frame.length === 7 && options.crcTx)) && !options.crcRx &&
      reply.data.length === 3 && crcValid(reply.data)
    const validIsoDep = options.isoDepResponse && !options.crcRx && crcValid(reply.data) && !(reply.collisionStatus & 0x80)
    if (reply.errorStatus === 0x10 && reply.rxLastBits === 0 && (validAtqa || validSak || validIsoDep)) {
      // EMD can flag a valid short ATQA/SAK. Never relax CRC, length or other error bits.
      reply.errorStatus = 0
      reply.irq0Status &= ~IRQ0_ERROR
    }
    const classicAck = options.allowMifareAck && options.crcTx && !options.crcRx &&
      options.confirmedTargetUid && [4, 7].includes(options.confirmedTargetUid.length) &&
      ((frame.length === 2 && frame[0] === 0xa0) || frame.length === 16) &&
      reply.rxLastBits === 4 && reply.data.length === 1 && (reply.data[0] & 15) === 0x0a &&
      (reply.errorStatus & ~0x10) === 0
    if (classicAck) { reply.errorStatus = 0; reply.irq0Status &= ~IRQ0_ERROR }
    const failure = shortWriteAck ? null : describeRfFailure(reply, timeoutMs)
    if (failure) {
      throw new RfError(failure.message, failure.detail)
    }
    return reply
  }

  /** 开关射频场。 */
  setRfField(enabled: boolean): Promise<void> {
    return this.run(() => this.doSetRfField(enabled))
  }

  private chipOperation<T>(operation: (session: DeviceSession) => Promise<T>): Promise<T> {
    return this.run(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      try { return await operation(await this.session()) }
      finally { if (this.fieldEnabled) this.scheduleIdleOff() }
    })
  }

  async prepareClassicRf(): Promise<() => Promise<void>> {
    const restore = await this.chipOperation(async session => session.prepareClassicRf ? session.prepareClassicRf() : async () => {})
    return async () => { await this.chipOperation(() => restore()) }
  }

  executeChipCommand(command: number, fifoInput: Uint8Array, options: { timeoutMs?: number; confirmedTargetUid: Uint8Array }): Promise<ChipCommandResult> {
    return this.chipOperation(session => {
      if (!session.executeChipCommand) throw new Error('当前硬件方案不支持芯片命令')
      return session.executeChipCommand(command, fifoInput, options)
    })
  }

  readChipRegister(address: number): Promise<number> {
    return this.chipOperation(session => {
      if (!session.readChipRegister) throw new Error('当前硬件方案不支持寄存器读取')
      return session.readChipRegister(address)
    })
  }

  writeChipRegister(address: number, value: number): Promise<void> {
    return this.chipOperation(session => {
      if (!session.writeChipRegister) throw new Error('当前硬件方案不支持寄存器写入')
      return session.writeChipRegister(address, value)
    })
  }

  private async doSetRfField(enabled: boolean): Promise<void> {
    if (!enabled && this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = 0
    }
    const session = await this.session()
    await session.setRfField(enabled)
    this.fieldEnabled = enabled
    this.emitField()
    if (enabled) this.scheduleIdleOff()
  }

  /**
   * 按参考刷写器流程复位射频场：关场 300ms，开场后预热 100ms。
   *
   * 预热不可省略：CLRC663 重新开场后需要时间稳定载波与接收门限，
   * 立刻发帧会导致首个响应出现整字节错误（IRQ0 ERR + ERROR INTEGERR）。
   *
   * 关场／开场时长可以调，默认值是真机实测能稳定复位卡的那一档；
   * 调试射频时序时可以拉长，看卡要多久才肯重新应答。
   */
  async cycleRfField(options: { offMs?: number; onMs?: number } = {}): Promise<void> {
    await this.setRfField(false)
    await delay(options.offMs ?? 300)
    await this.setRfField(true)
    await delay(options.onMs ?? 100)
  }

  /** 取就绪的设备会话。 */
  private async session(): Promise<DeviceSession> {
    return deviceSession.require()
  }
}

/** 射频失败时返回说明与细节；没有失败返回 null。 */
function describeRfFailure(
  reply: RfReply,
  timeoutMs: number
): { message: string; detail: RfErrorDetail } | null {
  const detail: RfErrorDetail = {
    status: 0,
    irq0Status: reply.irq0Status,
    irq1Status: reply.irq1Status,
    errorStatus: reply.errorStatus,
    collisionStatus: reply.collisionStatus,
    timeoutMs,
  }
  const names = reply.errorStatus ? describeErrorBits(reply.errorStatus) : []
  const hex = (value: number): string =>
    `0x${value.toString(16).padStart(2, '0').toUpperCase()}`

  if (reply.errorStatus || reply.irq0Status & IRQ0_ERROR) {
    detail.status = reply.errorStatus
    return {
      message:
        `射频错误 ERROR=${hex(reply.errorStatus)} IRQ0=${hex(reply.irq0Status)}` +
        (names.length ? `（${names.join(', ')}）` : ''),
      detail,
    }
  }
  // RxColl holds a collision position (and bit 7 validity), not an error flag.
  // Actual collisions are reported by Error.CollDet above, including position 0.
  if (!reply.data.length) {
    detail.status = 0x0d
    return {
      message: `未收到应答（等待 ${timeoutMs} ms）`,
      detail,
    }
  }
  return null
}

/** 延时工具。 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
