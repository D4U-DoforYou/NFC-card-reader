/**
 * A01 方案的帧格式：长度头 + CRC32 + COBS。
 *
 * 与 tmp/rf_device_platform 的 host/src/rf_platform/transport/framing.py
 * 和 firmware/components/platform_core/src/cobs_frame_codec.cpp 逐字节对齐：
 *
 * ```text
 * 原始帧  = len(4B, 小端) | payload(lenB) | crc32(payload)(4B, 小端)
 * 线上帧  = COBS(原始帧) | 0x00
 * ```
 *
 * 帧与帧之间用 0x00 分隔，所以设备收到字节流即可自行切帧，
 * 主机把一帧拆成多次 BLE 写入也不会错位。
 */

/** 单帧最大负载，与固件的 ProtocolCodec::kMaxEncodedSize 对齐。 */
export const MAX_CONTROL_FRAME = 10_541

/** 原始帧的头部与校验长度。 */
const HEADER_SIZE = 4
const CRC_SIZE = 4

/** CRC32 查表（多项式 0xEDB88320，反射式，与 zlib.crc32 一致）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 标准 CRC32（IEEE 802.3），与 Python 的 zlib.crc32 结果一致。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 帧错误。 */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** COBS 编码。 */
export function cobsEncode(raw: Uint8Array): Uint8Array {
  const encoded = new Uint8Array(raw.length + Math.ceil(raw.length / 254) + 2)
  let codeIndex = 0
  let writeIndex = 1
  let code = 1
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index]
    if (byte === 0) {
      encoded[codeIndex] = code
      code = 1
      codeIndex = writeIndex++
    } else {
      encoded[writeIndex++] = byte
      code += 1
      if (code === 0xff) {
        encoded[codeIndex] = code
        code = 1
        codeIndex = writeIndex++
      }
    }
  }
  encoded[codeIndex] = code
  return encoded.subarray(0, writeIndex)
}

/** COBS 解码。 */
export function cobsDecode(encoded: Uint8Array): Uint8Array {
  const decoded = new Uint8Array(encoded.length)
  let writeIndex = 0
  let readIndex = 0
  while (readIndex < encoded.length) {
    const code = encoded[readIndex]
    readIndex += 1
    if (code === 0) {
      throw new FrameError('COBS 帧里出现 0x00')
    }
    const count = code - 1
    if (readIndex + count > encoded.length) {
      throw new FrameError('COBS 块被截断')
    }
    decoded.set(encoded.subarray(readIndex, readIndex + count), writeIndex)
    writeIndex += count
    readIndex += count
    if (code !== 0xff && readIndex < encoded.length) {
      decoded[writeIndex++] = 0
    }
  }
  return decoded.subarray(0, writeIndex)
}

/** 编码一帧：长度头 + 负载 + CRC32，再 COBS，最后补 0x00 分隔符。 */
export function encodeFrame(payload: Uint8Array, maxSize = MAX_CONTROL_FRAME): Uint8Array {
  if (!payload.length || payload.length > maxSize) {
    throw new FrameError('负载长度非法')
  }
  const raw = new Uint8Array(HEADER_SIZE + payload.length + CRC_SIZE)
  const view = new DataView(raw.buffer)
  view.setUint32(0, payload.length, true)
  raw.set(payload, HEADER_SIZE)
  view.setUint32(HEADER_SIZE + payload.length, crc32(payload), true)
  const encoded = cobsEncode(raw)
  const frame = new Uint8Array(encoded.length + 1)
  frame.set(encoded, 0)
  frame[encoded.length] = 0
  return frame
}

/** 解码一帧（不含结尾的 0x00 分隔符）。 */
export function decodeFrame(encoded: Uint8Array, maxSize = MAX_CONTROL_FRAME): Uint8Array {
  if (!encoded.length) {
    throw new FrameError('空帧')
  }
  const raw = cobsDecode(encoded)
  if (raw.length < HEADER_SIZE + CRC_SIZE) {
    throw new FrameError('帧太短')
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const payloadSize = view.getUint32(0, true)
  if (payloadSize === 0 || payloadSize > maxSize) {
    throw new FrameError('负载长度越界')
  }
  if (raw.length !== HEADER_SIZE + payloadSize + CRC_SIZE) {
    throw new FrameError('帧长度与头部不符')
  }
  const payload = raw.subarray(HEADER_SIZE, HEADER_SIZE + payloadSize)
  const expected = view.getUint32(HEADER_SIZE + payloadSize, true)
  if (crc32(payload) !== expected) {
    throw new FrameError('帧校验和不匹配')
  }
  return payload
}

/**
 * 字节流解码器：把任意切分的 BLE 通知拼成完整帧。
 *
 * 设备按 MTU 分片发通知，一帧会被拆成好几条，所以必须自己拼。
 */
export class FrameStreamDecoder {
  private readonly maxSize: number
  private readonly maxEncodedSize: number
  private buffer: Uint8Array
  private length = 0
  private discarding = false

  constructor(maxSize = MAX_CONTROL_FRAME) {
    this.maxSize = maxSize
    this.maxEncodedSize = maxSize + Math.ceil(maxSize / 254) + 16
    this.buffer = new Uint8Array(Math.min(256, this.maxEncodedSize))
  }

  /** 喂入一段字节，返回本次拼出的完整帧。 */
  feed(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = []
    let offset = 0
    while (offset < data.length) {
      const delimiter = data.indexOf(0, offset)
      const end = delimiter < 0 ? data.length : delimiter
      const segmentLength = end - offset

      if (segmentLength > 0 && !this.discarding) {
        if (this.length + segmentLength > this.maxEncodedSize) {
          this.length = 0
          this.discarding = true
        } else {
          this.ensureCapacity(this.length + segmentLength)
          this.buffer.set(data.subarray(offset, end), this.length)
          this.length += segmentLength
        }
      }

      if (delimiter < 0) break
      if (this.length && !this.discarding) {
        try {
          frames.push(decodeFrame(this.buffer.subarray(0, this.length), this.maxSize))
        } catch {
          // 校验不过的帧直接丢弃，字节流继续往下走。
        }
      }
      this.length = 0
      this.discarding = false
      offset = delimiter + 1
    }
    return frames
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(this.maxEncodedSize, capacity * 2)
    const next = new Uint8Array(capacity)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }

  /** 丢弃已缓存的半帧（重连时用）。 */
  reset(): void {
    this.length = 0
    this.discarding = false
  }
}
