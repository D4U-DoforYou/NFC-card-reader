/**
 * 连接任务：把「选设备 → 连接 → 失败重试」串成一个流程。
 *
 * 与小程序版的差别：浏览器蓝牙**没有持续扫描**，只能在用户点击时弹出
 * 设备选择器，所以这里没有「扫到哪些设备」的清单，也没有信号兜底策略；
 * 一次流程就是弹一次选择器、连一次。
 *
 * 用户主动取消选择（NotFoundError）时不重试——再弹一次是打扰。
 * 其余失败（读卡器没上电、服务不对等）才值得重试。
 */

import { transportManager } from '../../platform/transport'
import { readerLogs } from './readerLogs'

export interface ConnectionState {
  running: boolean
  attempt: number
  total: number
  error: string
}

/** 判断是不是「用户取消了设备选择」。 */
function isUserCancel(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    return (error as { name: string }).name === 'NotFoundError'
  }
  return false
}

export class ReaderConnection {
  state: ConnectionState = { running: false, attempt: 0, total: 0, error: '' }
  private pending: Promise<void> | null = null
  private cancelled = false
  private listeners: Array<() => void> = []

  constructor(private retryMs = 800) {}

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  private emit(): void {
    this.listeners.forEach(listener => listener())
  }

  connect(attempts = 1): Promise<void> {
    if (this.pending) {
      return this.pending
    }
    if (transportManager.status === 'connected') {
      return Promise.resolve()
    }
    this.cancelled = false
    this.state = { running: true, attempt: 0, total: attempts, error: '' }
    // 推迟至微任务，让 pending 在状态回调触发前赋值，保证任务合并。
    this.pending = Promise.resolve()
      .then(() => this.run(attempts))
      .finally(() => {
        this.pending = null
        this.state.running = false
        this.emit()
      })
    this.emit()
    return this.pending
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    await this.pending?.catch(() => undefined)
  }

  private async run(attempts: number): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.cancelled) {
        throw new Error('连接已取消')
      }
      this.state.attempt = attempt
      this.emit()
      readerLogs.add('info', `连接读卡器：第 ${attempt}/${attempts} 次尝试`)
      try {
        await transportManager.connect()
        if (this.cancelled) {
          await transportManager.disconnect().catch(() => undefined)
          throw new Error('连接已取消')
        }
        this.state.error = ''
        readerLogs.add('success', `已连接读卡器：${transportManager.connectedName}`)
        return
      } catch (error) {
        if (this.cancelled) {
          throw new Error('连接已取消')
        }
        const message = error instanceof Error ? error.message : String(error)
        if (isUserCancel(error)) {
          this.state.error = ''
          readerLogs.add('info', '已取消选择设备')
          throw new Error('已取消选择设备')
        }
        this.state.error = message
        readerLogs.add('warn', `第 ${attempt}/${attempts} 次未连接：${message}`)
        this.emit()
        if (attempt < attempts) {
          await new Promise<void>(resolve => setTimeout(resolve, this.retryMs))
        }
      }
    }
    throw new Error(this.state.error || '未连接读卡器，请确认读卡器已上电')
  }
}

export const readerConnection = new ReaderConnection()

/** RSSI 是接收信号强度，未知时不伪造百分比。 */
export function signalInfo(rssi: number | null): { bars: number; label: string } {
  if (rssi === null || !Number.isFinite(rssi) || rssi >= 0 || rssi < -127) {
    return { bars: 0, label: '信号未知' }
  }
  if (rssi >= -55) {
    return { bars: 4, label: '信号很强' }
  }
  if (rssi >= -67) {
    return { bars: 3, label: '信号良好' }
  }
  if (rssi >= -80) {
    return { bars: 2, label: '信号一般' }
  }
  return { bars: 1, label: '信号较弱' }
}
