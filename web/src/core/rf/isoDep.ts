/**
 * ISO-DEP 状态机：NFC-A 唤醒、防冲突、选卡、RATS/CID 协商，以及块级收发。
 *
 * 对齐 tmp/rf_device_platform/host/src/rf_platform/nfc/iso_dep.py。
 */

import { RfBridge, RfError, RfReply } from './bridge'
import { crcA, describeErrorBits } from './crc'

const MAX_ISODEP_INF = 256 - 3
const NFC_WAKE_ATTEMPTS = 20
const NFC_WAKE_RETRY_DELAY_MS = 50
const FSC_TABLE = [16, 24, 32, 40, 48, 64, 96, 128, 256]

/**
 * 各步骤的射频等待时长，与参考实现一致。
 *
 * 标签应答 RATS/SELECT 的时间比唤醒帧长得多，统一用 100ms 会在
 * 标签还没回完时就把接收窗口关掉，产生半帧与 CRC 错误。
 */
const TIMEOUT_WAKE_MS = 100
const TIMEOUT_ANTICOLLISION_MS = 100
const TIMEOUT_SELECT_MS = 120
const TIMEOUT_RATS_MS = 180

/** 华为专用唤醒帧。 */
export const WAKE_FRAME_HUAWEI = 0x7a
/** 标准 NFC-A REQA。 */
export const WAKE_FRAME_REQA = 0x26
/** 标准 NFC-A WUPA（唤醒也回应），Type 2 标签用它。 */
export const WAKE_FRAME_WUPA = 0x52

export interface Activation {
  uid: Uint8Array
  sak: number
  atqa: Uint8Array
  ats: Uint8Array
  fsc: number
  fwtMs: number
  cid: number | null
}

export class IsoDepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IsoDepError'
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/** 校验射频响应，返回去掉 CRC 后的数据。 */
export function validateReply(reply: RfReply, label: string, crcPresent = true): Uint8Array {
  let data = reply.data
  if (reply.rxLastBits) {
    const candidate = data.slice(0, data.length - 1)
    const crcMatches =
      crcPresent &&
      !reply.errorStatus &&
      !(reply.irq0Status & 0x02) &&
      candidate.length >= 3 &&
      equalBytes(crcA(candidate.slice(0, candidate.length - 2)), candidate.slice(candidate.length - 2))
    if (crcMatches) {
      data = candidate
    } else {
      const reason = reply.errorStatus ? 'RF error' : 'short-frame'
      throw new IsoDepError(
        `${label} 射频状态异常 RXBITS=${reply.rxLastBits} IRQ0=${reply.irq0Status.toString(16)} ` +
          `ERROR=${reply.errorStatus.toString(16)}（${reason}）`
      )
    }
  }
  if (reply.errorStatus || reply.irq0Status & 0x02) {
    const names = describeErrorBits(reply.errorStatus)
    throw new IsoDepError(
      `${label} 射频错误 IRQ0=${reply.irq0Status.toString(16)} ERROR=${reply.errorStatus.toString(16)}` +
        (names.length ? `（${names.join(', ')}）` : '')
    )
  }
  if (crcPresent) {
    if (data.length < 3 || !equalBytes(crcA(data.slice(0, data.length - 2)), data.slice(data.length - 2))) {
      throw new IsoDepError(`${label} CRC_A 校验失败`)
    }
    return data.slice(0, data.length - 2)
  }
  return data
}

/** 激活选项。 */
export interface ActivateOptions {
  /** Optional operation-stage diagnostics, without card payloads. */
  trace?: (message: string) => void
  /** 是否要求 ATQA 严格等于 04 00（墨水屏标签）。默认 true。 */
  strictAtqa?: boolean
  /** 是否要求标签支持 ISO-DEP。默认 true。 */
  requireIsoDep?: boolean
  /**
   * 已知 UID 时直接用它选卡，跳过防冲突。
   *
   * SELECT(0x93 0x70 + UID + BCC) 本身就带着卡号，只有「学卡号」才需要防冲突那一步。
   * 已知卡号时省一次射频往返，批量认证时很可观。
   */
  knownUid?: Uint8Array
}

/** 激活 NFC 标签并完成 ISO-DEP 协商。 */
export async function activateTag(
  bridge: RfBridge,
  wakeFrame: number,
  options: ActivateOptions = {}
): Promise<Activation> {
  if (
    wakeFrame !== WAKE_FRAME_HUAWEI &&
    wakeFrame !== WAKE_FRAME_REQA &&
    wakeFrame !== WAKE_FRAME_WUPA
  ) {
    throw new Error('仅支持 0x7A、0x26 或 0x52 唤醒帧')
  }
  let atqa: Uint8Array = new Uint8Array(0)
  let lastError: Error | null = null
  for (let attempt = 0; attempt < NFC_WAKE_ATTEMPTS; attempt += 1) {
    try {
      options.trace?.(`Type A 唤醒 0x${wakeFrame.toString(16)}（第 ${attempt + 1} 次）`)
      const reply = await bridge.exchange(new Uint8Array([wakeFrame]), {
        txLastBits: 7,
        shortResponse: 'atqa',
        timeoutMs: TIMEOUT_WAKE_MS,
      })
      const value = stripCrcIfPresent(validateReply(reply, '唤醒', false))
      const strict = options.strictAtqa ?? true
      if (value.length !== 2 || (strict && (value[0] !== 0x04 || value[1] !== 0x00))) {
        throw new IsoDepError(`ATQA 异常：${Array.from(value).map(toHexByte).join(' ')}`)
      }
      atqa = value
      break
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === NFC_WAKE_ATTEMPTS - 1) {
        throw new IsoDepError(
          `唤醒帧 0x${wakeFrame.toString(16).toUpperCase()} 失败：${lastError.message}`
        )
      }
      await new Promise<void>(resolve => {
        setTimeout(resolve, NFC_WAKE_RETRY_DELAY_MS)
      })
    }
  }

  const uidParts: number[] = []
  let sak = 0

  // 已知 UID：直接 SELECT，省掉防冲突那一轮。
  // 只对 4 字节 UID 生效：7 字节 UID 要走级联（0x93 0x88 … / 0x95 …），
  // 拿前 4 字节直接 SELECT 是选不中的。
  if (options.knownUid && options.knownUid.length === 4) {
    const known = options.knownUid.slice(0, 4)
    const bcc = known[0] ^ known[1] ^ known[2] ^ known[3]
    const body = new Uint8Array([0x93, 0x70, known[0], known[1], known[2], known[3], bcc])
    const selected = validateReply(
      await bridge.exchange(withCrc(body), { timeoutMs: TIMEOUT_SELECT_MS, shortResponse: 'sak' }),
      '选卡'
    )
    if (selected.length !== 1) {
      throw new IsoDepError('SAK 长度非法')
    }
    sak = selected[0]
    return {
      uid: known.slice(),
      sak,
      atqa,
      ats: new Uint8Array(0),
      fsc: 0,
      fwtMs: 0,
      cid: null,
    }
  }

  for (const select of [0x93, 0x95, 0x97]) {
    options.trace?.(`UID 防冲突，级联 0x${select.toString(16)}`)
    const anti = await anticollision(bridge, select)
    const part = anti.data
    if (part.length !== 5 || part[4] !== (part[0] ^ part[1] ^ part[2] ^ part[3])) {
      throw new IsoDepError('UID 防冲突 BCC 校验失败')
    }
    const body = new Uint8Array([select, 0x70, part[0], part[1], part[2], part[3], part[4]])
    options.trace?.(`SELECT 选卡，级联 0x${select.toString(16)}`)
    const selected = validateReply(
      await bridge.exchange(withCrc(body), { timeoutMs: TIMEOUT_SELECT_MS, shortResponse: 'sak' }),
      '选卡'
    )
    if (selected.length !== 1) {
      throw new IsoDepError('SAK 长度非法')
    }
    sak = selected[0]
    const cascade = part[0] === 0x88
    if (cascade !== Boolean(sak & 0x04)) {
      throw new IsoDepError('级联标识与 SAK 不一致')
    }
    if (cascade) {
      uidParts.push(part[1], part[2], part[3])
    } else {
      uidParts.push(part[0], part[1], part[2], part[3])
    }
    if (!(sak & 0x04)) {
      break
    }
  }

  const uid = new Uint8Array(uidParts)
  const requireIsoDep = options.requireIsoDep ?? true
  if (![4, 7, 10].includes(uid.length)) {
    throw new IsoDepError('UID 长度非法')
  }
  if (!(sak & 0x20)) {
    if (requireIsoDep) {
      throw new IsoDepError('标签不支持 ISO-DEP')
    }
    return { uid, sak, atqa, ats: new Uint8Array(0), fsc: 0, fwtMs: 0, cid: null }
  }

  const rats = new Uint8Array([0xe0, 0x80])
  const ats = validateReply(
    await bridge.exchange(withCrc(rats), { timeoutMs: TIMEOUT_RATS_MS, isoDepResponse: true }),
    'ATS'
  )
  if (ats.length < 2 || ats.length > 20 || ats[0] !== ats.length) {
    throw new IsoDepError('ATS TL 非法')
  }
  const info = parseAts(ats)

  return { uid, sak, atqa, ats, fsc: info.fsc, fwtMs: info.fwtMs, cid: info.cid }
}

/** ATS 解析结果。 */
export interface AtsInfo {
  /** 帧尺寸。 */
  fsc: number
  /** 帧等待时间（毫秒）。 */
  fwtMs: number
  /** 卡号标识，null 表示不支持。 */
  cid: number | null
}

/**
 * 解析 ATS：帧尺寸（FSCI）、帧等待（FWI）与是否支持 CID。
 *
 * 激活时要用，重新协商会话（resync）时也要用，所以抽成独立函数。
 */
export function parseAts(ats: Uint8Array): AtsInfo {
  if (ats.length < 2 || ats.length > 20 || ats[0] !== ats.length) {
    throw new IsoDepError('ATS TL 非法')
  }
  const t0 = ats[1]
  const fsci = t0 & 0x0f
  if (fsci >= FSC_TABLE.length) {
    throw new IsoDepError('ATS FSCI 非法')
  }
  let offset = 2
  let tb: number | null = null
  if (t0 & 0x80) throw new IsoDepError('ATS T0 保留位非法')
  if (t0 & 0x10) {
    if (offset >= ats.length) throw new IsoDepError('ATS 接口字节被截断')
    offset += 1
  }
  if (t0 & 0x20) {
    if (offset >= ats.length) {
      throw new IsoDepError('ATS 接口字节被截断')
    }
    tb = ats[offset]
    offset += 1
  }
  if (t0 & 0x40) {
    if (offset >= ats.length) {
      throw new IsoDepError('ATS 接口字节被截断')
    }
    offset += 1
  }
  const fwi = tb !== null ? tb >> 4 : 4
  if (fwi === 15 || (tb !== null && (tb & 0x0f) === 15)) {
    throw new IsoDepError('ATS FWI 非法')
  }
  return {
    fsc: FSC_TABLE[fsci],
    fwtMs: (4096 / 13560000) * Math.pow(2, fwi) * 1000,
    // RATS E0 80 uses CID 0; leave optional CID bytes absent, like the A01 host.
    cid: null,
  }
}

/** 追加 CRC_A。 */
function withCrc(data: Uint8Array): Uint8Array {
  const crc = crcA(data)
  const result = new Uint8Array(data.length + 2)
  result.set(data, 0)
  result.set(crc, data.length)
  return result
}

/**
 * 若末尾两字节是校验通过的 CRC_A 就去掉它。
 *
 * 墨水屏标签的 ATQA 不带 CRC，只有 2 字节；
 * 标准 ISO-14443A 卡的 ATQA 后面跟着 CRC_A，是 4 字节。两种都要认。
 */
export function stripCrcIfPresent(data: Uint8Array): Uint8Array {
  if (data.length < 4) {
    return data
  }
  const body = data.slice(0, data.length - 2)
  const tail = data.slice(data.length - 2)
  const crc = crcA(body)
  return crc[0] === tail[0] && crc[1] === tail[1] ? body : data
}

/**
 * 反冲突帧。
 *
 * 标准 ISO-14443A 的反冲突帧带 CRC_A，而墨水屏标签能接受不带 CRC 的版本，
 * 所以先按不带的试，卡没反应（超时或射频错误）再补上 CRC 重试一次。
 */
async function anticollision(bridge: RfBridge, select: number): Promise<RfReply> {
  const frame = new Uint8Array([select, 0x20])
  try {
    const reply = await bridge.exchange(frame, { timeoutMs: TIMEOUT_ANTICOLLISION_MS })
    if (!reply.rxLastBits && !(reply.irq0Status & 0x02) && !reply.errorStatus) {
      return reply
    }
  } catch (error) {
    // 卡没接住不带 CRC 的帧，换带 CRC 的版本再试
  }
  const reply = await bridge.exchange(withCrc(frame), { timeoutMs: TIMEOUT_ANTICOLLISION_MS })
  if (reply.rxLastBits || reply.irq0Status & 0x02 || reply.errorStatus) {
    const names = describeErrorBits(reply.errorStatus)
    throw new IsoDepError(
      `防冲突射频状态异常 RXBITS=${reply.rxLastBits} IRQ0=${reply.irq0Status.toString(16)} ` +
        `ERROR=${reply.errorStatus.toString(16)}${names.length ? `（${names.join(', ')}）` : ''}`
    )
  }
  return reply
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

/** ISO-DEP 会话：负责分块、WTX 与 R(NAK) 恢复。 */
export class IsoDepSession {
  private readonly bridge: RfBridge
  /** 激活信息：重新协商会话后 CID/帧尺寸可能变化，所以不是只读的。 */
  private activation: Activation
  private readonly maxWtx: number
  private readonly maxRetries: number
  private blockNumber = 0
  private cidOverhead: number
  /** 单个 ISO-DEP 帧能承载的 INF 字节数。 */
  private infLimit: number

  constructor(bridge: RfBridge, activation: Activation, maxWtx = 50, maxRetries = 4) {
    this.bridge = bridge
    this.activation = activation
    this.maxWtx = maxWtx
    this.maxRetries = maxRetries
    this.cidOverhead = activation.cid !== null ? 1 : 0
    this.infLimit = Math.min(activation.fsc - 3 - this.cidOverhead, MAX_ISODEP_INF - this.cidOverhead)
  }

  /**
   * 射频出错后重新协商 ISO-DEP 会话。
   *
   * 上一帧交换半路失败时，读卡机与标签的块序号可能已经错位，
   * 这时直接重发命令会被当成上一帧的延续，标签不会当作新命令执行。
   * 重新发一次 RATS 让双方回到同一起点，重传才有意义。
   */
  async resync(): Promise<void> {
    const rats = new Uint8Array([0xe0, 0x80])
    const ats = validateReply(
      await this.bridge.exchange(withCrc(rats), { timeoutMs: TIMEOUT_RATS_MS, isoDepResponse: true }),
      'ATS'
    )
    const info = parseAts(ats)
    this.activation = {
      ...this.activation,
      cid: info.cid,
      fsc: info.fsc,
      fwtMs: info.fwtMs,
    }
    this.cidOverhead = info.cid !== null ? 1 : 0
    this.infLimit = Math.min(info.fsc - 3 - this.cidOverhead, MAX_ISODEP_INF - this.cidOverhead)
    this.blockNumber = 0
  }

  private encode(pcb: number, inf: Uint8Array = new Uint8Array(0)): Uint8Array {
    const body = new Uint8Array(1 + this.cidOverhead + inf.length)
    body[0] = this.activation.cid !== null ? pcb | 0x08 : pcb
    if (this.activation.cid !== null) {
      body[1] = this.activation.cid
    }
    body.set(inf, 1 + this.cidOverhead)
    return withCrc(body)
  }

  private decode(reply: RfReply): Uint8Array {
    const body = validateReply(reply, 'ISO-DEP')
    if (body[0] & 0x08) {
      if (body.length < 2 || body[1] !== this.activation.cid) {
        throw new IsoDepError('ISO-DEP CID 不匹配')
      }
      const result = new Uint8Array(body.length - 1)
      result[0] = body[0]
      result.set(body.slice(2), 1)
      return result
    }
    if (this.activation.cid !== null) {
      throw new IsoDepError('ISO-DEP 响应缺少 CID 字段')
    }
    return body
  }

  private async receive(
    outgoing: Uint8Array,
    retries: number,
    confirmedTargetUid?: Uint8Array,
    deadline = Date.now() + 15_000
  ): Promise<Uint8Array> {
    let wtxCount = 0
    let retryBudget = retries
    let timeoutMs = Math.min(300_000, Math.ceil(this.activation.fwtMs) + 4)
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new IsoDepError('ISO-DEP 交换超时，结果未确认')
      let reply: RfReply
      try {
        reply = await this.bridge.exchange(outgoing, {
          timeoutMs: Math.min(timeoutMs, remaining),
          confirmedTargetUid,
          isoDepResponse: true,
        })
      } catch (error) {
        if (retryBudget <= 0) {
          throw error
        }
        retryBudget -= 1
        if ((outgoing[0] & 0xf7) !== 0xf2) outgoing = this.encode(0xb2 | this.blockNumber)
        continue
      }
      let body: Uint8Array
      try {
        body = this.decode(reply)
      } catch (error) {
        if (retryBudget <= 0) {
          throw error
        }
        retryBudget -= 1
        if ((outgoing[0] & 0xf7) !== 0xf2) outgoing = this.encode(0xb2 | this.blockNumber)
        continue
      }
      if ((body[0] & 0xf7) !== 0xf2) {
        return body
      }
      wtxCount += 1
      if (body.length !== 2 || wtxCount > this.maxWtx) {
        throw new IsoDepError('WTX 非法或超出重试上限')
      }
      const multiplier = body[1]
      const timeout = Math.ceil(this.activation.fwtMs * multiplier) + 4
      if (multiplier < 1 || multiplier > 59 || timeout > 300_000) {
        throw new IsoDepError('WTX 超出射频桥超时上限')
      }
      timeoutMs = timeout
      outgoing = this.encode(0xf2, new Uint8Array([multiplier]))
    }
  }

  /** 本会话选中的卡片 UID。 */
  get uid(): Uint8Array {
    return this.activation.uid
  }

  /**
   * 单个 ISO-DEP 帧能承载的最大 INF 字节数。
   *
   * 上层用它决定应用层包的大小：一个包连包头超过这个数就要拆成链式块，
   * 每多一块就多一次射频往返，刷图时间直接翻倍。
   */
  get maxInf(): number {
    return this.infLimit
  }

  /**
   * 交换一段 INF 数据，返回标签的响应负载。
   *
   * `confirmedTargetUid` 用于写操作：把用户确认过的 UID 绑到这次射频事务上，
   * 设备侧可以据此校验「写的是不是用户看到的那张卡」。
   */
  async exchange(
    inf: Uint8Array,
    recoveryBudget?: number,
    confirmedTargetUid?: Uint8Array,
    deadlineMs = 15_000
  ): Promise<Uint8Array> {
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) throw new IsoDepError('ISO-DEP deadline 必须为正整数')
    const deadline = Date.now() + deadlineMs
    const retries = recoveryBudget ?? this.maxRetries
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < inf.length; offset += this.infLimit) {
      parts.push(inf.slice(offset, Math.min(offset + this.infLimit, inf.length)))
    }
    if (parts.length === 0) {
      parts.push(new Uint8Array(0))
    }
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const chaining = index < parts.length - 1
      const pcb = 0x02 | this.blockNumber | (chaining ? 0x10 : 0)
      let body = await this.receive(this.encode(pcb, part), retries, confirmedTargetUid, deadline)
      for (let nak = 0; body.length === 1 && body[0] === (0xb2 | this.blockNumber); nak++) {
        if (nak >= retries) throw new IsoDepError('ISO-DEP R-NAK 超出恢复上限')
        body = await this.receive(this.encode(pcb, part), retries, confirmedTargetUid, deadline)
      }
      if ((body[0] & 0xc0) === 0x80) {
        if (body.length !== 1 || body[0] !== (0xa2 | this.blockNumber)) throw new IsoDepError('ISO-DEP R-ACK 非法')
        if (!chaining) {
          throw new IsoDepError('收到非预期的 R-block')
        }
        this.blockNumber ^= 1
        continue
      }
      if (chaining) {
        throw new IsoDepError('链式 I-block 缺少 R-ACK')
      }
      if (!body.length || (body[0] & 0xee) !== 0x02 || (body[0] & 1) !== this.blockNumber) throw new IsoDepError('ISO-DEP I-block 非法')
      let response = new Uint8Array(body.length - 1)
      response.set(body.slice(1), 0)
      this.blockNumber ^= 1
      while (body[0] & 0x10) {
        body = await this.receive(this.encode(0xa2 | this.blockNumber), retries, confirmedTargetUid, deadline)
        if (!body.length || (body[0] & 0xee) !== 0x02 || (body[0] & 1) !== this.blockNumber) throw new IsoDepError('ISO-DEP 链式响应非法')
        const merged = new Uint8Array(response.length + body.length - 1)
        merged.set(response, 0)
        merged.set(body.slice(1), response.length)
        this.blockNumber ^= 1
        response = merged
      }
      return response
    }
    return new Uint8Array(0)
  }

  /** 交换一次，不发送 R(NAK) 恢复帧（用于刷新等不可重复的命令）。 */
  async exchangeOnce(inf: Uint8Array, confirmedTargetUid?: Uint8Array, deadlineMs = 15_000): Promise<Uint8Array> {
    return this.exchange(inf, 0, confirmedTargetUid, deadlineMs)
  }

  /** 是否可判断射频错误类型。 */
  static isRfError(error: unknown): boolean {
    return error instanceof RfError
  }
}
