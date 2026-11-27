/**
 * 硬件方案登记处。
 *
 * 蓝牙设备名规则：
 *
 * ```text
 * D4U-NFC + 方案编号 + '-' + 蓝牙 MAC 尾段
 * 例如 D4U-NFCA01-1A2B、D4U-NFCB01-30CEF9F517
 * ```
 *
 * - `D4U-NFC` 是固定前缀，所有方案共用；
 * - `A01`、`B01` 是硬件方案编号，协议差异按方案隔离；
 * - 末尾是蓝牙 MAC 的十六进制尾段，长度随固件而异（1–6 字节），
 *   用来区分同型号的多台设备。
 *
 * 协议层与硬件方案一一对应：这里登记了哪个方案，
 * 上层才知道该怎么跟它说话。B01 目前与 A01 通信协议一致，
 * 共用同一套帧格式与消息契约，但仍是独立方案、独立档案。
 */

import { HardwareProfile } from './types'
import { A01_PROFILE } from './a01'
import { B01_PROFILE } from './b01'

/** 设备名的固定前缀。 */
export const DEVICE_NAME_PREFIX = 'D4U-NFC'

/** 已登记的硬件方案。 */
const PROFILES: HardwareProfile[] = [A01_PROFILE, B01_PROFILE]

/** 设备名解析结果。 */
export interface DeviceNameInfo {
  /** 硬件方案编号，例如 'A01'。 */
  scheme: string
  /** 蓝牙 MAC 尾段（十六进制，大写）。长度随固件而异，最多 6 字节。 */
  macTail: string
}

/**
 * 解析广播名。
 *
 * 名称不认得就返回 null——不要猜，猜错会连上一台说不清话的设备。
 *
 * MAC 尾段的长度不固定：A01 广播的是后两字节（4 位十六进制），
 * B01 广播的是 5 字节（10 位十六进制）。所以这里只校验「是十六进制、且不超过 6 字节」，
 * 不去猜固件会广播几位——方案号才是认设备的依据，尾段只是顺带带出来的信息。
 */
export function parseDeviceName(name: string): DeviceNameInfo | null {
  const trimmed = (name || '').trim()
  if (!trimmed.toUpperCase().startsWith(DEVICE_NAME_PREFIX)) {
    return null
  }
  const rest = trimmed.slice(DEVICE_NAME_PREFIX.length)
  const dash = rest.indexOf('-')
  if (dash <= 0) {
    return null
  }
  const scheme = rest.slice(0, dash).trim().toUpperCase()
  const macTail = rest.slice(dash + 1).trim().toUpperCase()
  if (!/^[A-Z][0-9]{2}$/.test(scheme) || !/^[0-9A-F]{1,12}$/.test(macTail)) {
    return null
  }
  return { scheme, macTail }
}

/** 全部已登记的方案。 */
export function listProfiles(): HardwareProfile[] {
  return [...PROFILES]
}

/** 按方案编号找档案。 */
export function profileByScheme(scheme: string): HardwareProfile | null {
  const upper = (scheme || '').trim().toUpperCase()
  if (!upper) {
    return null
  }
  return PROFILES.find(profile => profile.scheme.toUpperCase() === upper) ?? null
}

/** 按 GATT 服务 UUID 找档案。 */
export function profileByServiceUuid(uuid: string): HardwareProfile | null {
  const upper = (uuid || '').trim().toUpperCase()
  if (!upper) {
    return null
  }
  return (
    PROFILES.find(profile => profile.serviceUuid.toUpperCase() === upper) ?? null
  )
}

/**
 * 按广播名解析出硬件方案。
 *
 * 名字认得但方案没登记时返回 null——这类设备以后可能有别的协议，
 * 不能拿 A01 的协议去硬碰。
 */
export function resolveProfileByName(name: string): HardwareProfile | null {
  const parsed = parseDeviceName(name)
  if (!parsed) {
    return null
  }
  return profileByScheme(parsed.scheme)
}

/** 广播名匹配结果。 */
export interface MatchResult {
  matched: boolean
  reason: string
  /** 认出来的硬件方案。 */
  profile: HardwareProfile | null
}

/**
 * 判定一台设备是不是支持的读卡器。
 *
 * 广播了已知服务最可靠；名称里带 D4U-NFC 且方案已登记次之。
 */
export function matchReaderDevice(label: string, advertisesService: boolean): MatchResult {
  const parsed = parseDeviceName(label)
  if (parsed) {
    const profile = profileByScheme(parsed.scheme)
    if (profile) {
      return {
        matched: true,
        reason: `方案 ${profile.scheme}（${profile.label}）`,
        profile,
      }
    }
    return { matched: false, reason: `未登记的硬件方案 ${parsed.scheme}`, profile: null }
  }
  if (advertisesService) {
    return { matched: true, reason: '广播了已知服务', profile: null }
  }
  return { matched: false, reason: '未匹配读卡器', profile: null }
}
