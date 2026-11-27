/**
 * 墨水屏协议命令集合。
 *
 * 取值与 tmp/demo/python/epaper_ble_suite/commands.py、panel_commands.py 一致。
 */

import { fromHex } from '../hex'

/** D1 读取设备信息。 */
export const READ_INFO = fromHex('00D1000000')
/** PIN 校验指令头。 */
export const VERIFY_PIN_HEADER = fromHex('0020000105')
/** 应用默认 PIN。 */
export const DEFAULT_PIN = fromHex('5265699919')
/** 通用面板读取扩展信息。 */
export const PANEL_READ_CUSTOM_INFO = fromHex('F0D8000005000000000E')
/** 华为四色屏刷新指令。 */
export const HUAWEI_REFRESH = fromHex('F0D4948000')
/** 华为四色屏刷新状态查询。 */
export const HUAWEI_READ_STATUS = fromHex('F0DE000001')
/** 通用面板刷新指令。 */
export const PANEL_REFRESH = fromHex('F0D4850000')
/** 通用面板清除驱动。 */
export const PANEL_CLEAR_DRIVER = fromHex('F0DB020000')

/** 图像分块大小。 */
export const APP_BLOCK_SIZE = 2000
/** 单个应用层子包的最大数据长度。 */
export const APP_COMPRESSED_CHUNK = 250
/** 单个射频帧可承载的 ISO-DEP INF 上限。 */
export const MAX_PACKET_DATA = 250

/** D2 包头长度（命令、平面号、包号、长度）。 */
export const D2_HEADER_BYTES = 5
/** D3 包头长度（命令、平面/末包标记、长度、块号、子包号）。C1 固件也用这一种。 */
export const D3_HEADER_BYTES = 7

/** ISO-DEP 单帧最多能装的 INF 字节数（256 - 3）。 */
export const ISO_DEP_MAX_INF = 253

/** C1 固件 1.0 单块压缩数据的上限（整块压缩结果必须 <=246 字节）。 */
export const C1_MAX_COMPRESSED_BYTES = 246
/** C1 的 D3 包长上限（包头 + 压缩数据）。 */
export const C1_MAX_PACKET_BYTES = C1_MAX_COMPRESSED_BYTES + D3_HEADER_BYTES

/**
 * 应用层子包大小是**固定值**，不能按 ISO-DEP 的帧长调整。
 *
 * 标签按参考协议固定的 250 字节边界重组 D3 压缩流：把子包改小，
 * 标签拼出来的就不是一个合法的 LZO 流，解压直接失败（SW=6992）。
 * 一个 257 字节的 D3 包由 ISO-DEP 按 FSC 拆成多个 I-block 发送，
 * 那是协议本来的分层方式，参考实现也是这么做的。
 */
export const APP_CHUNK_SIZE = 250

/**
 * 拼一个「包头 + 载荷」的应用层包。
 *
 * 包头长度是协议的一部分，多一个少一个字节设备就会拒收整个包，
 * 所以按常量分配并核对内容长度：以后改包头数组时立刻报错，
 * 而不是悄悄多出一个字节让屏幕不刷新。
 */
export function buildAppPacket(header: number[], payload: Uint8Array, headerBytes: number): Uint8Array {
  if (header.length !== headerBytes) {
    throw new Error(`包头长度应为 ${headerBytes} 字节，实际 ${header.length} 字节`)
  }
  const packet = new Uint8Array(headerBytes + payload.length)
  packet.set(header, 0)
  packet.set(payload, headerBytes)
  return packet
}

export type ProtocolFamily = 'huawei' | 'panel'

/** 状态字是否表示成功。 */
export function isSuccess(response: Uint8Array): boolean {
  return response.length >= 2 && response[response.length - 2] === 0x90 && response[response.length - 1] === 0x00
}

/** 取出状态字并翻译常见错误。 */
export function requireSuccess(response: Uint8Array, context: string): Uint8Array {
  if (!isSuccess(response)) {
    const sw =
      response.length >= 2
        ? `${response[response.length - 2].toString(16).padStart(2, '0').toUpperCase()}${response[
            response.length - 1
          ]
            .toString(16)
            .padStart(2, '0')
            .toUpperCase()}`
        : '缺失'
    const reason: Record<string, string> = {
      '6992': 'LZO 解压失败',
      '6993': '解压长度错误',
      '68CA': '低电压',
      '68CB': '刷新超时',
    }
    throw new Error(`${context}失败 SW=${sw}${reason[sw] ? ' ' + reason[sw] : ''}`.trim())
  }
  return response.slice(0, response.length - 2)
}
