/**
 * USB HID transport for the RF Device control interface.
 *
 * HID reports carry the same COBS/CRC byte stream as BLE. Each output report
 * contains up to eight bytes; input reports are joined back into that stream
 * before the protocol session sees them.
 */

import { A01_PROFILE } from '@/core/protocol/a01'
import { resolveProfileByName } from '@/core/protocol/hardware'
import type { HardwareProfile, WriteOptions } from '@/core/protocol/types'
import { describeError, type TraceLevel, type Transport, type TransportKind, type TransportStatus } from './transport'

const USB_FILTER = { vendorId: 0x1a86, productId: 0x572d }
const REPORT_ID = 0
const REPORT_SIZE = 8
const MAX_ENCODED_FRAME = 10_541 + 32

interface HidReportEvent extends Event {
  device: HidDeviceLike
  reportId: number
  data: DataView
}

interface HidDeviceLike extends EventTarget {
  vendorId: number
  productId: number
  productName: string
  opened: boolean
  collections: Array<{
    outputReports?: Array<{ reportId: number; items: Array<{ reportSize: number }> }>
    inputReports?: Array<{ reportId: number; items: Array<{ reportSize: number }> }>
  }>
  open(): Promise<void>
  close(): Promise<void>
  sendReport(reportId: number, data: BufferSource): Promise<void>
}

interface WebHidLike extends EventTarget {
  requestDevice(options: { filters: Array<{ vendorId: number; productId: number }> }): Promise<HidDeviceLike[]>
}

function webHid(): WebHidLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { hid?: WebHidLike }).hid ?? null
}

/** Whether this browser can use WebHID. */
export function usbAvailable(): boolean {
  return webHid() !== null
}

export class UsbHidTransport implements Transport {
  readonly kind: TransportKind = 'usb'
  status: TransportStatus = 'idle'
  readonly chunkSize = REPORT_SIZE
  connectedName = ''
  connectedDeviceId = ''
  connectedAt = 0
  hardwareProfile: HardwareProfile | null = null
  lastRssi: number | null = null
  connectedDurationMs = 0
  writtenBytes = 0
  writeCount = 0

  private device: HidDeviceLike | null = null
  private encoded: number[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private intentionalDisconnect = false
  private statusListeners: Array<(status: TransportStatus, message: string) => void> = []
  private dataListeners: Array<(bytes: Uint8Array) => void> = []
  private traceListeners: Array<(message: string, level: TraceLevel) => void> = []
  private errorListeners: Array<(message: string) => void> = []

  private readonly onInputReport = (event: Event): void => {
    const report = event as HidReportEvent
    if (report.device !== this.device || report.reportId !== REPORT_ID) return
    for (const byte of new Uint8Array(report.data.buffer, report.data.byteOffset, report.data.byteLength)) {
      if (byte === 0) {
        if (this.encoded.length) {
          const frame = Uint8Array.from([...this.encoded, 0])
          this.dataListeners.forEach(listener => listener(frame))
        }
        this.encoded = []
      } else if (this.encoded.length < MAX_ENCODED_FRAME) {
        this.encoded.push(byte)
      } else {
        this.encoded = []
        this.emitTrace('USB HID 数据帧超长，已丢弃', 'warn')
      }
    }
  }

  private readonly onDisconnect = (event: Event): void => {
    const device = (event as Event & { device?: HidDeviceLike }).device
    if (device && device !== this.device) return
    webHid()?.removeEventListener('disconnect', this.onDisconnect)
    this.device?.removeEventListener('inputreport', this.onInputReport)
    this.device = null
    this.resetConnection()
    if (!this.intentionalDisconnect) {
      const message = 'USB HID 读卡器已断开，请重新连接'
      this.emitTrace(message, 'error')
      this.emitError(message)
      this.emitStatus('error', message)
    }
  }

  async connect(): Promise<void> {
    if (this.status === 'connected') await this.disconnect()
    const hid = webHid()
    if (!hid) {
      const message = '当前浏览器不支持 WebHID，请使用 Chrome 或 Edge 桌面版，并通过 HTTPS 或 localhost 打开'
      this.emitStatus('error', message)
      this.emitError(message)
      throw new Error(message)
    }

    this.emitStatus('connecting', '正在选择 USB HID 读卡器…')
    try {
      const devices = await hid.requestDevice({ filters: [USB_FILTER] })
      const device = devices[0]
      if (!device) throw new Error('没有选择 USB HID 设备')
      this.device = device
      await device.open()
      this.validateReports(device)
      this.encoded = []
      device.addEventListener('inputreport', this.onInputReport)
      hid.addEventListener('disconnect', this.onDisconnect)
      this.connectedName = device.productName || 'USB HID 读卡器'
      this.connectedDeviceId = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`.toUpperCase()
      // The approved VID/PID is the RF Device interface; current A01/B01 USB
      // firmware shares the registered control protocol and frame format.
      this.hardwareProfile = resolveProfileByName(device.productName) ?? A01_PROFILE
      this.connectedAt = Date.now()
      this.emitTrace(`USB HID 已打开：${this.connectedName}（${this.connectedDeviceId}）`, 'success')
      this.emitStatus('connected', 'USB HID 读卡器已连接')
    } catch (error) {
      await this.closeDevice()
      const message = describeError(error)
      this.emitTrace(`USB HID 连接失败：${message}`, 'error')
      this.emitStatus('error', message)
      this.emitError(message)
      throw error instanceof Error ? error : new Error(message)
    }
  }

  private validateReports(device: HidDeviceLike): void {
    const inputs = device.collections.flatMap(collection => collection.inputReports ?? [])
    const outputs = device.collections.flatMap(collection => collection.outputReports ?? [])
    if (!inputs.some(report => report.reportId === REPORT_ID) || !outputs.some(report => report.reportId === REPORT_ID)) {
      throw new Error('USB HID 设备缺少 report ID 0 的输入或输出报告，请确认已连接 RF Device HID 接口')
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true
    await this.closeDevice()
    this.intentionalDisconnect = false
    this.resetConnection()
    this.emitStatus('idle', '')
  }

  private async closeDevice(): Promise<void> {
    const device = this.device
    this.device = null
    const hid = webHid()
    device?.removeEventListener('inputreport', this.onInputReport)
    hid?.removeEventListener('disconnect', this.onDisconnect)
    try { if (device?.opened) await device.close() } catch { /* device may already be gone */ }
  }

  private resetConnection(): void {
    this.encoded = []
    this.hardwareProfile = null
    this.connectedName = ''
    this.connectedDeviceId = ''
    this.connectedAt = 0
    this.connectedDurationMs = 0
  }

  async writeChunk(bytes: Uint8Array, _options?: WriteOptions): Promise<void> {
    const device = this.device
    if (!device?.opened) throw new Error('USB HID 读卡器未连接')
    if (bytes.length > REPORT_SIZE) throw new Error(`USB HID 单次最多写入 ${REPORT_SIZE} 字节`)
    const report = new Uint8Array(REPORT_SIZE)
    report.set(bytes)
    const previous = this.writeChain
    let release!: () => void
    this.writeChain = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      await device.sendReport(REPORT_ID, report)
      this.writtenBytes += bytes.length
      this.writeCount += 1
    } catch (error) {
      const message = describeError(error)
      this.emitTrace(`USB HID 写入失败：${message}`, 'error')
      throw error
    } finally {
      release()
    }
  }

  onStatus(listener: (status: TransportStatus, message: string) => void): () => void {
    this.statusListeners.push(listener)
    return () => { this.statusListeners = this.statusListeners.filter(item => item !== listener) }
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.push(listener)
    return () => { this.dataListeners = this.dataListeners.filter(item => item !== listener) }
  }

  onTrace(listener: (message: string, level: TraceLevel) => void): void { this.traceListeners.push(listener) }
  onError(listener: (message: string) => void): void { this.errorListeners.push(listener) }

  private emitStatus(status: TransportStatus, message: string): void {
    this.status = status
    this.statusListeners.forEach(listener => listener(status, message))
  }

  private emitTrace(message: string, level: TraceLevel = 'info'): void {
    this.traceListeners.forEach(listener => listener(message, level))
  }

  private emitError(message: string): void { this.errorListeners.forEach(listener => listener(message)) }
}
