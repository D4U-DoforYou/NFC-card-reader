/** 对比「密钥不对」与「密钥正确」时芯片报告的状态，用来给字典穷举分类。 */
import net from 'node:net'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
const { transportManager } = await server.ssrLoadModule('/src/platform/transport.ts')
const { A01_PROFILE } = await server.ssrLoadModule('/src/core/protocol/a01/index.ts')
const { deviceSession } = await server.ssrLoadModule('/src/core/protocol/index.ts')
const { epdSession } = await server.ssrLoadModule('/src/core/rf/session.ts')
const { activateTag, WAKE_FRAME_REQA, WAKE_FRAME_WUPA } = await server.ssrLoadModule('/src/core/rf/isoDep.ts')
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

const hex = v => `0x${v.toString(16).padStart(2, '0').toUpperCase()}`

await relay.connect()
await deviceSession.require()
const bridge = epdSession.rfBridge
const session = await deviceSession.require()

// 先把射频场彻底关掉一会儿，让卡复位，再唤醒。
await bridge.setRfField(false)
await new Promise(r => setTimeout(r, 400))
await bridge.cycleRfField()
let tag = null
for (let attemptIndex = 0; attemptIndex < 5 && !tag; attemptIndex += 1) {
  await bridge.cycleRfField()
  try {
    try {
      tag = await activateTag(bridge, WAKE_FRAME_REQA, { strictAtqa: false, requireIsoDep: false })
    } catch {
      await bridge.cycleRfField()
      tag = await activateTag(bridge, WAKE_FRAME_WUPA, { strictAtqa: false, requireIsoDep: false })
    }
  } catch (error) {
    console.log(`  唤醒重试 ${attemptIndex + 1}：${error.message}`)
  }
}
if (!tag) throw new Error('卡片无应答')
console.log(`UID=${audit.toHex(tag.uid)}\n`)

async function attempt(label, keyHex) {
  // MFAUTHENT 要求卡片处于 ACTIVE 状态，所以每次都要重新选卡。
  await bridge.cycleRfField()
  let picked = null
  for (const wake of [WAKE_FRAME_REQA, WAKE_FRAME_WUPA]) {
    try {
      picked = await activateTag(bridge, wake, { strictAtqa: false, requireIsoDep: false })
      break
    } catch { await bridge.cycleRfField() }
  }
  if (!picked) { console.log(`${label.padEnd(18)} 选卡失败`); return }
  const uid = picked.uid
  await bridge.writeChipRegister(0x0b, 0)
  const load = await bridge.executeChipCommand(2, audit.fromHex(keyHex), { confirmedTargetUid: uid })
  const auth = await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
  console.log(
    `${label.padEnd(18)} key=${keyHex}  LOAD(error=${hex(load.error)} irq0=${hex(load.irq0)} status=${hex(load.status)})  ` +
    `AUTH(error=${hex(auth.error)} irq0=${hex(auth.irq0)} irq1=${hex(auth.irq1)} status=${hex(auth.status)})  ` +
    `crypto1=${(auth.status & 0x20) ? 'ON' : 'OFF'}`,
  )
}

console.log('扇区 0（真密钥 042C9C69CBD1）：')
await attempt('正确密钥', '042C9C69CBD1')
await attempt('错误密钥', 'FFFFFFFFFFFF')
await attempt('错误密钥', '8DDA647A31AF')
await attempt('错误密钥', '000000000000')
await attempt('正确密钥（复测）', '042C9C69CBD1')

await relay.disconnect()
await server.close()
