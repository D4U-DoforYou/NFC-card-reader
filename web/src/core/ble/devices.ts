/**
 * 设备发现与选择：蓝牙设备名规则、读卡器判定、候选设备管理。
 *
 * 这块单独成模块，是为了以后改规则时只动这里：
 * 固件改广播名、加前缀、换广播内容，或者要支持别的读卡器型号，
 * 都不用碰传输层（transport）与连接流程（connection）。
 *
 * 名称规则由 core/protocol/hardware 统一定义：
 * `D4U-NFC` + 硬件方案编号 + `-` + 蓝牙 MAC 尾段，例如 `D4U-NFCA01-1A2B`、
 * `D4U-NFCB01-30CEF9F517`（尾段长度随固件而异）。
 */

import {
  DEVICE_NAME_PREFIX,
  listProfiles,
  matchReaderDevice,
  parseDeviceName,
  profileByScheme,
} from '@/core/protocol/hardware'
import { HardwareProfile } from '@/core/protocol/types'

export { DEVICE_NAME_PREFIX, parseDeviceName, profileByScheme }

/** 候选设备上限，避免周围 BLE 设备太多时把列表撑爆。 */
export const MAX_DEVICES = 40

/**
 * 超过这个时间还没找到匹配的读卡器，就按信号最强的设备兜底。
 *
 * 万一读卡器改了广播名导致认不出来，也不至于完全连不上。
 */
export const FALLBACK_AFTER_MS = 4000

/** 候选设备。 */
export interface DeviceCandidate {
  deviceId: string
  /** 展示名：广播名优先，其次本地名，都没有就叫「未知设备」。 */
  name: string
  localName: string
  rssi: number
  /** 是否广播了透传服务。 */
  advertisesService: boolean
  /** 是否判定为读卡器。 */
  matched: boolean
  /** 判定理由，界面上能看出为什么认定它是读卡器。 */
  reason: string
  /** 识别出的硬件方案。 */
  profile: HardwareProfile | null
  /** 首次发现的时间戳。 */
  seenAt: number
}

/** 判定结果。 */
export interface MatchResult {
  matched: boolean
  reason: string
}

/**
 * 判定一台设备是不是读卡器。
 *
 * 广播了透传服务最可靠——即使名字被改过也能认出来；
 * 名称匹配是次选，固件默认在广播名里带 D4U-NFC 与方案编号。
 */
export function matchReader(label: string, advertisesService: boolean): MatchResult {
  const result = matchReaderDevice(label, advertisesService)
  return { matched: result.matched, reason: result.reason }
}

/**
 * 扫描到的设备清单。
 *
 * 只负责收集与挑选，具体连不连由连接流程决定。
 */
export class DeviceCatalog {
  private items: DeviceCandidate[] = []

  /** 当前候选设备，按发现顺序。 */
  list(): DeviceCandidate[] {
    return [...this.items]
  }

  /** 清空，重新扫描时用。 */
  clear(): void {
    this.items = []
  }

  /**
   * 收到一条广播就更新清单。
   *
   * 同一个设备会反复广播，RSSI 每次都不一样，所以按 deviceId 覆盖而不是追加。
   */
  upsert(
    raw: {
      deviceId: string
      name: string
      localName: string
      rssi: number
      advertisesService: boolean
    },
    now = Date.now()
  ): DeviceCandidate {
    const label = (raw.name || raw.localName || '').trim() || '未知设备'
    const match = matchReaderDevice(label, raw.advertisesService)
    const item: DeviceCandidate = {
      deviceId: raw.deviceId,
      name: label,
      localName: raw.localName,
      rssi: raw.rssi,
      advertisesService: raw.advertisesService,
      matched: match.matched,
      reason: match.reason,
      profile: match.profile,
      seenAt: now,
    }
    const index = this.items.findIndex(entry => entry.deviceId === item.deviceId)
    if (index >= 0) {
      // 保留首次发现时间
      item.seenAt = this.items[index].seenAt
      this.items = this.items.map(entry => (entry.deviceId === item.deviceId ? item : entry))
    } else if (this.items.length < MAX_DEVICES) {
      this.items = [...this.items, item]
    }
    return item
  }

  /**
   * 从候选设备里挑一台来连。
   *
   * 规则：
   * 1. 匹配到读卡器就立刻用它，不等；
   * 2. 一直没匹配上，超过兜底时间后按信号最强的那台连；
   * 3. `rejected` 里的设备不再考虑（上一轮发现它没有透传服务）。
   */
  pick(rejected: Set<string>, elapsedMs: number): DeviceCandidate | null {
    const usable = this.items.filter(item => !rejected.has(item.deviceId))
    if (!usable.length) {
      return null
    }
    const matched = usable.find(item => item.matched)
    if (matched) {
      return matched
    }
    if (elapsedMs >= FALLBACK_AFTER_MS) {
      return [...usable].sort((a, b) => b.rssi - a.rssi)[0]
    }
    return null
  }

  /** 按信号强弱排序，给界面显示用。 */
  sortedBySignal(): DeviceCandidate[] {
    return [...this.items].sort((a, b) => {
      if (a.matched !== b.matched) {
        return a.matched ? -1 : 1
      }
      return b.rssi - a.rssi
    })
  }

  /**
   * 只返回判定为读卡器的设备。
   *
   * 名称不匹配的普通 BLE 设备（耳机、手环、音箱）不该出现在界面上，
   * 那是干扰项——用户只想看到能当读卡器用的那几台。
   */
  matchedList(): DeviceCandidate[] {
    return this.sortedBySignal().filter(item => item.matched)
  }
}

/** 已登记的硬件方案，供界面展示。 */
export function supportedProfiles(): HardwareProfile[] {
  return listProfiles()
}
