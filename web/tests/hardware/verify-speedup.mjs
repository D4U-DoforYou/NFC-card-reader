/**
 * 真机验证解卡提速改动。
 *
 * 提速做了三件事，这里逐条验证它们没把正确性搭进去：
 *   1. 已知 UID 时直接 SELECT（跳过防冲突那一轮射频往返）；
 *   2. 去掉认证前那次「清状态寄存器」的寄存器写——复位射频场时固件已经清过了；
 *   3. 同一把密钥换扇区再试时不重复装密钥。
 *
 * 特别要盯住的是第 2 条：状态寄存器里的 Crypto1 标志如果没被清干净，
 * 上一次成功的认证会残留下来，让这一次的错密钥被误判成成功。
 * 所以这里专门跑一轮「对密钥 → 立刻错密钥」，错的那次必须判定为失败。
 *
 * 用法：先起 relay.py，再跑这个脚本。
 */
import net from 'node:net'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })

const { transportManager } = await server.ssrLoadModule('/src/platform/transport.ts')
const { A01_PROFILE } = await server.ssrLoadModule('/src/core/protocol/a01/index.ts')
const { deviceSession } = await server.ssrLoadModule('/src/core/protocol/index.ts')
const { epdSession } = await server.ssrLoadModule('/src/core/rf/session.ts')
const { MifareClassicSession } = await server.ssrLoadModule('/src/core/nfc/mifareClassic.ts')
const audit = await server.ssrLoadModule('/src/core/nfc/audit.ts')

class RelayTransport {
  kind = 'bluetooth'; status = 'idle'; chunkSize = 244
  connectedName = 'relay'; connectedDeviceId = 'relay'; connectedAt = 0
  hardwareProfile = A01_PROFILE; lastRssi = null; connectedDurationMs = 0
  socket = null; buffer = Buffer.alloc(0); dataListeners = []; statusListeners = []
  onStatus(l) { this.statusListeners.push(l) }
  onData(l) { this.dataListeners.push(l); return () => {} }
  onTrace() {} onError() {}
  emitStatus(s, m) { this.status = s; this.statusListeners.forEach(l => l(s, m)) }
  async connect() {
    this.emitStatus('connecting', '')
    this.socket = net.createConnection({ host: '127.0.0.1', port: 8791 })
    await new Promise((res, rej) => { this.socket.once('connect', res); this.socket.once('error', rej) })
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      for (;;) {
        if (this.buffer.length < 2) return
        const len = this.buffer.readUInt16BE(0)
        if (this.buffer.length < 2 + len) return
        const payload = this.buffer.subarray(2, 2 + len)
        this.buffer = this.buffer.subarray(2 + len)
        this.dataListeners.forEach(l => l(new Uint8Array(payload)))
      }
    })
    this.emitStatus('connected', '')
  }
  async writeChunk(bytes) {
    const header = Buffer.alloc(2); header.writeUInt16BE(bytes.length, 0)
    this.socket.write(Buffer.concat([header, Buffer.from(bytes)]))
  }
  async disconnect() { this.socket?.destroy(); this.emitStatus('idle', '') }
}

const relay = new RelayTransport()
transportManager.use(relay)
const now = () => Number(process.hrtime.bigint() / 1000000n)

const UID = '560CAEE9'
const GOOD = '042C9C69CBD1'
const BAD = 'FFFFFFFFFFFF'
/** 提速前的基线：同一张卡、同一段密钥流，一次「试一把密钥」约 2100 ms。 */
const BASELINE_MS = 2100

async function main() {
  await relay.connect()
  await deviceSession.require()
  const session = new MifareClassicSession(epdSession.rfBridge)
  await session.open(audit.fromHex(UID))
  console.log(`真卡已选上（UID ${UID}）\n`)

  const good = audit.fromHex(GOOD)
  const bad = audit.fromHex(BAD)
  /** 扇区 2 的真密钥：用来验「同一把密钥连着试两个块」。 */
  const other2 = audit.fromHex('6FEF5882D1D0')

  // ---- 1. 正确密钥：必须次次都通过 ----
  let ok = 0
  let sum = 0
  const N = 8
  for (let i = 0; i < N; i++) {
    const t0 = now()
    const probe = await session.probeAuthenticate(0, good, 'A')
    sum += now() - t0
    if (probe === 'ok') ok++
  }
  const goodMs = Math.round(sum / N)
  console.log(`1. 正确密钥：${ok}/${N} 通过，平均 ${goodMs} ms`)

  // ---- 2. 错误密钥：必须次次都不通过 ----
  let rejected = 0
  sum = 0
  for (let i = 0; i < N; i++) {
    const t0 = now()
    const probe = await session.probeAuthenticate(0, bad, 'A')
    sum += now() - t0
    if (probe !== 'ok') rejected++
  }
  const badMs = Math.round(sum / N)
  console.log(`2. 错误密钥：${rejected}/${N} 判定为不通过，平均 ${badMs} ms`)

  // ---- 3. 对密钥 → 立刻错密钥：错的那次绝不能被误判成成功 ----
  // 这一条专门盯「去掉清状态寄存器」那个改动：状态标志没清干净的话，
  // 上一次成功的认证会残留，让这一次的错密钥看起来也是对的。
  let falsePositive = 0
  for (let i = 0; i < 6; i++) {
    await session.probeAuthenticate(0, good, 'A')
    const probe = await session.probeAuthenticate(0, bad, 'A')
    if (probe === 'ok') falsePositive++
  }
  console.log(`3. 对→错交替：错密钥被误判成成功 ${falsePositive} 次（必须是 0）`)

  // ---- 4. 同一把密钥连着试两次：第二次不重装密钥也要过 ----
  // 这张卡每个扇区的密钥都不同，所以同一把密钥只在同一个扇区内换块来试。
  let bothOk = 0
  for (let i = 0; i < 4; i++) {
    const first = await session.probeAuthenticate(8, other2, 'A')
    const second = await session.probeAuthenticate(9, other2, 'A')
    if (first === 'ok' && second === 'ok') bothOk++
  }
  console.log(`4. 同一把密钥连试两个块：${bothOk}/4 都通过`)

  // ---- 5. 换一把密钥后仍然要重新判定 ----
  const other = audit.fromHex('8DDA647A31AF')
  let crossOk = 0
  for (let i = 0; i < 4; i++) {
    const probe = await session.probeAuthenticate(4, other, 'A')
    if (probe === 'ok') crossOk++
  }
  console.log(`5. 换一把密钥（扇区 1 的真密钥）：${crossOk}/4 通过`)

  await session.close().catch(() => undefined)
  await relay.disconnect()
  await server.close()

  const speed = Math.round((1 - goodMs / BASELINE_MS) * 100)
  console.log(`\n提速：${BASELINE_MS} ms → ${goodMs} ms（对密钥），快 ${speed}%`)
  const passed = ok === N && rejected === N && falsePositive === 0 && bothOk === 4 && crossOk === 4
  console.log(passed ? '结论：提速没伤正确性' : '结论：有指标不达标')
  process.exit(passed ? 0 : 1)
}

await main()
