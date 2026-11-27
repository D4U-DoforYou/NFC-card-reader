/**
 * 墨水屏会话：连接读卡器后完成激活、协议判定与屏幕档案读取。
 *
 * 协议族通过唤醒帧判定（华为 0x7A / 通用 NFC-A 0x26），随后用 D1 的 TLV
 * 复核几何与能力参数；两者不一致时以 D1 为准并提示用户。
 */

import { transportManager } from '../../platform/transport'
import { deviceSession } from '../protocol'
import { capabilityOperationIssue } from '../protocol/features'
import { toHex } from '../hex'
import { RfBridge } from './bridge'
import { Activation, IsoDepSession, WAKE_FRAME_HUAWEI, WAKE_FRAME_REQA, activateTag } from './isoDep'
import { ProtocolFamily, READ_INFO } from '../epd/commands'
import { DeviceProfile, parseProfile } from '../epd/profile'

export interface ActivationResult {
  activation: Activation
  profile: DeviceProfile
  family: ProtocolFamily
  /** 协议判定与 D1 复核是否存在差异。 */
  warning: string
}

/** 每个协议族的激活尝试次数。 */
const ACTIVATION_ATTEMPTS = 3

export class EpdSession {
  private readonly bridge: RfBridge
  private activation: Activation | null = null
  private profile: DeviceProfile | null = null
  private isoDep: IsoDepSession | null = null

  constructor() {
    this.bridge = new RfBridge(transportManager)
  }

  get isReady(): boolean {
    return this.isoDep !== null && this.activation !== null
  }

  get currentProfile(): DeviceProfile | null {
    return this.profile
  }

  get currentActivation(): Activation | null {
    return this.activation
  }

  get rfBridge(): RfBridge {
    return this.bridge
  }

  /** ISO-DEP 会话（激活后可用）。 */
  get iso(): IsoDepSession | null {
    return this.isoDep
  }

  /** 复位射频场并激活卡片，同时判定屏幕协议。 */
  async activate(onLog?: (message: string) => void): Promise<ActivationResult> {
    this.reset()
    if (transportManager.status !== 'connected') {
      throw new Error('读卡器未连接')
    }
    const device = await deviceSession.require()
    for (const operation of ['set_field', 'transceive']) {
      const issue = capabilityOperationIssue(device.capabilities, 'org.example.rf.raw', operation)
      if (issue) throw new Error(issue)
    }
    const candidates: Array<{ frame: number; family: ProtocolFamily }> = [
      { frame: WAKE_FRAME_HUAWEI, family: 'huawei' },
      { frame: WAKE_FRAME_REQA, family: 'panel' },
    ]
    const failures: string[] = []
    let activation: Activation | null = null
    let family: ProtocolFamily = 'panel'

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const label = `0x${candidate.frame.toString(16).toUpperCase()}`
      for (let attempt = 1; attempt <= ACTIVATION_ATTEMPTS; attempt += 1) {
        onLog?.(attempt === 1 ? '复位射频场' : `复位射频场（第 ${attempt} 次重试）`)
        await this.bridge.cycleRfField()
        try {
          activation = await activateTag(this.bridge, candidate.frame)
          family = candidate.family
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (attempt === ACTIVATION_ATTEMPTS) {
            failures.push(`${label}: ${message}`)
            break
          }
          // 射频错误多为偶发（标签未响应、接收窗口过窄），复位射频场后重试。
          onLog?.(`${label} 激活失败，重试：${message}`)
        }
      }
      if (activation) {
        break
      }
    }

    if (!activation) {
      await this.releaseRfField()
      throw new Error(`自动识别屏幕失败；${failures.join('; ')}`)
    }

    this.activation = activation
    this.isoDep = new IsoDepSession(this.bridge, activation)

    try {
      onLog?.('读取屏幕信息')
      const response = await this.isoDep.exchange(READ_INFO)
      let profile: DeviceProfile
      let warning = ''
      try {
        profile = parseProfile(family, response)
      } catch (error) {
        const other: ProtocolFamily = family === 'huawei' ? 'panel' : 'huawei'
        try {
          profile = parseProfile(other, response)
          warning = `D1 参数与${family === 'huawei' ? '华为' : '通用面板'}协议不一致，已按${
            other === 'huawei' ? '华为' : '通用面板'
          }协议解析`
        } catch (fallbackError) {
          throw new Error(
            `D1 解析失败：${error instanceof Error ? error.message : String(error)}；` +
              `备用协议解析同样失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
          )
        }
      }

      if (profile.family !== family) {
        warning = warning || 'D1 参数与唤醒帧协议不一致，已以 D1 为准'
      }
      if (profile.uid.length !== activation.uid.length || profile.uid.some((value, index) => value !== activation!.uid[index])) {
        throw new Error('D1 UID 与选卡 UID 不一致，已停止刷写')
      }
      this.profile = profile
      onLog?.(
        `已识别：${profile.modelName}，协议=${profile.family}，UID=${toHex(profile.uid)}，${profile.colorCount} 色`
      )
      return { activation, profile, family: profile.family, warning }
    } catch (error) {
      await this.releaseRfField()
      this.reset()
      throw error
    }
  }

  /** 发送一条应用层指令。 */
  async exchange(inf: Uint8Array, recoveryBudget?: number): Promise<Uint8Array> {
    if (!this.isoDep) {
      throw new Error('请先激活卡片')
    }
    return this.isoDep.exchange(inf, recoveryBudget)
  }

  /** 关闭射频场。 */
  async releaseRfField(): Promise<void> {
    try {
      await this.bridge.setRfField(false)
    } catch (error) {
      // 断电或已断开时忽略
    }
  }

  /** 重置会话状态。 */
  reset(): void {
    this.activation = null
    this.profile = null
    this.isoDep = null
  }
}

/** 全局会话实例。 */
export const epdSession = new EpdSession()
