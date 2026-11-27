/** 认证第一次失败是「时序」还是「卡没醒」？试不同延时。 */
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
await relay.connect()
await deviceSession.require()
const bridge = epdSession.rfBridge

async function selectCard() {
  for (const wake of [WAKE_FRAME_REQA, WAKE_FRAME_WUPA]) {
    try {
      return await activateTag(bridge, wake, { strictAtqa: false, requireIsoDep: false })
    } catch { await bridge.cycleRfField() }
  }
  return null
}

async function attempt(keyHex, delayMs) {
  await bridge.cycleRfField()
  const picked = await selectCard()
  if (!picked) return { ok: false, error: 0xff, note: '选卡失败' }
  if (delayMs) await new Promise(r => setTimeout(r, delayMs))
  const uid = picked.uid
  await bridge.writeChipRegister(0x0b, 0)
  await bridge.executeChipCommand(2, audit.fromHex(keyHex), { confirmedTargetUid: uid })
  const auth = await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
  return { ok: Boolean(auth.status & 0x20), error: auth.error, note: '' }
}

const KEY = '042C9C69CBD1'
for (const delayMs of [0, 50, 150, 300]) {
  let first = 0
  const results = []
  for (let i = 0; i < 6; i += 1) {
    const result = await attempt(KEY, delayMs)
    if (result.ok) first += 1
    results.push(result.ok ? 'OK' : `e${result.error.toString(16)}`)
  }
  console.log(`延时 ${String(delayMs).padStart(3)} ms：首试成功 ${first}/6  [${results.join(' ')}]`)
}

await relay.disconnect()
await server.close()
