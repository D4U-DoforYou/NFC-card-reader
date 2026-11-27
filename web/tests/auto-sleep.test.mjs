import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

// 自动休眠的开关存在 localStorage 里，Node 环境下没有 window，
// 补一个内存版的替身，顺带把「记住选择」也测了。
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: key => { storage.delete(key) },
  },
}

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const {
  AutoSleepScheduler,
  AUTO_SLEEP_PULSE_INTERVAL_MS,
  AUTO_SLEEP_PULSE_DURATION_MS,
  AUTO_SLEEP_WINDOW_MS,
  isAutoSleepEnabled,
  setAutoSleepEnabled,
} = await server.ssrLoadModule('/src/core/rf/autoSleep.ts')

/** 等一会儿。 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 假设备：只回答「现在什么状态」，并记录开关动作。 */
function makeDriver() {
  const state = {
    connected: true,
    fieldOn: false,
    busy: false,
    manual: false,
    lastActivityAt: Date.now(),
    /** 每次开关射频场记一笔。 */
    switches: [],
  }
  return {
    state,
    driver: {
      connected: () => state.connected,
      fieldOn: () => state.fieldOn,
      busy: () => state.busy,
      manual: () => state.manual,
      lastActivityAt: () => state.lastActivityAt,
      async setField(on) {
        state.fieldOn = on
        state.switches.push({ on, at: Date.now() })
      },
    },
    /** 开场的次数。 */
    opens: () => state.switches.filter(item => item.on).length,
  }
}

test('默认打开自动休眠，并且记住用户的选择', () => {
  storage.clear()
  assert.equal(isAutoSleepEnabled(), true)
  setAutoSleepEnabled(false)
  assert.equal(isAutoSleepEnabled(), false)
  setAutoSleepEnabled(true)
  assert.equal(isAutoSleepEnabled(), true)
})

test('默认时序就是每 10 秒唤醒 1 秒、循环 10 分钟', () => {
  assert.equal(AUTO_SLEEP_PULSE_INTERVAL_MS, 10_000)
  assert.equal(AUTO_SLEEP_PULSE_DURATION_MS, 1_000)
  assert.equal(AUTO_SLEEP_WINDOW_MS, 10 * 60_000)
})

test('闲时每 10 秒把射频场打开 1 秒再关掉', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 15, durationMs: 4, windowMs: 5_000 })
  scheduler.start()
  await wait(140)
  scheduler.stop()
  await wait(20)
  // 140 毫秒里至少该有几次脉冲。
  assert.ok(fake.opens() >= 3, `期望至少 3 次唤醒，实际 ${fake.opens()}`)
  // 每次开场都配一次关场：场是我们开的，就得由我们关。
  const closes = fake.state.switches.filter(item => !item.on).length
  assert.equal(closes, fake.opens())
  assert.equal(fake.state.fieldOn, false)
})

test('脉冲被打断时射频场要收回去', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  // 场开着的时间比观察窗口还长，保证停的时候脉冲正开着。
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 400, windowMs: 5_000 })
  scheduler.start()
  await wait(40)
  assert.equal(fake.state.fieldOn, true)
  scheduler.stop()
  await wait(20)
  assert.equal(fake.state.fieldOn, false)
})

test('忙的时候不唤醒，射频场留给刷图和读卡', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  fake.state.busy = true
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 5_000 })
  scheduler.start()
  await wait(90)
  assert.equal(fake.opens(), 0)
  assert.equal(scheduler.state.busy, true)
  // 忙完就恢复脉冲。
  fake.state.busy = false
  await wait(60)
  assert.ok(fake.opens() > 0)
  scheduler.stop()
})

test('手动开着射频场时不抢着脉冲', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  fake.state.manual = true
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 5_000 })
  scheduler.start()
  await wait(80)
  assert.equal(fake.opens(), 0)
  scheduler.stop()
})

test('10 分钟内没人操作就停掉脉冲，进入深睡', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 50 })
  scheduler.start()
  await wait(30)
  assert.equal(scheduler.state.asleep, false)
  assert.ok(fake.opens() > 0)
  // 窗口耗尽后转入深睡。
  await wait(150)
  assert.equal(scheduler.state.asleep, true)
  assert.equal(scheduler.state.nextPulseInMs, 0)
  // 深睡之后不再打扰设备。
  const before = fake.opens()
  await wait(90)
  assert.equal(fake.opens(), before)
  scheduler.stop()
})

test('射频活动会唤醒设备并重置深睡窗口', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 50 })
  scheduler.start()
  await wait(160)
  assert.equal(scheduler.state.asleep, true)
  // 用了一次设备：窗口重新计时，脉冲也恢复。
  fake.state.lastActivityAt = Date.now()
  scheduler.notifyActivity()
  assert.equal(scheduler.state.asleep, false)
  assert.ok(scheduler.state.windowRemainingMs > 0)
  await wait(60)
  assert.ok(fake.opens() > 0)
  scheduler.stop()
})

test('关掉自动休眠，脉冲就持续循环下去', async () => {
  setAutoSleepEnabled(false)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 30 })
  scheduler.start()
  await wait(200)
  assert.equal(scheduler.state.asleep, false)
  // 没有窗口：不会因为时间到就停下。
  assert.equal(scheduler.state.windowRemainingMs, 0)
  assert.ok(fake.opens() >= 5, `期望至少 5 次唤醒，实际 ${fake.opens()}`)
  scheduler.stop()
})

test('打开自动休眠会重新开始算窗口', async () => {
  setAutoSleepEnabled(false)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 40 })
  scheduler.start()
  await wait(120)
  assert.equal(scheduler.state.windowRemainingMs, 0)
  scheduler.setEnabled(true)
  assert.ok(scheduler.state.windowRemainingMs > 0)
  assert.equal(scheduler.state.asleep, false)
  scheduler.stop()
})

test('脉冲期间设备被用起来了就不能关场', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  // 脉冲持续 150 毫秒，比观察窗口长，保证中途能塞进一次活动。
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 150, windowMs: 5_000 })
  scheduler.start()
  await wait(30)
  assert.equal(fake.state.fieldOn, true)
  // 脉冲这 1 秒里设备被用起来了（刷图、读卡、手动开场）。
  fake.state.lastActivityAt = Date.now()
  await wait(200)
  // 场不能被脉冲抢着关掉：中途关场会把正在进行的通信打断，卡片当场复位。
  assert.equal(fake.state.fieldOn, true)
  scheduler.stop()
})

test('设备忙的时候脉冲也不能抢着关场', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 150, windowMs: 5_000 })
  scheduler.start()
  await wait(30)
  assert.equal(fake.state.fieldOn, true)
  fake.state.busy = true
  await wait(200)
  assert.equal(fake.state.fieldOn, true)
  scheduler.stop()
})

test('手动开场的时候脉冲也不能抢着关场', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 150, windowMs: 5_000 })
  scheduler.start()
  await wait(30)
  assert.equal(fake.state.fieldOn, true)
  fake.state.manual = true
  await wait(200)
  assert.equal(fake.state.fieldOn, true)
  scheduler.stop()
})

test('断开连接就停掉调度，不再有脉冲', async () => {
  setAutoSleepEnabled(true)
  const fake = makeDriver()
  const scheduler = new AutoSleepScheduler(fake.driver, { intervalMs: 10, durationMs: 2, windowMs: 5_000 })
  scheduler.start()
  await wait(40)
  scheduler.stop()
  const before = fake.opens()
  await wait(80)
  assert.equal(fake.opens(), before)
  assert.equal(scheduler.state.asleep, false)
  assert.equal(scheduler.state.nextPulseInMs, 0)
})
