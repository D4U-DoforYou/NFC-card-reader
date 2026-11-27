/**
 * NFC Forum Type 2 标签会话：能力容器、用户内存、NDEF 读写。
 *
 * 与 tmp/rf_device_platform/host/src/rf_platform/nfc/type2.py 对齐，
 * 同样遵守「写之前重新选卡并核对 UID、写完回读验证」的规矩：
 * 写操作不能因为中途换了一张卡就写错地方。
 *
 * Type 2 标签不走 ISO-DEP，帧格式是 NFC Forum Type 2 Tag Commands：
 *   - 0x60 GET_VERSION
 *   - 0x30 READ（一次四页，共 16 字节）
 *   - 0xA2 WRITE（一次一页，4 字节）
 */

import { RfBridge, RfError } from '../rf/bridge'
import { ntagModel } from './tagDetails'
import { crcA } from '../rf/crc'
import { Activation, WAKE_FRAME_WUPA, activateTag } from '../rf/isoDep'

/** NTAG I2C 的产品类型字节。 */
const NTAG_I2C_PRODUCT_TYPE = 0x05

/** 静态锁页的上限（页 15 之后属于动态锁，不在自动写入范围内）。 */
const MAX_STATIC_LOCK_PAGE = 15

/** Type 2 标签错误。 */
export class Type2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Type2Error'
  }
}

/** TLV 结构里的一段 NDEF 记录。 */
export interface NdefTlv {
  /** NDEF TLV 在用户内存里的起始偏移。 */
  start: number
  /** 长度字段的偏移。 */
  lengthOffset: number
  /** 长度字段占几个字节（1 或 3）。 */
  lengthWidth: number
  /** NDEF 负载的偏移。 */
  valueOffset: number
  /** NDEF 负载。 */
  value: Uint8Array
  /** NDEF TLV 的结束偏移。 */
  end: number
}

/** Type 2 标签信息。 */
export interface Type2TagInfo {
  /** 卡 UID。 */
  uid: Uint8Array
  /** SAK。 */
  sak: number
  /** ATQA。 */
  atqa: Uint8Array
  /** GET_VERSION 的返回；不支持时为 null。 */
  version: Uint8Array | null
  /** Read from page 2. */
  staticLocks?: Uint8Array
  /** NTAG21x password protection starting page; undefined if unreadable. */
  auth0?: number
  authenticated?: boolean
  /** 能力容器（CC）4 字节。 */
  capabilityContainer: Uint8Array
  /** 用户内存全文。 */
  userMemory: Uint8Array
  /** CC 声明容量；快速读取的 userMemory 仅包含已读取前缀。 */
  userCapacity?: number
  memoryComplete?: boolean
  /** NDEF TLV。 */
  ndefTlv: NdefTlv | null
  /** 可以追加 TLV 的位置。 */
  appendOffset: number
  /** 是否存在锁 / 内存控制 TLV。 */
  hasControlTlv: boolean
  /** NDEF 之后是否还有其他 TLV。 */
  hasTlvAfterNdef: boolean
}

/** TLV 扫描结果。 */
interface TlvScan {
  ndef: NdefTlv | null
  appendOffset: number
  hasControlTlv: boolean
  hasTlvAfterNdef: boolean
}

/** 追加 CRC_A。 */
function withCrc(data: Uint8Array): Uint8Array {
  const crc = crcA(data)
  const result = new Uint8Array(data.length + 2)
  result.set(data, 0)
  result.set(crc, data.length)
  return result
}

/** 末尾两字节是否是校验通过的 CRC_A。 */
function crcMatches(data: Uint8Array): boolean {
  if (data.length < 3) {
    return false
  }
  const crc = crcA(data.slice(0, data.length - 2))
  const tail = data.slice(data.length - 2)
  return crc[0] === tail[0] && crc[1] === tail[1]
}

/**
 * 扫描 Type 2 的 TLV 列表。
 *
 * Type 2 的 TLV 与 ISO-DEP 的 BER-TLV 是两套格式，不能复用 apdu.ts 里的解析。
 */
export function scanType2Tlvs(memory: Uint8Array): TlvScan {
  let offset = 0
  let appendOffset = 0
  let ndef: NdefTlv | null = null
  let hasControlTlv = false
  let hasTlvAfterNdef = false

  while (offset < memory.length) {
    const tag = memory[offset]
    if (tag === 0x00) {
      offset += 1
      continue
    }
    if (tag === 0xfe) {
      break
    }

    const start = offset
    offset += 1
    if (offset >= memory.length) {
      throw new Type2Error('Type 2 TLV 长度被截断')
    }
    let length = memory[offset]
    const lengthOffset = offset
    offset += 1
    let lengthWidth = 1
    if (length === 0xff) {
      if (offset + 2 > memory.length) {
        throw new Type2Error('Type 2 TLV 扩展长度被截断')
      }
      length = (memory[offset] << 8) | memory[offset + 1]
      lengthWidth = 3
      offset += 2
    }
    const end = offset + length
    if (end > memory.length) {
      throw new Type2Error('Type 2 TLV 超出了用户内存范围')
    }

    if (tag === 0x01 || tag === 0x02) {
      hasControlTlv = true
    }
    if (tag === 0x03) {
      if (!ndef) {
        ndef = {
          start,
          lengthOffset,
          lengthWidth,
          valueOffset: offset,
          value: memory.slice(offset, end),
          end,
        }
      } else {
        hasTlvAfterNdef = true
      }
    } else if (ndef) {
      hasTlvAfterNdef = true
    } else {
      appendOffset = end
    }
    offset = end
  }

  return { ndef, appendOffset, hasControlTlv, hasTlvAfterNdef }
}

/** 编码一条 NDEF 文本记录。 */
export function encodeTextRecord(text: string): Uint8Array {
  const payload = new Uint8Array([0x02, 0x65, 0x6e, ...new TextEncoder().encode(text)])
  if (payload.length > 255) {
    throw new Type2Error('文本太长，放不进单条短 NDEF 记录')
  }
  const message = new Uint8Array(4 + payload.length)
  message[0] = 0xd1
  message[1] = 0x01
  message[2] = payload.length
  message[3] = 0x54
  message.set(payload, 4)
  return message
}

/** NFC Forum URI RTD; prefix-compressed HTTP(S), UTF-8, no credentials. */
export function encodeUriRecord(value: string): Uint8Array {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Type2Error('请使用不含账号密码的 HTTP / HTTPS 链接')
  const prefixes: Array<[string, number]> = [['https://www.', 2], ['http://www.', 1], ['https://', 4], ['http://', 3]]
  const [prefix, code] = prefixes.find(([prefix]) => value.startsWith(prefix)) ?? ['', 0]
  const body = new TextEncoder().encode(value.slice(prefix.length))
  if (body.length + 1 > 255) throw new Type2Error('链接超出短 NDEF 记录长度')
  return new Uint8Array([0xd1, 1, body.length + 1, 0x55, code, ...body])
}

/** 解析一条 NDEF 文本记录。 */
export function decodeTextRecord(message: Uint8Array): string | null {
  if (message.length < 7 || message[0] !== 0xd1 || message[1] !== 1) {
    return null
  }
  const payloadLength = message[2]
  if (message[3] !== 0x54 || message.length !== 4 + payloadLength) {
    return null
  }
  const payload = message.slice(4)
  if (!payload.length) {
    return null
  }
  const languageLength = payload[0] & 0x3f
  if (1 + languageLength > payload.length) {
    return null
  }
  const charset = payload[0] & 0x80 ? 'utf-16' : 'utf-8'
  try {
    return new TextDecoder(charset).decode(payload.slice(1 + languageLength))
  } catch {
    return null
  }
}

/** 解析一条 NDEF URI 记录。 */
export function decodeUriRecord(message: Uint8Array): string | null {
  if (message.length < 5 || message[0] !== 0xd1 || message[1] !== 1) {
    return null
  }
  const payloadLength = message[2]
  if (message[3] !== 0x55 || message.length !== 4 + payloadLength) {
    return null
  }
  const payload = message.slice(4)
  const prefixes: Record<number, string> = {
    0x00: '',
    0x01: 'http://www.',
    0x02: 'https://www.',
    0x03: 'http://',
    0x04: 'https://',
  }
  const prefix = prefixes[payload[0]]
  if (prefix === undefined) {
    return null
  }
  try {
    return prefix + new TextDecoder('utf-8').decode(payload.slice(1))
  } catch {
    return null
  }
}

/** 把 NDEF 消息包成 Type 2 的 NDEF TLV。 */
export function encodeNdefTlv(message: Uint8Array, extended: boolean): Uint8Array {
  if (extended || message.length >= 0xff) {
    if (message.length > 0xffff) {
      throw new Type2Error('NDEF 消息超出 Type 2 标签容量')
    }
    const result = new Uint8Array(4 + message.length + 1)
    result[0] = 0x03
    result[1] = 0xff
    result[2] = (message.length >>> 8) & 0xff
    result[3] = message.length & 0xff
    result.set(message, 4)
    result[result.length - 1] = 0xfe
    return result
  }
  const result = new Uint8Array(2 + message.length + 1)
  result[0] = 0x03
  result[1] = message.length
  result.set(message, 2)
  result[result.length - 1] = 0xfe
  return result
}

/** Type 2 标签会话。 */
export interface Type2Credentials {
  password: Uint8Array
  expectedPack?: Uint8Array
  /** Recheck the UID before sending a credential to a reselected tag. */
  uid: Uint8Array
}
export class Type2Session {
  private readonly bridge: RfBridge
  private info: Type2TagInfo | null = null
  private active = false
  private selectedUid: Uint8Array | null = null
  private authenticated = false
  private readonly credentials?: Type2Credentials
  private readonly trace: (message: string) => void

  constructor(bridge: RfBridge, trace: (message: string) => void = () => {}, credentials?: Type2Credentials) {
    this.bridge = bridge
    this.trace = trace
    if (credentials) {
      if (credentials.password.length !== 4 || (credentials.expectedPack && credentials.expectedPack.length !== 2) || ![4,7,10].includes(credentials.uid.length)) throw new Type2Error('PWD 应为 4 字节，PACK 应为 2 字节，且需先识别目标 UID')
      this.credentials = { password: credentials.password.slice(), expectedPack: credentials.expectedPack?.slice(), uid: credentials.uid.slice() }
    }
  }

  private async authenticateTarget(): Promise<void> {
    this.authenticated = false
    const credentials = this.credentials
    if (!credentials) return
    if (!this.selectedUid || !equalBytes(credentials.uid, this.selectedUid)) throw new Type2Error('认证目标 UID 不一致，未发送密码')
    this.trace('执行 PWD_AUTH（不记录密码，不自动重试）')
    let data: Uint8Array
    try {
      data = await this.exchange(new Uint8Array([0x1b, ...credentials.password]), 100)
    } catch {
      throw new Type2Error('PWD_AUTH 失败：密码未被确认；未自动重试，请核对密码与标签状态')
    }
    if (data.length !== 4 || !crcMatches(data)) throw new Type2Error('PWD_AUTH 未返回有效 PACK，可能密码错误或认证次数受限；未重试')
    if (credentials.expectedPack && !equalBytes(data.slice(0, 2), credentials.expectedPack)) throw new Type2Error('PACK 与预期不符，认证结果未接受')
    this.authenticated = true
    this.trace('PWD_AUTH 应答与校验通过')
  }

  private async selectTarget(): Promise<Activation> {
    this.authenticated = false
    this.trace('复位射频场并重新选卡')
    await this.bridge.cycleRfField()
    try {
      return await activateTag(this.bridge, WAKE_FRAME_WUPA, { strictAtqa: false, requireIsoDep: false, trace: this.trace })
    } catch (error) {
      throw new Type2Error(`Type 2 重新选卡失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 当前标签信息；未打开时为 null。 */
  get tag(): Type2TagInfo | null {
    return this.info
  }

  /** 打开会话：复位射频场、WUPA 选卡、读 CC 与用户内存。 */
  async open(options: { quick?: boolean } = {}): Promise<Type2TagInfo> {
    if (this.active) {
      await this.close()
    }
    this.active = true
    try {
      const activation = await this.selectTarget()
      this.selectedUid = activation.uid.slice()
      if (activation.sak & 0x20) {
        throw new Type2Error('选中的卡支持 ISO-DEP，不是 Type 2 标签')
      }
      await this.authenticateTarget()

      this.trace('读取 GET_VERSION')
      const version = await this.readVersion()
      if (!version) await this.requireTarget(activation.uid)
      this.trace('读取能力容器（页 3）')
      const ccPage = await this.readPage(3)
      const cc = ccPage.slice(0, 4)
      if (cc.length !== 4 || cc[0] !== 0xe1) {
        throw new Type2Error('标签没有 NFC Forum Type 2 能力容器')
      }
      const userBytes = cc[2] * 8
      if (userBytes < 4 || userBytes > 1008) {
        throw new Type2Error(`Type 2 用户内存大小非法：${userBytes} 字节`)
      }

      if ((cc[1] >> 4) !== 1 || (cc[3] >> 4) !== 0) throw new Type2Error('标签的 CC 版本或读取权限不受支持')
      const model = ntagModel(version)
      if (model && userBytes > model.physicalBytes) throw new Type2Error('CC 声明容量超出已知型号用户区')
      const staticLocks = (await this.readPage(2)).slice(2, 4)
      let auth0: number | undefined
      if (model) {
        try { auth0 = (await this.readPage(model.configPage))[3] }
        catch (error) {
          this.trace(`读取密码配置失败，状态保持未知：${error instanceof Error ? error.message : String(error)}`)
          await this.requireTarget(activation.uid)
        }
      }
      const memory = await this.readUserMemory(userBytes, Boolean(options.quick))
      const scan = scanType2Tlvs(memory)
      this.info = {
        uid: activation.uid,
        sak: activation.sak,
        atqa: activation.atqa,
        version,
        staticLocks,
        auth0,
        authenticated: this.authenticated,
        capabilityContainer: cc,
        userMemory: memory,
        userCapacity: userBytes,
        memoryComplete: memory.length === userBytes,
        ndefTlv: scan.ndef,
        appendOffset: scan.appendOffset,
        hasControlTlv: scan.hasControlTlv,
        hasTlvAfterNdef: scan.hasTlvAfterNdef,
      }
      return this.info
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** 关闭会话。 */
  async close(): Promise<void> {
    this.active = false
    this.selectedUid = null
    this.authenticated = false
    this.info = null
    await this.bridge.setRfField(false).catch(() => undefined)
  }

  /** 发一条 Type 2 指令并等待应答。 */
  private async exchange(command: Uint8Array, timeoutMs = 50): Promise<Uint8Array> {
    const reply = await this.bridge.exchange(withCrc(command), {
      crcTx: false,
      crcRx: false,
      timeoutMs,
      confirmedTargetUid: this.selectedUid ?? this.info?.uid,
    })
    return reply.data
  }

  /** GET_VERSION；不支持的标签返回 null。 */
  private async readVersion(): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await this.exchange(new Uint8Array([0x60]), 50)
        if (data.length === 1) return null
        if (data.length !== 10) throw new Type2Error(`GET_VERSION 响应长度异常（${data.length} 字节）`)
        if (!crcMatches(data)) throw new Type2Error('GET_VERSION CRC_A 校验失败')
        return data.slice(0, 8)
      } catch (error) {
        if (!attempt && this.selectedUid && error instanceof RfError) {
          this.trace(`GET_VERSION 射频异常，重新选定原 UID 后重试一次：${error.message}`)
          await this.requireTarget(this.selectedUid)
          continue
        }
        if (error instanceof RfError && error.detail.status === 0x0d && !error.detail.errorStatus) return null
        throw new Type2Error(`Type 2 GET_VERSION 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return null
  }

  /** 读一页（4 字节）。 */
  async readPage(page: number): Promise<Uint8Array> {
    if (!Number.isInteger(page) || page < 0 || page > 0xff) {
      throw new Type2Error('页号必须是 0..255')
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.trace(`读取页 ${page}～${page + 3}${attempt ? '（恢复后重试）' : ''}`)
        const data = await this.exchange(new Uint8Array([0x30, page]))
        if (data.length === 1) throw new Type2Error(`Type 2 READ 第 ${page} 页返回 NAK=0x${(data[0] & 15).toString(16)}，可能受保护或页号无效`)
        if (data.length !== 18) throw new Type2Error(`Type 2 READ 第 ${page} 页响应长度异常（${data.length} 字节）`)
        if (!crcMatches(data)) throw new Type2Error(`Type 2 READ 第 ${page} 页 CRC_A 校验失败`)
        return data.slice(0, 16)
      } catch (error) {
        if (!attempt && this.selectedUid && error instanceof RfError) {
          this.trace(`READ 页 ${page} 射频异常，重新选定原 UID 后仅重试读取一次：${error.message}`)
          await this.requireTarget(this.selectedUid)
          continue
        }
        throw new Type2Error(`Type 2 READ 第 ${page} 页失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Type2Error(`Type 2 READ 第 ${page} 页未完成`)
  }

  /** 读整段用户内存。 */
  async readUserMemory(size: number, quick = false): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < size) {
      const page = 4 + Math.floor(total / 4)
      const data = await this.readPage(page)
      const take = Math.min(16, size - total)
      chunks.push(data.slice(0, take))
      total += take
      if (quick && total >= Math.min(48, size)) {
        const prefix = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { prefix.set(chunk, offset); offset += chunk.length }
        if (hasTlvTerminator(prefix)) break
      }
    }
    const memory = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      memory.set(chunk, offset)
      offset += chunk.length
    }
    return memory
  }

  /** 写一页（4 字节）；写前写后都要重新选卡核对 UID。 */
  private async writePage(page: number, data: Uint8Array, uid: Uint8Array): Promise<void> {
    if (data.length !== 4) {
      throw new Type2Error('Type 2 一次只能写四字节')
    }
    await this.requireTarget(uid)
    const command = new Uint8Array(6)
    command[0] = 0xa2
    command[1] = page
    command.set(data, 2)
    this.trace(`写入用户页 ${page}（不自动重发）`)
    let reply
    try {
      reply = await this.bridge.exchange(withCrc(command), {
      allowType2Ack: true,
      crcTx: false,
      crcRx: false,
      timeoutMs: 100,
      confirmedTargetUid: uid,
      })
    } catch (error) {
      throw new Type2Error(`Type 2 WRITE 第 ${page} 页失败，结果未确认，未重发：${error instanceof Error ? error.message : String(error)}`)
    }
    const ack = reply.data
    if (reply.rxLastBits !== 4 || ack.length !== 1 || (ack[0] & 0x0f) !== 0x0a) {
      throw new Type2Error(`Type 2 写第 ${page} 页被拒绝`)
    }
    await this.requireTarget(uid)
    const readBack = await this.readPage(page)
    if (!equalBytes(readBack.slice(0, 4), data)) {
      throw new Type2Error(`Type 2 写第 ${page} 页后回读不一致`)
    }
  }

  /** 重新选卡并核对 UID：写操作必须确认还是同一张卡。 */
  private async requireTarget(expectedUid: Uint8Array): Promise<void> {
    const activation = await this.selectTarget()
    if (!equalBytes(activation.uid, expectedUid)) {
      throw new Type2Error('操作过程中卡片 UID 发生变化，已中止')
    }
    this.selectedUid = activation.uid.slice()
    await this.authenticateTarget()
  }

  /**
   * 写入一条 NDEF 文本。
   *
   * 需要用户输入确认的 UID——写标签是不可撤销的，UID 对不上就拒绝。
   */
  async writeText(text: string, confirmUid: string): Promise<Uint8Array> {
    return this.writeNdef(encodeTextRecord(text), confirmUid)
  }

  async writeUri(uri: string, confirmUid: string): Promise<Uint8Array> {
    return this.writeNdef(encodeUriRecord(uri), confirmUid)
  }

  private async writeNdef(message: Uint8Array, confirmUid: string): Promise<Uint8Array> {
    const info = this.info
    if (!info || !this.active) {
      throw new Type2Error('Type 2 会话尚未打开')
    }
    const cleaned = confirmUid.replace(/[^0-9a-fA-F]/g, '')
    if (cleaned.length !== info.uid.length * 2) {
      throw new Type2Error('确认用的 UID 必须是十六进制，且长度要与卡片一致')
    }
    const confirmed = new Uint8Array(cleaned.length / 2)
    for (let index = 0; index < confirmed.length; index += 1) {
      confirmed[index] = parseInt(cleaned.substr(index * 2, 2), 16)
    }
    if (!equalBytes(confirmed, info.uid)) {
      throw new Type2Error('确认的 UID 与当前卡片不一致')
    }

    if (info.capabilityContainer[3] & 0x0f) {
      throw new Type2Error('能力容器标记该标签为只读')
    }
    if (info.hasControlTlv) {
      throw new Type2Error('标签带有锁或内存控制 TLV，拒绝自动写入')
    }
    if (info.hasTlvAfterNdef) {
      throw new Type2Error('NDEF 之后还有其他 TLV，拒绝自动写入')
    }
    requireWritableNtag(info)

    const current = info.userMemory
    const old = info.ndefTlv
    const start = old ? old.start : info.appendOffset
    const encoded = encodeNdefTlv(message, Boolean(old && old.lengthWidth === 3))
    const writeEnd = start + encoded.length
    if (writeEnd > current.length) {
      throw new Type2Error('文本长度超出标签的用户内存')
    }

    const firstPage = 4 + Math.floor(start / 4)
    const lastPage = 4 + Math.floor((writeEnd - 1) / 4)
    if (lastPage > MAX_STATIC_LOCK_PAGE) {
      throw new Type2Error('NDEF 超出页 4..15，需要处理动态锁，拒绝自动写入')
    }

    const model = ntagModel(info.version)
    if (model) {
      const auth0 = (await this.readPage(model.configPage))[3]
      if (lastPage >= auth0 && !this.authenticated) throw new Type2Error('目标区域受密码保护，请使用已授权的认证流程')
    }
    const staticLocks = (await this.readPage(2)).slice(2, 4)
    for (let page = firstPage; page <= lastPage; page += 1) {
      if (page <= 7 && staticLocks[0] & (1 << page)) {
        throw new Type2Error(`第 ${page} 页已被静态锁定`)
      }
      if (page >= 8 && page <= 15 && staticLocks[1] & (1 << (page - 8))) {
        throw new Type2Error(`第 ${page} 页已被静态锁定`)
      }
    }

    const updated = current.slice()
    updated.set(encoded, start)

    // 长度字段分两步写：先写 0（让标签认为没有 NDEF），再写正文，
    // 最后写回真实长度。中间任何一步掉电，标签都不会拿着半截数据。
    const lengthOffset = start + 1
    const staged = updated.slice()
    if (encoded[1] === 0xff) {
      staged[lengthOffset + 1] = 0
      staged[lengthOffset + 2] = 0
    } else {
      staged[lengthOffset] = 0
    }
    const commitPage = 4 + Math.floor(lengthOffset / 4)
    const pageData = (memory: Uint8Array, page: number): Uint8Array => {
      const offset = (page - 4) * 4
      return memory.slice(offset, offset + 4)
    }
    const stagedCommit = pageData(staged, commitPage)
    if (!equalBytes(pageData(current, commitPage), stagedCommit)) {
      await this.writePage(commitPage, stagedCommit, info.uid)
    }
    for (let page = firstPage; page <= lastPage; page += 1) {
      if (page === commitPage) {
        continue
      }
      const data = pageData(staged, page)
      if (!equalBytes(pageData(current, page), data)) {
        await this.writePage(page, data, info.uid)
      }
    }
    const finalCommit = pageData(updated, commitPage)
    if (!equalBytes(stagedCommit, finalCommit)) {
      await this.writePage(commitPage, finalCommit, info.uid)
    }

    const verified = await this.readUserMemory(current.length)
    const parsed = scanType2Tlvs(verified)
    if (!parsed.ndef || !equalBytes(parsed.ndef.value, message)) {
      throw new Type2Error('NDEF 写入校验失败')
    }
    this.info = { ...info, authenticated: this.authenticated, userMemory: verified, ndefTlv: parsed.ndef, appendOffset: parsed.appendOffset }
    return message
  }
}

/** 字节数组是否相等。 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false
    }
  }
  return true
}

/** Allow known NTAG layouts only; page/lock/UID checks still apply separately. */
function requireWritableNtag(info: Type2TagInfo): void {
  const v = info.version
  const nxpTag = v && v.length === 8 && v[0] === 0 && v[1] === 4 && v[2] === 4 && v[7] === 3
  const i2c = nxpTag && v[3] === NTAG_I2C_PRODUCT_TYPE
  const ntag21x = nxpTag && v[3] === 2 && v[4] === 1 && v[5] === 0 && [0x0f, 0x11, 0x13].includes(v[6])
  if (!i2c && !ntag21x) throw new Type2Error('GET_VERSION 未确认是 NTAG 21x / I2C，暂不支持自动写入')
}

export type { Activation }

/** Parse TLV boundaries: FE inside an NDEF payload is not a terminator. */
export function hasTlvTerminator(memory: Uint8Array): boolean {
  let offset = 0
  while (offset < memory.length) {
    const tag = memory[offset++]
    if (tag === 0xfe) return true
    if (tag === 0) continue
    if (offset >= memory.length) return false
    let length = memory[offset++]
    if (length === 0xff) {
      if (offset + 2 > memory.length) return false
      length = (memory[offset] << 8) | memory[offset + 1]
      offset += 2
    }
    if (offset + length > memory.length) return false
    offset += length
  }
  return false
}
