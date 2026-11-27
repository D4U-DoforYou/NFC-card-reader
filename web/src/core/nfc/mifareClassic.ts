import type { RfBridge, RfReply } from '../rf/bridge'
import { RfError } from '../rf/bridge'
import { activateTag, WAKE_FRAME_REQA, WAKE_FRAME_WUPA } from '../rf/isoDep'
import { describeErrorBits } from '../rf/crc'
import type { ChipCommandResult } from '../protocol/types'

/**
 * MFAUTHENT 的等待时长（毫秒）。
 *
 * 100 ms 在部分卡上不够：卡片应答慢一点，芯片就报 NODATAERR|PROTERR（0x0A），
 * 认证会被误判成「密钥错误」。真机实测 300 ms 连续多轮全部成功。
 */
const AUTH_TIMEOUT_MS = 300

/**
 * 认证结果的分类。
 *
 * 控制器做 MIFARE 认证时只有两种可观察结果：建立了 Crypto1 会话（密钥对），
 * 或者没有。密钥不对时，卡会拒绝握手，芯片把它报成射频错误——
 * 和「卡没赶上」在报错上长得一样，所以不能凭报错就断言密钥错了。
 */
export type AuthProbe =
  /** 认证通过，密钥是对的。 */
  | 'ok'
  /** 密钥不对：卡主动拒了这次握手，再试也是这个结果。 */
  | 'wrong-key'
  /** 卡回了应答但帧不完整：它拒了这次握手（错密钥时它回 4 位 NAK）。 */
  | 'rejected'
  /** 这次没法定论（卡没应答），重试一次说不定就成。 */
  | 'inconclusive'

/** ERROR 寄存器位：卡没应答（NODATAERR）。 */
const ERROR_NO_DATA = 0x08
/** ERROR 寄存器位：收到不完整的帧（MINFRAMEERR）。错密钥时卡回的 4 位 NAK 就是这个。 */
const ERROR_MIN_FRAME = 0x10

/**
 * 判断控制器报的射频错误是「密钥不对」还是「还没定论」。
 *
 * 真机实测（同一张卡、同一段密钥流）：
 * - 错误的密钥 → 报 0x12（MINFRAMEERR|PROTERR），卡回了 4 位 NAK，
 *   它是明确拒了这次握手 → 不用重试，重试纯属浪费时间。
 * - 正确的密钥偶尔第一次没赶上 → 报 0x0A（NODATAERR|PROTERR），
 *   卡根本没应答 → 这种要重试。
 * - 还有 0x03（INTEGERR）：收到的是被噪声弄坏的帧，属于时序／信号问题，
 *   也得重试——不然真密钥会被误判成打不开。
 *
 * 之前只把 NODATAERR 当成「没定论」，其余一律重试，等于每把错密钥都跑两遍；
 * 现在反过来：只有「卡明确拒了握手」才不重试。
 */
export function classifyAuthError(error: number): 'wrong-key' | 'inconclusive' {
  return (error & ERROR_MIN_FRAME) && !(error & ERROR_NO_DATA) ? 'wrong-key' : 'inconclusive'
}

/**
 * 判断「芯片命令没跑完」这次失败要不要重试。
 *
 * 固件在作业失败时不会把错误寄存器的内容带回来（作业本身失败了），
 * 这里用自己读到的错误位来判断：
 * - MINFRAMEERR（0x10）且没有 NODATAERR：卡回了应答但帧不完整——
 *   错密钥时它回的就是 4 位 NAK，再试一次还是这个结果，不用重试；
 * - NODATAERR（0x08）：卡压根没应答，是时序抖动，值得再试一次；
 * - 读不到寄存器或别的原因：没法定论，重试一次最保险。
 *
 * 真机实测：错密钥时错误寄存器稳定是 0x10，成功认证后是 0x00——
 * 这个寄存器跟着上一条命令走，不会留旧值。
 */
export function classifyAuthTimeout(error: number | null): 'rejected' | 'inconclusive' {
  if (error === null) {
    return 'inconclusive'
  }
  if ((error & ERROR_MIN_FRAME) && !(error & ERROR_NO_DATA)) {
    return 'rejected'
  }
  return 'inconclusive'
}

/** 一次认证的结果。 */
export interface AuthOutcome {
  /** 分类。 */
  probe: AuthProbe
  /** 控制器报的射频错误；0 表示没报错。 */
  error: number
  /** 值不值得重试一次。 */
  retryable: boolean
  /** 控制器原始状态。 */
  result?: ChipCommandResult
  /** 定位信息。 */
  target: string
  /** 诊断文本。 */
  detail: string
}

export class MifareClassicRfError extends Error {
  constructor(message: string, readonly result: ChipCommandResult) {
    super(message)
    this.name = 'MifareClassicRfError'
  }
}

/** Real Classic 1K access. Crypto1 and encrypted parity stay on the controller. */
export class MifareClassicSession {
  private uid: Uint8Array | null = null
  /** 芯片里当前装着的密钥；同一把密钥换扇区再试时不用重装。 */
  private loadedKey: string | null = null
  private restoreReception: (() => Promise<void>) | null = null
  constructor(private bridge: RfBridge, private trace: (message: string) => void = () => {}) {}

  async open(expectedUid: Uint8Array): Promise<void> {
    if (this.uid) throw new Error('Classic 会话已打开，请先关闭')
    if (![4, 7].includes(expectedUid.length)) throw new Error('请先识别 Classic 1K 卡片 UID')
    try {
      await this.select(expectedUid)
      this.uid = expectedUid.slice()
      this.restoreReception = await this.bridge.prepareClassicRf?.() ?? null
    } catch (error) {
      this.uid = null
      await this.bridge.turnOffField().catch(() => undefined)
      throw error
    }
  }

  private async select(expectedUid: Uint8Array): Promise<void> {
    await this.bridge.cycleRfField()
    // 先问 REQA，再问 WUPA：有些卡（尤其是克隆卡）只应 REQA，
    // 有些卡在休眠后只有 WUPA 才醒。两种都试一遍最稳。
    //
    // 已知 UID 时走快路径：SELECT 自带卡号，只有「学卡号」才需要防冲突那一轮，
    // 批量认证时这一轮就是白等的一次射频往返。
    let tag: Awaited<ReturnType<typeof activateTag>> | null = null
    const failures: string[] = []
    for (const wake of [WAKE_FRAME_REQA, WAKE_FRAME_WUPA]) {
      try {
        tag = await activateTag(this.bridge, wake, {
          strictAtqa: false,
          requireIsoDep: false,
          knownUid: expectedUid,
          trace: message => this.trace(message),
        })
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        this.trace(`选卡失败（${wake === WAKE_FRAME_REQA ? 'REQA' : 'WUPA'}）：${message}`)
      }
      await this.bridge.cycleRfField()
    }
    if (!tag) {
      throw new Error(`卡片没有应答（期望 UID ${hexBytes(expectedUid)}）：${failures.join('；')}`)
    }
    if (tag.sak !== 0x08) throw new Error('当前只支持 MIFARE Classic 1K（SAK 08）')
    if (!same(tag.uid, expectedUid)) throw new Error('卡片 UID 发生变化，已停止，未发送密钥')
  }

  private validate(block: number, key: Uint8Array, keyType: 'A' | 'B'): void {
    if (!this.uid) throw new Error('Classic 会话尚未打开')
    if (!Number.isInteger(block) || block < 0 || block > 63) throw new Error('Classic 1K 块号必须为 0–63')
    if (key.length !== 6 || !['A', 'B'].includes(keyType)) throw new Error('请提供 6 字节 Key A 或 Key B')
  }

  async authenticate(block: number, key: Uint8Array, keyType: 'A' | 'B' = 'A'): Promise<void> {
    const outcome = await this.runAuth(block, key, keyType)
    if (outcome.probe === 'ok') {
      this.trace('Crypto1 认证通过')
      return
    }
    if (outcome.probe === 'inconclusive') {
      throw new MifareClassicRfError(
        `Key ${keyType} 认证失败：控制器报告射频错误，不能据此判定密钥错误（${outcome.target}；${outcome.detail}）`,
        outcome.result ?? { fifoOutput: new Uint8Array(0), irq0: 0, irq1: 0, error: outcome.error, status: 0 },
      )
    }
    if (outcome.probe === 'rejected') {
      throw new Error(
        `Key ${keyType} 认证未通过：卡回了应答但帧不完整，没有建立 Crypto1 会话（${outcome.target}；${outcome.detail}）`,
      )
    }
    throw new Error(
      `Key ${keyType} 认证未通过：未建立 Crypto1 会话，请核对当前卡片与扇区密钥（${outcome.target}；${outcome.detail}）`,
    )
  }

  /**
   * 只试探一把密钥对不对，不抛异常。
   *
   * 字典穷举要用：控制器报射频错误时不能断言密钥错了。
   * 只有「卡没应答」（NODATAERR）这种没定论的情况才重试一次——
   * 卡明确拒了握手（MINFRAMEERR）的话，再试一遍结果不会变，
   * 白花一次完整的射频往返。
   */
  async probeAuthenticate(
    block: number,
    key: Uint8Array,
    keyType: 'A' | 'B' = 'A',
  ): Promise<AuthProbe> {
    let outcome = await this.runAuth(block, key, keyType, false)
    if (outcome.probe === 'inconclusive' && outcome.retryable) {
      outcome = await this.runAuth(block, key, keyType, false)
    }
    return outcome.probe
  }

  /** 认证的共同流程：复位射频场、重新选卡、装密钥、跑认证。 */
  private async runAuth(
    block: number,
    key: Uint8Array,
    keyType: 'A' | 'B',
    trace = true,
  ): Promise<AuthOutcome> {
    this.validate(block, key, keyType)
    const uid = this.uid!
    const target = `扇区 ${Math.floor(block / 4)} · 块 ${block} · UID ${hexBytes(uid)}`
    await this.select(uid)
    // 这里原本还有一次「清状态寄存器」的寄存器写。
    // 它是多余的：上面复位射频场时固件的关场动作已经把状态寄存器清零了
    // （固件 set_rf_field(false) 会写 STATUS=0，等价于 mfrc630_MF_deauth），
    // 而状态寄存器里的 Crypto1-on 标志必须清掉，否则上一次成功的认证会残留下来，
    // 让这一次的错密钥被误判成成功。省掉这一次写，每把密钥就少一个蓝牙往返。
    if (trace) {
      this.trace(`认证块 ${block} · 扇区 ${Math.floor(block / 4)} · Key ${keyType} · UID ${hexBytes(uid)}`)
    }
    // 同一把密钥换扇区再试时，芯片里还留着它，不用重装（省一次射频往返）。
    const keyHex = Array.from(key, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
    if (this.loadedKey !== keyHex) {
      const load = await this.bridge.executeChipCommand(2, key.slice(), { confirmedTargetUid: uid })
      if (load.error || load.irq0 & 0x02) {
        // 密钥没装进去就没资格谈对错，直接停在这里，不要继续认证。
        throw new Error(`密钥加载失败，未执行认证：${chipStatus(load)}`)
      }
      this.loadedKey = keyHex
    }
    let auth: ChipCommandResult
    try {
      auth = await this.bridge.executeChipCommand(3, new Uint8Array([keyType === 'A' ? 0x60 : 0x61, block, ...uid.slice(-4)]), { timeoutMs: AUTH_TIMEOUT_MS, confirmedTargetUid: uid })
    } catch (error) {
      // 芯片命令在时限内没跑完时，固件会把整个作业判为失败。
      // 这既可能是密钥不对（卡没接住握手），也可能是射频没赶上——
      // 没法定论，不能当成密钥错误。
      //
      // 但要不要重试是可以判断的：固件不会把错误寄存器带回来，自己读一次。
      // 错密钥时卡回 4 位 NAK，错误寄存器是 MINFRAMEERR(0x10)，
      // 这种再试一次还是被拒，白花一次完整的射频往返；
      // 卡没应答时是 NODATAERR(0x08)，那是时序抖动，值得再试。
      const message = error instanceof Error ? error.message : String(error)
      const bits = await this.readErrorRegister()
      const verdict = classifyAuthTimeout(bits)
      const detail =
        `芯片命令未完成：${message}` +
        (bits === null ? '' : ` ERROR=0x${bits.toString(16).padStart(2, '0').toUpperCase()}`) +
        (verdict === 'rejected' ? '（卡回了应答但帧不完整：它拒了这次握手）' : '')
      this.trace(`认证未完成：${detail}`)
      return {
        probe: verdict === 'rejected' ? 'rejected' : 'inconclusive',
        error: bits ?? 0,
        retryable: verdict === 'inconclusive',
        target,
        detail,
      }
    }
    if (auth.error || auth.irq0 & 0x02) {
      // 控制器报了射频错误。措辞上不能断言密钥错了（卡没应答与握手被拒长得一样），
      // 但「要不要重试」可以由错误位决定：
      // 只有「卡回了不完整的帧」（MINFRAMEERR 且没有 NODATAERR）才是它明确拒了握手，
      // 那种再试一次还是被拒；其余（没应答、收到坏帧、碰撞）都是时序问题，值得再试。
      const detail = chipStatus(auth)
      this.trace(`认证未通过：${detail}`)
      const rejected = Boolean((auth.error & ERROR_MIN_FRAME) && !(auth.error & ERROR_NO_DATA))
      return {
        probe: rejected ? 'rejected' : 'inconclusive',
        error: auth.error,
        retryable: !rejected,
        result: auth,
        target,
        detail,
      }
    }
    if (!(auth.status & 0x20)) {
      return { probe: 'wrong-key', error: 0, retryable: false, result: auth, target, detail: chipStatus(auth) }
    }
    return { probe: 'ok', error: 0, retryable: false, result: auth, target, detail: chipStatus(auth) }
  }

  /**
   * 读错误寄存器（0x0A）。
   *
   * 作业失败时固件不会把错误位带回来，只能自己读。
   * 读不到就返回 null，交给调用方按「没定论」处理。
   */
  private async readErrorRegister(): Promise<number | null> {
    try {
      return await this.bridge.readChipRegister(0x0a)
    } catch {
      return null
    }
  }

  private async readAuthenticated(block: number): Promise<Uint8Array> {
    const reply = await this.bridge.exchange(Uint8Array.of(0x30, block), { crcTx: true, crcRx: true, timeoutMs: 100, confirmedTargetUid: this.uid! })
    if (reply.errorStatus || reply.rxLastBits || reply.data.length !== 16) throw new Error(`块 ${block} 的读取应答无效`)
    return reply.data.slice()
  }

  async readBlock(block: number, key: Uint8Array, keyType: 'A' | 'B' = 'A'): Promise<Uint8Array> {
    return (await this.readBlocks([block], key, keyType)).get(block)!
  }

  async readSector(sector: number, key: Uint8Array, keyType: 'A' | 'B' = 'A', includeTrailer = false): Promise<Map<number, Uint8Array>> {
    if (!Number.isInteger(sector) || sector < 0 || sector > 15) throw new Error('Classic 1K 扇区号必须为 0–15')
    return this.readBlocks(Array.from({ length: includeTrailer ? 4 : 3 }, (_, index) => sector * 4 + index), key, keyType)
  }

  /** Read several blocks in the same sector without restarting its Crypto1 session. */
  async readBlocks(blocks: readonly number[], key: Uint8Array, keyType: 'A' | 'B' = 'A'): Promise<Map<number, Uint8Array>> {
    if (!blocks.length) throw new Error('请至少选择一个数据块')
    for (const block of blocks) this.validate(block, key, keyType)
    const sector = Math.floor(blocks[0] / 4)
    if (blocks.some(block => Math.floor(block / 4) !== sector)) throw new Error('连续读取的数据块必须属于同一扇区')
    const read = async (): Promise<Map<number, Uint8Array>> => {
      await this.authenticate(blocks[0], key, keyType)
      const data = new Map<number, Uint8Array>()
      for (const block of blocks) {
        data.set(block, await this.readAuthenticated(block))
        this.trace(`块 ${block} 读取完成`)
      }
      return data
    }
    try { return await read() }
    catch (error) {
      if (!(error instanceof RfError || error instanceof MifareClassicRfError)) throw error
      this.trace(`扇区 ${sector} 射频应答异常，重新选卡后重读一次`)
      // authenticate reactivates the field and checks the same UID again.
      return read()
    }
  }

  async writeBlock(block: number, data: Uint8Array, key: Uint8Array, keyType: 'A' | 'B' = 'A'): Promise<Uint8Array> {
    this.validate(block, key, keyType)
    if (block === 0 || block % 4 === 3) throw new Error('不能写入制造商块或扇区尾块（密钥／访问条件）')
    if (data.length !== 16) throw new Error('每个数据块必须恰好 16 字节')
    const bytes = data.slice()
    await this.authenticate(block, key, keyType)
    try {
      const options = { crcTx: true, crcRx: false, timeoutMs: 100, confirmedTargetUid: this.uid!, allowMifareAck: true }
      requireAck(await this.bridge.exchange(Uint8Array.of(0xa0, block), options))
      requireAck(await this.bridge.exchange(bytes, options))
      const actual = await this.readAuthenticated(block)
      if (!same(actual, bytes)) throw new Error('回读数据与写入内容不一致')
      this.trace(`块 ${block} 写入并通过回读校验`)
      return actual
    } catch (error) {
      throw new Error(`块 ${block} 写入未确认，未自动重发：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 写厂商块（第 0 块）。
   *
   * 普通读卡流程里第 0 块是只读的（制造商信息），但 UID / FUID 这类克隆卡的
   * 第 0 块存放 UID，把它改回可以锁死 UID，让卡不能再改。
   * 这个动作不可撤销，调用方必须自己确认过。
   */
  async writeUidBlock(data: Uint8Array, key: Uint8Array, keyType: 'A' | 'B' = 'A'): Promise<Uint8Array> {
    if (!this.uid) throw new Error('Classic 会话尚未打开')
    if (data.length !== 16) throw new Error('每个数据块必须恰好 16 字节')
    await this.authenticate(4, key, keyType)
    const options = { crcTx: true, crcRx: false, timeoutMs: 100, confirmedTargetUid: this.uid!, allowMifareAck: true }
    requireAck(await this.bridge.exchange(Uint8Array.of(0xa0, 0), options))
    requireAck(await this.bridge.exchange(data.slice(), options))
    const actual = await this.readAuthenticated(0)
    if (!same(actual, data)) throw new Error('回读数据与写入内容不一致')
    this.trace('厂商块写入并通过回读校验')
    return actual
  }

  async close(): Promise<void> {
    const uid = this.uid
    const restore = this.restoreReception
    this.uid = null
    this.restoreReception = null
    try {
      await this.bridge.writeChipRegister(0x0b, 0)
      if (uid) await this.bridge.executeChipCommand(2, new Uint8Array(6), { confirmedTargetUid: uid })
      this.loadedKey = null
    } finally {
      try { await restore?.() }
      finally { await this.bridge.turnOffField() }
    }
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]) }
function hexBytes(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') }
function chipStatus(result: ChipCommandResult): string {
  const hex = (value: number) => `0x${value.toString(16).padStart(2, '0').toUpperCase()}`
  const errors = describeErrorBits(result.error)
  return `ERROR=${hex(result.error)}${errors.length ? `（${errors.join(' | ')}）` : ''} IRQ0=${hex(result.irq0)} IRQ1=${hex(result.irq1)} STATUS=${hex(result.status)}`
}
function requireAck(reply: RfReply): void {
  if (reply.errorStatus || reply.irq0Status & 2 || reply.data.length !== 1 || ![0, 4].includes(reply.rxLastBits) || (reply.data[0] & 15) !== 10) throw new Error('标签未确认写入（NAK 或无效 ACK）')
}
