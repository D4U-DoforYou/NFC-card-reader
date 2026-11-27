/**
 * 协议探测：判断卡片用的是哪一套射频协议。
 *
 * Type A、Type B、FeliCa、Type V 的调制方式、唤醒帧与应答格式都不一样。
 * A01 固件提供了 CLRC663 的 19 组收发预设，所以每种协议都用**自己的模式**去问，
 * 而不是像旧固件那样所有协议都按 Type A 调制发同一帧——
 * 那样 Type B / FeliCa / Type V 的卡根本听不见。
 *
 * 每一步的原始应答都留着，界面上可以显示「试了什么、回了什么」。
 */

import { RfBridge } from './bridge'
import { crcA } from './crc'
import { CardProtocol } from '../nfc/cards'
import { deviceSession } from '../protocol'

/** 探测结果里的一次尝试。 */
export interface ProbeAttempt {
  /** 协议名。 */
  protocol: string
  /** 使用的唤醒帧（十六进制）。 */
  frame: string
  /** 使用的射频模式。 */
  mode: string
  /** 是否成功。 */
  ok: boolean
  /** 应答（十六进制）。 */
  reply: string
  /** 说明。 */
  note: string
}

/** 探测结果。 */
export interface ProbeResult {
  /** 判定的协议族，未命中为 unknown。 */
  protocol: CardProtocol
  /** 命中的协议名。 */
  protocolName: string
  /** Type A 的 ATQA（仅 Type A 命中时有）。 */
  atqa: Uint8Array
  /** Type V 的 UID（仅 Type V 命中时有）。 */
  uid15693: Uint8Array
  /** FeliCa 的 IDm。 */
  idm: Uint8Array
  /** 每次尝试的记录。 */
  attempts: ProbeAttempt[]
}

const PROTOCOL_LABELS: Record<string, string> = {
  'iso14443a': 'ISO-14443A（Type A）',
  'iso14443b': 'ISO-14443B（Type B）',
  felica: 'FeliCa（Type F）',
  iso15693: 'ISO-15693（Type V）',
}

/** Type A 的 REQA（7 位帧，无 CRC）。 */
const REQA = new Uint8Array([0x26])
/** Type V 的 Request（16 位帧）。 */
const REQUEST_V = new Uint8Array([0x26, 0x01, 0x00])
/** Type B 的 REQB（3 字节，最后一字节 7 位）。 */
const REQB = new Uint8Array([0x05, 0x00, 0x00])
/** FeliCa 的轮询请求（要求系统码 0x0000）。 */
const FELICA_POLLING = new Uint8Array([
  0x06, 0x00, 0xff, 0xff, 0x01, 0x00,
])

function hex(data: Uint8Array): string {
  return Array.from(data)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

function crcMatches(data: Uint8Array): boolean {
  if (data.length < 3) {
    return false
  }
  const body = data.slice(0, data.length - 2)
  const tail = data.slice(data.length - 2)
  const crc = crcA(body)
  return crc[0] === tail[0] && crc[1] === tail[1]
}

/** 模式编号的中文名。 */
function modeLabel(rxMode: number, txMode: number): string {
  const rx = deviceSession.current?.profile.rfPresets?.rxModes.find(mode => mode.id === rxMode)
  const tx = deviceSession.current?.profile.rfPresets?.txModes.find(mode => mode.id === txMode)
  if (!rx) {
    return `RX ${rxMode}`
  }
  if (rx.id === txMode) {
    return rx.label
  }
  return `${rx.label} / ${tx?.label ?? `TX ${txMode}`}`
}

/**
 * 探测卡片使用的协议。
 *
 * 顺序有讲究：Type A 最常见，先问；再按 Type V、Type B、FeliCa 依次试，
 * 每次都用该协议自己的射频模式。
 */
export async function probeProtocol(bridge: RfBridge, typeAOnly = false): Promise<ProbeResult> {
  const presets = deviceSession.current?.profile.rfPresets
  const MODE_ISO14443A = presets?.typeA.rx ?? 0
  const DEFAULT_TX_MODE = presets?.typeA.tx ?? 0
  const MODE_ISO14443B = presets?.typeB.rx ?? 4
  const MODE_ISO14443B_TX = presets?.typeB.tx ?? 4
  const MODE_FELICA = presets?.felica.rx ?? 8
  const MODE_FELICA_TX = presets?.felica.tx ?? 8
  const MODE_ISO15693 = presets?.typeV.rx ?? 10
  const MODE_ISO15693_TX = presets?.typeV.tx ?? 10
  typeAOnly = typeAOnly || !presets
  const attempts: ProbeAttempt[] = []
  const result: ProbeResult = {
    protocol: 'unknown',
    protocolName: '未识别',
    atqa: new Uint8Array(0),
    uid15693: new Uint8Array(0),
    idm: new Uint8Array(0),
    attempts,
  }

  // ---- 1. Type A：REQA 0x26（7 位帧） ----
  try {
    const reply = await bridge.exchange(REQA, {
      txLastBits: 7,
      shortResponse: 'atqa',
      crcTx: false,
      crcRx: false,
      timeoutMs: 100,
      rxMode: MODE_ISO14443A,
      txMode: DEFAULT_TX_MODE,
    })
    const data = reply.data
    // 标准 Type A 卡的 ATQA 后面跟着 CRC_A（4 字节），
    // 墨水屏标签不带 CRC（2 字节）；两种都算 Type A。
    const atqa = data.length === 4 && crcMatches(data) ? data.slice(0, 2) : data
    if (atqa.length === 2) {
      result.protocol = 'iso14443a'
      result.protocolName = PROTOCOL_LABELS.iso14443a
      result.atqa = atqa.slice()
      attempts.push({
        protocol: 'ISO-14443A',
        frame: '26',
        mode: modeLabel(MODE_ISO14443A, DEFAULT_TX_MODE),
        ok: true,
        reply: hex(data),
        note: `ATQA ${hex(atqa)}`,
      })
      return result
    }
    attempts.push({
      protocol: 'ISO-14443A',
      frame: '26',
      mode: modeLabel(MODE_ISO14443A, DEFAULT_TX_MODE),
      ok: false,
      reply: hex(data),
      note: `应答长度 ${data.length} 字节，不是合法的 ATQA`,
    })
  } catch (error) {
    attempts.push({
      protocol: 'ISO-14443A',
      frame: '26',
      mode: modeLabel(MODE_ISO14443A, DEFAULT_TX_MODE),
      ok: false,
      reply: '',
      note: error instanceof Error ? error.message : String(error),
    })
  }

  if (typeAOnly) {
    attempts.push({
      protocol: 'Type B / F / V',
      frame: '—',
      mode: '—',
      ok: false,
      reply: '',
      note: '本次仅探测 Type A',
    })
    return result
  }

  // ---- 2. Type V：ISO-15693 Request ----
  try {
    const reply = await bridge.exchange(REQUEST_V, {
      txLastBits: 0,
      crcTx: true,
      crcRx: true,
      timeoutMs: 120,
      rxMode: MODE_ISO15693,
      txMode: MODE_ISO15693_TX,
    })
    const data = reply.data
    if (data.length === 10 && !(data[0] & 0x01)) {
      result.protocol = 'iso15693'
      result.protocolName = PROTOCOL_LABELS.iso15693
      result.uid15693 = data.slice(2, 10).reverse()
      attempts.push({
        protocol: 'ISO-15693',
        frame: hex(REQUEST_V),
        mode: modeLabel(MODE_ISO15693, MODE_ISO15693_TX),
        ok: true,
        reply: hex(data),
        note: `UID ${hex(result.uid15693)}`,
      })
      return result
    }
    attempts.push({
      protocol: 'ISO-15693',
      frame: hex(REQUEST_V),
      mode: modeLabel(MODE_ISO15693, MODE_ISO15693_TX),
      ok: false,
      reply: hex(data),
      note: `应答长度 ${data.length} 字节，不是已知的 UID 格式`,
    })
  } catch (error) {
    attempts.push({
      protocol: 'ISO-15693',
      frame: hex(REQUEST_V),
      mode: modeLabel(MODE_ISO15693, MODE_ISO15693_TX),
      ok: false,
      reply: '',
      note: error instanceof Error ? error.message : String(error),
    })
  }

  // ---- 3. Type B：REQB ----
  try {
    const reply = await bridge.exchange(REQB, {
      txLastBits: 0,
      crcTx: true,
      crcRx: true,
      timeoutMs: 100,
      rxMode: MODE_ISO14443B,
      txMode: MODE_ISO14443B_TX,
    })
    const data = reply.data
    if (data.length === 12 && data[0] === 0x50) {
      const body = data
      result.protocol = 'iso14443b'
      result.protocolName = PROTOCOL_LABELS.iso14443b
      attempts.push({
        protocol: 'ISO-14443B',
        frame: hex(REQB),
        mode: modeLabel(MODE_ISO14443B, MODE_ISO14443B),
        ok: true,
        reply: hex(data),
        note: `ATQB ${hex(body)}`,
      })
      return result
    }
    attempts.push({
      protocol: 'ISO-14443B',
      frame: hex(REQB),
      mode: modeLabel(MODE_ISO14443B, MODE_ISO14443B),
      ok: false,
      reply: hex(data),
      note: `应答长度 ${data.length} 字节，不是合法的 ATQB`,
    })
  } catch (error) {
    attempts.push({
      protocol: 'ISO-14443B',
      frame: hex(REQB),
      mode: modeLabel(MODE_ISO14443B, MODE_ISO14443B),
      ok: false,
      reply: '',
      note: error instanceof Error ? error.message : String(error),
    })
  }

  // ---- 4. FeliCa：轮询请求 ----
  try {
    const reply = await bridge.exchange(FELICA_POLLING, {
      txLastBits: 0,
      crcTx: true,
      crcRx: true,
      timeoutMs: 120,
      rxMode: MODE_FELICA,
      txMode: MODE_FELICA_TX,
    })
    const data = reply.data
    if ((data.length === 18 || data.length === 20) && data[0] === data.length && data[1] === 0x01) {
      result.protocol = 'felica'
      result.protocolName = PROTOCOL_LABELS.felica
      result.idm = data.slice(2, 10)
      attempts.push({
        protocol: 'FeliCa',
        frame: hex(FELICA_POLLING),
        mode: modeLabel(MODE_FELICA, MODE_FELICA),
        ok: true,
        reply: hex(data),
        note: `IDm ${hex(result.idm)}`,
      })
      return result
    }
    attempts.push({
      protocol: 'FeliCa',
      frame: hex(FELICA_POLLING),
      mode: modeLabel(MODE_FELICA, MODE_FELICA),
      ok: false,
      reply: hex(data),
      note: `应答长度 ${data.length} 字节，不是合法的 IDm`,
    })
  } catch (error) {
    attempts.push({
      protocol: 'FeliCa',
      frame: hex(FELICA_POLLING),
      mode: modeLabel(MODE_FELICA, MODE_FELICA),
      ok: false,
      reply: '',
      note: error instanceof Error ? error.message : String(error),
    })
  }

  return result
}
