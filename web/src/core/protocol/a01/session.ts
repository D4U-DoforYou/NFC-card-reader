/**
 * A01 方案的设备会话。
 *
 * 对应 tmp/rf_device_platform/host/src/rf_platform/client.py 的 DeviceClient，
 * 但只保留网页端用得到的部分：
 *
 *   握手（Hello）→ 能力清单（CapabilityList）→ 作业（StartJob / JobEvent）
 *
 * 关键约束：
 * - 同一时间只有一个请求在途。固件收到完整帧才会处理，
 *   帧没被主循环取走之前到达的字节会被丢弃，所以请求必须串行。
 * - 会话 ID 是 64 位随机数，用 BigInt 承载，不能用 Number（会丢精度）。
 * - 握手之前 session_id 必须是 0，固件会拒绝非 0 的握手。
 */

import {
  CapabilityDescriptor,
  DeviceInfo,
  DeviceSession,
  HardwareProfile,
  JobEvent,
  OperationDescriptor,
  ProtocolByteChannel,
  ProtocolTransferStats,
  RawRfFrame,
  RawRfOptions,
  ChipCommandResult,
  FirmwareUploadOptions,
  SessionHello,
} from '../types'
import { FrameStreamDecoder, encodeFrame, crc32 } from './framing'
import { inspectFirmwareImage } from './firmware'
import { CAPABILITY, ERROR_CODE_TEXT, JOB_STATE, proto } from './messages'
import { DEFAULT_RX_MODE } from './rfModes'
import { capabilityOperationIssue } from '../features'
import { readerLogs } from '../../ble/readerLogs'

/** 本主机支持的协议版本。 */
const PROTOCOL_MAJOR = 1
const PROTOCOL_MINOR = 0

/** 请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * 帧发出后，等设备回话的静默上限（毫秒）。
 *
 * 设备收到帧就会立刻有反应（回执的第一个字节），
 * 正常在百来毫秒内就到。超过这个窗口一个字节都没来，
 * 就判定这帧没被设备处理——固件在应用层丢字节时是静默的，
 * 不主动去问就永远等不出来。
 */
const FRAME_SILENCE_MS = 1_500

/** 帧没送到时，最多整帧重发几次。 */
const FRAME_REPLAY_LIMIT = 2

/** At most this many no-response fragments are sent before an ATT confirmation. */
const DEFAULT_MAX_INFLIGHT_WRITES = 4
const INFLIGHT_SHRINK_STEP = 2
/** Known safe B01-sized payload; larger candidates caused link recovery on some units. */
const SAFE_PROBE_SIZE = 118

/** Envelope 里所有可能的 body 字段名。 */
const BODY_NAMES = [
  'hello_request',
  'hello_response',
  'capability_query',
  'capability_list',
  'start_job',
  'cancel_job',
  'query_job',
  'job_event',
  'transfer_begin',
  'transfer_chunk',
  'transfer_ack',
  'transfer_finish',
] as const

type BodyName = (typeof BODY_NAMES)[number]

/**
 * 这些请求设备回话可能很慢（固件升级时设备在忙）。
 *
 * 静默窗口要跟着放宽，不然会把「还没回话」误判成「帧没送到」，
 * 白白重发一遍——固件分片重发是有风险的。
 */
const SLOW_ACK_BODIES = new Set<BodyName>(['transfer_begin', 'transfer_chunk', 'transfer_finish'])

/** 解码后的 Envelope。 */
interface DecodedEnvelope {
  protocolMajor: number
  protocolMinor: number
  sessionId: bigint
  requestId: number
  bodyName: BodyName | null
  body: Record<string, unknown>
}

/** 等待中的请求。 */
interface PendingRequest {
  resolve: (envelope: DecodedEnvelope) => void
  reject: (error: Error) => void
  timer: number
  expected: BodyName
  timing: { firstByteAt: number; responseAt: number; sentAt: number }
}

interface RequestOptions {
  targetFrameSize?: number
  allowReplay?: boolean
  silenceMs?: number
}

/** 作业事件通道：事件可能比调用方先到，所以先缓存。 */
class JobChannel {
  private events: JobEvent[] = []
  private waiter: ((event: JobEvent | Error) => void) | null = null
  private failure: Error | null = null

  fail(error: Error): void { this.failure = error; this.waiter?.(error); this.waiter = null; this.events = [] }

  push(event: JobEvent): void {
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter(event)
      return
    }
    this.events.push(event)
  }

  next(timeoutMs: number): Promise<JobEvent> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.events.length) {
      return Promise.resolve(this.events.shift() as JobEvent)
    }
    return new Promise<JobEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error(`等待设备作业事件超时（${timeoutMs} ms）`))
      }, timeoutMs)
      this.waiter = event => {
        clearTimeout(timer)
        if (event instanceof Error) reject(event)
        else resolve(event)
      }
    })
  }
}

/** 协议层错误。 */
export class DeviceProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceProtocolError'
  }
}

/** 把底层异常说成一句话，好带上给用户看。 */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/** 作业选项。 */
export interface JobOptions {
  capabilityMajor?: number
  deadlineMs?: number
  idempotencyKey?: Uint8Array
  confirmedTargetUid?: Uint8Array
}

/** A01 会话。 */
export class A01Session implements DeviceSession {
  readonly profile: HardwareProfile

  private readonly channel: ProtocolByteChannel
  private readonly decoder = new FrameStreamDecoder()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly jobChannels = new Map<number, JobChannel>()
  private readonly counters: ProtocolTransferStats = {
    requests: 0, submitMs: 0, firstReceiveWaitMs: 0, responseReceiveMs: 0,
    terminalWaitMs: 0, receivedChunks: 0, receivedBytes: 0, frameReplays: 0,
  }
  get transferStats(): ProtocolTransferStats { return { ...this.counters } }

  private requestId = 0
  /** 作业幂等键的计数。 */
  private idempotencyCounter = 0
  private sessionId = 0n
  /** 最近一次收到设备字节的时刻。 */
  private lastReceiveAt = 0
  /** 等待「下一个字节到达」的回调。 */
  private receiveWaiters: Array<() => void> = []
  /** 发送失败后收缩到的分片上限；0 表示还没收缩过。 */
  private shrunkChunkSize = 0
  /** Unconfirmed fragments per frame window; reduced after silent frame loss. */
  private maxInflightWrites = DEFAULT_MAX_INFLIGHT_WRITES
  private capabilityList: CapabilityDescriptor[] = []
  private capabilityFingerprint = ''
  private capabilitiesLoaded = false
  private helloInfo: SessionHello | null = null
  private closed = false
  private unsubscribe: (() => void) | null = null
  private requestChain: Promise<unknown> = Promise.resolve()
  /** BLE indication queue has four frames: wait for each job's terminal event. */
  private jobChain: Promise<unknown> = Promise.resolve()
  private deviceInfoRead: Promise<DeviceInfo> | null = null
  private activeJobs = 0
  private updateActive = false
  private updateNeedsReconnect = false

  get firmwareUpdating(): boolean { return this.updateActive }
  get firmwareRequiresReconnect(): boolean { return this.updateNeedsReconnect }

  constructor(profile: HardwareProfile, channel: ProtocolByteChannel) {
    this.profile = profile
    this.channel = channel
  }

  /**
   * 当前该用多大的分片。
   *
   * 通道的 chunkSize 会随设备协商结果变化（BLE 收发的 MTU 是同一个，
   * 通道按设备发过来的分片长度反推上限），所以这里直接跟随。
   * 但一旦发送失败收缩过，就不再涨回去——失败说明这一档发不出去。
   */
  private effectiveChunkSize(): number {
    const negotiated = Number(this.channel.chunkSize)
    const current = Number.isFinite(negotiated) && negotiated > 0 ? Math.floor(negotiated) : 20
    if (this.shrunkChunkSize > 0) {
      return Math.min(current, this.shrunkChunkSize)
    }
    return current
  }

  get capabilities(): CapabilityDescriptor[] {
    return this.capabilityList
  }

  get hello(): SessionHello | null {
    return this.helloInfo
  }

  /** 建立会话：握手 + 拉能力清单。 */
  async connect(): Promise<SessionHello> {
    if (this.closed) {
      throw new DeviceProtocolError('设备会话已关闭')
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.channel.onData(bytes => this.handleData(bytes))
    }

    const nonce = new Uint8Array(16)
    globalThis.crypto.getRandomValues(nonce)
    const helloEnvelope = await this.request(
      'hello_request',
      {
        min_protocol_major: PROTOCOL_MAJOR,
        max_protocol_major: PROTOCOL_MAJOR,
        max_protocol_minor: PROTOCOL_MINOR,
        host_nonce: nonce,
      },
      'hello_response',
    )

    const body = helloEnvelope.body
    if (helloEnvelope.bodyName !== 'hello_response') {
      throw new DeviceProtocolError('设备没有返回握手信息')
    }
    if (helloEnvelope.protocolMajor !== PROTOCOL_MAJOR) {
      throw new DeviceProtocolError(
        `设备协议主版本为 ${helloEnvelope.protocolMajor}，本网页只支持 ${PROTOCOL_MAJOR}`
      )
    }
    if (helloEnvelope.sessionId === 0n) {
      throw new DeviceProtocolError('设备返回了空的会话 ID')
    }
    this.sessionId = helloEnvelope.sessionId

    this.helloInfo = {
      deviceId: toBytes(body.device_id),
      bootId: toBytes(body.boot_id),
      protocolMajor: Number(body.protocol_major ?? PROTOCOL_MAJOR),
      protocolMinor: Number(body.protocol_minor ?? PROTOCOL_MINOR),
      maxControlMessage: Number(body.max_control_message ?? 0),
      maxDataChunk: Number(body.max_data_chunk ?? 0),
      maxInFlightJobs: Number(body.max_in_flight_jobs ?? 0),
      transports: Array.isArray(body.transport) ? (body.transport as string[]) : [],
    }

    const listEnvelope = await this.request(
      'capability_query',
      {},
      'capability_list',
    )
    const list = listEnvelope.body
    const rawCapabilities = Array.isArray(list.capabilities) ? list.capabilities : []
    this.capabilityFingerprint = fingerprintCapabilities(list)
    this.capabilityList = (rawCapabilities as Record<string, unknown>[]).map(item => ({
      id: String(item.id ?? ''),
      majorVersion: Number(item.major_version ?? 0),
      minorVersion: Number(item.minor_version ?? 0),
      operations: (Array.isArray(item.operations) ? item.operations : []).map(
        (operation: Record<string, unknown>) => ({
          id: String(operation.id ?? ''),
          mutating: Boolean(operation.mutating),
          cancellable: Boolean(operation.cancellable),
          maxPayloadSize: Number(operation.max_payload_size ?? 0),
          requiresTargetConfirmation: Boolean(operation.requires_target_confirmation),
        })
      ),
    }))
    this.capabilitiesLoaded = true
    await this.probeSafeWriteSize()

    return this.helloInfo
  }

  /** Verify one known B01-sized payload using only a read-only capability query. */
  private async probeSafeWriteSize(): Promise<void> {
    if (!this.channel.setVerifiedChunkSize || this.channel.chunkSize >= SAFE_PROBE_SIZE) return
    try {
      const response = await this.request(
        'capability_query', {}, 'capability_list', 4_000,
        { targetFrameSize: SAFE_PROBE_SIZE, allowReplay: false, silenceMs: FRAME_SILENCE_MS },
      )
      if (!this.matchesCapabilities(response.body)) {
        throw new DeviceProtocolError('只读写入长度校验返回了不同的能力清单')
      }
      this.channel.setVerifiedChunkSize(SAFE_PROBE_SIZE)
    } catch (error) {
      readerLogs.add('warn', `118 字节只读写入验证未通过，继续使用当前安全长度：${describeCause(error)}`)
      // An oversized candidate may leave a partial byte stream. Reset its frame and
      // verify that normal, conservatively sized traffic still works before continuing.
      await this.channel.writeChunk(new Uint8Array([0])).catch(() => undefined)
      const recovery = await this.request('capability_query', {}, 'capability_list')
      if (!this.matchesCapabilities(recovery.body)) {
        throw new DeviceProtocolError('118 字节验证后链路恢复查询不一致')
      }
    }
  }

  private matchesCapabilities(body: Record<string, unknown>): boolean {
    return fingerprintCapabilities(body) === this.capabilityFingerprint
  }

  /** 关闭会话：清掉等待中的请求。 */
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.decoder.reset()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new DeviceProtocolError('设备会话已关闭'))
    }
    this.pending.clear()
    for (const channel of this.jobChannels.values()) channel.fail(new DeviceProtocolError('设备会话已关闭'))
    this.jobChannels.clear()
    // 正在等「帧有没有送到」的调用方也要醒过来，不能让它空等到超时。
    const waiters = this.receiveWaiters
    this.receiveWaiters = []
    waiters.forEach(waiter => waiter())
    this.sessionId = 0n
    this.helloInfo = null
  }

  /** 读取设备信息。 */
  getDeviceInfo(): Promise<DeviceInfo> {
    if (!this.deviceInfoRead) {
      this.deviceInfoRead = this.readDeviceInfo().finally(() => { this.deviceInfoRead = null })
    }
    return this.deviceInfoRead
  }

  private async readDeviceInfo(): Promise<DeviceInfo> {
    const event = await this.startJob(CAPABILITY.DEVICE_INFO, 'get')
    requireCompleted(event)
    const result = proto.decode('DeviceInfoResult', event.result)
    return {
      deviceId: toBytes(result.device_id),
      bootId: toBytes(result.boot_id),
      firmwareName: String(result.firmware_name ?? ''),
      firmwareVersion: String(result.firmware_version ?? ''),
      radioController: String(result.radio_controller ?? ''),
      bluetoothMac: toBytes(result.bluetooth_mac),
    }
  }

  /** 读取当前发射功率档位。 */
  async getTxAmplitude(): Promise<number> {
    const event = await this.startJob(CAPABILITY.CLRC663_CONFIG, 'get_tx_amplitude')
    requireCompleted(event)
    const result = proto.decode('TxAmplitudeResult', event.result)
    return Number(result.level ?? 0)
  }

  /** 设置发射功率档位（0..3）。 */
  async setTxAmplitude(level: number): Promise<number> {
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      throw new DeviceProtocolError('发射功率档位必须是 0..3')
    }
    const arguments_ = proto.encode('TxAmplitudeRequest', { level })
    const event = await this.startJob(CAPABILITY.CLRC663_CONFIG, 'set_tx_amplitude', arguments_)
    requireCompleted(event)
    const result = proto.decode('TxAmplitudeResult', event.result)
    return Number(result.level ?? level)
  }

  /** 开关射频场。 */
  async setRfField(enabled: boolean): Promise<void> {
    const arguments_ = proto.encode('RfFieldRequest', { enabled })
    const event = await this.startJob(CAPABILITY.RF_RAW, 'set_field', arguments_, {
      deadlineMs: 5_000,
    })
    requireCompleted(event)
  }

  /** 收发一帧原始射频数据。 */
  async rawTransceive(tx: Uint8Array, options: RawRfOptions = {}): Promise<RawRfFrame> {
    if (!tx.length || tx.length > 256) {
      throw new DeviceProtocolError('射频帧长度必须为 1..256 字节')
    }
    const timeoutMs = options.timeoutMs ?? 25
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new DeviceProtocolError('射频等待时长必须为 1..300000 毫秒')
    }
    for (const [name, value, max] of [
      ['txLastBits', options.txLastBits ?? 0, 7], ['rxAlign', options.rxAlign ?? 0, 7],
      ['crcFlags', options.crcFlags ?? 0, 3], ['rxMode', options.rxMode ?? DEFAULT_RX_MODE, 18],
      ['txMode', options.txMode ?? options.rxMode ?? DEFAULT_RX_MODE, 18],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > max) throw new DeviceProtocolError(`${name} 必须为 0..${max} 的整数`)
    }
    const rxMode = options.rxMode ?? DEFAULT_RX_MODE
    const txMode = options.txMode
    if (txMode !== undefined && txMode !== rxMode) {
      this.requireRawModes()
    } else if (rxMode !== DEFAULT_RX_MODE) {
      this.requireRawModes()
    }

    const request: Record<string, unknown> = {
      tx,
      timeout_ms: timeoutMs,
      tx_last_bits: options.txLastBits ?? 0,
      rx_align: options.rxAlign ?? 0,
      crc_flags: options.crcFlags ?? 0,
      rx_mode: rxMode,
    }
    if (txMode !== undefined) {
      request.tx_mode = txMode
    }
    const arguments_ = proto.encode('RawRfTransceiveRequest', request)
    const event = await this.startJob(CAPABILITY.RF_RAW, 'transceive', arguments_, {
      deadlineMs: Math.min(300_000, Math.max(5_000, timeoutMs + 5_000)),
      confirmedTargetUid: options.confirmedTargetUid,
    })
    requireCompleted(event)
    const result = proto.decode('RawRfTransceiveResult', event.result)
    return {
      rx: toBytes(result.rx),
      rxLastBits: Number(result.rx_last_bits ?? 0),
      irq0: Number(result.irq0 ?? 0),
      irq1: Number(result.irq1 ?? 0),
      error: Number(result.error ?? 0),
      collision: Number(result.collision ?? 0),
    }
  }

  /** 非默认射频模式需要固件支持 org.example.rf.raw 1.1。 */
  private requireRawModes(): void {
    const capability = this.capabilityList.find(item => item.id === CAPABILITY.RF_RAW)
    if (!capability || capability.majorVersion !== 1 || capability.minorVersion < 1) {
      throw new DeviceProtocolError('设备固件不支持指定射频模式（需要 org.example.rf.raw 1.1）')
    }
  }

  private requireChipPrimitives(operation: string): void {
    const cap = this.capabilityList.find(item => item.id === CAPABILITY.RF_RAW)
    if (!cap || cap.majorVersion !== 1 || cap.minorVersion < 2 || !cap.operations.some(op => op.id === operation)) throw new DeviceProtocolError('该设备未开放芯片原语，需要 raw RF 1.2 固件')
  }

  /**
   * A01 近场 Classic 接收准备。
   *
   * 早先这里把接收增益（RxAna 0x39）降一档，怕增益太高收到噪声。
   * 真机实测发现这样反而更慢：增益一低，芯片就收不到卡拒绝握手时回的
   * 4 位 NAK，错误寄存器是空的，分不清「卡拒了握手」和「卡没应答」，
   * 于是每试一把错密钥都要重跑一遍完整握手——解卡慢一倍。
   *
   * 保持芯片默认增益，芯片才看得见卡的应答，错误位才说得出到底发生了什么。
   * 高增益带来的噪声由 CRC 校验挡着，校验不过就是校验不过，不会读出错数据。
   */
  async prepareClassicRf(): Promise<() => Promise<void>> {
    return async () => {}
  }

  async executeChipCommand(command: number, fifoInput: Uint8Array, options: { timeoutMs?: number; confirmedTargetUid: Uint8Array }): Promise<ChipCommandResult> {
    this.requireChipPrimitives('execute_command')
    const timeoutMs = options.timeoutMs ?? 25
    const uid = options.confirmedTargetUid
    const allowed = Number.isInteger(command) && (
      ([0, 5, 0x1c].includes(command) && fifoInput.length === 0) ||
      (command === 2 && fifoInput.length === 6) ||
      (command === 3 && fifoInput.length === 6 && [0x60, 0x61].includes(fifoInput[0])) ||
      ([6, 7].includes(command) && fifoInput.length >= 1 && fifoInput.length <= 256) ||
      (command === 0x0d && fifoInput.length === 2 && fifoInput.every(mode => mode <= 18)))
    if (!allowed || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || ![4, 7, 10].includes(uid.length)) throw new DeviceProtocolError('芯片命令、FIFO、等待时间或目标 UID 无效')
    const event = await this.startJob(CAPABILITY.RF_RAW, 'execute_command', proto.encode('Clrc663CommandRequest', { command, fifo_input: fifoInput, timeout_ms: timeoutMs }), { confirmedTargetUid: uid, deadlineMs: Math.min(300_000, Math.max(5000, timeoutMs + 5000)) })
    requireCompleted(event)
    const result = proto.decode('Clrc663CommandResult', event.result)
    return { fifoOutput: toBytes(result.fifo_output), irq0: Number(result.irq0 ?? 0), irq1: Number(result.irq1 ?? 0), error: Number(result.error ?? 0), status: Number(result.status ?? 0) }
  }

  async readChipRegister(address: number): Promise<number> {
    this.requireChipPrimitives('read_register')
    if (!Number.isInteger(address) || address < 0 || address > 0x7f || address === 5) throw new DeviceProtocolError('寄存器地址无效，不能通过此接口读取 FIFO')
    const event = await this.startJob(CAPABILITY.RF_RAW, 'read_register', proto.encode('Clrc663RegisterRequest', { address }))
    requireCompleted(event)
    return Number(proto.decode('Clrc663RegisterResult', event.result).value ?? 0)
  }

  async writeChipRegister(address: number, value: number): Promise<void> {
    this.requireChipPrimitives('write_register')
    const allowed = address === 0x0b && value === 0 || address >= 0x14 && address <= 0x27 || address >= 0x2b && address <= 0x39 && address !== 0x2e
    if (!Number.isInteger(address) || !Number.isInteger(value) || value < 0 || value > 255 || !allowed) throw new DeviceProtocolError('寄存器受驱动保护，或地址／数值无效')
    requireCompleted(await this.startJob(CAPABILITY.RF_RAW, 'write_register', proto.encode('Clrc663RegisterRequest', { address, value })))
  }

  inspectFirmware(image: Uint8Array) { return inspectFirmwareImage(image, this.profile.firmwareTarget?.chipId) }

  async uploadFirmware(source: Uint8Array, options: FirmwareUploadOptions = {}): Promise<void> {
    if (this.closed || !this.sessionId) throw new DeviceProtocolError('请先连接设备并完成握手')
    if (this.updateActive || this.activeJobs || this.pending.size) throw new DeviceProtocolError('设备正在执行其他操作，请等待完成后升级')
    if (this.updateNeedsReconnect) throw new DeviceProtocolError('请重新连接设备后再升级')
    const image = source.slice()
    this.inspectFirmware(image)
    this.updateActive = true
    let started = false
    const check = () => {
      if (options.signal?.aborted) throw new DeviceProtocolError('固件上传已停止，未请求切换固件；请重新连接')
      if (this.closed) throw new DeviceProtocolError('升级连接已断开，请重新连接检查设备状态')
    }
    const report = (stage: 'preparing' | 'uploading' | 'finalizing' | 'rebooting', sent: number) => options.onProgress?.({ stage, sent, total: image.length })
    try {
      check(); report('preparing', 0)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', image))
      check()
      const transferId = crypto.getRandomValues(new Uint32Array(1))[0] || 1
      const transfer = async (name: 'transfer_begin' | 'transfer_chunk' | 'transfer_finish', body: Record<string, unknown>) => {
        check()
        const response = await this.request(name, { transfer_id: transferId, ...body }, 'transfer_ack', name === 'transfer_chunk' ? 60_000 : REQUEST_TIMEOUT_MS)
        const ack = response.body
        if (Number(ack.transfer_id ?? 0) !== transferId) throw new DeviceProtocolError('固件传输应答编号不匹配，已停止')
        const error = Number(ack.error_code ?? 0)
        if (error) throw new DeviceProtocolError(error === 1 ? '设备不支持 OTA，请先通过有线烧录支持 OTA 的固件' : `固件传输被拒绝：${ERROR_CODE_TEXT[error] || error}`)
        return ack
      }
      started = true
      const begin = await transfer('transfer_begin', { total_size: image.length, sha256: digest, purpose: 'firmware' })
      if (Number(begin.next_offset ?? 0) !== 0 || Number(begin.receive_window ?? 0) < 1) throw new DeviceProtocolError('设备没有接受新的固件传输窗口')
      for (let offset = 0, sequence = 0; offset < image.length; sequence++) {
        const chunk = image.slice(offset, offset + 512)
        const ack = await transfer('transfer_chunk', { offset, sequence, crc32: crc32(chunk), data: chunk })
        if (Number(ack.next_offset ?? 0) !== offset + chunk.length || Number(ack.receive_window ?? 0) < 1) throw new DeviceProtocolError('固件分块应答偏移或接收窗口异常；未重发')
        offset += chunk.length; report('uploading', offset)
      }
      check(); report('finalizing', image.length)
      try { await transfer('transfer_finish', {}) }
      catch (error) { throw new DeviceProtocolError(`固件切换结果未确认，请重连检查版本，未自动重发：${error instanceof Error ? error.message : String(error)}`) }
      report('rebooting', image.length)
    } finally {
      this.updateActive = false
      this.updateNeedsReconnect = started
    }
  }

  /** 发起一个作业并等到终态。 */
  private async startJob(
    capabilityId: string,
    operationId: string,
    args?: Uint8Array,
    options: JobOptions = {},
  ): Promise<JobEvent> {
    if (this.updateActive || this.updateNeedsReconnect) throw new DeviceProtocolError('固件升级期间或升级后请先重新连接，暂不能执行其他操作')
    this.activeJobs++
    const task = this.jobChain.then(() => {
      if (this.closed) throw new DeviceProtocolError('设备会话已关闭')
      return this.performJob(capabilityId, operationId, args, options)
    })
    this.jobChain = task.then(() => undefined, () => undefined)
    try { return await task }
    finally { this.activeJobs-- }
  }

  private async performJob(
    capabilityId: string,
    operationId: string,
    args?: Uint8Array,
    options: JobOptions = {},
  ): Promise<JobEvent> {
    if (this.capabilitiesLoaded) {
      const issue = capabilityOperationIssue(this.capabilityList, capabilityId, operationId, options.capabilityMajor ?? 1)
      if (issue) throw new DeviceProtocolError(issue)
    }
    const deadlineMs = options.deadlineMs ?? 30_000
    const confirmedTargetUid = options.confirmedTargetUid
    const envelope = await this.request(
      'start_job',
      {
        capability_id: capabilityId,
        capability_major: options.capabilityMajor ?? 1,
        operation_id: operationId,
        arguments: args ?? new Uint8Array(0),
        deadline_ms: deadlineMs,
        idempotency_key: options.idempotencyKey ?? this.nextIdempotencyKey(),
        user_confirmed: Boolean(confirmedTargetUid && confirmedTargetUid.length),
        confirmed_target_uid: confirmedTargetUid ?? new Uint8Array(0),
      },
      'job_event',
    )
    const accepted = toJobEvent(envelope.body)
    if (accepted.state !== JOB_STATE.ACCEPTED) {
      if (accepted.detail === 'unsupported capability') {
        throw new DeviceProtocolError(`设备已公布能力 ${capabilityId}，但执行 ${operationId} 时返回 unsupported capability；能力清单与设备执行状态不一致，请保存本次启动日志后重新连接`)
      }
      throw new DeviceProtocolError(`${capabilityId}/${operationId}：${jobFailureText(accepted)}`)
    }
    const channel = this.jobChannel(accepted.jobId)
    const acceptedAt = performance.now()
    try { return await this.waitTerminal(channel, deadlineMs + 1_000) }
    finally {
      this.counters.terminalWaitMs += performance.now() - acceptedAt
      this.jobChannels.delete(accepted.jobId)
    }
  }

  /** 等作业走到终态。 */
  private async waitTerminal(channel: JobChannel, timeoutMs: number): Promise<JobEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new DeviceProtocolError('等待设备作业事件超时')
      const event = await channel.next(remaining)
      if (event.state === JOB_STATE.ACCEPTED) {
        continue
      }
      if (
        event.state === JOB_STATE.COMPLETED ||
        event.state === JOB_STATE.FAILED ||
        event.state === JOB_STATE.CANCELLED ||
        event.state === JOB_STATE.RESULT_UNCERTAIN
      ) {
        return event
      }
    }
  }

  /** 取得（或建立）某个作业号的事件通道。 */
  private jobChannel(jobId: number): JobChannel {
    let channel = this.jobChannels.get(jobId)
    if (!channel) {
      channel = new JobChannel()
      this.jobChannels.set(jobId, channel)
    }
    return channel
  }

  /** 发一个请求并等它的响应。 */
  private request(
    bodyName: BodyName,
    body: Record<string, unknown>,
    expected: BodyName,
    timeoutMs = REQUEST_TIMEOUT_MS,
    options: RequestOptions = {},
  ): Promise<DecodedEnvelope> {
    // A01 is a byte stream with a single firmware receive buffer. Serialize
    // through the response, not just each BLE chunk. Queue time is not a timeout.
    const task = this.requestChain.then(() => this.performRequest(bodyName, body, expected, timeoutMs, options))
    this.requestChain = task.then(() => undefined, () => undefined)
    return task
  }

  private async performRequest(
    bodyName: BodyName,
    body: Record<string, unknown>,
    expected: BodyName,
    timeoutMs = REQUEST_TIMEOUT_MS,
    options: RequestOptions = {},
  ): Promise<DecodedEnvelope> {
    if (this.closed) {
      throw new DeviceProtocolError('设备会话已关闭')
    }
    const requestId = this.nextRequestId()
    let bytes = proto.encode('Envelope', {
      protocol_major: PROTOCOL_MAJOR,
      protocol_minor: PROTOCOL_MINOR,
      session_id: this.sessionId,
      request_id: requestId,
      [bodyName]: body,
    })
    let oneWriteSize: number | undefined
    if (options.targetFrameSize) {
      const padded = padFrameToSize(bytes, options.targetFrameSize)
      bytes = padded.payload
      oneWriteSize = padded.frameSize
    }
    const frame = encodeFrame(bytes)

    const startedAt = performance.now()
    const timing = { firstByteAt: 0, responseAt: 0, sentAt: 0 }
    let sending: Promise<void> = Promise.resolve()
    const response = new Promise<DecodedEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new DeviceProtocolError(`设备响应超时（${timeoutMs} ms）`))
      }, timeoutMs) as unknown as number
      this.pending.set(requestId, {
        resolve: envelope => { timing.responseAt = performance.now(); resolve(envelope) },
        reject, timer, expected, timing,
      })
      let sentAt = 0
      const outgoing = this.sendFrame(
        frame,
        options.allowReplay ?? ['hello_request', 'capability_query', 'query_job'].includes(bodyName),
        // 设备忙的时候回话会慢（固件升级尤其明显），静默窗口要跟着放宽，
        // 别把「还没回话」误判成「帧没送到」。
        options.silenceMs ?? (SLOW_ACK_BODIES.has(bodyName)
          ? Math.max(FRAME_SILENCE_MS, Math.floor(timeoutMs / 2))
          : Math.min(FRAME_SILENCE_MS, Math.floor(timeoutMs / 2))),
        oneWriteSize,
      ).then(value => { sentAt = value })
      sending = outgoing.then(() => { timing.sentAt = sentAt || performance.now() })
      void sending.catch(error => {
        const entry = this.pending.get(requestId)
        if (!entry) {
          return
        }
        this.pending.delete(requestId)
        clearTimeout(entry.timer)
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
    // Notifications can arrive before the final GATT write has settled.
    // Keep the request slot until both sending and the response are complete.
    const [envelope] = await Promise.all([response, sending])
    this.counters.requests++
    this.counters.submitMs += timing.sentAt - startedAt
    this.counters.firstReceiveWaitMs += Math.max(0, timing.firstByteAt - timing.sentAt)
    this.counters.responseReceiveMs += Math.max(0, timing.responseAt - Math.max(timing.firstByteAt, timing.sentAt))
    return envelope
  }

  /**
   * 送出一帧。
   *
   * A01 的帧是字节流：设备收到 0x00 就把之前残留的半帧丢掉，重新开始攒下一帧。
   * 握手、能力查询和作业查询可在重同步后调小分片重试。
   * 其他操作可能已执行，发送失败时不重发。
   *
   * 写完之后还要确认设备真的处理了：固件在应用层丢字节时是**静默**的
   * （`HandleByte` 在上一帧没处理完时整段丢弃），
   * 主机以为发出去了，设备其实只收到半帧，于是既不报错也不回执，
   * 只能干等满 10 秒才判超时。设备一个字节都没回，说明这帧压根没送到——
   * 它没见过这帧，重发是安全的（不会把操作执行两遍）。
   */
  private async sendFrame(
    bytes: Uint8Array,
    allowReplay = false,
    silenceMs = FRAME_SILENCE_MS,
    oneWriteSize?: number,
  ): Promise<number> {
    let sentAt = performance.now()
    for (let attempt = 0; attempt <= FRAME_REPLAY_LIMIT; attempt += 1) {
      const activityAtStart = this.lastReceiveAt
      await this.writeFrame(bytes, allowReplay, oneWriteSize)
      // 帧确实写出去的时刻：统计「发完到第一个字节回来」要用它，
      // 不能等后面的静默判定结束再记。
      sentAt = performance.now()
      // 设备已经有反应：帧到了，等它的正式回执就行。
      if (this.lastReceiveAt > activityAtStart) return sentAt
      const arrived = await this.waitForAnyByte(silenceMs)
      if (arrived) return sentAt
      this.noteFrameLoss()
      if (!allowReplay) break
      if (attempt >= FRAME_REPLAY_LIMIT) break
      // 一个字节都没回：这帧没送到，整帧重发。
      this.counters.frameReplays++
      readerLogs.add('warn', `帧未送达设备（${silenceMs} ms 内没有任何响应），整帧重发`)
      // 先补一个帧结束符，让设备把可能收到的半帧丢掉，再整帧重发。
      await this.channel.writeChunk(new Uint8Array([0])).catch(() => undefined)
    }
    throw new DeviceProtocolError(allowReplay
      ? `帧未送达设备（${silenceMs} ms 内没有任何响应，已整帧重发 ${FRAME_REPLAY_LIMIT} 次）`
      : `帧未收到设备响应（${silenceMs} ms 内没有任何响应）`)
  }

  /**
   * 把帧写出去。
   *
   * 写失败（浏览器报了错）时按原来的规则缩片重试；
   * 写成功但帧没到，由 sendFrame 负责重发。
   */
  private async writeFrame(bytes: Uint8Array, allowReplay: boolean, oneWriteSize?: number): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        // 分片大小在一帧之内固定，避免中途变化把一帧切得忽大忽小。
        const size = oneWriteSize ?? this.effectiveChunkSize()
        // 逐片串行写：Chrome 不允许并发的 GATT 操作，并发投递会直接报
        // “GATT operation already in progress”（实机踩过）。
        //
        // A bounded window avoids waiting one BLE connection interval per
        // fragment. Confirm every fourth fragment and the frame's final fragment;
        // on a silent frame loss, the next attempt reduces the window.
        let sinceConfirm = 0
        for (let offset = 0; offset < bytes.length; offset += size) {
          const end = Math.min(offset + size, bytes.length)
          const isLast = end >= bytes.length
          const confirm = isLast || sinceConfirm + 1 >= this.maxInflightWrites
          await this.channel.writeChunk(bytes.subarray(offset, end), { confirm })
          sinceConfirm = confirm ? 0 : sinceConfirm + 1
        }
        return
      } catch (error) {
        // 设备侧可能已经收到半帧：发一个帧结束符让它丢掉，再重写整段。
        await this.channel.writeChunk(new Uint8Array([0])).catch(() => undefined)
        if (!allowReplay) {
          // 带上原始原因：只说「未确认」没法判断是链路忙还是链路断了。
          throw new DeviceProtocolError(`发送结果未确认，未自动重发：${describeCause(error)}`)
        }
        const current = this.effectiveChunkSize()
        if (current <= 1) {
          throw error
        }
        this.shrunkChunkSize = Math.max(1, Math.floor(current / 2))
      }
    }
    throw new DeviceProtocolError('写入设备失败')
  }

  /** Reduce unconfirmed writes after a frame arrives without any device response. */
  private noteFrameLoss(): void {
    if (this.maxInflightWrites <= 1) return
    this.maxInflightWrites = Math.max(1, Math.floor(this.maxInflightWrites / INFLIGHT_SHRINK_STEP))
    readerLogs.add('warn', `在途分片窗口收窄到 ${this.maxInflightWrites} 片，避免继续丢帧`)
    if (this.maxInflightWrites === 1) {
      this.channel.setReliableWrites?.(true)
    }
  }

  /**
   * 等到设备的下一个字节，或等到超时。
   *
   * 返回 true 表示有字节到了。用来判断「帧有没有送到」，
   * 而不是干等整个请求超时。
   */
  private waitForAnyByte(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      const finish = (arrived: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.receiveWaiters = this.receiveWaiters.filter(item => item !== onByte)
        resolve(arrived)
      }
      const onByte = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs) as unknown as number
      this.receiveWaiters.push(onByte)
    })
  }

  /**
   * 分配一个作业的幂等键。
   *
   * 同一个作业的整帧重发用的是同一个键：固件若实现了幂等去重，
   * 重发会被收敛成原来那个作业，操作不会被执行两遍。
   * 这版固件还没实现该字段，带上它也没有副作用。
   */
  private nextIdempotencyKey(): Uint8Array {
    this.idempotencyCounter = (this.idempotencyCounter + 1) >>> 0
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, this.idempotencyCounter, true)
    return bytes
  }

  /** 分配下一个请求号。 */
  private nextRequestId(): number {
    for (let attempt = 0; attempt < 0xffffffff; attempt += 1) {
      this.requestId = (this.requestId + 1) & 0xffffffff
      if (this.requestId && !this.pending.has(this.requestId)) {
        return this.requestId
      }
    }
    throw new DeviceProtocolError('请求号已用尽')
  }

  /** 处理设备发来的字节。 */
  private handleData(bytes: Uint8Array): void {
    const receivedAt = performance.now()
    this.counters.receivedChunks++
    this.counters.receivedBytes += bytes.length
    // 记下收到的时刻，并唤醒正在等「帧有没有送到」的调用方。
    this.lastReceiveAt = receivedAt
    if (this.receiveWaiters.length) {
      const waiters = this.receiveWaiters
      this.receiveWaiters = []
      waiters.forEach(waiter => waiter())
    }
    for (const entry of this.pending.values()) {
      if (!entry.timing.firstByteAt) entry.timing.firstByteAt = receivedAt
    }
    let frames: Uint8Array[]
    try {
      frames = this.decoder.feed(bytes)
    } catch {
      return
    }
    for (const frame of frames) {
      let decoded: Record<string, unknown>
      try {
        decoded = proto.decode('Envelope', frame)
      } catch {
        continue
      }
      this.dispatch(decoded)
    }
  }

  /** 分发一条 Envelope。 */
  private dispatch(decoded: Record<string, unknown>): void {
    if (Number(decoded.protocol_major ?? 0) !== PROTOCOL_MAJOR ||
      (this.sessionId !== 0n && toBigInt(decoded.session_id) !== this.sessionId)) return
    const bodyName = BODY_NAMES.find(name => decoded[name] !== undefined) ?? null
    const requestId = Number(decoded.request_id ?? 0)
    const body = bodyName ? (decoded[bodyName] as Record<string, unknown>) : {}

    if (requestId) {
      const pending = this.pending.get(requestId)
      if (pending) {
        this.pending.delete(requestId)
        clearTimeout(pending.timer)
        if (bodyName !== pending.expected) {
          pending.reject(
            new DeviceProtocolError(`期望 ${pending.expected}，收到 ${bodyName ?? '空响应'}`)
          )
        } else {
          pending.resolve({
            protocolMajor: Number(decoded.protocol_major ?? 0),
            protocolMinor: Number(decoded.protocol_minor ?? 0),
            sessionId: toBigInt(decoded.session_id),
            requestId,
            bodyName,
            body,
          })
        }
      }
    }

    if (bodyName === 'job_event') {
      const event = toJobEvent(body)
      this.jobChannel(event.jobId).push(event)
    }
  }
}

/** 64 位会话 ID 用 BigInt 承载，转不出来时按 0 处理。 */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'number') {
    return BigInt(Math.trunc(value))
  }
  return 0n
}

/** 字节字段转 Uint8Array。 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[])
  }
  return new Uint8Array(0)
}

/** Pad the protobuf with an ignored field until its COBS frame reaches a candidate size. */
function padFrameToSize(payload: Uint8Array, targetSize: number): { payload: Uint8Array; frameSize: number } {
  const tag = Uint8Array.of(0xfa, 0x07) // protobuf field 127, wire type 2
  for (let length = 0; length <= targetSize; length += 1) {
    const lengthBytes = encodeVarint(length)
    const suffix = new Uint8Array(tag.length + lengthBytes.length + length)
    suffix.set(tag)
    suffix.set(lengthBytes, tag.length)
    suffix.fill(0xa5, tag.length + lengthBytes.length)
    const padded = new Uint8Array(payload.length + suffix.length)
    padded.set(payload)
    padded.set(suffix, payload.length)
    const frameSize = encodeFrame(padded).length
    if (frameSize >= targetSize) {
      if (frameSize > targetSize) throw new DeviceProtocolError('候选写入帧超过安全验证长度')
      return { payload: padded, frameSize }
    }
  }
  throw new DeviceProtocolError('无法构造候选写入验证帧')
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return Uint8Array.from(bytes)
}

function fingerprintCapabilities(body: Record<string, unknown>): string {
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities as Record<string, unknown>[]
    : []
  return JSON.stringify(capabilities.map(item => ({
    id: String(item.id ?? ''),
    majorVersion: Number(item.major_version ?? 0),
    minorVersion: Number(item.minor_version ?? 0),
    operations: (Array.isArray(item.operations) ? item.operations as Record<string, unknown>[] : []).map(operation => ({
      id: String(operation.id ?? ''),
      mutating: Boolean(operation.mutating),
      cancellable: Boolean(operation.cancellable),
      maxPayloadSize: Number(operation.max_payload_size ?? 0),
      requiresTargetConfirmation: Boolean(operation.requires_target_confirmation),
    })),
    requirements: (Array.isArray(item.requirements) ? item.requirements as Record<string, unknown>[] : []).map(requirement => ({
      id: String(requirement.id ?? ''),
      minimumMajor: Number(requirement.minimum_major ?? 0),
    })),
  })))
}

/** 作业事件转结构。 */
function toJobEvent(body: Record<string, unknown> | undefined): JobEvent {
  const source = body ?? {}
  return {
    jobId: Number(source.job_id ?? 0),
    state: Number(source.state ?? 0),
    stage: String(source.stage ?? ''),
    progressCurrent: Number(source.progress_current ?? 0),
    progressTotal: Number(source.progress_total ?? 0),
    errorCode: Number(source.error_code ?? 0),
    detail: String(source.detail ?? ''),
    result: toBytes(source.result),
  }
}

/** 作业失败时的说明。 */
function jobFailureText(event: JobEvent): string {
  const reason = ERROR_CODE_TEXT[event.errorCode]
  if (event.detail && reason) {
    return `${reason}：${event.detail}`
  }
  return event.detail || reason || `作业以状态 ${event.state} 结束`
}

/** 要求作业成功完成。 */
function requireCompleted(event: JobEvent): void {
  if (event.state !== JOB_STATE.COMPLETED) {
    throw new DeviceProtocolError(jobFailureText(event))
  }
}

/** 导出给界面用的操作描述符类型。 */
export type { CapabilityDescriptor, OperationDescriptor }
