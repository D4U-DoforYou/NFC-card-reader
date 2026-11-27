/**
 * 屏幕档案解析：D1 响应中的 TLV 字段、几何信息与协议族判定。
 *
 * 协议族通过唤醒帧区分（华为 0x7A / 通用 0x26），D1 再给出几何与能力参数，
 * 两处结果不一致时以 D1 为准并在界面上给出提示。
 */

import { ProtocolFamily, isSuccess } from './commands'

const FIRMWARE_10_PROFILES: Record<string, string> = {
  '152-3': 't1_1',
  '200-3': 't1_2',
  '152-4': 't1_3',
  '200-4': 't1_4',
  '240-3': 'c1_1',
  '240-4': 'c1_2',
  '416-3': 'c1_1',
  '416-4': 'c1_2',
}

const COLOR_CODE_MAPS: Record<number, { fixed?: Record<string, number>; byWidth?: Record<string, Record<string, number>> }> = {
  3: {
    byWidth: {
      '240': { '00': 2, '02': 1, '01': 0 },
    },
    fixed: { '00': 0, '02': 1, '01': 2 },
  },
  4: {
    fixed: { '00': 0, '01': 1, '02': 3, '03': 2 },
  },
}

const HD_COLOR_CODES: Record<string, number> = { '00': 0, '01': 1, '02': 3, '03': 2, '05': 6, '07': 5 }

export interface DeviceProfile {
  family: ProtocolFamily
  uid: Uint8Array
  width: number
  height: number
  colorCount: number
  firmware: number
  compression: boolean
  /** D1 原始尺寸与色数。 */
  rawWidth: number
  rawHeight: number
  rawColors: number
  scanVertical: boolean
  flipHorizontal: boolean
  flipVertical: boolean
  screenType: string | null
  isZhx: boolean
  colorCodes: Record<string, number> | null
  pinEnabled: boolean
  /** 供界面展示的型号描述。 */
  modelName: string
}

export class ScreenInfoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenInfoError'
  }
}

function parseTlvs(payload: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>()
  let offset = 0
  while (offset < payload.length) {
    if (offset + 2 > payload.length) {
      throw new ScreenInfoError('D1 TLV 头被截断')
    }
    const tag = payload[offset]
    const size = payload[offset + 1]
    offset += 2
    if (fields.has(tag) || offset + size > payload.length) {
      throw new ScreenInfoError('D1 TLV 重复或被截断')
    }
    fields.set(tag, payload.slice(offset, offset + size))
    offset += size
  }
  return fields
}

function requireField(fields: Map<number, Uint8Array>, tag: number, size: number): Uint8Array {
  const value = fields.get(tag)
  if (!value || value.length !== size) {
    throw new ScreenInfoError(`D1 字段 ${tag.toString(16).padStart(2, '0').toUpperCase()} 长度异常`)
  }
  return value
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

function colorMapping(colorCount: number, width: number): Record<string, number> {
  const mapping = COLOR_CODE_MAPS[colorCount]
  if (mapping) {
    if (mapping.byWidth && mapping.byWidth[String(width)]) {
      return { ...mapping.byWidth[String(width)] }
    }
    return { ...(mapping.fixed ?? {}) }
  }
  if (colorCount > 4) {
    return { ...HD_COLOR_CODES }
  }
  throw new ScreenInfoError(`不支持的面板色数：${colorCount}`)
}

/** 解析华为 552×768 四色屏档案。 */
export function parseHuaweiProfile(response: Uint8Array): DeviceProfile {
  if (!isSuccess(response)) {
    throw new ScreenInfoError('D1 读取失败')
  }
  const fields = parseTlvs(response.slice(0, response.length - 2))
  const profileA0 = requireField(fields, 0xa0, 7)
  const b1 = requireField(fields, 0xb1, 1)
  const b2 = requireField(fields, 0xb2, 1)
  const c0 = requireField(fields, 0xc0, 4)
  const c1 = requireField(fields, 0xc1, 4)

  const rawWidth = readUInt16BE(profileA0, 5)
  const rawHeight = readUInt16BE(profileA0, 3)
  const rawColors = b1[0]
  if (rawWidth !== 552 || rawHeight !== 1536 || rawColors !== 2) {
    throw new ScreenInfoError(`华为屏幕格式不匹配：${rawWidth}×${rawHeight}×${rawColors}`)
  }
  return {
    family: 'huawei',
    uid: c1,
    width: 552,
    height: 768,
    colorCount: 4,
    firmware: b2[0],
    compression: c0[3] !== 0,
    rawWidth,
    rawHeight,
    rawColors,
    scanVertical: false,
    flipHorizontal: false,
    flipVertical: false,
    screenType: 'huawei_552x768',
    isZhx: false,
    colorCodes: { '00': 0, '01': 1, '02': 2, '03': 3 },
    pinEnabled: true,
    modelName: '华为 552×768 四色墨水屏',
  }
}

/** 解析通用面板档案（3/4/6 色）。 */
export function parsePanelProfile(response: Uint8Array): DeviceProfile {
  if (!isSuccess(response)) {
    throw new ScreenInfoError('D1 读取失败')
  }
  const fields = parseTlvs(response.slice(0, response.length - 2))
  const profileA0 = requireField(fields, 0xa0, 7)
  const profileA1 = requireField(fields, 0xa1, 7)
  const b1 = fields.has(0xb1) ? requireField(fields, 0xb1, 1) : Uint8Array.of(profileA0[2] >> 4)
  const c0 = requireField(fields, 0xc0, 4)
  const c1 = requireField(fields, 0xc1, 4)
  const d1 = requireField(fields, 0xd1, 7)

  const flags = profileA0[1]
  let colors = profileA0[2] >> 4
  let height = readUInt16BE(profileA0, 3)
  let width = readUInt16BE(profileA0, 5)
  if (width === 0 || height === 0) {
    throw new ScreenInfoError('D1 屏幕尺寸不能为零')
  }
  if (colors === 2) {
    if (width >= height) {
      width = Math.floor(width / 2)
    } else {
      height = Math.floor(height / 2)
    }
    colors *= 2
  }
  if (colors < 3) {
    throw new ScreenInfoError(`不支持的面板色数：${colors}`)
  }

  const encoded = d1[1]
  const high = encoded >> 4
  const low = encoded & 0x0f
  if (high > 9 || low > 9) {
    throw new ScreenInfoError('D1 固件版本不是合法 BCD')
  }
  const firmware = high * 10 + low

  let scanVertical = profileA1[0] === 0
  let flipHorizontal = (flags & 0x80) !== 0
  const flipVertical = (flags & 0x40) !== 0
  let screenType: string | null = null
  let isZhx = false

  if (firmware === 20) {
    if (colors === 4 && width === 552) {
      screenType = 'c2_1'
      isZhx = true
    } else if (colors === 6 && width === 400) {
      screenType = 'x1_1'
      flipHorizontal = !flipHorizontal
    }
  } else if (firmware === 10) {
    scanVertical = false
    screenType = FIRMWARE_10_PROFILES[`${width}-${colors}`] ?? null
  }

  const productNames: Record<string, string> = { c1_2: 'Reink Case C1' }
  const modelName = productNames[screenType ?? ''] ?? screenType ?? '通用面板'

  return {
    family: 'panel',
    uid: c1,
    width,
    height,
    colorCount: colors,
    firmware,
    compression: c0[3] !== 0,
    rawWidth: readUInt16BE(profileA0, 5),
    rawHeight: readUInt16BE(profileA0, 3),
    rawColors: b1[0],
    scanVertical,
    flipHorizontal,
    flipVertical,
    screenType,
    isZhx,
    colorCodes: colorMapping(colors, width),
    pinEnabled: false,
    modelName: `${modelName} ${width}×${height} ${colors}色`,
  }
}

/** 按协议族解析 D1 响应。 */
export function parseProfile(family: ProtocolFamily, response: Uint8Array): DeviceProfile {
  return family === 'huawei' ? parseHuaweiProfile(response) : parsePanelProfile(response)
}

/** 依据唤醒帧推断协议族。 */
export function familyFromWakeFrame(wakeFrame: number): ProtocolFamily {
  return wakeFrame === 0x7a ? 'huawei' : 'panel'
}

/** 供界面展示的 UID 文本。 */
export function uidText(uid: Uint8Array): string {
  return toHex(uid)
}
