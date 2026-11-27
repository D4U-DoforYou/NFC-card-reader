/**
 * 自动休眠：闲时脉冲保活与深睡窗口。
 *
 * B01 这类硬件的升压电路在射频场关闭时负载太轻，供电会自行断掉，
 * 设备随即掉电。为了既省电、又不至于掉线，闲时改成「短脉冲」方式保活：
 *
 * - 每 10 秒把射频场打开 1 秒再关掉，让设备醒一下；
 * - 这个脉冲循环只维持 10 分钟，这段时间里没有任何操作就停掉脉冲，
 *   设备进入深睡，网页端不再打扰它；
 * - 关掉「自动休眠」开关，脉冲循环就一直持续下去，设备永远不休眠。
 *
 * 忙的时候（刷图、通用 NFC 通信）不跑这套时序：射频场保持开着，
 * 由调用方用 `RfBridge.retainField()` 挂住。
 *
 * 这个模块只管时序，不关心射频场怎么开关——具体动作由驱动注入，
 * 这样脱离真机也能对节奏做回归测试。
 */

import { getStorageSync, setStorageSync } from '../../platform/storage'

/** 两次脉冲之间的间隔（毫秒）。 */
export const AUTO_SLEEP_PULSE_INTERVAL_MS = 10_000

/** 每次脉冲射频场开着的时长（毫秒）。 */
export const AUTO_SLEEP_PULSE_DURATION_MS = 1_000

/** 脉冲循环的维持时长（毫秒）：这段时间内没人操作就转入深睡。 */
export const AUTO_SLEEP_WINDOW_MS = 10 * 60_000

/** 开关在本地存储里的键。 */
const ENABLED_KEY = 'auto_sleep_enabled'

/**
 * 开关是否打开。
 *
 * 默认打开——自动休眠是这款硬件的默认行为。
 */
export function isAutoSleepEnabled(): boolean {
  const stored = getStorageSync(ENABLED_KEY)
  if (stored === '' || stored === undefined || stored === null) return true
  return Boolean(stored)
}

/** 记下开关状态。 */
export function setAutoSleepEnabled(enabled: boolean): void {
  setStorageSync(ENABLED_KEY, enabled)
}

/** 自动休眠的状态快照。 */
export interface AutoSleepState {
  /** 开关是否打开。 */
  enabled: boolean
  /** 正在执行脉冲（射频场被调度器打开着）。 */
  pulsing: boolean
  /** 已进入深睡：脉冲循环停了，等下一次操作唤醒。 */
  asleep: boolean
  /** 忙（刷图／读卡），射频场保持开启。 */
  busy: boolean
  /** 距离下一次脉冲还有多少毫秒；深睡时为 0。 */
  nextPulseInMs: number
  /** 深睡窗口剩余毫秒；开关关掉时为 0（没有窗口，脉冲持续循环）。 */
  windowRemainingMs: number
  /** 已执行的脉冲次数。 */
  pulses: number
}

/**
 * 调度器需要的外部信息与动作。
 *
 * 射频场怎么开关是设备的事，这里只描述「现在是什么状态」和「请把场打开/关上」。
 */
export interface AutoSleepDriver {
  /** 传输层是否已连接。 */
  connected(): boolean
  /** 射频场是否已经开着。 */
  fieldOn(): boolean
  /** 是否有操作占用射频场（刷图、读卡）。 */
  busy(): boolean
  /** 是否处于手动开场模式。 */
  manual(): boolean
  /** 最近一次射频活动的时间戳。 */
  lastActivityAt(): number
  /** 开关射频场。 */
  setField(on: boolean): Promise<void>
}

/** 时序参数；测试时可以把三段时长缩短。 */
export interface AutoSleepTimings {
  intervalMs?: number
  durationMs?: number
  windowMs?: number
}

/** 延时工具。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * 自动休眠调度器。
 *
 * 状态机只有四步：等 → 判忙 → 脉冲 → 再等。
 * 脉冲循环本身不延长深睡窗口，只有真实的射频活动才会重置窗口，
 * 否则设备永远醒着，「自动休眠」就名存实亡了。
 */
export class AutoSleepScheduler {
  private readonly intervalMs: number
  private readonly durationMs: number
  private readonly windowMs: number

  /** 下一次动作的定时器。 */
  private timer: number = 0
  /** 代际标记：脉冲进行中设备被断开或重启时，用来放弃那次脉冲。 */
  private generation = 0
  /** 是否在跑（连接中且方案支持）。 */
  private running = false
  /** 开关是否打开。 */
  private enabled = true
  /** 正在执行脉冲。 */
  private pulsing = false
  /** 当前脉冲是否已经把射频场打开了（用来在中断时收场）。 */
  private pulseOpened = false
  /** 已进入深睡。 */
  private asleep = false
  /** 已执行的脉冲次数。 */
  private pulses = 0
  /** 深睡窗口的到期时间；0 表示没有窗口（脉冲持续循环）。 */
  private windowEndsAt = 0
  /** 下一次动作的时间戳；0 表示没有排期。 */
  private nextAt = 0
  /** 状态监听。 */
  private listeners: Array<(state: AutoSleepState) => void> = []

  constructor(private readonly driver: AutoSleepDriver, timings: AutoSleepTimings = {}) {
    this.intervalMs = timings.intervalMs ?? AUTO_SLEEP_PULSE_INTERVAL_MS
    this.durationMs = timings.durationMs ?? AUTO_SLEEP_PULSE_DURATION_MS
    this.windowMs = timings.windowMs ?? AUTO_SLEEP_WINDOW_MS
  }

  /** 当前状态快照。 */
  get state(): AutoSleepState {
    const now = Date.now()
    return {
      enabled: this.enabled,
      pulsing: this.pulsing,
      asleep: this.asleep,
      busy: this.driver.busy(),
      nextPulseInMs: this.asleep || !this.running ? 0 : Math.max(0, this.nextAt - now),
      windowRemainingMs: this.windowEndsAt > 0 ? Math.max(0, this.windowEndsAt - now) : 0,
      pulses: this.pulses,
    }
  }

  /** 订阅状态变化。 */
  onChange(listener: (state: AutoSleepState) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  /** 广播一次状态。 */
  private emit(): void {
    const state = this.state
    this.listeners.forEach(listener => listener(state))
  }

  /**
   * 开始调度。
   *
   * 连接建立后调用：窗口从这一刻起算，10 分钟内没人操作就转入深睡。
   */
  start(): void {
    this.clearTimer()
    ++this.generation
    this.running = true
    this.pulses = 0
    this.pulsing = false
    this.asleep = false
    this.enabled = isAutoSleepEnabled()
    this.windowEndsAt = this.enabled ? Date.now() + this.windowMs : 0
    this.schedule(this.intervalMs)
    this.emit()
  }

  /** 停止调度（断开连接）。 */
  stop(): void {
    this.clearTimer()
    ++this.generation
    this.running = false
    this.pulsing = false
    this.asleep = false
    this.windowEndsAt = 0
    this.nextAt = 0
    if (this.pulseOpened) {
      // 脉冲正开着场就被打断：场是我们开的，立刻收回去，
      // 不能等脉冲那 1 秒走完，也不能把半开的场留在那儿。
      this.pulseOpened = false
      void this.driver.setField(false).catch(() => undefined)
    }
    this.emit()
  }

  /**
   * 开关自动休眠。
   *
   * 打开：从现在起重新算一段窗口，窗口内没人操作就转入深睡。
   * 关掉：脉冲循环持续下去，窗口作废。
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    setAutoSleepEnabled(enabled)
    if (!this.running) {
      this.emit()
      return
    }
    if (enabled) {
      this.windowEndsAt = Date.now() + this.windowMs
      this.asleep = false
    } else {
      this.windowEndsAt = 0
      this.asleep = false
    }
    this.schedule(this.intervalMs)
    this.emit()
  }

  /**
   * 报告一次射频活动。
   *
   * 设备被唤醒了，深睡窗口重新计时——刚用过就立刻睡着不合理。
   */
  notifyActivity(): void {
    if (!this.running) return
    const wasAsleep = this.asleep
    this.asleep = false
    if (this.enabled) this.windowEndsAt = Date.now() + this.windowMs
    if (wasAsleep) this.schedule(this.intervalMs)
    this.emit()
  }

  /** 排下一次动作。 */
  private schedule(delayMs: number): void {
    this.clearTimer()
    if (!this.running) {
      this.nextAt = 0
      return
    }
    const wait = Math.max(0, delayMs)
    this.nextAt = Date.now() + wait
    this.timer = setTimeout(() => {
      this.timer = 0
      void this.tick()
    }, wait) as unknown as number
  }

  /** 清掉定时器。 */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = 0
    }
  }

  /** 一次调度判断。 */
  private readonly tick = async (): Promise<void> => {
    if (!this.running) return
    if (!this.driver.connected()) return
    const now = Date.now()
    if (this.enabled && this.windowEndsAt > 0 && now >= this.windowEndsAt) {
      // 窗口内没人操作：停掉脉冲，设备进入深睡，等下次操作唤醒。
      this.asleep = true
      this.nextAt = 0
      this.emit()
      return
    }
    if (this.driver.busy() || this.driver.manual() || this.driver.fieldOn()) {
      // 忙的时候不脉冲：射频场已经开着，等下一轮再看。
      this.schedule(this.intervalMs)
      return
    }
    const idle = now - this.driver.lastActivityAt()
    if (idle < this.intervalMs) {
      this.schedule(this.intervalMs - idle)
      return
    }
    await this.pulse()
  }

  /**
   * 执行一次脉冲：开场 1 秒再关掉。
   *
   * 脉冲本身不算「活动」：它不会延长深睡窗口，否则设备永远醒着。
   */
  private async pulse(): Promise<void> {
    const generation = this.generation
    // 脉冲开始前的活动时刻：这一秒里设备被用过，就说明这不是「闲时」了。
    const activityAtStart = this.driver.lastActivityAt()
    this.pulsing = true
    this.emit()
    let done = false
    try {
      await this.driver.setField(true)
      if (generation !== this.generation) {
        // 这期间被打断了：场是我们开的，收回去。
        try {
          await this.driver.setField(false)
        } catch {
          // 设备可能已经断开。
        }
        return
      }
      this.pulseOpened = true
      await delay(this.durationMs)
      if (generation !== this.generation) return
      // 这一秒里设备可能被用起来了（刷图、读卡、手动开场）。
      // 闲时脉冲不能由我们关场：中途关场会把正在进行的通信打断，
      // 卡片当场复位，表现为「通信中断」。这时交给空闲关场定时器收尾。
      const used = this.driver.busy() || this.driver.manual() ||
        this.driver.lastActivityAt() !== activityAtStart
      if (used) {
        this.pulseOpened = false
        return
      }
      await this.driver.setField(false)
      this.pulseOpened = false
      done = true
    } catch {
      // 脉冲失败不致命：设备可能正在忙，下一轮再试。
    } finally {
      if (generation === this.generation) {
        if (this.pulseOpened) {
          // 场是我们开的就得由我们关，中途出错也不例外。
          this.pulseOpened = false
          try {
            await this.driver.setField(false)
          } catch {
            // 设备可能已经断开，关不掉了。
          }
        }
        this.pulsing = false
        if (done) this.pulses++
        this.emit()
      }
    }
    if (generation === this.generation) this.schedule(this.intervalMs)
  }
}
