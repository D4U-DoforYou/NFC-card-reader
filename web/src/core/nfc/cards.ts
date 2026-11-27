/**
 * 卡片识别：把 ATQA / SAK / ATS 解码成「协议族 + 卡片型号 + 技术参数」。
 *
 * 识别思路与 nfc.software（NFC Tools）一致：先看协议，再看型号，最后给参数。
 * ATQA 的厂商私有位只能作参考，真正定型号的是 SAK 的协议位，
 * 所以这里把每条判断依据都记下来，界面上可以显示「为什么判成这张卡」。
 */

/** 卡片协议族。 */
export type CardProtocol = 'iso14443a' | 'iso14443b' | 'felica' | 'iso15693' | 'unknown'

/** 协议族中文名。 */
export const PROTOCOL_NAMES: Record<CardProtocol, string> = {
  iso14443a: 'ISO-14443A（Type A）',
  iso14443b: 'ISO-14443B（Type B）',
  felica: 'FeliCa（Type F）',
  iso15693: 'ISO-15693（Type V）',
  unknown: '未识别',
}

/** UID 形态。 */
export type UidKind = 'single' | 'double' | 'triple' | 'random' | 'unknown'

/** UID 形态中文名。 */
export const UID_KIND_NAMES: Record<UidKind, string> = {
  single: '单尺寸 UID（4 字节）',
  double: '双尺寸 UID（7 字节）',
  triple: '三尺寸 UID（10 字节）',
  random: '随机 UID（4 字节）',
  unknown: '未知',
}

/** 识别结果。 */
export interface CardIdentification {
  protocol: CardProtocol
  protocolName: string
  /** 型号标识，未识别时为 unknown。 */
  modelId: string
  modelName: string
  /** 厂商。 */
  vendor: string
  /** 容量描述（能判定时）。 */
  capacity: string
  /** 判断依据，逐条展示。 */
  evidence: string[]
  uid: string
  uidKind: UidKind
  uidKindName: string
  atqa: string
  sak: string
  ats: string
  /** 是否支持 ISO-DEP。 */
  isoDep: boolean
  /** SAK 协议位说明。 */
  sakFlags: string[]
  /** ISO-DEP 帧尺寸（FSC）。 */
  fsc: number
  /** ISO-DEP 帧等待时间（毫秒）。 */
  fwtMs: number
  /** 是否支持 CID。 */
  cidSupported: boolean
  /** 给用户的下一步提示。 */
  hint: string
}

/** ATQA 解码结果。 */
export interface AtqaInfo {
  /** 协议族。 */
  protocol: CardProtocol
  /** UID 形态（由 ATQA 的反冲突位决定）。 */
  uidKind: UidKind
  /** 厂商私有字节（ATQA 第二字节）。 */
  proprietary: number
  /** 型号候选。 */
  candidates: string[]
}

/**
 * 常见 ATQA 对应的卡片（整表按 ATQA 两字节查）。
 *
 * ATQA 两个字节合起来才有区分度：单看私有字节的话
 * NTAG（00 44）和 MIFARE Classic 1K（00 04）的低 6 位是一样的。
 */
const ATQA_TABLE: Record<string, string> = {
  '0002': 'MIFARE Classic 4K',
  '0004': 'MIFARE Classic 1K',
  '0044': 'MIFARE Ultralight / NTAG',
  '0200': 'MIFARE DESFire / MIFARE Plus',
  '0344': 'MIFARE DESFire EV1',
  '0400': 'ISO-14443A 通用卡（私有位 0x00）',
  '4400': 'MIFARE Ultralight / NTAG',
  '1200': '厂商私有标签',
}

/** ATQA is returned in RF byte order (low byte first). Its UID size bits
 * describe cascade size; actual UID length is authoritative after selection.
 */
export function decodeAtqa(atqa: Uint8Array): AtqaInfo {
  if (atqa.length < 2) {
    return { protocol: 'unknown', uidKind: 'unknown', proprietary: 0, candidates: [] }
  }
  // RF order is low byte first; also tolerate legacy high-byte-first input.
  const low = atqa[0] === 0 ? atqa[1] : atqa[0]
  const high = atqa[0] === 0 ? atqa[0] : atqa[1]
  const uidKind: UidKind = (low & 0xc0) === 0x80 ? 'triple' : (low & 0xc0) === 0x40 ? 'double' : (low & 0xc0) === 0 ? 'single' : 'unknown'
  const proprietary = high
  const key = `${high.toString(16).padStart(2, '0').toUpperCase()}${low.toString(16).padStart(2, '0').toUpperCase()}`
  const candidates: string[] = []
  const known = ATQA_TABLE[key]
  if (known) {
    candidates.push(known)
  }
  return { protocol: 'iso14443a', uidKind, proprietary, candidates }
}

/** SAK 解码结果。 */
export interface SakInfo {
  /** SAK 各位的含义。 */
  flags: string[]
  /** 协议位。 */
  isoDep: boolean
  /** 型号标识。 */
  modelId: string
  modelName: string
  vendor: string
  /** 是否还有后续级联（UID 未取全）。 */
  cascade: boolean
}

/** SAK reports cascade and ISO-DEP capabilities; it is not a unique product ID.
 * Reference: NXP AN10833. In particular SAK=00 is valid, and 18 is Classic 4K.
 */
export function decodeSak(sak: number): SakInfo {
  const flags: string[] = []
  const cascade = (sak & 0x04) !== 0
  if (cascade) flags.push('bit2 UID 未完整，需继续级联选卡')
  const isoDep = (sak & 0x20) !== 0
  if (isoDep) flags.push('bit5 支持 ISO-DEP')
  if (sak & 0x40) flags.push('bit6 支持 ISO/IEC 18092（不等于已识别 FeliCa）')
  let modelId = 'unknown'
  let modelName = 'ISO-14443A 通用卡（型号待确认）'
  let vendor = '未知'
  if (sak === 0) {
    modelName = 'ISO-14443A 非 ISO-DEP 卡（可检查 Type 2）'
    flags.push('SAK=0x00：已完成选卡，不支持 ISO-DEP')
  } else if ([0x08, 0x09, 0x0b, 0x18, 0x19].includes(sak)) {
    modelId = 'mifare-classic'
    modelName = 'MIFARE Classic 兼容卡'
    vendor = '待确认'
  } else if ([0x10, 0x11].includes(sak)) {
    modelId = 'mifare-plus'
    modelName = 'MIFARE Plus 候选'
  } else if (isoDep) {
    modelId = 'iso-dep'
    modelName = 'ISO-DEP 通用卡片'
  }
  return { flags, isoDep, modelId, modelName, vendor, cascade }
}

/** ATS 解码结果。 */
export interface AtsInfo {
  /** 帧尺寸。 */
  fsc: number
  /** 帧等待时间（毫秒）。 */
  fwtMs: number
  /** 是否支持 CID。 */
  cidSupported: boolean
  /** 是否支持 ISO-14443-4（ISO-DEP）。 */
  isoDep: boolean
  /** 历史字节。 */
  historical: string
  /** 各接口字节的说明。 */
  notes: string[]
}

const FSC_TABLE = [16, 24, 32, 40, 48, 64, 96, 128, 256]

/**
 * ATS（Answer To Select）解码。
 *
 * TL 是 ATS 的总长度，T0 的低 4 位是 FSCI，
 * T0 的 bit4/5/6 表示后面有无 TA/TB/TC。
 */
export function decodeAts(ats: Uint8Array): AtsInfo {
  const result: AtsInfo = {
    fsc: 0,
    fwtMs: 0,
    cidSupported: false,
    isoDep: false,
    historical: '',
    notes: [],
  }
  if (ats.length < 2) {
    return result
  }
  const t0 = ats[1]
  const fsci = t0 & 0x0f
  result.fsc = fsci < FSC_TABLE.length ? FSC_TABLE[fsci] : 0
  let offset = 2
  let tb: number | null = null
  let tc: number | null = null
  if (t0 & 0x10) {
    offset += 1
  }
  if (t0 & 0x20) {
    if (offset < ats.length) {
      tb = ats[offset]
      offset += 1
    }
  }
  if (t0 & 0x40) {
    if (offset < ats.length) {
      tc = ats[offset]
      offset += 1
    }
  }
  const fwi = tb !== null ? tb >> 4 : 4
  result.fwtMs = (4096 / 13560000) * Math.pow(2, fwi) * 1000
  result.cidSupported = tc !== null && (tc & 0x02) !== 0
  result.isoDep = true
  if (offset < ats.length) {
    result.historical = Array.from(ats.slice(offset))
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')
  }
  result.notes.push(`FSCI=${fsci} → 帧尺寸 ${result.fsc} 字节`)
  result.notes.push(`FWI=${fwi} → 帧等待 ${result.fwtMs.toFixed(1)}ms`)
  result.notes.push(result.cidSupported ? '支持 CID（卡号标识）' : '不支持 CID')
  return result
}

/** 识别输入。 */
export interface IdentifyInput {
  uid: Uint8Array
  sak: number
  atqa: Uint8Array
  ats?: Uint8Array
  /** 协议族，探测得出。 */
  protocol?: CardProtocol
  /**
   * 唤醒帧：0x7A 是华为墨水屏标签专用，0x26 是标准 REQA。
   *
   * 型号判定要用到它：墨水屏标签只应答 0x7A，
   * 而 ATQA 04 00 是 ISO-14443A 的通用应答，不能拿来当墨水屏标签的判据。
   */
  wakeFrame?: number
}

function hexBytes(data: Uint8Array): string {
  return Array.from(data)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

/** 型号判定的一条规则。 */
interface ModelRule {
  match: (atqa: Uint8Array, sak: number, wakeFrame: number) => boolean
  id: string
  name: string
  vendor: string
  capacity: string
  note: string
}

/** 华为墨水屏标签的专用唤醒帧。 */
export const WAKE_FRAME_HUAWEI = 0x7a
/** 标准 NFC-A REQA。 */
export const WAKE_FRAME_REQA = 0x26

/**
 * 型号判定规则表。
 *
 * 同一个 SAK 可能对应好几张卡（SAK 0x20 只是「符合 ISO-DEP」），
 * 所以要把 ATQA 一起看，规则按特异性从高到低排列，命中第一条就算。
 */
const MODEL_RULES: ModelRule[] = [
  {
    // 华为墨水屏标签：只有唤醒帧 0x7A 才会应答，标准 REQA(0x26) 不理它。
    // 判据必须是唤醒帧而不是 ATQA——ATQA 04 00 是 ISO-14443A 的通用应答，
    // 拿它当判据会把普通卡全认成墨水屏标签。
    match: (atqa, _sak, wakeFrame) =>
      wakeFrame === WAKE_FRAME_HUAWEI && atqa.length >= 2 && atqa[0] === 0x04 && atqa[1] === 0x00,
    id: 'epaper-tag',
    name: '墨水屏标签（华为）',
    vendor: '华为',
    capacity: '墨水屏标签',
    note: '只应答华为专用唤醒帧 0x7A，是本项目支持的墨水屏标签',
  },
  {
    match: (_atqa, sak) =>
      (sak & 0x08) !== 0 && (sak & 0x20) === 0 && (sak & 0x10) === 0,
    id: 'mifare-classic',
    name: 'MIFARE Classic 兼容卡',
    vendor: '待确认',
    capacity: '容量待确认',
    note: 'SAK 带 MIFARE Classic 位且不满足 ISO-DEP',
  },
  {
    // NTAG / Ultralight：ATQA 00 44，SAK 0x00（卡片不报告协议能力）
    match: (atqa, sak) =>
      sak === 0x00 && atqa.length >= 2 && ((atqa[0] === 0x00 && atqa[1] === 0x44) || (atqa[0] === 0x44 && atqa[1] === 0x00)),
    id: 'ultralight',
    name: 'MIFARE Ultralight / NTAG',
    vendor: 'NXP',
    capacity: '144 ~ 888 字节',
    note: 'ATQA 00 44 且 SAK 0x00，是 NTAG 系列的典型特征',
  },
]

/**
 * 综合 ATQA / SAK / ATS，得出卡片识别结果。
 */
export function identifyCard(input: IdentifyInput): CardIdentification {
  const evidence: string[] = []
  const atqa = decodeAtqa(input.atqa)
  const sak = decodeSak(input.sak)
  const atsInfo = decodeAts(input.ats ?? new Uint8Array(0))
  // Protocol comes from polling, never inferred from private SAK product bits.
  const protocol = input.protocol ?? atqa.protocol

  evidence.push(`ATQA ${hexBytes(input.atqa)}：${UID_KIND_NAMES[atqa.uidKind]}`)
  if (atqa.candidates.length) {
    evidence.push(`ATQA 私有字节 0x${atqa.proprietary.toString(16).padStart(2, '0').toUpperCase()} 指向 ${atqa.candidates.join('、')}`)
  }
  evidence.push(`SAK 0x${input.sak.toString(16).padStart(2, '0').toUpperCase()}：${sak.flags.length ? sak.flags.join('，') : '无协议位'}`)

  // 规则表命中
  let modelId = sak.modelId
  let modelName = sak.modelName
  let vendor = sak.vendor
  let capacity = '未知'
  let matched: ModelRule | null = null
  const wakeFrame = input.wakeFrame ?? WAKE_FRAME_REQA
  for (const rule of MODEL_RULES) {
    if (rule.match(input.atqa, input.sak, wakeFrame)) {
      matched = rule
      break
    }
  }
  if (matched) {
    modelId = matched.id
    modelName = matched.name
    vendor = matched.vendor
    capacity = matched.capacity
    evidence.push(`型号判定：${matched.note}`)
  } else if (sak.isoDep) {
    modelId = 'iso-dep'
    modelName = 'ISO-DEP 通用卡片'
    vendor = '未知'
    capacity = '需查文件系统'
    evidence.push('SAK 只表明符合 ISO-DEP，具体型号需读文件系统确认')
  } else {
    capacity = '未知'
    evidence.push('ATQA/SAK 组合没有匹配到已知型号')
  }
  if (modelId === 'mifare-classic') {
    capacity = [0x18, 0x19].includes(input.sak) ? '4KB' : input.sak === 0x09 ? '320 字节' : '1KB'
  }
  const uidKind: UidKind = input.uid.length === 4 ? (input.uid[0] === 0x08 ? 'random' : 'single')
    : input.uid.length === 7 ? 'double' : input.uid.length === 10 ? 'triple' : 'unknown'


  if (atsInfo.notes.length) {
    evidence.push(`ATS：${atsInfo.notes.join('，')}`)
  }
  if (atsInfo.historical) {
    evidence.push(`历史字节 ${atsInfo.historical}`)
  }

  let hint = ''
  if (modelId === 'mifare-classic') {
    hint = '可在「存储」页按扇区查看分区并读取数据块'
  } else if (modelId === 'ultralight' || input.sak === 0) {
    hint = '已完成 Type A 选卡；可在「存储」页检查 Type 2 能力容器、分页与 NDEF'
  } else if (modelId === 'iso-dep' || modelId === 'mifare-desfire' || modelId === 'epaper-tag') {
    hint = '可在「存储」页浏览文件列表并读出内容'
  } else if (sak.isoDep) {
    hint = '支持 ISO-DEP，可用 APDU 与卡片交互'
  } else {
    hint = '可到「原始」页手动收发射频帧或 APDU'
  }

  return {
    protocol,
    protocolName: PROTOCOL_NAMES[protocol],
    modelId,
    modelName,
    vendor,
    capacity,
    evidence,
    uid: hexBytes(input.uid),
    uidKind,
    uidKindName: UID_KIND_NAMES[uidKind],
    atqa: hexBytes(input.atqa),
    sak: `0x${input.sak.toString(16).padStart(2, '0').toUpperCase()}`,
    ats: input.ats && input.ats.length ? hexBytes(input.ats) : '无 ATS（非 ISO-DEP）',
    isoDep: sak.isoDep,
    sakFlags: sak.flags,
    fsc: atsInfo.fsc,
    fwtMs: atsInfo.fwtMs,
    cidSupported: atsInfo.cidSupported,
    hint,
  }
}
