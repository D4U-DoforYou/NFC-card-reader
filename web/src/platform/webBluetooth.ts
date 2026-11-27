/**
 * 浏览器蓝牙传输（Web Bluetooth）。
 *
 * 对应 A01 固件的 GATT 布局：服务 FF10、主机→设备写特征 FF11、
 * 设备→主机接收特征 FF12（新固件使用 Indicate，兼容旧 Notify）。
 *
 * 这一层只认字节：帧的 COBS 切分、protobuf 解析都在 core/protocol 里，
 * 由硬件方案（A01）决定。这里要做的是把字节流可靠地搬过去搬回来。
 *
 * 与小程序蓝牙 API 的几处关键差异，这里都做了处理：
 *
 * 1. **没有持续扫描**：浏览器只能在用户点击时弹出设备选择器
 *    （`requestDevice`），拿不到「附近有哪些设备」的列表，也拿不到 RSSI。
 *    所以连接页在网页端改成「搜索并选择设备」，信号一律显示「信号未知」。
 *
 * 2. 写入上限优先使用浏览器的 maxWriteWithoutResponseSize。
 *    不支持该接口时按设备通知长度的安全下界处理；未知时保守使用 20 字节，
 *    不用超出已知上限的试写冒险探测 MTU。
 *
 * 3. **写坏了要能重来**：A01 的帧是字节流，设备收到 0x00 就会丢掉
 *    之前残留的半帧。所以写入被拒时，先发一个结束符重同步，
 *    再把单包上限调小重写整段，不会出现「半帧 + 半帧」拼在一起的情况。
 */

import { DEVICE_NAME_PREFIX, listProfiles, parseDeviceName, resolveProfileByName } from '@/core/protocol/hardware'
import type { HardwareProfile, WriteOptions } from '@/core/protocol/types'
import {
  TraceLevel,
  Transport,
  TransportKind,
  TransportStatus,
  describeError,
} from './transport'

/** 保守的单次写入上限（ATT MTU 23 时的载荷）。 */
export const DEFAULT_CHUNK_SIZE = 20

/** 链路断开时统一给用户的一句话。 */
const LINK_LOST_MESSAGE = '读卡器已断开（可能是被拿走、关机或蓝牙中断），请重新连接'

/** 浏览器是否支持 Web Bluetooth。 */
export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

/** 浏览器蓝牙错误的中文说法。 */
const BLUETOOTH_ERROR_TEXT: Record<string, string> = {
  NotFoundError: '已取消选择设备',
  SecurityError: '浏览器拒绝了蓝牙访问（需要用户手势，且页面要在安全上下文中）',
  NetworkError: '蓝牙连接失败',
  InvalidStateError: '蓝牙设备当前不可用',
  AbortError: '蓝牙操作被中断',
  NotSupportedError: '该设备不支持蓝牙透传服务',
}

/**
 * 把浏览器的 DOMException 换成中文，同时**保留原始 name**。
 *
 * name 必须留着：上层靠 `NotFoundError` 区分「用户取消了设备选择」
 * 和「真的连不上」，前者不该弹错误提示、更不该重试。
 */
function wrapBluetoothError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error))
  }
  const name = error.name
  const text = BLUETOOTH_ERROR_TEXT[name]
  if (!text) {
    return error
  }
  const wrapped = new Error(text) as Error & { name: string }
  wrapped.name = name
  return wrapped
}

/**
 * 判断是不是「GATT 已经断了」这类错误。
 *
 * 浏览器抛的是原始英文异常（"GATT Server is disconnected. Cannot perform GATT
 * operations. (Re)connect first with `device.gatt.connect`."），
 * 直接给用户看等于把内部实现甩出去，所以先认出来再换成一句话。
 */
function isLinkLostError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message ?? '')
  return /GATT Server is disconnected|Cannot perform GATT operations|not connected/i.test(message)
}

/** 把浏览器的原始异常换成能照着做的话。 */
function translateLinkError(error: unknown): Error {
  if (isLinkLostError(error)) {
    return new Error(LINK_LOST_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 判断是不是「上一个 GATT 操作还没结束」这类忙错误。
 *
 * Chrome 在同一特征上还有操作在途时，再发一次会直接报
 * "GATT operation already in progress."。这不是链路坏了，是排队：
 * 等前一个操作收尾再写就行。
 */
function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message ?? '')
  return /already in progress|GATT operation/i.test(message)
}

/** A browser may advertise no-response writes but reject them on this characteristic. */
function isUnsupportedWriteError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false
  const name = (error as { name?: unknown }).name
  return name === 'NotSupportedError' || name === 'InvalidModificationError'
}

/** 忙错误给用户的一句话。 */
const BUSY_MESSAGE = '读卡器忙，上一次操作还没结束，请稍候重试'

/**
 * 单次写入的上限（毫秒）。
 *
 * 浏览器的 GATT 写有可能既不成功也不失败——Promise 永远不落地。
 * 那一次写入就会把整条串行队列堵死：射频场一直开着，
 * 后面所有操作都排在它后面，看起来就像「传输卡住了」。
 * 正常写入百来毫秒就回来了，这个上限给得足够宽松。
 */
const WRITE_TIMEOUT_MS = 5_000

/**
 * 「读卡器忙」时的重试间隔（毫秒）。
 *
 * Chrome 在上一个 GATT 操作还在途时会报 "GATT operation already in progress"，
 * 这是排队而不是链路坏了。等一会儿再写就好，但浏览器偶尔会连着报几次，
 * 所以给三档退避。
 */
const BUSY_RETRY_DELAYS_MS = [60, 180, 450]

/** 把浏览器的原始异常换成中文（写入路径用）。 */
export function translateBluetoothError(error: unknown): Error {
  if (isLinkLostError(error)) {
    return new Error(LINK_LOST_MESSAGE)
  }
  if (isBusyError(error)) {
    return new Error(BUSY_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 等一小会儿。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** 取 16 位短 UUID，统一 iOS 的短格式与 Android 的长格式。 */
function uuid16(uuid: string): string {
  const upper = (uuid || '').toUpperCase()
  if (upper.length === 4) {
    return upper
  }
  const match = /^0000([0-9A-F]{4})-/.exec(upper)
  return match ? match[1] : upper
}

/** 两个 UUID 是否指向同一个特征。 */
function sameUuid(left: string, right: string): boolean {
  return uuid16(left) === uuid16(right)
}

export class WebBluetoothTransport implements Transport {
  readonly kind: TransportKind = 'bluetooth'

  status: TransportStatus = 'idle'
  connectedName = ''
  connectedDeviceId = ''
  connectedAt = 0
  hardwareProfile: HardwareProfile | null = null
  lastRssi: number | null = null
  connectedDurationMs = 0
  /** 累计写入字节数。 */
  writtenBytes = 0
  /** 累计写入次数。 */
  writeCount = 0
  /** 累计 GATT 写入 Promise 等待时间，含失败与忙重试。 */
  writeDurationMs = 0

  /**
   * 单次写入上限。
   *
   * 写入一律用 ATT 确认写，上限就是协商出来的 MTU 减 3。
   * `maxWriteWithoutResponseSize` 与确认写共用协商后的 ATT MTU；设备回帧分片
   * 也提供安全下界。因此取浏览器报告值与已观察设备分片中的较大安全值，
   * 避免短回执把浏览器报告的更大 MTU 错误压低。
   */
  get chunkSize(): number {
    if (this.reliableChunkSize > 0) return this.reliableChunkSize
    const observed = Math.min(this.observedChunkSize, 244)
    const native = (this.device?.gatt as (BluetoothRemoteGATTServer & {
      maxWriteWithoutResponseSize?: number
    }) | undefined)?.maxWriteWithoutResponseSize
    const nativeLimit = typeof native === 'number' &&
      Number.isInteger(native) && native >= 20 && native <= 512 ? Math.min(native, 244) : 0
    return Math.max(DEFAULT_CHUNK_SIZE, observed, nativeLimit, this.verifiedSize)
  }

  setVerifiedChunkSize(size: number): void {
    if (!Number.isInteger(size) || size < DEFAULT_CHUNK_SIZE || size > 244) return
    this.verifiedSize = Math.max(this.verifiedSize, size)
    this.emitTrace(`只读协议回包验证通过：后续单次写入可使用 ${this.chunkSize} 字节`, 'success')
  }

  private connectionEpoch = 0

  private observedChunkSize = 0
  private verifiedSize = 0
  private reliableChunkSize = 0

  private device: BluetoothDevice | null = null
  private writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  private notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  /**
   * 设备的写特征是否支持「有响应写」（ATT 确认）。
   *
   * 支持就用有响应写：确认是链路层的流控点，确认过了就说明这一片
   * 已经落到设备上，设备端的接收队列不会被连发冲垮。
   * 只有设备根本不支持有响应写时，才退回无响应写。
   */
  private canWriteWithResponse = false
  private useWriteWithoutResponse = false
  private reliableWrites = false

  private statusListeners: Array<(status: TransportStatus, message: string) => void> = []
  private dataListeners: Array<(bytes: Uint8Array) => void> = []
  private traceListeners: Array<(message: string, level: TraceLevel) => void> = []
  private errorListeners: Array<(message: string) => void> = []

  private intentionalDisconnect = false
  /** 链路是否已经断掉；断掉后所有操作都报「请重新连接」，而不是含糊的「未连接」。 */
  private linkLost = false

  async connect(target?: string): Promise<void> {
    if (this.status === 'connected') {
      await this.disconnect()
    }
    if (!bluetoothAvailable()) {
      const message = '当前浏览器不支持 Web Bluetooth，请用 Chrome / Edge 桌面版打开'
      this.emitStatus('error', message)
      this.emitError(message)
      throw new Error(message)
    }
    this.emitStatus('connecting', '正在选择读卡器…')
    try {
      const device = await this.pickDevice(target)
      this.connectedName = device.name || '蓝牙读卡器'
      this.connectedDeviceId = device.id
      this.emitTrace(`已选择设备：${this.connectedName}`, 'success')

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        this.connectionEpoch++
        this.device = device
        this.observedChunkSize = 0
        this.verifiedSize = 0
        this.reliableChunkSize = 0
        this.reliableWrites = false
        this.useWriteWithoutResponse = false
        this.linkLost = false
        try {
          await this.initializeGatt(device)
          return
        } catch (error) {
          const linkDropped = this.linkLost || isLinkLostError(error)
          await this.cleanup()
          if (attempt === 1 && linkDropped) {
            this.emitTrace('连接初始化时 BLE 链路中断，正在恢复并重试一次…', 'warn')
            await delay(500)
            continue
          }
          throw error
        }
      }
    } catch (error) {
      await this.cleanup()
      const failure = this.linkLost || isLinkLostError(error)
        ? new Error(LINK_LOST_MESSAGE)
        : wrapBluetoothError(error)
      const message = describeError(failure)
      this.emitTrace(`连接失败：${message}`, 'error')
      this.emitStatus('error', message)
      this.emitError(message)
      // 保留原始错误的 name：调用方靠 `NotFoundError` 判断「用户取消了设备选择」，
      // 换成普通 Error 的话，连接流程会把「取消」当成失败反复重试。
      throw failure
    }
  }

  /** Connect and initialize services/characteristics; safe to retry as a unit. */
  private async initializeGatt(device: BluetoothDevice): Promise<void> {
    const server = await device.gatt?.connect()
    if (!server) throw new Error('无法建立 GATT 连接')
    // Attach immediately so disconnects during service discovery are observable.
    device.addEventListener('gattserverdisconnected', this.handleDisconnected)
    this.emitTrace('BLE 连接已建立', 'success')

    const profile = await this.resolveProfile(server)
    this.hardwareProfile = profile
    this.emitTrace(`硬件方案：${profile.label}`, 'success')

    const characteristics = await this.findCharacteristics(server, profile)
    this.notifyCharacteristic = characteristics.notify
    this.writeCharacteristic = characteristics.write
    this.canWriteWithResponse = Boolean(characteristics.write.properties.write)
    this.useWriteWithoutResponse = Boolean(characteristics.write.properties.writeWithoutResponse)
    this.emitTrace(
      `特征值就绪：写 ${uuid16(profile.rxUuid)}（${
        this.canWriteWithResponse
          ? this.useWriteWithoutResponse ? '支持有响应写和无响应写（分片窗口确认）' : '支持有响应写（逐片确认）'
          : '仅有无响应写'
      }）、接收 ${uuid16(profile.txUuid)}（${characteristics.notify.properties.indicate ? 'Indicate' : 'Notify'}）`,
      'success'
    )

    // Subscribe before the first protocol request; newer firmware responds only
    // after the indication/notification descriptor has been enabled.
    characteristics.notify.addEventListener('characteristicvaluechanged', this.handleValueChanged)
    await characteristics.notify.startNotifications()
    this.emitTrace('接收订阅已开启，可以收发数据', 'success')

    if (!device.gatt?.connected || this.linkLost) throw new Error(LINK_LOST_MESSAGE)

    this.connectedAt = Date.now()
    this.status = 'connected'
    this.emitTrace(
      `链路写入上限 ${this.chunkSize} 字节（设备回帧分片实测 ${this.observedChunkSize} 字节）` +
        `；短通知仅代表下界，不能据此判断实际 MTU`,
      'info',
    )
    this.emitStatus('connected', '读卡器已连接')
  }

  /**
   * 弹出系统设备选择器。
   *
   * 浏览器没有「扫描中」的概念，只有这一次用户手势。过滤条件按已登记的
   * 硬件方案生成：名字前缀 + 各方案的服务 UUID。手动指定设备时放开全部过滤。
   */
  private async pickDevice(target?: string): Promise<BluetoothDevice> {
    const bluetooth = navigator.bluetooth
    if (!bluetooth) {
      throw new Error('当前浏览器不支持 Web Bluetooth')
    }
    const profiles = listProfiles()
    // 多个方案可能共用同一个服务 UUID（A01 与 B01 目前就是），去重后再做过滤器。
    const serviceUuids = [...new Set(profiles.map(item => item.serviceUuid))]
    const options: RequestDeviceOptions = target
      ? { acceptAllDevices: true, optionalServices: serviceUuids }
      : {
          filters: [
            { namePrefix: DEVICE_NAME_PREFIX },
            ...serviceUuids.map(uuid => ({ services: [uuid] })),
          ],
          optionalServices: serviceUuids,
        }
    this.emitTrace('等待选择蓝牙设备…')
    return bluetooth.requestDevice(options)
  }

  /**
   * 认出这是哪一版硬件。
   *
   * 先看广播名里的方案编号；名字认不出来（被改名、被截断）就按 GATT 服务找，
   * 这样老设备换了名字也照样连得上。
   */
  private async resolveProfile(server: BluetoothRemoteGATTServer): Promise<HardwareProfile> {
    const named = parseDeviceName(this.connectedName)
    const byName = resolveProfileByName(this.connectedName)
    if (named && !byName) throw new Error(`暂不支持硬件方案 ${named.scheme}，不能套用其它方案的协议连接`)
    if (byName) {
      return byName
    }
    this.emitTrace('广播名未包含方案编号，按 GATT 服务识别…')
    const services = await server.getPrimaryServices()
    for (const profile of listProfiles()) {
      const service = services.find(item => sameUuid(item.uuid, profile.serviceUuid))
      if (!service) {
        continue
      }
      const characteristics = await service.getCharacteristics()
      const hasRx = characteristics.some(item => sameUuid(item.uuid, profile.rxUuid))
      const hasTx = characteristics.some(item => sameUuid(item.uuid, profile.txUuid))
      if (hasRx && hasTx) {
        // 多个方案共用同一个服务时这里会返回先登记的那个（A01）。
        // 协议一致所以照常能连，只是界面上的方案号按广播名为准。
        return profile
      }
    }
    throw new Error('该设备没有已知的读卡器服务，请确认连的是 D4U 读卡器')
  }

  /** 取出方案对应的读写特征。 */
  private async findCharacteristics(
    server: BluetoothRemoteGATTServer,
    profile: HardwareProfile
  ): Promise<{ write: BluetoothRemoteGATTCharacteristic; notify: BluetoothRemoteGATTCharacteristic }> {
    const services = await server.getPrimaryServices()
    const service = services.find(item => sameUuid(item.uuid, profile.serviceUuid))
    if (!service) {
      throw new Error('该设备没有读卡器服务')
    }
    const characteristics = await service.getCharacteristics()
    const notify = characteristics.find(item => sameUuid(item.uuid, profile.txUuid))
    const write = characteristics.find(item => sameUuid(item.uuid, profile.rxUuid))
    if (!notify || !(notify.properties.notify || notify.properties.indicate)) {
      throw new Error(`读卡器接收特征 ${uuid16(profile.txUuid)} 缺失或不支持 Notify / Indicate`)
    }
    if (!write || !(write.properties.write || write.properties.writeWithoutResponse)) {
      throw new Error('读卡器未提供可写的特征')
    }
    return { write, notify }
  }

  /**
   * 写入上限按设备分片长度推断。
   *
   * 设备发帧时按 `MTU - 3` 分片，所以「它发过来的分片有多长」，
   * 写入方向就能发多长——这是设备自己告诉我们的，不需要试写。
   *
   * 注意这个值是**下界**：设备回帧都短于它自己的 MTU 时，我们只能看到
   * 回帧的长度；浏览器支持时优先使用系统报告的真实长度。
   */
  private observeChunkSize(bytes: Uint8Array): void {
    if (bytes.length <= this.observedChunkSize) {
      return
    }
    this.observedChunkSize = bytes.length
    this.emitTrace(
      `设备发来的最大分片 ${bytes.length} 字节 → 单次写入上限 ${this.chunkSize} 字节`,
      'success',
    )
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true
    await this.cleanup()
    this.intentionalDisconnect = false
    this.linkLost = false
    this.emitStatus('idle', '')
  }

  private async cleanup(): Promise<void> {
    this.connectionEpoch++
    const device = this.device
    const notifyCharacteristic = this.notifyCharacteristic
    device?.removeEventListener('gattserverdisconnected', this.handleDisconnected)
    this.observedChunkSize = 0
    this.verifiedSize = 0
    this.device = null
    this.writeCharacteristic = null
    this.notifyCharacteristic = null
    this.connectedAt = 0
    this.connectedDurationMs = 0
    this.hardwareProfile = null
    this.lastRssi = null
    if (notifyCharacteristic) {
      try {
        notifyCharacteristic.removeEventListener('characteristicvaluechanged', this.handleValueChanged)
        await notifyCharacteristic.stopNotifications().catch(() => undefined)
      } catch {
        // 连接已经断了，忽略。
      }
    }
    if (device?.gatt?.connected) {
      try {
        device.gatt.disconnect()
      } catch {
        // 忽略。
      }
    }
  }

  /**
   * 写一段字节。
   *
   * 调用方（协议层）保证单次不超过 chunkSize；这里只做一次写入，
   * 分片与失败重试由协议层统一处理——它才知道帧的边界在哪。
   *
   * 默认在有限分片窗口中使用无响应写，并定期及每帧末尾等待 ATT 确认。
   * 这样缩短每片都等待 BLE 连接间隔造成的耗时，同时限制设备接收队列深度。
   */
  async writeChunk(bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    if (!this.writeCharacteristic) {
      throw new Error(this.linkLost ? LINK_LOST_MESSAGE : '读卡器未连接')
    }
    const startedAt = performance.now()
    try {
      await this.writeValue(bytes, options.confirm !== false)
      // 只统计真正写出去的数据：写失败的那次会被协议层重发，不该算两次。
      this.writtenBytes += bytes.length
      this.writeCount += 1
    } catch (error) {
      if (isLinkLostError(error)) {
        // 链路已经断了：把状态改掉，界面才不会继续显示「已连接」。
        const message = translateLinkError(error).message
        this.emitTrace(message, 'error')
        if (this.status === 'connected') {
          this.emitStatus('error', message)
        }
        throw new Error(message)
      }
      if (isBusyError(error)) {
        // 上一次 GATT 操作还在途：这不是链路坏了，是排队。
        // 等它收尾再写；多给几次机会——浏览器偶尔会连着报几次忙。
        for (const wait of BUSY_RETRY_DELAYS_MS) {
          await delay(wait)
          try {
            await this.writeValue(bytes, options.confirm !== false)
            this.writtenBytes += bytes.length
            this.writeCount += 1
            return
          } catch (retryError) {
            if (isLinkLostError(retryError)) {
              const message = translateLinkError(retryError).message
              this.emitTrace(message, 'error')
              if (this.status === 'connected') {
                this.emitStatus('error', message)
              }
              throw new Error(message)
            }
            if (!isBusyError(retryError)) {
              throw translateBluetoothError(retryError)
            }
          }
        }
        throw translateBluetoothError(error)
      }
      throw translateBluetoothError(error)
    } finally {
      this.writeDurationMs += performance.now() - startedAt
    }
  }

  private async writeValue(bytes: Uint8Array, confirm: boolean): Promise<void> {
    const characteristic = this.writeCharacteristic
    if (!characteristic) {
      throw new Error('读卡器未连接')
    }
    const payload = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    const canConfirm = Boolean(characteristic.properties.write)
    const canStream = this.useWriteWithoutResponse && !this.reliableWrites
    if (!confirm && canStream) {
      try {
        await this.withWriteTimeout(() => characteristic.writeValueWithoutResponse(payload))
        return
      } catch (error) {
        if (!isUnsupportedWriteError(error)) throw error
        this.useWriteWithoutResponse = false
        this.emitTrace('无响应写不可用，改用有响应写', 'warn')
      }
    }
    if (canConfirm) {
      await this.withWriteTimeout(() => characteristic.writeValueWithResponse(payload))
      return
    }
    await this.withWriteTimeout(() => characteristic.writeValueWithoutResponse(payload))
  }

  /** Shrink to one ATT-confirmed write per fragment after repeated frame loss. */
  setReliableWrites(enabled: boolean): void {
    if (this.reliableWrites === enabled) return
    this.reliableWrites = enabled
    this.reliableChunkSize = enabled ? this.chunkSize : 0
    this.emitTrace(
      enabled ? '链路持续丢帧，已切换为每片等确认' : '链路恢复快速传输窗口',
      enabled ? 'warn' : 'info',
    )
  }

  /**
   * 给写入加个上限。
   *
   * 浏览器的 GATT 写有可能既不成功也不失败——Promise 永远不落地。
   * 不设上限，这一次写入就会把整条串行队列堵死：
   * 射频场一直开着，后面所有操作都排在它后面。
   */
  private async withWriteTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`写入超时（${WRITE_TIMEOUT_MS} ms），蓝牙链路可能已经卡住`)),
            WRITE_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
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

  private handleValueChanged = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic | null
    const value = target?.value
    if (!value) {
      return
    }
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    // 设备按 MTU-3 分片发帧：分片长度就是写入方向的上限。
    this.observeChunkSize(bytes)
    this.dataListeners.forEach(listener => listener(bytes))
  }

  private handleDisconnected = (): void => {
    this.connectionEpoch++
    // 任何阶段掉线都要处理：连接过程中掉线如果被忽略，
    // 连接流程会继续往下走，最后把一条死链报成「已连接」。
    const wasConnecting = this.status === 'connecting'
    const wasActive = this.status === 'connected' || wasConnecting
    this.observedChunkSize = 0
    this.writeCharacteristic = null
    this.notifyCharacteristic = null
    this.connectedAt = 0
    this.connectedDurationMs = 0
    this.hardwareProfile = null
    if (!wasConnecting) this.device = null
    if (this.intentionalDisconnect) {
      this.emitStatus('idle', '')
      return
    }
    this.linkLost = true
    if (!wasActive) {
      return
    }
    if (wasConnecting) {
      // Keep the selected BluetoothDevice until connect() catches the failed
      // GATT request and performs one bounded recovery attempt.
      this.emitTrace('连接初始化期间 BLE 链路中断', 'warn')
      return
    }
    this.emitTrace(LINK_LOST_MESSAGE, 'error')
    this.emitError(LINK_LOST_MESSAGE)
    this.emitStatus('error', LINK_LOST_MESSAGE)
  }

  private emitStatus(status: TransportStatus, message: string): void {
    this.status = status
    this.statusListeners.forEach(listener => listener(status, message))
  }

  private emitTrace(message: string, level: TraceLevel = 'info'): void {
    this.traceListeners.forEach(listener => listener(message, level))
  }

  private emitError(message: string): void {
    this.errorListeners.forEach(listener => listener(message))
  }
}
