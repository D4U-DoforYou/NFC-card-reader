/**
 * LZO1X 压缩/解压（TypeScript 移植）。
 *
 * 移植自 LZ👌（MIT License, Copyright (c) 2018 Jack Andersen / AxioDL），
 * 上游地址 https://github.com/AxioDL/lzokay 。原始实现基于 Linux 内核
 * Documentation/lzo.txt 描述的 LZO1X 位流格式，与 lzo1x_1 / lzo1x_999 产生的
 * 数据兼容；tmp/demo 中 Python 端使用的 `lzokay` 绑定同样源自该实现。
 *
 * 华为墨水屏 D3 应用与通用面板 HD D3 都需要把点阵按 2000 字节分块压缩后上传，
 * 设备侧使用标准 LZO 解压器，因此这里必须产出合法的 LZO1X 位流。
 */

const HASH_SIZE = 0x4000
const MAX_DIST = 0xbfff
const MAX_MATCH_LEN = 0x800
const BUF_SIZE = MAX_DIST + MAX_MATCH_LEN
const UINT16_MAX = 0xffff

const M1_MAX_OFFSET = 0x0400
const M2_MAX_OFFSET = 0x0800
const M3_MAX_OFFSET = 0x4000

const M2_MIN_LEN = 3
const M2_MAX_LEN = 8
const M3_MAX_LEN = 33
const M4_MAX_LEN = 9

const M1_MARKER = 0x00
const M3_MARKER = 0x20
const M4_MARKER = 0x10

/** 最长匹配长度 + 1，用于按长度缓存最佳偏移。 */
const MAX_MATCH_BY_LENGTH_LEN = 34

const MAX_255_COUNT = 0xffffffff / 255 - 2

/** 与上游 compress_worst_size 一致的最坏输出大小。 */
export function lzoWorstSize(size: number): number {
  return size + Math.floor(size / 16) + 64 + 3
}

class Dict {
  /** 3 字节哈希链：key -> 链头槽位。 */
  readonly head = new Uint16Array(HASH_SIZE)
  /** 3 字节哈希链：key -> 链长度。 */
  readonly chainSize = new Uint16Array(HASH_SIZE)
  /** 3 字节哈希链：槽位 -> 下一链节点。 */
  readonly chain = new Uint16Array(BUF_SIZE)
  /** 3 字节哈希链：槽位 -> 该位置能达到的最佳匹配长度。 */
  readonly bestLen = new Uint16Array(BUF_SIZE)
  /** 2 字节匹配：2 字节数据 -> 槽位。 */
  readonly head2 = new Uint16Array(1 << 16)
  /** 环形窗口，尾部额外复制前 MAX_MATCH_LEN 字节以便跨界回看。 */
  readonly buffer = new Uint8Array(BUF_SIZE + MAX_MATCH_LEN)
}

export class LzoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LzoError'
  }
}

/**
 * LZO1X 压缩器。内部字典可以跨多次 compress 调用复用，避免每块重新分配内存。
 */
export class LzoCompressor {
  private readonly dict = new Dict()

  private src: Uint8Array = new Uint8Array(0)
  private srcEnd = 0
  private inp = 0
  private windSize = 0
  private windBegin = 0
  private windEnd = 0
  private cycle1Countdown = 0
  private bufSize = 0
  private bufPointer = 0
  /** 当前最佳回看匹配：偏移与长度。 */
  private lbOffset = 0
  private lbLength = 0
  /** 按匹配长度缓存的最佳偏移，用于挑选编码更短的等价匹配。 */
  private readonly bestOffset = new Uint32Array(MAX_MATCH_BY_LENGTH_LEN)

  compress(source: Uint8Array): Uint8Array {
    const out = new Uint8Array(lzoWorstSize(source.length))
    let outLength = 0
    let literalLength = 0
    let literalPointer = 0

    this.initState(source)
    literalPointer = this.inp
    this.advance(false)

    while (this.bufSize > 0) {
      if (literalLength === 0) {
        literalPointer = this.bufPointer
      }
      if (
        this.lbLength < 2 ||
        (this.lbLength === 2 &&
          (this.lbOffset > M1_MAX_OFFSET || literalLength === 0 || literalLength >= 4)) ||
        (this.lbLength === 2 && outLength === 0) ||
        (outLength === 0 && literalLength === 0)
      ) {
        this.lbLength = 0
      } else if (
        this.lbLength === M2_MIN_LEN &&
        this.lbOffset > M1_MAX_OFFSET + M2_MAX_OFFSET &&
        literalLength >= 4
      ) {
        this.lbLength = 0
      }
      if (this.lbLength === 0) {
        literalLength += 1
        this.advance(false)
        continue
      }
      this.findBetterMatch()
      outLength = this.encodeLiteralRun(out, outLength, literalPointer, literalLength)
      outLength = this.encodeLookbackMatch(out, outLength, literalLength)
      literalLength = 0
      this.advance(true)
    }

    outLength = this.encodeLiteralRun(out, outLength, literalPointer, literalLength)

    // 结束标记：M4 | 1，随后两个 0 字节表示流结束。
    out[outLength++] = M4_MARKER | 1
    out[outLength++] = 0
    out[outLength++] = 0

    return out.slice(0, outLength)
  }

  private initState(source: Uint8Array): void {
    this.dict.chainSize.fill(0)
    this.dict.head2.fill(UINT16_MAX)

    this.src = source
    this.srcEnd = source.length
    this.inp = 0
    this.cycle1Countdown = MAX_DIST
    this.windSize = Math.min(source.length, MAX_MATCH_LEN)
    this.windBegin = 0
    this.windEnd = this.windSize
    this.dict.buffer.set(source.subarray(0, this.windSize), 0)
    this.inp = this.windSize
    if (this.windEnd === BUF_SIZE) {
      this.windEnd = 0
    }
    if (this.windSize < 3) {
      this.dict.buffer.fill(0, this.windBegin + this.windSize, this.windBegin + this.windSize + 3)
    }
  }

  /** 读取下一个输入字节写入环形窗口，同时推进读写指针。 */
  private getByte(): void {
    const buffer = this.dict.buffer
    if (this.inp >= this.srcEnd) {
      if (this.windSize > 0) {
        this.windSize -= 1
      }
      buffer[this.windEnd] = 0
      if (this.windEnd < MAX_MATCH_LEN) {
        buffer[BUF_SIZE + this.windEnd] = 0
      }
    } else {
      buffer[this.windEnd] = this.src[this.inp]
      if (this.windEnd < MAX_MATCH_LEN) {
        buffer[BUF_SIZE + this.windEnd] = this.src[this.inp]
      }
      this.inp += 1
    }
    this.windEnd += 1
    if (this.windEnd === BUF_SIZE) {
      this.windEnd = 0
    }
    this.windBegin += 1
    if (this.windBegin === BUF_SIZE) {
      this.windBegin = 0
    }
  }

  /** 计算槽位相对当前读头的回看距离。 */
  private posToOffset(pos: number): number {
    return this.windBegin > pos ? this.windBegin - pos : BUF_SIZE - (pos - this.windBegin)
  }

  private makeKey3(offset: number): number {
    const data = this.dict.buffer
    const a = data[offset]
    const b = data[offset + 1]
    const c = data[offset + 2]
    // 与上游一致：XOR 在乘法内部，运算按 32 位无符号取模。
    const mixed = ((((a << 5) ^ b) << 5) ^ c) >>> 0
    return ((Math.imul(0x9f5f, mixed) >>> 0) >>> 5) & 0x3fff
  }

  private makeKey2(offset: number): number {
    const data = this.dict.buffer
    return (data[offset] ^ (data[offset + 1] << 8)) >>> 0
  }

  /** 从哈希链移除即将被覆盖的槽位。 */
  private resetNextInputEntry(): void {
    if (this.cycle1Countdown === 0) {
      const key3 = this.makeKey3(this.windEnd)
      if (this.dict.chainSize[key3] > 0) {
        this.dict.chainSize[key3] -= 1
      }
      const key2 = this.makeKey2(this.windEnd)
      if (this.dict.head2[key2] === this.windEnd) {
        this.dict.head2[key2] = UINT16_MAX
      }
    } else {
      this.cycle1Countdown -= 1
    }
  }

  /**
   * 推进输入一个位置：把当前位置写入哈希链，搜索最佳匹配，并更新窗口。
   */
  private advance(skip: boolean): void {
    const dict = this.dict
    const buffer = dict.buffer

    if (skip) {
      for (let i = 0; i < this.lbLength - 1; i += 1) {
        this.resetNextInputEntry()
        const key3 = this.makeKey3(this.windBegin)
        dict.chain[this.windBegin] = dict.chainSize[key3] === 0 ? UINT16_MAX : dict.head[key3]
        dict.head[key3] = this.windBegin
        dict.bestLen[this.windBegin] = MAX_MATCH_LEN + 1
        dict.chainSize[key3] += 1
        dict.head2[this.makeKey2(this.windBegin)] = this.windBegin
        this.getByte()
      }
    }

    let lbLength = 1
    let lbOffset = 0
    let lbPos = 0
    const bestPos = new Uint32Array(MAX_MATCH_BY_LENGTH_LEN)

    const key3 = this.makeKey3(this.windBegin)
    let matchPos = dict.chainSize[key3] === 0 ? UINT16_MAX : dict.head[key3]
    dict.chain[this.windBegin] = matchPos
    let matchCount = dict.chainSize[key3]
    dict.chainSize[key3] += 1
    if (matchCount > MAX_MATCH_LEN) {
      matchCount = MAX_MATCH_LEN
    }
    dict.head[key3] = this.windBegin

    let bestChar = buffer[this.windBegin]
    let bestLength = lbLength
    if (lbLength >= this.windSize) {
      if (this.windSize === 0) {
        bestChar = -1
      }
      lbOffset = 0
      dict.bestLen[this.windBegin] = MAX_MATCH_LEN + 1
    } else {
      // 2 字节匹配：仅用于兜底（保证至少 2 字节重复也能被编码）。
      const key2 = this.makeKey2(this.windBegin)
      const head2Pos = dict.head2[key2]
      if (head2Pos !== UINT16_MAX) {
        if (bestPos[2] === 0) {
          bestPos[2] = head2Pos + 1
        }
        if (lbLength < 2) {
          lbLength = 2
          lbPos = head2Pos
        }
      }
      if (lbLength >= 2 && this.windSize >= 3) {
        let pos = matchPos
        for (let i = 0; i < matchCount; i += 1) {
          let length = 0
          const limit = this.windSize
          while (length < limit && buffer[this.windBegin + length] === buffer[pos + length]) {
            length += 1
          }
          if (length < 2) {
            pos = dict.chain[pos]
            continue
          }
          if (length < MAX_MATCH_BY_LENGTH_LEN && bestPos[length] === 0) {
            bestPos[length] = pos + 1
          }
          if (length > lbLength) {
            lbLength = length
            lbPos = pos
            if (length === this.windSize || length > dict.bestLen[pos]) {
              pos = dict.chain[pos]
              break
            }
          }
          pos = dict.chain[pos]
        }
      }
      if (lbLength > bestLength) {
        lbOffset = this.posToOffset(lbPos)
      }
      dict.bestLen[this.windBegin] = lbLength
      for (let index = 2; index < MAX_MATCH_BY_LENGTH_LEN; index += 1) {
        this.bestOffset[index] = bestPos[index] > 0 ? this.posToOffset(bestPos[index] - 1) : 0
      }
    }

    this.resetNextInputEntry()
    dict.head2[this.makeKey2(this.windBegin)] = this.windBegin
    this.getByte()

    if (bestChar < 0) {
      this.bufSize = 0
      lbLength = 0
    } else {
      this.bufSize = this.windSize + 1
    }
    this.bufPointer = this.inp - this.bufSize

    this.lbOffset = lbOffset
    this.lbLength = lbLength
  }

  /** 在等价匹配中挑选编码更短的一个。 */
  private findBetterMatch(): void {
    const bestOffset = this.bestOffset
    let lbLength = this.lbLength
    let lbOffset = this.lbOffset
    if (lbLength <= M2_MIN_LEN || lbOffset <= M2_MAX_OFFSET) {
      return
    }
    if (
      lbOffset > M2_MAX_OFFSET &&
      lbLength >= M2_MIN_LEN + 1 &&
      lbLength <= M2_MAX_LEN + 1 &&
      bestOffset[lbLength - 1] !== 0 &&
      bestOffset[lbLength - 1] <= M2_MAX_OFFSET
    ) {
      lbLength -= 1
      lbOffset = bestOffset[lbLength]
    } else if (
      lbOffset > M3_MAX_OFFSET &&
      lbLength >= M4_MAX_LEN + 1 &&
      lbLength <= M2_MAX_LEN + 2 &&
      bestOffset[lbLength - 2] !== 0 &&
      bestOffset[lbLength] <= M2_MAX_OFFSET
    ) {
      lbLength -= 2
      lbOffset = bestOffset[lbLength]
    } else if (
      lbOffset > M3_MAX_OFFSET &&
      lbLength >= M4_MAX_LEN + 1 &&
      lbLength <= M3_MAX_LEN + 1 &&
      bestOffset[lbLength - 1] !== 0 &&
      bestOffset[lbLength - 2] <= M3_MAX_OFFSET
    ) {
      lbLength -= 1
      lbOffset = bestOffset[lbLength]
    }
    this.lbLength = lbLength
    this.lbOffset = lbOffset
  }

  /** 写出一段字面量。 */
  private encodeLiteralRun(out: Uint8Array, outLength: number, literalPointer: number, literalLength: number): number {
    let length = outLength
    if (length === 0 && literalLength <= 238) {
      out[length++] = 17 + literalLength
    } else if (literalLength <= 3) {
      out[length - 2] |= literalLength
    } else if (literalLength <= 18) {
      out[length++] = literalLength - 3
    } else {
      out[length++] = 0
      let rest = literalLength - 18
      while (rest > 255) {
        out[length++] = 0
        rest -= 255
      }
      out[length++] = rest
    }
    out.set(this.src.subarray(literalPointer, literalPointer + literalLength), length)
    return length + literalLength
  }

  /** 写出一个回看匹配。上游按值传参，因此这里不会回写当前匹配状态。 */
  private encodeLookbackMatch(
    out: Uint8Array,
    outLength: number,
    lastLiteralLength: number
  ): number {
    let length = outLength
    let lbLength = this.lbLength
    let lbOffset = this.lbOffset

    if (lbLength === 2) {
      lbOffset -= 1
      out[length++] = M1_MARKER | ((lbOffset & 0x3) << 2)
      out[length++] = lbOffset >> 2
    } else if (lbLength <= M2_MAX_LEN && lbOffset <= M2_MAX_OFFSET) {
      lbOffset -= 1
      out[length++] = ((lbLength - 1) << 5) | ((lbOffset & 0x7) << 2)
      out[length++] = lbOffset >> 3
    } else if (lbLength === M2_MIN_LEN && lbOffset <= M1_MAX_OFFSET + M2_MAX_OFFSET && lastLiteralLength >= 4) {
      lbOffset -= 1 + M2_MAX_OFFSET
      out[length++] = M1_MARKER | ((lbOffset & 0x3) << 2)
      out[length++] = lbOffset >> 2
    } else if (lbOffset <= M3_MAX_OFFSET) {
      lbOffset -= 1
      if (lbLength <= M3_MAX_LEN) {
        out[length++] = M3_MARKER | (lbLength - 2)
      } else {
        lbLength -= M3_MAX_LEN
        out[length++] = M3_MARKER
        let rest = lbLength
        while (rest > 255) {
          out[length++] = 0
          rest -= 255
        }
        out[length++] = rest
      }
      out[length++] = (lbOffset << 2) & 0xff
      out[length++] = (lbOffset >>> 6) & 0xff
    } else {
      lbOffset -= 0x4000
      if (lbLength <= M4_MAX_LEN) {
        out[length++] = M4_MARKER | ((lbOffset & 0x4000) >> 11) | (lbLength - 2)
      } else {
        lbLength -= M4_MAX_LEN
        out[length++] = M4_MARKER | ((lbOffset & 0x4000) >> 11)
        let rest = lbLength
        while (rest > 255) {
          out[length++] = 0
          rest -= 255
        }
        out[length++] = rest
      }
      out[length++] = (lbOffset << 2) & 0xff
      out[length++] = (lbOffset >>> 6) & 0xff
    }

    return length
  }
}

/** 默认压缩器实例；小程序内建议复用同一实例以复用字典内存。 */
export const defaultCompressor = new LzoCompressor()

/** 压缩一段数据。 */
export function lzoCompress(source: Uint8Array): Uint8Array {
  return defaultCompressor.compress(source)
}

/**
 * 解压 LZO1X 数据，用于自检与设备回读校验。
 *
 * @param source 压缩数据
 * @param expectedSize 期望的原始长度
 */
export function lzoDecompress(source: Uint8Array, expectedSize: number): Uint8Array {
  if (source.length < 3) {
    throw new LzoError('LZO 数据长度不足')
  }
  const dst = new Uint8Array(expectedSize)
  let inp = 0
  let outp = 0
  let state = 0
  let nstate = 0
  let lbcur = 0
  let lblen = 0

  const needIn = (count: number): void => {
    if (inp + count > source.length) {
      throw new LzoError('LZO 输入越界')
    }
  }
  const needOut = (count: number): void => {
    if (outp + count > dst.length) {
      throw new LzoError('LZO 输出越界')
    }
  }

  if (source[0] >= 22) {
    const len = source[inp++] - 17
    needIn(len)
    needOut(len)
    dst.set(source.subarray(inp, inp + len), outp)
    inp += len
    outp += len
    state = 4
  } else if (source[0] >= 18) {
    nstate = source[inp++] - 17
    state = nstate
    needIn(nstate)
    needOut(nstate)
    dst.set(source.subarray(inp, inp + nstate), outp)
    inp += nstate
    outp += nstate
  }

  for (;;) {
    needIn(1)
    const inst = source[inp++]
    if (inst & 0xc0) {
      needIn(1)
      lbcur = outp - ((source[inp++] << 3) + ((inst >> 2) & 0x7) + 1)
      lblen = (inst >> 5) + 1
      nstate = inst & 0x3
    } else if (inst & M3_MARKER) {
      lblen = (inst & 0x1f) + 2
      if (lblen === 2) {
        let offset = 0
        while (source[inp] === 0) {
          inp += 1
          offset += 1
          if (offset > MAX_255_COUNT) {
            throw new LzoError('LZO 长度扩展溢出')
          }
          needIn(1)
        }
        lblen += offset * 255 + 31 + source[inp++]
      }
      needIn(2)
      nstate = source[inp] | (source[inp + 1] << 8)
      inp += 2
      lbcur = outp - ((nstate >> 2) + 1)
      nstate &= 0x3
    } else if (inst & M4_MARKER) {
      lblen = (inst & 0x7) + 2
      if (lblen === 2) {
        let offset = 0
        while (source[inp] === 0) {
          inp += 1
          offset += 1
          if (offset > MAX_255_COUNT) {
            throw new LzoError('LZO 长度扩展溢出')
          }
          needIn(1)
        }
        lblen += offset * 255 + 7 + source[inp++]
      }
      needIn(2)
      nstate = source[inp] | (source[inp + 1] << 8)
      inp += 2
      lbcur = outp - (((inst & 0x8) << 11) + (nstate >> 2))
      nstate &= 0x3
      if (lbcur === outp) {
        break
      }
      lbcur -= 16384
    } else if (state === 0) {
      let len = inst + 3
      if (len === 3) {
        let offset = 0
        while (source[inp] === 0) {
          inp += 1
          offset += 1
          if (offset > MAX_255_COUNT) {
            throw new LzoError('LZO 长度扩展溢出')
          }
          needIn(1)
        }
        len += offset * 255 + 15 + source[inp++]
      }
      needIn(len)
      needOut(len)
      dst.set(source.subarray(inp, inp + len), outp)
      inp += len
      outp += len
      state = 4
      continue
    } else if (state !== 4) {
      needIn(1)
      nstate = inst & 0x3
      lbcur = outp - ((inst >> 2) + (source[inp++] << 2) + 1)
      lblen = 2
    } else {
      needIn(1)
      nstate = inst & 0x3
      lbcur = outp - ((inst >> 2) + (source[inp++] << 2) + 2049)
      lblen = 3
    }

    if (lbcur < 0) {
      throw new LzoError('LZO 回看越界')
    }
    needIn(nstate)
    needOut(lblen + nstate)
    for (let i = 0; i < lblen; i += 1) {
      dst[outp] = dst[lbcur + i]
      outp += 1
    }
    state = nstate
    for (let i = 0; i < nstate; i += 1) {
      dst[outp] = source[inp]
      inp += 1
      outp += 1
    }
  }

  return dst.subarray(0, outp)
}
