/**
 * hex 数据处理工具。
 *
 * 供 NFC 页面「工具箱」使用：把用户输入的十六进制串解析成字节、
 * 把原始字节格式化（紧凑串 / 经典转储）、对比两段内容是否一致。
 *
 * 全部为纯函数，不依赖微信 API，也不依赖蓝牙模块，
 * 因此可以脱离小程序单独引入到校验脚本里运行。
 */

/** 十六进制字符串格式化选项。 */
export interface FormatHexOptions {
  /** 字节之间的分隔符，默认空格。 */
  separator?: string
  /** 是否输出大写，默认 true。 */
  uppercase?: boolean
  /** 每组多少个字节，0 表示不分组，默认 16。 */
  groupSize?: number
}

/** 十六进制转储选项。 */
export interface HexDumpOptions {
  /** 每行多少个字节，默认 16。 */
  bytesPerLine?: number
  /** 起始地址，默认 0。 */
  baseAddress?: number
}

/** 一处差异。 */
export interface HexDiffOffset {
  /** 在 left 中的偏移。 */
  offset: number
  /** left 在该偏移上的字节值。 */
  left: number
  /** right 在该偏移上的字节值。 */
  right: number
}

/** 两段内容的差异统计。 */
export interface HexDiffResult {
  /** 长度是否不同。 */
  lengthDiffers: boolean
  /** 共同长度内的差异偏移。 */
  offsets: HexDiffOffset[]
  /** 差异字节数（共同长度内）。 */
  diffCount: number
  /** 左侧独有的字节数。 */
  leftOnly: number
  /** 右侧独有的字节数。 */
  rightOnly: number
  /** 相同的字节数。 */
  sameCount: number
  /** 左右完全一致。 */
  identical: boolean
  /** 第一处差异的偏移，全同则为 -1。 */
  firstDiffOffset: number
}

/** 默认每行 16 个字节。 */
const DEFAULT_DUMP_BYTES_PER_LINE = 16
/** 默认每 16 个字节一组。 */
const DEFAULT_GROUP_SIZE = 16
/** 转储里每 8 个字节再分一段，便于肉眼定位。 */
const DUMP_GROUP_SIZE = 8
/** 并排对比视图里每行多少个字节。 */
const DEFAULT_DIFF_BYTES_PER_LINE = 8
/** 并排对比视图里十六进制单元格的宽度（标记位 + 两位 hex）。 */
const DIFF_CELL_WIDTH = 3

/** 判断一个字符是不是十六进制数字。 */
const isHexDigit = (char: string): boolean =>
  (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')

/** 判断一个字符是不是可以直接跳过的分隔符（空白、逗号、冒号）。 */
const isHexSeparator = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === ':'

/**
 * 把十六进制字符串解析成字节数组。
 *
 * 容忍空格、制表符、换行、逗号、冒号分隔以及 `0x` 前缀，大小写均可。
 * 半字节数为奇数时说明无法按字节切分，非法字符会直接指出是哪一个字符。
 *
 * @param text 待解析的十六进制文本
 * @returns 解析出的字节数组
 */
export function parseHex(text: string): Uint8Array {
  const nibbles: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (isHexSeparator(char)) {
      index += 1
      continue
    }
    // `0x` 前缀只有落在半字节边界上时才当作前缀，否则后面的 `x` 会被判成非法字符。
    if (char === '0' && (text[index + 1] === 'x' || text[index + 1] === 'X') && nibbles.length % 2 === 0) {
      index += 2
      continue
    }
    if (isHexDigit(char)) {
      nibbles.push(char)
      index += 1
      continue
    }
    throw new Error(`hex 字符串含有非法字符 "${char}"（位置 ${index}）`)
  }
  if (nibbles.length % 2 !== 0) {
    throw new Error('hex 字符数为奇数，无法按字节切分')
  }
  const bytes = new Uint8Array(nibbles.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(nibbles[i * 2] + nibbles[i * 2 + 1], 16)
  }
  return bytes
}

/**
 * 把字节数组格式化成十六进制字符串。
 *
 * 默认输出大写、空格分隔、每 16 个字节一组（组间两个空格）。
 *
 * @param data 待格式化的字节数组
 * @param options 分隔符、大小写与分组大小
 * @returns 十六进制字符串
 */
export function formatHex(data: Uint8Array, options: FormatHexOptions = {}): string {
  const separator = options.separator ?? ' '
  const uppercase = options.uppercase ?? true
  const groupSize = options.groupSize ?? DEFAULT_GROUP_SIZE
  const parts: string[] = []
  for (let i = 0; i < data.length; i += 1) {
    const text = hexByte(data[i])
    parts.push(uppercase ? text : text.toLowerCase())
  }
  if (groupSize <= 0) {
    return parts.join(separator)
  }
  const groups: string[] = []
  for (let i = 0; i < parts.length; i += groupSize) {
    groups.push(parts.slice(i, i + groupSize).join(separator))
  }
  // 组间用两个分隔符，默认就是两个空格。
  return groups.join(separator + separator)
}

/**
 * 把字节数组格式化成经典十六进制转储。
 *
 * 每行形如 `00000000  48 65 6C 6C 6F 20 57 6F  72 6C 64 00 00 00 00 00  |Hello World.....|`：
 * 8 位地址、两个空格、每 8 字节一组（组间两个空格）、两个空格、`|` 包裹的 ASCII。
 *
 * @param data 待转储的字节数组
 * @param options 每行字节数与起始地址
 * @returns 多行转储文本，换行符为 `\n`
 */
export function formatHexDump(data: Uint8Array, options: HexDumpOptions = {}): string {
  const bytesPerLine = options.bytesPerLine ?? DEFAULT_DUMP_BYTES_PER_LINE
  const baseAddress = options.baseAddress ?? 0
  if (!Number.isInteger(bytesPerLine) || bytesPerLine < 1) {
    throw new Error('每行字节数必须为正整数')
  }
  if (!Number.isInteger(baseAddress) || baseAddress < 0) {
    throw new Error('起始地址必须为非负整数')
  }
  const lines: string[] = []
  for (let start = 0; start < data.length; start += bytesPerLine) {
    const end = Math.min(start + bytesPerLine, data.length)
    const groups: string[] = []
    for (let group = start; group < end; group += DUMP_GROUP_SIZE) {
      const cells: string[] = []
      for (let i = group; i < Math.min(group + DUMP_GROUP_SIZE, end); i += 1) {
        cells.push(hexByte(data[i]))
      }
      groups.push(cells.join(' '))
    }
    let ascii = ''
    for (let i = start; i < end; i += 1) {
      ascii += isPrintableAscii(data[i]) ? String.fromCharCode(data[i]) : '.'
    }
    const address = (baseAddress + start).toString(16).padStart(8, '0').toUpperCase()
    lines.push(`${address}  ${groups.join('  ')}  |${ascii}|`)
  }
  return lines.join('\n')
}

/**
 * 对比两段字节内容。
 *
 * 只统计共同长度内的差异字节，长度差由 leftOnly / rightOnly 单独给出。
 *
 * @param left 左侧内容
 * @param right 右侧内容
 * @returns 差异统计结果
 */
export function diffHex(left: Uint8Array, right: Uint8Array): HexDiffResult {
  const common = Math.min(left.length, right.length)
  const offsets: HexDiffOffset[] = []
  let diffCount = 0
  for (let i = 0; i < common; i += 1) {
    if (left[i] !== right[i]) {
      offsets.push({ offset: i, left: left[i], right: right[i] })
      diffCount += 1
    }
  }
  const leftOnly = Math.max(0, left.length - right.length)
  const rightOnly = Math.max(0, right.length - left.length)
  const lengthDiffers = left.length !== right.length
  return {
    lengthDiffers,
    offsets,
    diffCount,
    leftOnly,
    rightOnly,
    sameCount: common - diffCount,
    identical: !lengthDiffers && diffCount === 0,
    firstDiffOffset: offsets.length > 0 ? offsets[0].offset : -1,
  }
}

/**
 * 把差异统计整理成一行中文摘要。
 *
 * 形如 `共 64 字节，差异 3 处（首个差异在偏移 0x10），左侧多 2 字节，右侧多 0 字节`，
 * 其中「共 N 字节」指实际参与比对的共同长度。
 *
 * @param result 差异统计结果
 * @param leftLength 左侧字节数
 * @param rightLength 右侧字节数
 * @returns 一行摘要文本
 */
export function formatDiffSummary(result: HexDiffResult, leftLength: number, rightLength: number): string {
  const common = Math.min(leftLength, rightLength)
  const parts: string[] = [`共 ${common} 字节`]
  if (result.firstDiffOffset >= 0) {
    parts.push(
      `差异 ${result.diffCount} 处（首个差异在偏移 0x${result.firstDiffOffset.toString(16).padStart(2, '0').toUpperCase()}）`
    )
  } else {
    parts.push(`差异 ${result.diffCount} 处（两侧完全一致）`)
  }
  parts.push(`左侧多 ${result.leftOnly} 字节`)
  parts.push(`右侧多 ${result.rightOnly} 字节`)
  return parts.join('，')
}

/**
 * 生成两段内容的并排对比视图。
 *
 * 每行形如
 * `00000000   48 65 6C 6C 6F 20 57 6F  |Hello Wo|   48 65 6C 6C 6F 20 57 6F  |Hello Wo|`：
 * 左侧先打印地址，右侧不重复地址；差异字节在十六进制单元格前用 `>` 标记
 * （单元格固定宽度，左右因此始终对齐），长度短的一侧用空白补齐。
 *
 * @param left 左侧内容
 * @param right 右侧内容
 * @param result 差异统计结果，用于标记差异字节
 * @param bytesPerLine 每行多少个字节，默认 8
 * @returns 多行对比文本，换行符为 `\n`
 */
export function formatDiffLines(
  left: Uint8Array,
  right: Uint8Array,
  result: HexDiffResult,
  bytesPerLine: number = DEFAULT_DIFF_BYTES_PER_LINE
): string {
  if (!Number.isInteger(bytesPerLine) || bytesPerLine < 1) {
    throw new Error('每行字节数必须为正整数')
  }
  // 差异位置以传入的统计结果为准：共同长度内的差异加上尾部多出来的字节。
  const diffOffsets = new Set<number>()
  for (const item of result.offsets) {
    diffOffsets.add(item.offset)
  }
  const common = Math.min(left.length, right.length)
  for (let i = common; i < Math.max(left.length, right.length); i += 1) {
    diffOffsets.add(i)
  }
  const lines: string[] = []
  const total = Math.max(left.length, right.length)
  for (let start = 0; start < total; start += bytesPerLine) {
    const end = Math.min(start + bytesPerLine, total)
    const leftSide = renderDiffSide(left, start, end, diffOffsets)
    const rightSide = renderDiffSide(right, start, end, diffOffsets)
    const address = start.toString(16).padStart(8, '0').toUpperCase()
    lines.push(`${address}  ${leftSide.hex}  |${leftSide.ascii}|  ${rightSide.hex}  |${rightSide.ascii}|`)
  }
  return lines.join('\n')
}

/**
 * 渲染并排对比视图的一侧。
 *
 * @param data 本侧内容
 * @param start 本行起始偏移
 * @param end 本行结束偏移（不含）
 * @param diffOffsets 需要标记的偏移集合
 * @returns 本侧的十六进制串与 ASCII 串
 */
function renderDiffSide(
  data: Uint8Array,
  start: number,
  end: number,
  diffOffsets: Set<number>
): { hex: string; ascii: string } {
  const cells: string[] = []
  let ascii = ''
  for (let i = start; i < end; i += 1) {
    if (i >= data.length) {
      // 本侧没有这个字节，用空白补齐，保证左右两列宽度一致。
      cells.push(' '.repeat(DIFF_CELL_WIDTH))
      ascii += ' '
      continue
    }
    cells.push(`${diffOffsets.has(i) ? '>' : ' '}${hexByte(data[i])}`)
    ascii += isPrintableAscii(data[i]) ? String.fromCharCode(data[i]) : '.'
  }
  return { hex: cells.join(''), ascii }
}

/**
 * 把单个字节转成两位大写十六进制。
 *
 * @param value 0..255 的字节值
 * @returns 两位大写十六进制字符串
 */
export function hexByte(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error('十六进制字节值必须为 0..255 的整数')
  }
  return value.toString(16).padStart(2, '0').toUpperCase()
}

/**
 * 判断一个字节是否是可以直接显示的 ASCII 字符。
 *
 * @param byte 字节值
 * @returns 是否为可打印 ASCII
 */
export function isPrintableAscii(byte: number): boolean {
  return Number.isInteger(byte) && byte >= 0x20 && byte <= 0x7e
}

/**
 * 按字节异或两段内容，长度不等时按较短的算。
 *
 * 用来快速判断两段数据是不是只是密钥偏移不同。
 *
 * @param left 左侧内容
 * @param right 右侧内容
 * @returns 异或结果，长度为两者较短者
 */
export function xorHex(left: Uint8Array, right: Uint8Array): Uint8Array {
  const length = Math.min(left.length, right.length)
  const result = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    result[i] = left[i] ^ right[i]
  }
  return result
}
