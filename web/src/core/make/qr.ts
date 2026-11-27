/**
 * 二维码编码器（字节模式）。
 *
 * 按 ISO/IEC 18004 实现：数据编码 → 分块 + 纠错 → 矩阵构造 → 掩模择优 → 格式/版本信息。
 * 覆盖版本 1..40 与 L/M/Q/H 四个纠错等级，用于火车票等需要可扫读的场合。
 *
 * 分块表与对齐图案坐标见 `qr_tables.ts`，取自 ISO/IEC 18004 表 9 与表 E.1。
 *
 * 实现细节（数据填充顺序、掩模罚分、格式信息落位）严格对齐参考实现，
 * `tools/qr_check.mjs` 会与 Python 侧 segno 逐模块对拍。
 */

import { ALIGNMENT_POS, EC_BLOCKS } from './qr_tables'

/** 纠错等级。 */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H'

/** 一块码字的信息：[块数, 每块总码字数, 每块数据码字数]。 */
type EcGroup = [number, number, number]

/** 纠错等级在格式信息里的 2 位编码。 */
const EC_FORMAT_BITS: Record<QrEcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 }

// ---------- GF(256) 伽罗华域 ----------

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

;(function initGaloisField(): void {
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value
    GF_LOG[value] = index
    value <<= 1
    if (value & 0x100) {
      value ^= 0x11d
    }
  }
  for (let index = 255; index < 512; index += 1) {
    GF_EXP[index] = GF_EXP[index - 255]
  }
})()

/** 伽罗华域乘法。 */
function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** 生成 RS 生成多项式，系数按高次在前。 */
function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let index = 0; index < degree; index += 1) {
    const next: number[] = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[index])
    }
    poly = next
  }
  return poly
}

/** 计算一段数据的纠错码字。 */
function rsEncode(data: number[], ecLength: number): number[] {
  const generator = rsGenerator(ecLength)
  const result: number[] = new Array(ecLength).fill(0)
  for (const byte of data) {
    const factor = byte ^ result[0]
    result.shift()
    result.push(0)
    if (factor !== 0) {
      for (let index = 0; index < ecLength; index += 1) {
        result[index] ^= gfMultiply(generator[index + 1], factor)
      }
    }
  }
  return result
}

// ---------- 位缓冲 ----------

/** 位缓冲区，按位追加。 */
class BitBuffer {
  private bits: number[] = []

  /** 追加若干位（高位在前）。 */
  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1)
    }
  }

  /** 当前位数。 */
  get length(): number {
    return this.bits.length
  }

  /** 取出字节数组，不足一个字节的高位补 0。 */
  toBytes(): number[] {
    const bytes: number[] = []
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | (this.bits[index + bit] ?? 0)
      }
      bytes.push(byte)
    }
    return bytes
  }
}

// ---------- 版本与容量 ----------

/** 取某版本的分组表。 */
function ecGroups(version: number, ecLevel: QrEcLevel): EcGroup[] {
  const table = EC_BLOCKS[String(version)]
  if (!table) {
    throw new Error(`不支持的二维码版本：${version}`)
  }
  const groups = table[ecLevel]
  if (!groups) {
    throw new Error(`版本 ${version} 不支持纠错等级 ${ecLevel}`)
  }
  return groups
}

/** 某版本某等级能装下的数据码字总数。 */
function dataCapacity(version: number, ecLevel: QrEcLevel): number {
  return ecGroups(version, ecLevel).reduce((sum, group) => sum + group[0] * group[2], 0)
}

/** 字节模式的长度指示器位数：版本 1..9 用 8 位，10..40 用 16 位。 */
function byteCountBits(version: number): number {
  return version < 10 ? 8 : 16
}

/** 选出能装下内容的最小版本。 */
function pickVersion(byteLength: number, ecLevel: QrEcLevel): number {
  for (let version = 1; version <= 40; version += 1) {
    const capacityBits = dataCapacity(version, ecLevel) * 8
    const needed = 4 + byteCountBits(version) + byteLength * 8
    if (needed <= capacityBits) {
      return version
    }
  }
  throw new Error('内容过长，超出二维码容量')
}

// ---------- 数据编码 ----------

/** 把内容编码成带纠错的码字序列。 */
function buildCodewords(content: Uint8Array, version: number, ecLevel: QrEcLevel): number[] {
  const groups = ecGroups(version, ecLevel)
  const capacity = groups.reduce((sum, group) => sum + group[0] * group[2], 0)

  const buffer = new BitBuffer()
  buffer.push(0b0100, 4) // 字节模式
  buffer.push(content.length, byteCountBits(version))
  for (const byte of content) {
    buffer.push(byte, 8)
  }

  // 结束符最多 4 位
  const capacityBits = capacity * 8
  const terminator = Math.min(4, capacityBits - buffer.length)
  if (terminator > 0) {
    buffer.push(0, terminator)
  }
  // 补齐到字节边界
  while (buffer.length % 8 !== 0) {
    buffer.push(0, 1)
  }

  const codewords = buffer.toBytes()
  // 交替填充码字
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (codewords.length < capacity) {
    codewords.push(padBytes[padIndex % 2])
    padIndex += 1
  }

  // 分块并算纠错
  const dataBlocks: number[][] = []
  const errorBlocks: number[][] = []
  let offset = 0
  for (const [blockCount, total, dataLength] of groups) {
    for (let block = 0; block < blockCount; block += 1) {
      const data = codewords.slice(offset, offset + dataLength)
      offset += dataLength
      dataBlocks.push(data)
      errorBlocks.push(rsEncode(data, total - dataLength))
    }
  }

  // 交织：数据码字逐个轮转，纠错码字同样轮转
  const interleaved: number[] = []
  const maxData = Math.max(...dataBlocks.map(block => block.length))
  for (let index = 0; index < maxData; index += 1) {
    for (const block of dataBlocks) {
      if (index < block.length) {
        interleaved.push(block[index])
      }
    }
  }
  const maxError = Math.max(...errorBlocks.map(block => block.length))
  for (let index = 0; index < maxError; index += 1) {
    for (const block of errorBlocks) {
      if (index < block.length) {
        interleaved.push(block[index])
      }
    }
  }
  return interleaved
}

// ---------- 矩阵构造 ----------

/** 矩阵：0 浅 1 深。 */
type QrMatrix = number[][]

/** 放一个 7×7 的定位图形（含分隔符）。 */
function placeFinder(matrix: QrMatrix, reserved: boolean[][], row: number, col: number, size: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r
      const x = col + c
      if (y < 0 || y >= size || x < 0 || x >= size) {
        continue
      }
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6
      const dark =
        inRing &&
        ((r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      matrix[y][x] = dark ? 1 : 0
      reserved[y][x] = true
    }
  }
}

/** 放一个 5×5 的对齐图案。 */
function placeAlignment(matrix: QrMatrix, reserved: boolean[][], centerRow: number, centerCol: number): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const y = centerRow + r
      const x = centerCol + c
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1
      matrix[y][x] = dark ? 1 : 0
      reserved[y][x] = true
    }
  }
}

/** 预留格式信息区域（先占位为浅色，最后再写入真正的值）。 */
function reserveFormatAreas(matrix: QrMatrix, reserved: boolean[][], size: number): void {
  // 左上角：第 8 列的前 9 格与第 8 行的前 9 格
  for (let index = 0; index < 9; index += 1) {
    matrix[index][8] = 0
    reserved[index][8] = true
    matrix[8][index] = 0
    reserved[8][index] = true
  }
  // 左下角与右上角：各 8 格
  for (let index = 1; index <= 8; index += 1) {
    matrix[size - index][8] = 0
    reserved[size - index][8] = true
    matrix[8][size - index] = 0
    reserved[8][size - index] = true
  }
}

/** 预留版本信息区域（版本 7 起才有）。 */
function reserveVersionAreas(matrix: QrMatrix, reserved: boolean[][], size: number): void {
  for (let index = 0; index < 6; index += 1) {
    matrix[index][size - 11] = 0
    reserved[index][size - 11] = true
    matrix[index][size - 10] = 0
    reserved[index][size - 10] = true
    matrix[index][size - 9] = 0
    reserved[index][size - 9] = true
    matrix[size - 11][index] = 0
    reserved[size - 11][index] = true
    matrix[size - 10][index] = 0
    reserved[size - 10][index] = true
    matrix[size - 9][index] = 0
    reserved[size - 9][index] = true
  }
}

/**
 * 把码字按之字形填进数据区域。
 *
 * 从右下角开始，两列一组交替向上、向下推进；第 6 列是定时图案，整列跳过。
 */
function placeCodewords(matrix: QrMatrix, reserved: boolean[][], codewords: number[], size: number): void {
  let index = 0
  const total = codewords.length * 8
  for (let raw = size - 1; raw > 0; raw -= 2) {
    // 第 6 列是定时图案，整列不参与数据填充
    const right = raw <= 6 ? raw - 1 : raw
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset
        let upwards = (right & 2) === 0
        if (col < 6) {
          upwards = !upwards
        }
        const row = upwards ? size - 1 - vertical : vertical
        if (reserved[row][col] || index >= total) {
          continue
        }
        matrix[row][col] = (codewords[index >>> 3] >>> (7 - (index & 7))) & 1
        index += 1
      }
    }
  }
}

// ---------- 掩模 ----------

/** 某个模块是否受当前掩模影响。 */
function maskApplies(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** 给数据模块套上掩模。 */
function applyMask(matrix: QrMatrix, reserved: boolean[][], mask: number, size: number): void {
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (reserved[row][col]) {
        continue
      }
      if (maskApplies(mask, row, col)) {
        matrix[row][col] = matrix[row][col] ? 0 : 1
      }
    }
  }
}

/** 序列里是否存在深色模块。 */
function hasDark(sequence: number[], from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (sequence[index]) {
      return true
    }
  }
  return false
}

/** 1:1:3:1:1 图案的出现次数（前后有 4 倍宽的浅色区才算）。 */
function patternOccurrences(sequence: number[], size: number): number {
  const pattern = [1, 0, 1, 1, 1, 0, 1]
  let count = 0
  let from = 0
  for (;;) {
    // 找到下一个 1:1:3:1:1 图案
    let found = -1
    for (let index = from; index + pattern.length <= size; index += 1) {
      let matched = true
      for (let offset = 0; offset < pattern.length; offset += 1) {
        if (sequence[index + offset] !== pattern[offset]) {
          matched = false
          break
        }
      }
      if (matched) {
        found = index
        break
      }
    }
    if (found === -1) {
      break
    }
    const after = found + pattern.length
    const atEdge = found === 0 || found === size - pattern.length
    const beforeLight = !hasDark(sequence, Math.max(found - 4, 0), Math.min(found, size))
    const afterLight = !hasDark(sequence, Math.max(after, 0), Math.min(after + 4, size))
    if (atEdge || beforeLight || afterLight) {
      count += 1
      from = after
    } else {
      from = found + 4
    }
  }
  return count
}

/**
 * 掩模罚分：N1 连续同色、N2 2×2 同色、N3 1:1:3:1:1、N4 黑白比例。
 */
function maskPenalty(matrix: QrMatrix, size: number): number {
  let n1 = 0
  let n2 = 0
  let n3 = 0
  let dark = 0

  for (let row = 0; row < size; row += 1) {
    let run = 1
    for (let col = 1; col < size; col += 1) {
      if (matrix[row][col] === matrix[row][col - 1]) {
        run += 1
      } else {
        if (run >= 5) {
          n1 += run - 2
        }
        run = 1
      }
    }
    if (run >= 5) {
      n1 += run - 2
    }
  }
  for (let col = 0; col < size; col += 1) {
    let run = 1
    for (let row = 1; row < size; row += 1) {
      if (matrix[row][col] === matrix[row - 1][col]) {
        run += 1
      } else {
        if (run >= 5) {
          n1 += run - 2
        }
        run = 1
      }
    }
    if (run >= 5) {
      n1 += run - 2
    }
  }

  // N2：2×2 同色方块
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = matrix[row][col]
      if (
        matrix[row][col + 1] === value &&
        matrix[row + 1][col] === value &&
        matrix[row + 1][col + 1] === value
      ) {
        n2 += 3
      }
    }
  }

  // N3：1:1:3:1:1 图案（行与列各算一遍）
  const rowSequence: number[] = new Array(size)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      rowSequence[col] = matrix[row][col]
      dark += matrix[row][col]
    }
    n3 += patternOccurrences(rowSequence, size) * 40
  }
  const columnSequence: number[] = new Array(size)
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size; row += 1) {
      columnSequence[row] = matrix[row][col]
    }
    n3 += patternOccurrences(columnSequence, size) * 40
  }

  // N4：深色模块占比偏离 50% 越远罚分越多
  const percent = dark / (size * size)
  const n4 = 10 * Math.trunc(Math.abs(percent * 100 - 50) / 5)

  return n1 + n2 + n3 + n4
}

// ---------- 格式信息与版本信息 ----------

/** 格式信息：5 位数据 + BCH(15,5)，再与 0x5412 异或。 */
export function formatInfoBits(ecLevel: QrEcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask
  let remainder = data << 10
  for (let index = 14; index >= 10; index -= 1) {
    if ((remainder >>> index) & 1) {
      remainder ^= 0b10100110111 << (index - 10)
    }
  }
  return ((data << 10) | remainder) ^ 0b101010000010010
}

/** 版本信息：6 位数据 + BCH(18,6)。生成多项式 0x1F25。 */
export function versionInfoBits(version: number): number {
  let remainder = version << 12
  for (let index = 17; index >= 12; index -= 1) {
    if ((remainder >>> index) & 1) {
      remainder ^= 0b1111100100101 << (index - 12)
    }
  }
  return (version << 12) | remainder
}

/** 把格式信息与固定的黑模块写进矩阵。 */
function writeFormatInfo(matrix: QrMatrix, ecLevel: QrEcLevel, mask: number, size: number): void {
  const bits = formatInfoBits(ecLevel, mask)
  for (let index = 0; index < 8; index += 1) {
    const verticalBit = (bits >>> index) & 1
    const horizontalBit = (bits >>> (14 - index)) & 1
    const verticalOffset = index >= 6 ? 1 : 0
    const horizontalOffset = index >= 6 ? 1 : 0
    matrix[index + verticalOffset][8] = verticalBit
    matrix[8][index + horizontalOffset] = horizontalBit
    matrix[8][size - 1 - index] = verticalBit
    matrix[size - 1 - index][8] = horizontalBit
  }
  // 固定的黑模块
  matrix[size - 8][8] = 1
}

/** 把版本信息写进矩阵（版本 7 起）。 */
function writeVersionInfo(matrix: QrMatrix, version: number, size: number): void {
  if (version < 7) {
    return
  }
  const bits = versionInfoBits(version)
  for (let index = 0; index < 6; index += 1) {
    const bit1 = (bits >>> (index * 3)) & 1
    const bit2 = (bits >>> (index * 3 + 1)) & 1
    const bit3 = (bits >>> (index * 3 + 2)) & 1
    matrix[size - 11][index] = bit1
    matrix[size - 10][index] = bit2
    matrix[size - 9][index] = bit3
    matrix[index][size - 11] = bit1
    matrix[index][size - 10] = bit2
    matrix[index][size - 9] = bit3
  }
}

// ---------- 对外接口 ----------

/** 二维码矩阵：每行一个 0/1 数组，1 为深色模块。 */
export interface QrCode {
  /** 边长（模块数）。 */
  size: number
  /** 矩阵内容。 */
  modules: QrMatrix
  /** 实际使用的版本。 */
  version: number
  /** 实际使用的掩模。 */
  mask: number
}

/**
 * 把文本编码成二维码矩阵。
 *
 * 内容按 UTF-8 字节处理。
 */
export function encodeQr(text: string, ecLevel: QrEcLevel = 'M', forcedVersion?: number): QrCode {
  const detail = encodeQrDetail(text, ecLevel, forcedVersion)
  return { size: detail.size, modules: detail.matrix, version: detail.version, mask: detail.mask }
}

/** 编码过程的中间结果，供离线校验比对掩模罚分。 */
export interface QrDetail {
  /** 边长（模块数）。 */
  size: number
  /** 最终矩阵。 */
  matrix: QrMatrix
  /** 实际使用的版本。 */
  version: number
  /** 实际使用的掩模。 */
  mask: number
  /** 掩模应用前的矩阵。 */
  beforeMask: QrMatrix
  /** 功能区标记。 */
  reserved: boolean[][]
  /** 八个掩模各自的罚分。 */
  penalties: number[]
}

/** 编码并保留中间结果。 */
export function encodeQrDetail(text: string, ecLevel: QrEcLevel = 'M', forcedVersion?: number): QrDetail {
  const content = utf8Bytes(text)
  const version = forcedVersion ?? pickVersion(content.length, ecLevel)
  const codewords = buildCodewords(content, version, ecLevel)
  const size = version * 4 + 17

  const matrix: QrMatrix = []
  const reserved: boolean[][] = []
  for (let row = 0; row < size; row += 1) {
    matrix.push(new Array<number>(size).fill(0))
    reserved.push(new Array<boolean>(size).fill(false))
  }

  // 先预留格式与版本信息区（此时都是浅色），它们不参与掩模与罚分
  reserveFormatAreas(matrix, reserved, size)
  if (version >= 7) {
    reserveVersionAreas(matrix, reserved, size)
  }

  placeFinder(matrix, reserved, 0, 0, size)
  placeFinder(matrix, reserved, size - 7, 0, size)
  placeFinder(matrix, reserved, 0, size - 7, size)

  // 定时图案：第 6 行与第 6 列交替深浅，会覆盖预留区里的 (8,6) 与 (6,8)
  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0
    matrix[6][index] = dark ? 1 : 0
    reserved[6][index] = true
    matrix[index][6] = dark ? 1 : 0
    reserved[index][6] = true
  }

  // 对齐图案：与三个定位图形重叠的组合不画
  const positions = ALIGNMENT_POS[version - 1] ?? []
  if (positions.length) {
    const min = positions[0]
    const max = positions[positions.length - 1]
    for (const row of positions) {
      for (const col of positions) {
        if ((row === min && col === min) || (row === min && col === max) || (row === max && col === min)) {
          continue
        }
        placeAlignment(matrix, reserved, row, col)
      }
    }
  }

  placeCodewords(matrix, reserved, codewords, size)
  const beforeMask = matrix.map(row => row.slice())

  // 八个掩模逐个试，取罚分最低的。
  // 评估时矩阵里还没有格式信息与版本信息，与标准一致。
  const penalties: number[] = []
  let bestMask = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map(row => row.slice())
    applyMask(candidate, reserved, mask, size)
    const penalty = maskPenalty(candidate, size)
    penalties.push(penalty)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestMask = mask
    }
  }
  applyMask(matrix, reserved, bestMask, size)
  writeFormatInfo(matrix, ecLevel, bestMask, size)
  writeVersionInfo(matrix, version, size)

  return { size, matrix, version, mask: bestMask, beforeMask, reserved, penalties }
}

/** 文本转 UTF-8 字节。 */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return new Uint8Array(bytes)
}
