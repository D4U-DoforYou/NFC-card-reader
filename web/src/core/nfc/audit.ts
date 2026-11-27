/**
 * MIFARE Classic 安全审计：密钥表、整卡 dump、字典穷举、写卡与格式化。
 *
 * 这一层只做「怎么操作卡」；卡怎么加密由 CLRC663 芯片负责，
 * 所以这里不需要在主机侧实现 Crypto1：
 *   - 认证：LOADKEY 装密钥 → MFAUTHENT 由芯片跑完整握手；
 *   - 之后芯片自动加密发出的帧、解密收到的帧。
 *
 * 字典穷举直接对真卡试：认证成功即命中。
 * 认证失败分两种——「密钥不对」与「射频异常」——两者必须分开，
 * 否则一次射频抖动就会漏掉真正的密钥。
 */

import type { MifareClassicSession } from './mifareClassic'
import {
  BUILTIN_KEYS,
  MadInfo,
  analyzeMad,
  analyzeTrailerAccess,
  describeAccess,
  detectValueBlock,
} from './mifareTools'

/** Classic 1K 的块数。 */
export const CLASSIC_1K_BLOCKS = 64
/** 每块字节数。 */
export const CLASSIC_BLOCK_SIZE = 16
/** 扇区数。 */
export const CLASSIC_SECTORS = 16
/** 扇区尾块（每扇区第 4 块）。 */
export const TRAILER_BLOCK = 3
/** 默认密钥（出廠状态）。 */
export const DEFAULT_KEY = 'FFFFFFFFFFFF'

/** 一个扇区的密钥。 */
export interface ClassicSectorKey {
  /** Key A（12 位十六进制）。 */
  keyA: string
  /** Key B（12 位十六进制）。 */
  keyB: string
}

/** 扇区读取结果。 */
export type ClassicSectorState = 'ok' | 'no-key' | 'auth-failed' | 'error'

/** 一个扇区的读取结果。 */
export interface ClassicSectorResult {
  sector: number
  state: ClassicSectorState
  message: string
}

/** 整卡 dump。 */
export interface ClassicDump {
  /** 卡片 UID（十六进制，无分隔）。 */
  uid: string
  /** 16 个扇区的密钥。 */
  keys: ClassicSectorKey[]
  /** 64 个块；null 表示没读到。 */
  blocks: (Uint8Array | null)[]
  /** 每个扇区的读取结果。 */
  sectors: ClassicSectorResult[]
}

/** 密钥是否为合法的 6 字节十六进制。 */
export function isValidKey(text: string): boolean {
  return /^[0-9a-fA-F]{12}$/.test(text.replace(/\s/g, ''))
}

/** 规范化密钥：去掉分隔符并转大写；不合法时抛错。 */
export function normalizeKey(text: string): string {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (cleaned.length !== 12) {
    throw new Error(`密钥必须是 12 位十六进制：${text.trim()}`)
  }
  return cleaned
}

/** 全部扇区都用默认密钥的密钥表。 */
export function defaultKeys(): ClassicSectorKey[] {
  return Array.from({ length: CLASSIC_SECTORS }, () => ({ keyA: DEFAULT_KEY, keyB: DEFAULT_KEY }))
}

/** 把密钥表复制一份（避免共享引用）。 */
export function cloneKeys(keys: ClassicSectorKey[]): ClassicSectorKey[] {
  return keys.map(item => ({ keyA: item.keyA, keyB: item.keyB }))
}

/**
 * 标准空白扇区的尾块。
 *
 * 布局：Key A(6) | 访问位(4) | GP(2) | 特殊字节(2)。
 * 出廠状态的访问位是 FF FF FF 07（读写都用默认条件）。
 */
export function standardTrailer(): Uint8Array {
  const trailer = new Uint8Array(CLASSIC_BLOCK_SIZE).fill(0xff)
  trailer.set([0xff, 0xff, 0xff, 0x07], 6)
  return trailer
}

/** 标准空白卡：数据块全 0，尾块是标准尾块，厂商块留空。 */
export function blankDump(): ClassicDump {
  const blocks: (Uint8Array | null)[] = new Array(CLASSIC_1K_BLOCKS).fill(null)
  for (let block = 0; block < CLASSIC_1K_BLOCKS; block += 1) {
    if (block === 0) {
      continue
    }
    blocks[block] = block % 4 === TRAILER_BLOCK ? standardTrailer() : new Uint8Array(CLASSIC_BLOCK_SIZE)
  }
  return {
    uid: '',
    keys: defaultKeys(),
    blocks,
    sectors: Array.from({ length: CLASSIC_SECTORS }, (_, sector) => ({
      sector,
      state: 'no-key' as ClassicSectorState,
      message: '未读取',
    })),
  }
}

/** 空 dump（什么都没有）。 */
export function emptyDump(): ClassicDump {
  return {
    uid: '',
    keys: defaultKeys(),
    blocks: new Array(CLASSIC_1K_BLOCKS).fill(null),
    sectors: Array.from({ length: CLASSIC_SECTORS }, (_, sector) => ({
      sector,
      state: 'no-key' as ClassicSectorState,
      message: '未读取',
    })),
  }
}

/** 十六进制工具。 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** 解析十六进制；不合法时抛错。 */
export function fromHex(text: string): Uint8Array {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length % 2 !== 0) {
    throw new Error('十六进制长度必须为偶数')
  }
  const bytes = new Uint8Array(cleaned.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(cleaned.substr(index * 2, 2), 16)
  }
  return bytes
}

/** 一行块数据的可读摘要。 */
export function blockSummary(bytes: Uint8Array | null): string {
  if (!bytes) {
    return '—'
  }
  let text = ''
  for (const byte of bytes) {
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
  }
  return text
}

/**
 * 序列化成可编辑的纯文本 dump。
 *
 * 格式是自定义的，但一眼能看懂、可以直接在编辑器里改：
 *
 * ```text
 * # D4U Classic 1K dump
 * UID 560CAEE9
 * KEY 00 A 042C9C69CBD1
 * BLOCK 00 4131382D573000004746413138000000
 * ```
 */
export function serializeDump(dump: ClassicDump): string {
  const lines: string[] = ['# D4U Classic 1K dump']
  if (dump.uid) {
    lines.push(`UID ${dump.uid.toUpperCase()}`)
  }
  dump.keys.forEach((key, sector) => {
    lines.push(`KEY ${sector.toString(16).padStart(2, '0')} A ${key.keyA}`)
    lines.push(`KEY ${sector.toString(16).padStart(2, '0')} B ${key.keyB}`)
  })
  dump.blocks.forEach((block, index) => {
    if (!block) {
      return
    }
    lines.push(`BLOCK ${index.toString(16).padStart(2, '0')} ${toHex(block)}`)
  })
  return `${lines.join('\n')}\n`
}

/** 解析纯文本 dump。 */
export function parseDump(text: string): ClassicDump {
  const dump = emptyDump()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const parts = line.split(/\s+/)
    const tag = parts[0]?.toUpperCase()
    if (tag === 'UID' && parts[1]) {
      dump.uid = parts[1].replace(/[^0-9a-fA-F]/g, '').toUpperCase()
      continue
    }
    if (tag === 'KEY' && parts.length >= 4) {
      const sector = Number.parseInt(parts[1], 16)
      if (!Number.isInteger(sector) || sector < 0 || sector >= CLASSIC_SECTORS) {
        throw new Error(`扇区号非法：${parts[1]}`)
      }
      const key = normalizeKey(parts[3])
      if (parts[2].toUpperCase() === 'A') {
        dump.keys[sector].keyA = key
      } else if (parts[2].toUpperCase() === 'B') {
        dump.keys[sector].keyB = key
      } else {
        throw new Error(`Key 类型只能是 A 或 B：${parts[2]}`)
      }
      continue
    }
    if (tag === 'BLOCK' && parts.length >= 3) {
      const block = Number.parseInt(parts[1], 16)
      if (!Number.isInteger(block) || block < 0 || block >= CLASSIC_1K_BLOCKS) {
        throw new Error(`块号非法：${parts[1]}`)
      }
      const data = fromHex(parts[2])
      if (data.length !== CLASSIC_BLOCK_SIZE) {
        throw new Error(`块 ${block} 的数据必须是 ${CLASSIC_BLOCK_SIZE} 字节`)
      }
      dump.blocks[block] = data
    }
  }
  return dump
}

/** 导出成「每块一行」的纯 hex，方便和其它工具互转。 */
export function serializeBlocks(dump: ClassicDump): string {
  const lines: string[] = []
  dump.blocks.forEach(block => {
    lines.push(block ? toHex(block) : ''.padEnd(CLASSIC_BLOCK_SIZE * 2, '0'))
  })
  return `${lines.join('\n')}\n`
}

/** 解析「每块一行」的纯 hex。 */
export function parseBlocks(text: string): (Uint8Array | null)[] {
  const blocks: (Uint8Array | null)[] = new Array(CLASSIC_1K_BLOCKS).fill(null)
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  lines.forEach((line, index) => {
    if (index >= CLASSIC_1K_BLOCKS) {
      throw new Error(`块数超过 ${CLASSIC_1K_BLOCKS}`)
    }
    const cleaned = line.replace(/[^0-9a-fA-F]/g, '')
    if (cleaned.length === 0) {
      return
    }
    if (cleaned.length !== CLASSIC_BLOCK_SIZE * 2) {
      throw new Error(`第 ${index} 行必须是 ${CLASSIC_BLOCK_SIZE * 2} 位十六进制`)
    }
    blocks[index] = fromHex(cleaned)
  })
  return blocks
}

/** 读取过程中的回调。 */
export interface AuditProgress {
  /** 已经处理的扇区数。 */
  done: number
  /** 总扇区数。 */
  total: number
  /** 当前说明。 */
  message: string
}

/** 读取整卡 dump 的选项。 */
export interface ReadDumpOptions {
  /** 是否连尾块一起读（尾块需要 Key A 才能读出访问位）。 */
  includeTrailers?: boolean
  /** 是否跳过密钥等于默认值的扇区。 */
  skipDefaultKeys?: boolean
  onProgress?: (progress: AuditProgress) => void
  /** 中断回调；返回 true 就停下来。 */
  shouldStop?: () => boolean
}

/**
 * 按密钥表把整卡读出来。
 *
 * 每个扇区都要重新选卡、重新认证（芯片的 Crypto1 会话不能跨扇区复用），
 * 所以 16 个扇区就是 16 次完整握手，慢是没办法的。
 */
export async function readFullDump(
  session: MifareClassicSession,
  dump: ClassicDump,
  options: ReadDumpOptions = {},
): Promise<ClassicDump> {
  const result: ClassicDump = {
    uid: dump.uid,
    keys: cloneKeys(dump.keys),
    blocks: dump.blocks.map(block => (block ? block.slice() : null)),
    sectors: dump.sectors.map(item => ({ ...item })),
  }
  const includeTrailers = options.includeTrailers ?? false
  const skipDefault = options.skipDefaultKeys ?? false

  for (let sector = 0; sector < CLASSIC_SECTORS; sector += 1) {
    if (options.shouldStop?.()) {
      result.sectors[sector] = { sector, state: 'error', message: '已中断' }
      break
    }
    const key = result.keys[sector].keyA
    const blockCount = includeTrailers ? 4 : 3
    const blocks = Array.from({ length: blockCount }, (_, index) => sector * 4 + index)
    if (skipDefault && key === DEFAULT_KEY) {
      result.sectors[sector] = { sector, state: 'no-key', message: '密钥未知（默认密钥），跳过' }
      continue
    }
    options.onProgress?.({ done: sector, total: CLASSIC_SECTORS, message: `正在读取扇区 ${sector}` })
    try {
      const data = await session.readBlocks(blocks, fromHex(key), 'A')
      data.forEach((bytes, index) => {
        result.blocks[index] = bytes.slice()
      })
      result.sectors[sector] = { sector, state: 'ok', message: `读取 ${data.size} 块` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.sectors[sector] = {
        sector,
        state: message.includes('认证') ? 'auth-failed' : 'error',
        message,
      }
    }
  }
  options.onProgress?.({ done: CLASSIC_SECTORS, total: CLASSIC_SECTORS, message: '读取完成' })
  return result
}

/** 字典穷举的结果。 */
export interface KeySearchResult {
  /** 命中的密钥；没命中为 null。 */
  key: string | null
  /** 试过的密钥个数。 */
  tested: number
  /** 候选总数。 */
  total: number
  /** 射频异常导致的无效尝试次数。 */
  inconclusive: number
  /** 逐条记录。 */
  log: Array<{ key: string; result: 'hit' | 'miss' | 'inconclusive'; note: string }>
}

/** 字典穷举的选项。 */
export interface KeySearchOptions {
  /** 用 Key A 还是 Key B 试。 */
  keyType?: 'A' | 'B'
  onProgress?: (progress: { tested: number; total: number; current: string }) => void
  /** 中断回调；返回 true 就停下来。 */
  shouldStop?: () => boolean
}

/**
 * 对一个扇区穷举候选密钥。
 *
 * 每个候选都要真实认证一次：芯片跑完握手并且建立了 Crypto1 会话，
 * 才算命中。「射频异常」不算失败，会单独计数——
 * 把射频抖动当成密钥错误，就会漏掉真正的密钥。
 */
export async function searchSectorKey(
  session: MifareClassicSession,
  sector: number,
  candidates: readonly string[],
  options: KeySearchOptions = {},
): Promise<KeySearchResult> {
  const keyType = options.keyType ?? 'A'
  const block = sector * 4
  const result: KeySearchResult = { key: null, tested: 0, total: candidates.length, inconclusive: 0, log: [] }
  for (const candidate of candidates) {
    if (options.shouldStop?.()) {
      break
    }
    let key: Uint8Array
    try {
      key = fromHex(normalizeKey(candidate))
    } catch {
      result.log.push({ key: candidate, result: 'miss', note: '不是合法的 6 字节密钥' })
      continue
    }
    options.onProgress?.({ tested: result.tested, total: candidates.length, current: candidate })
    let probe: string
    try {
      const outcome = await session.probeAuthenticate(block, key, keyType)
      if (outcome === 'ok') {
        result.key = normalizeKey(candidate)
        result.tested += 1
        result.log.push({ key: result.key, result: 'hit', note: '认证通过' })
        return result
      }
      probe = outcome
    } catch (error) {
      probe = 'inconclusive'
      result.log.push({
        key: candidate,
        result: 'inconclusive',
        note: error instanceof Error ? error.message : String(error),
      })
    }
    result.tested += 1
    if (probe === 'inconclusive') {
      result.inconclusive += 1
    } else {
      result.log.push({
        key: candidate,
        result: 'miss',
        note: probe === 'rejected' ? '卡回了拒绝应答' : '未建立 Crypto1 会话',
      })
    }
  }
  options.onProgress?.({ tested: result.tested, total: candidates.length, current: '' })
  return result
}

/** 写卡的结果。 */
export interface WriteDumpResult {
  written: number
  skipped: number
  failed: Array<{ block: number; message: string }>
}

/** 写 dump 的选项。 */
export interface WriteDumpOptions {
  /** 是否写扇区尾块（默认不写：尾块改坏了卡就废了）。 */
  includeTrailers?: boolean
  /** 是否写厂商块 0（默认不写）。 */
  includeManufacturerBlock?: boolean
  onProgress?: (progress: AuditProgress) => void
  shouldStop?: () => boolean
}

/**
 * 把 dump 写回卡片。
 *
 * 厂商块与扇区尾块默认不写：这两块写坏了卡就废了，
 * 必须由使用者在界面上明确勾选。
 */
export async function writeDump(
  session: MifareClassicSession,
  dump: ClassicDump,
  options: WriteDumpOptions = {},
): Promise<WriteDumpResult> {
  const result: WriteDumpResult = { written: 0, skipped: 0, failed: [] }
  const includeTrailers = options.includeTrailers ?? false
  const includeManufacturer = options.includeManufacturerBlock ?? false

  for (let sector = 0; sector < CLASSIC_SECTORS; sector += 1) {
    if (options.shouldStop?.()) {
      break
    }
    const key = dump.keys[sector].keyA
    const blocks: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const block = sector * 4 + index
      if (block === 0 && !includeManufacturer) {
        result.skipped += 1
        continue
      }
      if (block % 4 === TRAILER_BLOCK && !includeTrailers) {
        result.skipped += 1
        continue
      }
      if (!dump.blocks[block]) {
        result.skipped += 1
        continue
      }
      blocks.push(block)
    }
    if (!blocks.length) {
      continue
    }
    options.onProgress?.({ done: sector, total: CLASSIC_SECTORS, message: `正在写入扇区 ${sector}` })
    try {
      await session.authenticate(blocks[0], fromHex(key), 'A')
      for (const block of blocks) {
        const data = dump.blocks[block]!
        await session.writeBlock(block, data, fromHex(key), 'A')
        result.written += 1
      }
    } catch (error) {
      result.failed.push({ block: blocks[0], message: error instanceof Error ? error.message : String(error) })
    }
  }
  options.onProgress?.({ done: CLASSIC_SECTORS, total: CLASSIC_SECTORS, message: '写入完成' })
  return result
}

/**
 * 格式化卡片：把数据块清零、尾块写成标准状态。
 *
 * 尾块算「写尾块」，所以这里显式允许——格式化本来就是要重置访问条件。
 * 厂商块保持不动。
 */
export async function formatCard(
  session: MifareClassicSession,
  dump: ClassicDump,
  options: { onProgress?: (progress: AuditProgress) => void; shouldStop?: () => boolean } = {},
): Promise<WriteDumpResult> {
  const blank = blankDump()
  blank.keys = cloneKeys(dump.keys)
  blank.blocks[0] = dump.blocks[0] ? dump.blocks[0].slice() : null
  return writeDump(session, blank, {
    includeTrailers: true,
    includeManufacturerBlock: false,
    onProgress: options.onProgress,
    shouldStop: options.shouldStop,
  })
}

/** 解析候选密钥列表：每行一个，支持 `#` 注释。 */
export function parseKeyList(text: string): string[] {
  const keys: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim()
    if (!line) {
      continue
    }
    for (const piece of line.split(/[\s,;]+/)) {
      if (!piece) {
        continue
      }
      const cleaned = piece.replace(/[^0-9a-fA-F]/g, '')
      if (cleaned.length === 12) {
        keys.push(cleaned.toUpperCase())
      }
    }
  }
  return Array.from(new Set(keys))
}

/**
 * 锁死 UID 块（UFUID）。
 *
 * UID / FUID 这类克隆卡的第 0 块存的就是 UID。把它写回同样的内容、
 * 只改最后一字节（锁字节），卡就再也不能改 UID 了。
 *
 * 锁字节的约定各卡不同：常见是 0x01 表示已锁定，0x00 表示未锁定，
 * 所以这里让调用方指定，不替用户猜。写之前必须读出当前第 0 块，
 * 原样保留除锁字节以外的所有内容——锁错了也不会把 UID 写坏。
 */
export function buildLockedUidBlock(current: Uint8Array, lockByte: number): Uint8Array {
  if (current.length !== CLASSIC_BLOCK_SIZE) {
    throw new Error(`UID 块必须是 ${CLASSIC_BLOCK_SIZE} 字节`)
  }
  if (!Number.isInteger(lockByte) || lockByte < 0 || lockByte > 0xff) {
    throw new Error('锁字节必须是 0..255')
  }
  const next = current.slice()
  next[next.length - 1] = lockByte
  return next
}

/**
 * 读出当前 UID 块。
 *
 * 第 0 块虽然本身不能单独认证，但用扇区 0 的密钥认证之后就能读。
 */
export async function readUidBlock(
  session: MifareClassicSession,
  key: Uint8Array,
): Promise<Uint8Array> {
  const blocks = await session.readBlocks([0], key, 'A')
  const data = blocks.get(0)
  if (!data) {
    throw new Error('读不到第 0 块')
  }
  return data
}

/** 比较两份 dump，返回不同的块号。 */
export function diffDumps(left: ClassicDump, right: ClassicDump): number[] {
  const changed: number[] = []
  for (let block = 0; block < CLASSIC_1K_BLOCKS; block += 1) {
    const a = left.blocks[block]
    const b = right.blocks[block]
    if (!a || !b) {
      if (a || b) {
        changed.push(block)
      }
      continue
    }
    if (!a.every((byte, index) => byte === b[index])) {
      changed.push(block)
    }
  }
  return changed
}

/** 一个扇区的解卡结果。 */
export interface SectorCrack {
  sector: number
  /** 找到的 Key A。 */
  keyA: string
  /** 找到的 Key B。 */
  keyB: string
  /** 是否解开。 */
  unlocked: boolean
  /** 说明。 */
  message: string
}

/** 解卡结果。 */
export interface CrackResult {
  /** 每个扇区的密钥。 */
  keys: ClassicSectorKey[]
  /** 每个扇区的状态。 */
  sectors: SectorCrack[]
  /** 读到的块（如果要求读）。 */
  blocks: (Uint8Array | null)[]
  /** 试过的候选密钥数。 */
  tested: number
  /** 实际发起的认证次数（含命中后扫其它扇区的那些）。 */
  attempts: number
  /** 候选总数。 */
  total: number
  /** 没定论的尝试次数（射频异常或芯片命令没跑完）。 */
  inconclusive: number
  /** 总耗时（毫秒）。 */
  elapsedMs: number
}

/** 解卡过程中的阶段。 */
export type CrackPhase = 'probing' | 'sweeping' | 'reading' | 'done'

/** 解卡进度。 */
export interface CrackProgress {
  /** 已试的候选密钥数。 */
  tested: number
  /** 实际发起的认证次数。 */
  attempts: number
  /** 候选总数（密钥 × 密钥类型）。 */
  total: number
  /** 当前这把密钥。 */
  current: string
  /** 当前在处理的扇区。 */
  sector: number
  /** 已解开的扇区数。 */
  unlocked: number
  /** 已用时间（毫秒）。 */
  elapsedMs: number
  /** 预计还要多久（毫秒）；算不出来时为 null。 */
  etaMs: number | null
  /** 当前阶段。 */
  phase: CrackPhase
}

/**
 * 按当前速度估算还要多久。
 *
 * 用的是「每次认证的平均耗时 × 还没试的候选数」，
 * 命中之后扫其它扇区的那一段会让估算偏乐观，只作参考。
 */
export function estimateRemaining(elapsedMs: number, attempts: number, remaining: number): number | null {
  if (remaining <= 0) {
    return 0
  }
  if (attempts <= 0 || elapsedMs <= 0) {
    return null
  }
  return Math.round((elapsedMs / attempts) * remaining)
}

/** 解卡选项。 */
export interface CrackOptions {
  /** 候选密钥；不填就用内置字典。 */
  keys?: string[]
  /** 要试的密钥类型，默认 A 与 B 都试。 */
  keyTypes?: Array<'A' | 'B'>
  /** 命中后是否顺手把该扇区读出来。 */
  readSectors?: boolean
  onProgress?: (progress: CrackProgress) => void
  /** 中断回调；返回 true 就停下来。 */
  shouldStop?: () => boolean
  /** 每次状态变化时的回调（预览用）。 */
  onUpdate?: (snapshot: { sectors: SectorCrack[]; blocks: (Uint8Array | null)[] }) => void
}

/**
 * 一键解卡：按候选密钥逐把试，命中就把该扇区解开。
 *
 * 走的是**在线**路线：每一把候选密钥都真刀真枪地认证一次，
 * 芯片建立起 Crypto1 会话才算命中。这跟 pm3 的 autopwn 是同一个思路，
 * 区别是 pm3 还能用 nested / darkside 之类「拿卡的随机数」的攻击，
 * 那边我们做不到——认证在芯片里完成，主机看不到随机数。
 *
 * 省时间的做法：一把密钥通常能打开同一张卡的多个扇区。
 * 所以先用它试一个还没打开的扇区，成了再拿同一把密钥扫剩下的扇区，
 * 而不是每把密钥都把所有扇区试一遍。
 */
export async function crackCard(
  session: MifareClassicSession,
  options: CrackOptions = {},
): Promise<CrackResult> {
  const candidates = options.keys?.length ? options.keys : BUILTIN_KEYS
  const keyTypes = options.keyTypes ?? ['A', 'B']
  const readSectors = options.readSectors ?? true
  const keys: ClassicSectorKey[] = defaultKeys()
  const sectors: SectorCrack[] = Array.from({ length: CLASSIC_SECTORS }, (_, sector) => ({
    sector,
    keyA: '',
    keyB: '',
    unlocked: false,
    message: '未尝试',
  }))
  const blocks: (Uint8Array | null)[] = new Array(CLASSIC_1K_BLOCKS).fill(null)

  const startedAt = Date.now()
  let tested = 0
  let attempts = 0
  let inconclusive = 0
  let phase: CrackPhase = 'probing'
  const total = candidates.length * keyTypes.length

  /** 还没解开的扇区。 */
  const locked = (): number[] => sectors.filter(item => !item.unlocked).map(item => item.sector)

  /** 报一次进度：进度条、剩余时间都靠它。 */
  const report = (current: string, sector: number): void => {
    const elapsedMs = Date.now() - startedAt
    options.onProgress?.({
      tested,
      attempts,
      total,
      current,
      sector,
      unlocked: sectors.filter(item => item.unlocked).length,
      elapsedMs,
      etaMs: estimateRemaining(elapsedMs, attempts, total - tested),
      phase,
    })
  }

  /** 报一次状态快照：预览靠它实时刷新。 */
  const publish = (): void => {
    options.onUpdate?.({
      sectors: sectors.map(item => ({ ...item })),
      blocks: blocks.map(block => (block ? block.slice() : null)),
    })
  }

  /** 记下一个扇区被解开了。 */
  const unlock = (sector: number, key: string, keyType: 'A' | 'B'): void => {
    const item = sectors[sector]
    item.unlocked = true
    item.message = `Key ${keyType} 认证通过`
    if (keyType === 'A') {
      keys[sector].keyA = key
      item.keyA = key
    } else {
      keys[sector].keyB = key
      item.keyB = key
    }
    publish()
  }

  // 先把 Key A 全试完，再试 Key B。
  // 绝大多数卡的读写都用 Key A，先跑完 A 那一半，命中就早一半时间；
  // 整轮下来试的次数跟「一把一把交替着试」是一样的。
  for (const keyType of keyTypes) {
    for (const candidate of candidates) {
      if (options.shouldStop?.()) {
        break
      }
      let key: Uint8Array
      try {
        key = fromHex(normalizeKey(candidate))
      } catch {
        continue
      }
      const normalized = normalizeKey(candidate)
      const remaining = locked()
      if (!remaining.length) {
        break
      }
      if (options.shouldStop?.()) {
        break
      }
      const first = remaining[0]
      phase = 'probing'
      report(normalized, first)
      tested += 1
      attempts += 1
      let probe: string
      try {
        probe = await session.probeAuthenticate(first * 4, key, keyType)
      } catch (error) {
        // 一次异常不算「这把密钥不行」，记一笔继续往下试。
        probe = 'inconclusive'
      }
      if (probe === 'inconclusive') {
        inconclusive += 1
      }
      if (probe !== 'ok') {
        continue
      }
      unlock(first, normalized, keyType)
      // 这把密钥能打开第一个扇区，很可能是全卡通用：把剩下的扇区都扫一遍。
      phase = 'sweeping'
      for (const sector of remaining.slice(1)) {
        if (options.shouldStop?.()) {
          break
        }
        // 命中之后要把这把钥匙扫过其它扇区，这一段比试候选密钥慢，
        // 进度要报出来，不然界面看着像卡住了。
        report(`${normalized} → 扇区 ${sector}`, sector)
        attempts += 1
        let outcome: string
        try {
          outcome = await session.probeAuthenticate(sector * 4, key, keyType)
        } catch {
          outcome = 'inconclusive'
        }
        if (outcome === 'inconclusive') {
          inconclusive += 1
        }
        if (outcome !== 'ok') {
          continue
        }
        unlock(sector, normalized, keyType)
      }
    }
  }

  if (readSectors) {
    phase = 'reading'
    for (const sector of sectors) {
      if (!sector.unlocked || !sector.keyA) {
        continue
      }
      if (options.shouldStop?.()) {
        break
      }
      report('', sector.sector)
      const base = sector.sector * 4
      try {
        const data = await session.readBlocks([base, base + 1, base + 2], fromHex(sector.keyA), 'A')
        data.forEach((bytes, block) => {
          blocks[block] = bytes.slice()
        })
        publish()
      } catch (error) {
        sector.message = `认证通过但读取失败：${error instanceof Error ? error.message : String(error)}`
        publish()
      }
    }
  }

  for (const sector of sectors) {
    if (!sector.unlocked) {
      sector.message = '没找到能打开它的密钥'
    }
  }

  phase = 'done'
  report('', -1)
  publish()

  return {
    keys,
    sectors,
    blocks,
    tested,
    attempts,
    total,
    inconclusive,
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * 拿一把密钥去扫全卡，返回它能打开哪些扇区。
 *
 * 对应 pm3 的 `hf mf chk`。
 */
export async function checkKeyOnCard(
  session: MifareClassicSession,
  key: string,
  keyType: 'A' | 'B' = 'A',
  onProgress?: (progress: { sector: number; total: number }) => void,
  shouldStop?: () => boolean,
): Promise<number[]> {
  const bytes = fromHex(normalizeKey(key))
  const opened: number[] = []
  for (let sector = 0; sector < CLASSIC_SECTORS; sector += 1) {
    if (shouldStop?.()) {
      break
    }
    onProgress?.({ sector, total: CLASSIC_SECTORS })
    try {
      const probe = await session.probeAuthenticate(sector * 4, bytes, keyType)
      if (probe === 'ok') {
        opened.push(sector)
      }
    } catch {
      // 这次没定论，跳过这个扇区继续扫。
    }
  }
  return opened
}

/** dump 的离线分析结果。 */
export interface DumpAnalysis {
  /** 卡片布局。 */
  mad: MadInfo
  /** 每个扇区的访问权限。 */
  access: Array<{ sector: number; lines: string[]; valid: boolean }>
  /** 值块。 */
  valueBlocks: Array<{ block: number; value: number; address: number }>
}

/**
 * 离线分析一份 dump：卡片布局、各扇区访问权限、值块。
 *
 * 纯计算，不碰射频，所以任何时候都能跑。
 */
export function analyzeDump(dump: ClassicDump): DumpAnalysis {
  const uid = dump.uid ? fromHex(dump.uid) : undefined
  const access: DumpAnalysis['access'] = []
  for (let sector = 0; sector < CLASSIC_SECTORS; sector += 1) {
    const trailer = dump.blocks[sector * 4 + TRAILER_BLOCK]
    if (!trailer) {
      continue
    }
    const result = analyzeTrailerAccess(trailer)
    access.push({ sector, lines: describeAccess(result), valid: result.valid })
  }
  const valueBlocks: DumpAnalysis['valueBlocks'] = []
  dump.blocks.forEach((block, index) => {
    const value = detectValueBlock(block)
    if (value) {
      valueBlocks.push({ block: index, value: value.value, address: value.address })
    }
  })
  return {
    mad: analyzeMad([dump.blocks[0], dump.blocks[1], dump.blocks[2], dump.blocks[3]], uid),
    access,
    valueBlocks,
  }
}
