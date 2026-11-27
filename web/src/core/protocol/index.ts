/**
 * 协议层门面。
 *
 * 对外只暴露两件事：
 * 1. 硬件方案登记处（按方案隔离协议差异）；
 * 2. 设备会话管理器（连接后自动握手，随时可取到就绪的会话）。
 *
 * 上层（射频桥、界面）只跟 DeviceSession 打交道，
 * 不需要知道底下是蓝牙还是 USB，也不关心具体是哪个硬件方案。
 */

import { transportManager } from '../../platform/transport'
import { DeviceSession } from './types'

export * from './types'
export * from './hardware'
export * from './features'
export { A01_PROFILE } from './a01'
export { B01_PROFILE } from './b01'

/**
 * 设备会话管理器。
 *
 * 传输层连上就自动握手；上层要用的时候直接 await require()。
 */
export class DeviceSessionManager {
  private session: DeviceSession | null = null
  private ready: Promise<DeviceSession> | null = null
  private failure: Error | null = null

  private generation = 0

  constructor(private readonly transport = transportManager) {
    this.transport.onStatus(status => {
      if (status === 'connected') {
        void this.open().catch(() => undefined)
      } else if (status === 'idle' || status === 'error' || status === 'connecting') {
        void this.close()
      }
    })
  }

  /** 当前会话；未连接或握手未完成时为 null。 */
  get current(): DeviceSession | null {
    return this.session
  }

  /** 握手失败的原因。 */
  get error(): Error | null {
    return this.failure
  }

  /** 建立会话并握手。 */
  open(): Promise<DeviceSession> {
    if (this.ready) return this.ready
    if (this.transport.status !== 'connected') return Promise.reject(new Error('读卡器未连接'))
    const profile = this.transport.hardwareProfile
    if (!profile) {
      this.failure = new Error('未能识别读卡器的硬件方案')
      return Promise.reject(this.failure)
    }
    const generation = ++this.generation
    const previous = this.session
    this.session = null
    this.failure = null
    // Publish the single-flight promise before closing old sessions or starting a handshake.
    const promise = Promise.resolve().then(async () => {
      if (previous) await previous.close().catch(() => undefined)
      if (generation !== this.generation || this.transport.status !== 'connected') throw new Error('设备连接已变化')
      const session = profile.createSession(this.transport)
      this.session = session
      try {
        await session.connect()
        if (generation !== this.generation || this.session !== session) throw new Error('设备连接已变化')
        return session
      } catch (error) {
        await session.close().catch(() => undefined)
        if (this.session === session) this.session = null
        throw error
      }
    })
    this.ready = promise
    void promise.catch(error => {
      if (this.ready === promise && generation === this.generation) {
        this.failure = error instanceof Error ? error : new Error(String(error))
        this.ready = null
      }
    })
    return promise
  }

  /**
   * 取得就绪的会话。
   *
   * 刚连上还没握手完时，这里会等到握手结束再返回。
   */
  async require(): Promise<DeviceSession> {
    if (this.ready) {
      return this.ready
    }
    if (this.transport.status === 'connected') {
      return this.open()
    }
    throw new Error('读卡器未连接')
  }

  /** 关闭会话。 */
  async close(): Promise<void> {
    ++this.generation
    this.ready = null
    const session = this.session
    this.session = null
    if (session) {
      await session.close().catch(() => undefined)
    }
  }
}

/** 全局会话管理器。 */
export const deviceSession = new DeviceSessionManager()
