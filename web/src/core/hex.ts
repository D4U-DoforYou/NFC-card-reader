/**
 * 十六进制与字节数组的互转工具。
 *
 * 之前这些函数放在 core/ble/protocol.ts 里，跟着旧蓝牙帧协议一起。
 * 换成新协议后帧格式不再属于「蓝牙」这一层，工具函数独立出来，
 * 协议层与界面层都能直接用。
 */

/** 把字节数组格式化为十六进制字符串。 */
export function toHex(bytes: Uint8Array, separator = ' '): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 1) {
    parts.push(bytes[i].toString(16).padStart(2, '0').toUpperCase())
  }
  return parts.join(separator)
}

/** 解析十六进制字符串，忽略空白与分隔符。 */
export function fromHex(text: string): Uint8Array {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length % 2 !== 0) {
    throw new Error('十六进制长度必须为偶数')
  }
  const bytes = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16)
  }
  return bytes
}

/** 合并多个字节数组。 */
export function concatBytes(...items: Uint8Array[]): Uint8Array {
  let total = 0
  for (const item of items) {
    total += item.length
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const item of items) {
    result.set(item, offset)
    offset += item.length
  }
  return result
}
