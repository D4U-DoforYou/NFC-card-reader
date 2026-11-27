/**
 * MIFARE Classic 的密钥穷举：用常见弱密钥字典试解密文块。
 *
 * 很多卡用的是出厂默认密钥或简单口令，字典穷举往往一发就中。
 * 判定「解对了」靠明文结构特征：值块的异或关系、全是可打印字符等。
 * 解不出来说明密钥不在字典里，可以改用已知密钥恢复（`recoverMifareKeys`）。
 */

import { MifareBlockType, crypto1DecryptBlock, isMifareValueBlock, mifareBlockType, mifareSectors, mifareSectorOfBlock } from './mifare'

/**
 * 常见弱密钥字典。
 *
 * 出厂默认密钥、简单口令、以及一些公开项目里用过的密钥。
 * 都是 6 字节。
 */
export const COMMON_MIFARE_KEYS: Uint8Array[] = [
  'FFFFFFFFFFFF',
  '000000000000',
  '111111111111',
  '121212121212',
  '131313131313',
  '141414141414',
  '222222222222',
  '333333333333',
  '444444444444',
  '555555555555',
  '565656565656',
  '666666666666',
  '676767676767',
  '777777777777',
  '787878787878',
  '888888888888',
  '989898989898',
  '999999999999',
  'A0A1A2A3A4A5',
  'B0B1B2B3B4B5',
  'C0C1C2C3C4C5',
  'D0D1D2D3D4D5',
  'E0E1E2E3E4E5',
  'F0F1F2F3F4F5',
  '001122334455',
  '0123456789AB',
  '1234567890AB',
  '123456789ABC',
  '3E3E3E3E3E3E',
  '4D5A6F000000',
  '5A5A5A5A5A5A',
  '6A6A6A6A6A6A',
  'AAAAAAAAAAAA',
  'ABCDABCDABCD',
].map(hex => {
  const bytes = new Uint8Array(6)
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
})

/** 明文可信度评分。 */
export interface PlaintextVerdict {
  /** 0 表示看起来还是密文；越高越像明文。 */
  score: number
  /** 中文说明。 */
  reason: string
}

/**
 * 判断一段字节「像不像」明文。
 *
 * 靠三个结构特征：
 * 1. 值块：4 组「值 / 取反值 / 校验 / 取反校验」的异或关系；
 * 2. 全是可打印字符（或是 0x00）；
 * 3. 大部分字节可打印。
 */
export function judgePlaintext(data: Uint8Array): PlaintextVerdict {
  if (data.length !== 16) {
    return { score: 0, reason: '长度不是 16 字节' }
  }
  if (isMifareValueBlock(data)) {
    return { score: 100, reason: '符合值块结构（值与校验的异或关系成立）' }
  }
  let printable = 0
  for (const byte of data) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x00) {
      printable += 1
    }
  }
  if (printable === 16) {
    return { score: 90, reason: '全部字节都是可打印字符或 0x00' }
  }
  if (printable >= 12) {
    return { score: 60, reason: `${printable}/16 个字节可打印` }
  }
  return { score: 0, reason: '看不出明文结构，多半还没解开' }
}

/** 一次穷举的结果。 */
export interface BruteForceHit {
  /** 命中的密钥。 */
  key: Uint8Array
  /** 解出来的明文。 */
  plain: Uint8Array
  /** 可信度评分。 */
  score: number
  /** 判定理由。 */
  reason: string
}

/** 穷举结果。 */
export interface BruteForceResult {
  /** 命中的候选（按评分从高到低）。 */
  hits: BruteForceHit[]
  /** 试过的密钥个数。 */
  tried: number
  /** 用时（毫秒）。 */
  elapsedMs: number
}

/**
 * 用字典里的密钥逐个试解一个密文块。
 *
 * @param key 密钥字典，不传则用常见弱密钥
 * @param uid 卡片 UID（参与会话密钥计算，必需）
 * @param blockNumber 块号
 * @param cipher 16 字节密文
 */
export function bruteForceMifareBlock(
  uid: Uint8Array,
  blockNumber: number,
  cipher: Uint8Array,
  key?: Uint8Array
): BruteForceResult {
  const started = Date.now()
  const dictionary = key ? [key] : COMMON_MIFARE_KEYS
  const hits: BruteForceHit[] = []
  for (const candidate of dictionary) {
    const plain = crypto1DecryptBlock(candidate, uid, blockNumber, cipher)
    const verdict = judgePlaintext(plain)
    if (verdict.score > 0) {
      hits.push({
        key: candidate,
        plain,
        score: verdict.score,
        reason: verdict.reason,
      })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits, tried: dictionary.length, elapsedMs: Date.now() - started }
}

/**
 * 扫一遍整卡 dump，列出每个扇区解出来的密钥。
 *
 * 每个扇区用 Key A 解数据块、Key B 解访问控制块，
 * 哪个扇区解出可信的明文，就认为该扇区的密钥猜对了。
 */
export function bruteForceMifareDump(
  uid: Uint8Array,
  dump: Uint8Array,
  size: '1K' | '2K' | '4K',
  keys?: Uint8Array[]
): Array<{ sector: number; key: Uint8Array; score: number; reason: string }> {
  const dictionary = keys && keys.length ? keys : COMMON_MIFARE_KEYS
  const found: Array<{ sector: number; key: Uint8Array; score: number; reason: string }> = []
  const layout = mifareSectors(size)
  for (let start = 0; start < layout.blocks;) {
    const region = mifareSectorOfBlock(size, start)
    const sector = region.sector
    for (const candidate of dictionary) {
      let best = 0
      let reason = ''
      for (let offset = 0; offset < region.sectorSize - 1; offset += 1) {
        const block = start + offset
        if (block * 16 + 16 > dump.length) {
          break
        }
        const slice = dump.slice(block * 16, block * 16 + 16)
        const verdict = judgePlaintext(crypto1DecryptBlock(candidate, uid, block, slice))
        if (verdict.score > best) {
          best = verdict.score
          reason = verdict.reason
        }
      }
      if (best >= 90) {
        found.push({ sector, key: candidate, score: best, reason })
        break
      }
    }
    start += region.sectorSize
  }
  return found
}

/** 块类型的中文名（用于穷举结果说明）。 */
export function describeBlockType(type: MifareBlockType): string {
  if (type === 'manufacturer') {
    return '厂商块'
  }
  if (type === 'trailer') {
    return '访问控制块'
  }
  if (type === 'value') {
    return '值块'
  }
  return '数据块'
}

/** 供界面显示：块类型。 */
export { mifareBlockType, mifareSectors, mifareSectorOfBlock }
