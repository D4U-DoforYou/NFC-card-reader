/**
 * 诊断「一次试密钥」的时间花在哪。
 *
 * 重点看两件事：
 *   1. 卡拒绝过一次握手之后，下一次唤醒（REQA）要试几次才应答——
 *      唤醒重试是最贵的隐藏开销；
 *   2. 复位射频场的关场／开场延时能不能再短。
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

async function main() {
  await relay.connect()
  await deviceSession.require()
  const good = audit.fromHex('042C9C69CBD1')
  const bad = audit.fromHex('FFFFFFFFFFFF')

  for (const [label, key] of [['对密钥', good], ['错密钥', bad]]) {
    const lines = []
    const session = new MifareClassicSession(epdSession.rfBridge, message => lines.push(message))
    await session.open(audit.fromHex('560CAEE9'))
    const times = []
    for (let i = 0; i < 3; i++) {
      const before = lines.length
      const t0 = now()
      const probe = await session.probeAuthenticate(0, key, 'A')
      const dt = now() - t0
      const detail = lines.slice(before).filter(line => line.trim().length > 0)
      times.push(`${dt}ms（${probe}）${detail.length ? ' ' + detail.join(' | ') : ''}`)
    }
    console.log(`${label}：`)
    times.forEach(item => console.log(`  ${item}`))
    await session.close().catch(() => undefined)
  }

  await relay.disconnect()
  await server.close()
}

await main()
