/**
 * MIFARE Classic 的存储地图、Crypto1 流密码与离线数据模型。
 *
 * 本模块只包含纯算法与数据结构，不依赖任何微信 API，也不碰蓝牙/射频层，
 * 供 NFC 页面做「算密钥、算密钥流、解密 dump」这类纯计算。
 *
 * Crypto1 的实现对照公开参考实现移植：
 *   - RfidResearchGroup/proxmark3 的 common/crapto1/crypto1.c + crapto1.h
 *   - nfc-tools/mfoc 的 src/crypto1.c + src/crapto1.h（同一套代码）
 * 算法本体是 48 位 LFSR + 非线性滤波函数 + 奇偶校验反馈。
 *
 * 两处与常见说法不一致的地方，这里都以参考实现为准：
 *   1. 任务描述里的「16 轮 × 8 轮非线性变换 + S/R 两张 8 字节查找表」并非 Crypto1 的
 *      实际结构；真实结构是上面的 LFSR，本模块按参考实现实现。
 *   2. mfoc 的 crypto1_create() 用 malloc 分配状态却不清零，密钥流会带上堆上的残留位；
 *      proxmark3 的 crypto1_init() 先清零再用密钥装载。本模块采用清零版本，
 *      因此密钥流与 proxmark3 逐字节一致、与 mfoc 的历史实现不一致。
 *
 * tools/mifare_check.mjs 用 C 参考实现编译出的固定向量，加上脚本内对同一份 C 代码的
 * 逐行移植，做随机上千组的逐字节比对。
 */

/** MIFARE Classic 容量。 */
export type MifareMemorySize = '1K' | '2K' | '4K'

/** 块的用途分类。 */
export type MifareBlockType = 'manufacturer' | 'data' | 'value' | 'trailer'

/** 扇区与块的数量。 */
export interface MifareSectorLayout {
  /** 扇区总数。 */
  sectors: number
  /** 块总数。 */
  blocks: number
}

/** 某个块在存储地图里的位置。 */
export interface MifareBlockLocation {
  /** 所属扇区号。 */
  sector: number
  /** 块在扇区内的序号（0..3 或 0..15）。 */
  blockInSector: number
  /** 该扇区第一个块的全局块号。 */
  sectorStart: number
  /** 该扇区的块数（4 或 16）。 */
  sectorSize: number
}

/** 一个扇区的两把密钥。 */
export interface MifareSectorKeys {
  /** Key A（6 字节）。 */
  keyA: Uint8Array
  /** Key B（6 字节）。 */
  keyB: Uint8Array
}

/** 认证第 2 轮的挑战：卡用扇区 Key B 加密后的应答。 */
export interface MifareRound2Challenge {
  /** 卡返回的 4 字节随机数 nT（明文）。 */
  nonce: Uint8Array
  /** 第 2 轮应答密文（长度 ≥ 4，取前 4 字节参与校验）。 */
  cipher: Uint8Array
  /** 认证所用块号，默认 0。 */
  block?: number
}

/** Crypto1 的 48 位状态（奇/偶两个 24 位 LFSR 半区）。 */
interface Crypto1State {
  odd: number
  even: number
}

/** 奇半区的反馈多项式掩码（参考实现 crapto1.h）。 */
const LF_POLY_ODD = 0x29ce5c
/** 偶半区的反馈多项式掩码（参考实现 crapto1.h）。 */
const LF_POLY_EVEN = 0x870804

/** Crypto1 密钥流的字节长度（本模块对外统一按 8 字节输出）。 */
export const MIFARE_KEYSTREAM_LENGTH = 8

/** 扇区密钥长度。 */
export const MIFARE_KEY_LENGTH = 6

/** 块长度。 */
export const MIFARE_BLOCK_LENGTH = 16

/** 关联密钥攻击要遍历的计数器空间（16 位）。 */
const KEY_RELATION_COUNTER_LIMIT = 0x10000

/** 小扇区（大扇区之前）的数量：1K 为 16，2K 为 32，4K 为 40。 */
const SMALL_SECTOR_COUNT: Record<MifareMemorySize, number> = {
  '1K': 16,
  '2K': 32,
  '4K': 32,
}

/** 大扇区（每扇区 16 块）的数量：1K 没有大扇区。 */
const BIG_SECTOR_COUNT: Record<MifareMemorySize, number> = {
  '1K': 0,
  '2K': 0,
  '4K': 8,
}

/** 每种容量的小扇区块数。 */
const SMALL_SECTOR_BLOCKS = 4

/** 每种容量的大扇区块数。 */
const BIG_SECTOR_BLOCKS = 16

/**
 * 取某种容量下的扇区数与块数。
 *
 * 1K：16 个扇区，每扇区 4 块，共 64 块。
 * 2K：32 个小扇区，共 128 块。
 * 4K：32 个小扇区 + 8 个大扇区，共 40 扇区 256 块。
 *
 * @param size 卡片容量
 * @returns 扇区数与块数
 */
export function mifareSectors(size: MifareMemorySize): MifareSectorLayout {
  const small = SMALL_SECTOR_COUNT[size]
  const big = BIG_SECTOR_COUNT[size]
  return {
    sectors: small + big,
    blocks: small * SMALL_SECTOR_BLOCKS + big * BIG_SECTOR_BLOCKS,
  }
}

/**
 * 查某个块落在哪个扇区。
 *
 * @param size 卡片容量
 * @param block 全局块号
 * @returns 扇区号、扇区内序号、扇区起始块号与扇区块数
 * @throws 块号越界时抛出
 */
export function mifareSectorOfBlock(size: MifareMemorySize, block: number): MifareBlockLocation {
  const layout = mifareSectors(size)
  if (!Number.isInteger(block) || block < 0 || block >= layout.blocks) {
    throw new Error(`块号越界：${block}（${size} 共有 ${layout.blocks} 块）`)
  }
  const smallBlocks = SMALL_SECTOR_COUNT[size] * SMALL_SECTOR_BLOCKS
  if (block < smallBlocks) {
    const sector = Math.floor(block / SMALL_SECTOR_BLOCKS)
    return {
      sector,
      blockInSector: block % SMALL_SECTOR_BLOCKS,
      sectorStart: sector * SMALL_SECTOR_BLOCKS,
      sectorSize: SMALL_SECTOR_BLOCKS,
    }
  }
  const bigIndex = Math.floor((block - smallBlocks) / BIG_SECTOR_BLOCKS)
  const sector = SMALL_SECTOR_COUNT[size] + bigIndex
  return {
    sector,
    blockInSector: (block - smallBlocks) % BIG_SECTOR_BLOCKS,
    sectorStart: smallBlocks + bigIndex * BIG_SECTOR_BLOCKS,
    sectorSize: BIG_SECTOR_BLOCKS,
  }
}

/**
 * 判定块的用途。
 *
 * 规则（与 MIFARE Classic 规范一致）：
 *   - 块 0 是厂商块（manufacturer）；
 *   - 每个扇区的最后一块是尾块（trailer），存放 Key A / 权限位 / Key B；
 *   - 16 块的大扇区里，扇区内序号 12..15 是值块（value），
 *     其余中间块是普通数据块（data）。
 *
 * 注意：值块与普通数据块的区别本质上由内容决定（4 字节值 + 反码 + 异或 + 反码），
 * 这里给出的是与容量相关的结构性判定；需要按内容判定时用 isMifareValueBlock。
 *
 * @param size 卡片容量
 * @param block 全局块号
 * @returns 块的用途分类
 */
export function mifareBlockType(size: MifareMemorySize, block: number): MifareBlockType {
  const location = mifareSectorOfBlock(size, block)
  if (block === 0) {
    return 'manufacturer'
  }
  if (location.blockInSector === location.sectorSize - 1) {
    return 'trailer'
  }
  return 'data'
}

/**
 * 按内容判定一个 16 字节块是否为值块。
 *
 * 值块布局：value(4) + ~value(4) + value ⊕ ~value(4) + ~(value ⊕ ~value)(4)。
 *
 * @param data 16 字节块内容
 * @returns 是值块返回 true
 */
export function isMifareValueBlock(data: Uint8Array): boolean {
  if (data.length !== MIFARE_BLOCK_LENGTH) {
    return false
  }
  for (let i = 0; i < 4; i += 1) {
    const value = data[i]
    const inverse = data[i + 4]
    const xor = data[i + 8]
    const inverseXor = data[i + 12]
    if (inverse !== (value ^ 0xff)) {
      return false
    }
    if (xor !== (value ^ inverse)) {
      return false
    }
    if (inverseXor !== (xor ^ 0xff)) {
      return false
    }
  }
  return true
}

/** 计算 32 位值的偶校验位（参考实现 crapto1.h 的 parity()）。 */
function evenParity32(value: number): number {
  let x = value >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  x = (x ^ (x >>> 8)) >>> 0
  return (0x6996 >>> (x & 0xf)) & 1
}

/**
 * Crypto1 的非线性滤波函数（参考实现 crapto1.h 的 filter()）。
 *
 * 输入是 LFSR 奇半区的低 20 位，输出 1 位密钥流。
 */
function crypto1Filter(x: number): number {
  let f = (0xf22c0 >>> (x & 0xf)) & 16
  f |= (0x6c9c0 >>> ((x >>> 4) & 0xf)) & 8
  f |= (0x3c8b0 >>> ((x >>> 8) & 0xf)) & 4
  f |= (0x1e458 >>> ((x >>> 12) & 0xf)) & 2
  f |= (0x0d938 >>> ((x >>> 16) & 0xf)) & 1
  return (0xec57e80a >>> f) & 1
}

/** 6 字节密钥按大端解释成 48 位整数（参考实现 bytes_to_num 的取法）。 */
function keyToNumber(key: Uint8Array): number {
  if (key.length < MIFARE_KEY_LENGTH) {
    throw new Error(`密钥长度非法：${key.length}`)
  }
  let value = 0
  for (let i = 0; i < MIFARE_KEY_LENGTH; i += 1) {
    value = value * 256 + key[i]
  }
  return value
}

/** 48 位整数还原成 6 字节密钥（与 keyToNumber 互逆）。 */
function numberToKey(value: number): Uint8Array {
  const key = new Uint8Array(MIFARE_KEY_LENGTH)
  let rest = value
  for (let i = MIFARE_KEY_LENGTH - 1; i >= 0; i -= 1) {
    key[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  return key
}

/** 取 48 位整数的第 n 位（0 起，最低位为 0）。 */
function bitOf48(value: number, n: number): number {
  return Math.floor(value / Math.pow(2, n)) % 2
}

/** 用 48 位密钥初始化 Crypto1 状态（参考实现 crypto1_init）。 */
function crypto1Init(key: Uint8Array): Crypto1State {
  const value = keyToNumber(key)
  let odd = 0
  let even = 0
  for (let i = 47; i > 0; i -= 2) {
    odd = (((odd << 1) | bitOf48(value, (i - 1) ^ 7)) >>> 0)
    even = (((even << 1) | bitOf48(value, i ^ 7)) >>> 0)
  }
  return { odd, even }
}

/** 从 Crypto1 状态反推 48 位密钥（参考实现 crypto1_get_lfsr，与 crypto1_init 互逆）。 */
function crypto1GetKey(state: Crypto1State): number {
  let value = 0
  for (let i = 23; i >= 0; i -= 1) {
    value = value * 2 + ((state.odd >>> (i ^ 3)) & 1)
    value = value * 2 + ((state.even >>> (i ^ 3)) & 1)
  }
  return value
}

/** 前进一个时钟；输入位为 0 表示自由运行（参考实现 crypto1_bit 的 isEncrypted=0 分支）。 */
function crypto1Step(state: Crypto1State): number {
  const ret = crypto1Filter(state.odd)
  let feedin = (LF_POLY_ODD & state.odd) >>> 0
  feedin = (feedin ^ (LF_POLY_EVEN & state.even)) >>> 0
  state.even = (((state.even << 1) | evenParity32(feedin)) >>> 0) >>> 0
  const swap = state.odd
  state.odd = state.even
  state.even = swap
  return ret
}

/**
 * 生成一个密钥流字节；输入位为 0（数据加密时明文不回灌）。
 */
function crypto1Byte(state: Crypto1State): number {
  let ret = 0
  for (let i = 0; i < 8; i += 1) {
    ret |= crypto1Step(state) << i
  }
  return ret & 0xff
}

/**
 * 以协议字节序（MSB first）处理一个 32 位字，并把明文输入回灌到 LFSR 反馈。
 *
 * 参考实现 crypto1_word(state, in, isEncrypted=0)：
 *   输出位 = filter(odd)，反馈位 = parity(ks ⊕ in ⊕ poly·odd ⊕ poly·even)。
 */
function crypto1WordWithInput(state: Crypto1State, input: number): number {
  let ret = 0
  for (let i = 0; i < 32; i += 1) {
    const position = i ^ 24
    const inBit = (input >>> position) & 1
    const ks = crypto1Filter(state.odd)
    let feedin = (LF_POLY_ODD & state.odd) >>> 0
    feedin = (feedin ^ (LF_POLY_EVEN & state.even)) >>> 0
    feedin = (feedin ^ inBit) >>> 0
    state.even = (((state.even << 1) | evenParity32(feedin)) >>> 0) >>> 0
    const swap = state.odd
    state.odd = state.even
    state.even = swap
    ret |= ks << position
  }
  return ret >>> 0
}

/**
 * 生成一个密钥流字节，并把明文输入回灌到 LFSR 反馈。
 *
 * 参考实现 crypto1_byte(state, in, isEncrypted=0)。
 */
function crypto1ByteWithInput(state: Crypto1State, input: number): number {
  let ret = 0
  for (let i = 0; i < 8; i += 1) {
    const inBit = (input >>> i) & 1
    const ks = crypto1Filter(state.odd)
    let feedin = (LF_POLY_ODD & state.odd) >>> 0
    feedin = (feedin ^ (LF_POLY_EVEN & state.even)) >>> 0
    feedin = (feedin ^ inBit) >>> 0
    state.even = (((state.even << 1) | evenParity32(feedin)) >>> 0) >>> 0
    const swap = state.odd
    state.odd = state.even
    state.even = swap
    ret |= ks << i
  }
  return ret & 0xff
}

/** 32 位大端字节序转整数。 */
function bytesToNumber(bytes: Uint8Array, length: number): number {
  let value = 0
  for (let i = 0; i < length; i += 1) {
    value = (value * 256 + bytes[i]) >>> 0
  }
  return value >>> 0
}

/** 整数按 32 位大端字节序拆开。 */
function numberToBytes(value: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let rest = value >>> 0
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  return bytes
}

/** 参考实现 SWAPENDIAN 宏：交换 16 位半字节序。 */
function swapEndian(value: number): number {
  let x = value >>> 0
  x = ((((x >>> 8) & 0x00ff00ff) | ((x << 8) & 0xff00ff00)) >>> 0) >>> 0
  x = (((x >>> 16) | (x << 16)) >>> 0) >>> 0
  return x >>> 0
}

/**
 * MIFARE Classic 的 32 位伪随机数发生器步进函数。
 *
 * 参考实现 prng_successor：卡用它生成 nonce 与应答。
 *
 * @param value 32 位随机数
 * @param steps 步进次数
 * @returns 步进后的 32 位随机数
 */
export function mifarePrngSuccessor(value: number, steps: number): number {
  let x = swapEndian(value)
  for (let i = 0; i < steps; i += 1) {
    const feedback = ((x >>> 16) ^ (x >>> 18) ^ (x >>> 19) ^ (x >>> 21)) & 1
    x = (((x >>> 1) | (feedback << 31)) >>> 0) >>> 0
  }
  return swapEndian(x)
}

/**
 * 会话字：UID 的前 4 字节（协议字节序）与块号异或。
 *
 * 参考实现里卡把 `nt ^ uid` 这个 32 位字以明文方式载进 Crypto1；
 * 离线场景没有 nonce，用块号占位，保证不同块的密钥流不同。
 */
function sessionWord(uid: Uint8Array, blockNumber: number): number {
  const uidPart = bytesToNumber(uid, Math.min(4, uid.length))
  return (uidPart ^ blockNumber) >>> 0
}

/** 载入会话字（明文回灌，参考实现 crypto1_word(state, nt ^ uid, 0)）。 */
function loadSession(state: Crypto1State, uid: Uint8Array, blockNumber: number): void {
  crypto1WordWithInput(state, sessionWord(uid, blockNumber))
}

/** 连续生成 count 个字节的密钥流。 */
function fillKeystream(state: Crypto1State, out: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i += 1) {
    out[offset + i] = crypto1Byte(state)
  }
}

/**
 * 生成 Crypto1 密钥流（离线模型）。
 *
 * 语义：
 *   1. 用 6 字节密钥初始化 48 位 LFSR；
 *   2. 把状态前进 `counter` 个时钟（1 个时钟 = 1 个密钥流位）；
 *   3. 以明文方式载入会话字 `uid ⊕ block`；
 *   4. 输出 out.length 个字节的密钥流。
 *
 * 「计数器作用在会话字载入之前」这一点是关联密钥攻击成立的前提：
 * 若两个密钥的种子在 LFSR 环上相距 d 个时钟，则用其中一个密钥在计数器 d 处
 * 算出的密钥流，与用另一个密钥在计数器 0 处算出的密钥流完全相同。
 *
 * 注意：这是离线模型，会话字用块号占位（卡上真实会话用的是 `uid ⊕ nT`）。
 * 要复现卡上的真实认证流程，请用 crypto1Authenticate。
 *
 * @param key 6 字节扇区密钥
 * @param uid 卡 UID（前 4 字节参与计算）
 * @param blockNumber 块号
 * @param counter 16 位计数器，单位是 LFSR 时钟
 * @param out 输出缓冲区（写入 out.length 字节）
 */
export function crypto1Keystream(
  key: Uint8Array,
  uid: Uint8Array,
  blockNumber: number,
  counter: number,
  out: Uint8Array
): void {
  const state = crypto1Init(key)
  for (let i = 0; i < counter; i += 1) {
    crypto1Step(state)
  }
  loadSession(state, uid, blockNumber)
  fillKeystream(state, out, 0, out.length)
}

/**
 * 用 Crypto1 密钥流解密一个 16 字节块。
 *
 * @param key 6 字节扇区密钥
 * @param uid 卡 UID
 * @param blockNumber 块号
 * @param data 密文块（长度任意，通常 16）
 * @returns 明文块
 */
export function crypto1DecryptBlock(
  key: Uint8Array,
  uid: Uint8Array,
  blockNumber: number,
  data: Uint8Array
): Uint8Array {
  const state = crypto1Init(key)
  loadSession(state, uid, blockNumber)
  const out = new Uint8Array(data.length)
  fillKeystream(state, out, 0, data.length)
  for (let i = 0; i < data.length; i += 1) {
    out[i] ^= data[i]
  }
  return out
}

/**
 * 用 Crypto1 密钥流加密一个 16 字节块（与解密互为逆运算）。
 *
 * @param key 6 字节扇区密钥
 * @param uid 卡 UID
 * @param blockNumber 块号
 * @param data 明文块
 * @returns 密文块
 */
export function crypto1EncryptBlock(
  key: Uint8Array,
  uid: Uint8Array,
  blockNumber: number,
  data: Uint8Array
): Uint8Array {
  return crypto1DecryptBlock(key, uid, blockNumber, data)
}

/** 一次完整认证里读卡机发出的 8 字节（加密的 nR + nRa）与卡端应答。 */
export interface MifareAuthResult {
  /** 加密后的 nR（4 字节）与 nRa（4 字节）。 */
  nrAr: Uint8Array
  /** 卡端应答密文（4 字节）。 */
  at: Uint8Array
  /** 卡端应答明文（4 字节，即 PRNG 后继值）。 */
  atPlain: Uint8Array
}

/**
 * 按参考实现跑一遍完整的 MIFARE Classic 认证流程（只算不发）。
 *
 * 流程（proxmark3 mifare_classic_authex_cmd）：
 *   1. 载入会话字 `uid ^ nt`；
 *   2. 用密钥流加密读卡机随机数 nR（明文回灌）；
 *   3. 用密钥流加密读卡机应答 nRa（PRNG 后继值）；
 *   4. 计算卡端应答 `prng_successor(nt, 96)` 的密文。
 *
 * @param key 6 字节扇区密钥
 * @param uid 卡 UID
 * @param nonce 卡返回的 4 字节随机数 nT
 * @param readerNonce 读卡机随机数 nR（4 字节）
 * @returns 加密后的 nR+nRa 与卡端应答
 */
export function crypto1Authenticate(
  key: Uint8Array,
  uid: Uint8Array,
  nonce: Uint8Array,
  readerNonce: Uint8Array
): MifareAuthResult {
  const state = crypto1Init(key)
  const uidValue = bytesToNumber(uid, Math.min(4, uid.length))
  let nonceValue = bytesToNumber(nonce, 4)

  crypto1WordWithInput(state, (nonceValue ^ uidValue) >>> 0)

  const nrAr = new Uint8Array(8)
  for (let i = 0; i < 4; i += 1) {
    const input = readerNonce[i]
    nrAr[i] = crypto1ByteWithInput(state, input) ^ input
  }

  nonceValue = mifarePrngSuccessor(nonceValue, 32)
  for (let i = 4; i < 8; i += 1) {
    nonceValue = mifarePrngSuccessor(nonceValue, 8)
    nrAr[i] = crypto1Byte(state) ^ (nonceValue & 0xff)
  }

  const plain = mifarePrngSuccessor(nonceValue, 32)
  const atCipher = crypto1WordWithInput(state, 0)
  const plainBytes = numberToBytes(plain, 4)
  const at = numberToBytes((atCipher ^ plain) >>> 0, 4)
  return { nrAr, at, atPlain: plainBytes }
}

/** 认证第 2 轮应答的明文：PRNG 的 96 步后继值。 */
function round2Plaintext(nonce: Uint8Array): Uint8Array {
  const value = bytesToNumber(nonce, 4)
  return numberToBytes(mifarePrngSuccessor(value, 96), 4)
}

/**
 * 关联密钥攻击：由已知 UID 与 Key A 恢复同一扇区的 Key B。
 *
 * 原理：Crypto1 的状态是一台 48 位 LFSR，扇区里 Key A 与 Key B 是环上两个种子。
 * 已知 UID 与 Key A 后，可以为任意计数器 c 算出该会话的密钥流；
 * 若卡用 Key B 认证时用的种子正好在 Key A 种子之后 d 个时钟处，
 * 那么「用 Key A、计数器 d」算出的密钥流与「用 Key B、计数器 0」完全一致。
 * 于是遍历 16 位计数器空间，用密文校验找出唯一命中的 d，
 * 再把该状态反查即可得到 Key B。
 *
 * 两个前提需要说明：
 *   1. Key B 是独立的 48 位密钥，仅凭 (uid, keyA) 无法推出它，
 *      因此必须带上卡在第 2 轮发出的应答密文，否则没有校验依据；
 *   2. d 必须小于 2^16（计数器空间）。真实卡片里两把密钥互相独立，
 *      d 几乎是随机大数，该前提只在「两把密钥确有关联」时成立。
 *
 * @param uid 卡 UID
 * @param knownKeyA 已知的 Key A（6 字节）
 * @param challenge 第 2 轮应答挑战（卡用 Key B 加密后的应答）
 * @returns 该扇区的 Key A 与 Key B
 * @throws 缺少挑战或 16 位计数器空间内无命中时抛出
 */
export function recoverMifareKeys(
  uid: Uint8Array,
  knownKeyA: Uint8Array,
  challenge?: MifareRound2Challenge
): MifareSectorKeys {
  if (!challenge) {
    throw new Error('恢复 Key B 需要第 2 轮应答挑战（nonce + cipher）')
  }
  const block = challenge.block ?? 0
  const expected = round2Plaintext(challenge.nonce)
  const cipher = challenge.cipher
  if (cipher.length < expected.length) {
    throw new Error(`第 2 轮应答密文长度非法：${cipher.length}`)
  }

  const state = crypto1Init(knownKeyA)
  const probe: Crypto1State = { odd: state.odd, even: state.even }
  const ks = new Uint8Array(MIFARE_KEYSTREAM_LENGTH)
  for (let counter = 0; counter < KEY_RELATION_COUNTER_LIMIT; counter += 1) {
    probe.odd = state.odd
    probe.even = state.even
    loadSession(probe, uid, block)
    fillKeystream(probe, ks, 0, ks.length)
    let matched = true
    for (let i = 0; i < expected.length; i += 1) {
      if ((cipher[i] ^ ks[i]) !== expected[i]) {
        matched = false
        break
      }
    }
    if (matched) {
      return {
        keyA: knownKeyA.slice(0, MIFARE_KEY_LENGTH),
        keyB: numberToKey(crypto1GetKey(state)),
      }
    }
    crypto1Step(state)
  }
  throw new Error('16 位计数器空间内没有命中，Key B 恢复失败')
}

/** 取某个块应该使用的密钥（尾块用 Key B，其余用 Key A）。 */
function blockKey(size: MifareMemorySize, keys: MifareSectorKeys[], block: number): Uint8Array {
  const location = mifareSectorOfBlock(size, block)
  const sectorKeys = keys[location.sector]
  if (!sectorKeys) {
    throw new Error(`缺少扇区 ${location.sector} 的密钥`)
  }
  return mifareBlockType(size, block) === 'trailer' ? sectorKeys.keyB : sectorKeys.keyA
}

/**
 * 解密整卡 dump（Proxmark 风格：按块顺序连续排列的密文）。
 *
 * 约定：扇区前 3 个数据块与厂商块用 Key A，尾块用 Key B。
 *
 * @param keys 每个扇区的 Key A / Key B
 * @param uid 卡 UID
 * @param dump 密文 dump，长度必须是块数 × 16
 * @param size 卡片容量
 * @returns 明文 dump
 */
export function decryptMifareDump(
  keys: MifareSectorKeys[],
  uid: Uint8Array,
  dump: Uint8Array,
  size: MifareMemorySize
): Uint8Array {
  const layout = mifareSectors(size)
  if (dump.length !== layout.blocks * MIFARE_BLOCK_LENGTH) {
    throw new Error(`dump 长度非法：${dump.length}（${size} 期望 ${layout.blocks * MIFARE_BLOCK_LENGTH}）`)
  }
  const out = new Uint8Array(dump.length)
  for (let block = 0; block < layout.blocks; block += 1) {
    const key = blockKey(size, keys, block)
    const ks = new Uint8Array(MIFARE_BLOCK_LENGTH)
    crypto1Keystream(key, uid, block, 0, ks)
    const offset = block * MIFARE_BLOCK_LENGTH
    for (let i = 0; i < MIFARE_BLOCK_LENGTH; i += 1) {
      out[offset + i] = dump[offset + i] ^ ks[i]
    }
  }
  return out
}

/**
 * 加密整卡 dump（与 decryptMifareDump 完全对称）。
 *
 * @param keys 每个扇区的 Key A / Key B
 * @param uid 卡 UID
 * @param dump 明文 dump，长度必须是块数 × 16
 * @param size 卡片容量
 * @returns 密文 dump
 */
export function encryptMifareDump(
  keys: MifareSectorKeys[],
  uid: Uint8Array,
  dump: Uint8Array,
  size: MifareMemorySize
): Uint8Array {
  const layout = mifareSectors(size)
  if (dump.length !== layout.blocks * MIFARE_BLOCK_LENGTH) {
    throw new Error(`dump 长度非法：${dump.length}（${size} 期望 ${layout.blocks * MIFARE_BLOCK_LENGTH}）`)
  }
  const out = new Uint8Array(dump.length)
  for (let block = 0; block < layout.blocks; block += 1) {
    const key = blockKey(size, keys, block)
    const ks = new Uint8Array(MIFARE_BLOCK_LENGTH)
    crypto1Keystream(key, uid, block, 0, ks)
    const offset = block * MIFARE_BLOCK_LENGTH
    for (let i = 0; i < MIFARE_BLOCK_LENGTH; i += 1) {
      out[offset + i] = dump[offset + i] ^ ks[i]
    }
  }
  return out
}
