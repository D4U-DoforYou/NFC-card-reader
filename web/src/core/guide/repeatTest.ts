export interface RepeatConfig { rounds: number; intervalSeconds: number; retrySeconds: number }
export interface RepeatEvent { type: 'start' | 'attempt' | 'success' | 'failure' | 'wait' | 'complete' | 'stopped'; round: number; attempt: number; message: string }
export function validRepeatConfig(config: RepeatConfig): boolean {
  return Number.isInteger(config.rounds) && config.rounds >= 1 && config.rounds <= 10000 &&
    [config.intervalSeconds, config.retrySeconds].every(n => Number.isFinite(n) && n >= 0 && n <= 86400)
}
export function waitForTest(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
/** Stop interrupts waits; an in-flight hardware write always finishes first. */
export async function runRepeatTest(config: RepeatConfig, flash: () => Promise<void>, signal: AbortSignal,
  emit: (event: RepeatEvent) => void, wait = waitForTest): Promise<void> {
  if (!validRepeatConfig(config)) throw new Error('测试参数无效')
  const send = (type: RepeatEvent['type'], round: number, attempt: number, message: string) => emit({ type, round, attempt, message })
  send('start', 0, 0, `开始测试，共 ${config.rounds} 轮`)
  for (let round = 1; round <= config.rounds; round++) {
    let attempt = 0
    while (!signal.aborted) {
      attempt++
      send('attempt', round, attempt, '开始刷图')
      try {
        await flash()
        send('success', round, attempt, '本轮刷图成功')
        break
      } catch (error) {
        send('failure', round, attempt, error instanceof Error ? error.message : String(error))
        if (!signal.aborted) {
          send('wait', round, attempt, `失败，${config.retrySeconds} 秒后重试本轮`)
          await wait(config.retrySeconds * 1000, signal)
        }
      }
    }
    if (signal.aborted) { send('stopped', round, attempt, '测试已停止'); return }
    if (round < config.rounds) {
      send('wait', round, attempt, `${config.intervalSeconds} 秒后开始下一轮`)
      await wait(config.intervalSeconds * 1000, signal)
    }
  }
  if (signal.aborted) send('stopped', config.rounds, 0, '测试已停止')
  else send('complete', config.rounds, 0, '全部轮次完成')
}
