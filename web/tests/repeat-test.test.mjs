import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())
const { runRepeatTest, waitForTest, validRepeatConfig } = await server.ssrLoadModule('/src/core/guide/repeatTest.ts')
const config = { rounds: 3, intervalSeconds: 2, retrySeconds: 7 }

test('success runs exactly the requested rounds with waits only between them', async () => {
  let calls = 0; const waits = [], events = []
  await runRepeatTest(config, async () => { calls++ }, new AbortController().signal, e => events.push(e), async ms => { waits.push(ms) })
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 2000]); assert.equal(events.at(-1).type, 'complete')
})
test('failure retries the same round before counting success', async () => {
  let calls = 0; const waits = [], events = []
  await runRepeatTest({ ...config, rounds: 2 }, async () => { if (++calls === 1) throw new Error('timeout') }, new AbortController().signal, e => events.push(e), async ms => { waits.push(ms) })
  assert.equal(calls, 3); assert.deepEqual(waits, [7000, 2000])
  assert.deepEqual(events.filter(e => e.type === 'attempt').map(e => [e.round, e.attempt]), [[1,1], [1,2], [2,1]])
})
test('stop during an in-flight operation waits for it and schedules no further writes', async () => {
  const controller = new AbortController(); let release; let calls = 0; const events = []
  const task = runRepeatTest(config, async () => { calls++; await new Promise(resolve => { release = resolve }) }, controller.signal, e => events.push(e))
  controller.abort(); assert.equal(calls, 1); release(); await task
  assert.equal(calls, 1); assert.equal(events.at(-1).type, 'stopped')
})
test('stop interrupts retry delay', async () => {
  const controller = new AbortController(); let calls = 0; const events = []
  await runRepeatTest(config, async () => { calls++; throw new Error('failed') }, controller.signal, e => { events.push(e); if (e.type === 'wait') controller.abort() })
  assert.equal(calls, 1); assert.equal(events.at(-1).type, 'stopped')
})
test('abortable wait resolves immediately after stop', async () => {
  const controller = new AbortController(); const wait = waitForTest(60000, controller.signal); controller.abort(); await wait
})
test('reject invalid counts and delays', async () => {
  for (const patch of [{ rounds: 0 }, { rounds: 1.5 }, { rounds: 10001 }, { intervalSeconds: -1 }, { retrySeconds: NaN }]) {
    assert.equal(validRepeatConfig({ ...config, ...patch }), false)
    await assert.rejects(runRepeatTest({ ...config, ...patch }, async () => {}, new AbortController().signal, () => {}))
  }
})
