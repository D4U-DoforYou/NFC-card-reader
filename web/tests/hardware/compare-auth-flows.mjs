/**
 * 比较几种认证流程的速度与成功率，为解卡引擎选最省时间的那套。
 *
 * A：现在的流程（复位射频场 → 选卡 → 装密钥 → 认证）
 * B：不复位射频场，直接重新选卡（卡拒绝过握手后停在 IDLE，仍可唤醒）
 * C：装密钥放到选卡之前
 * D：先认证一次、再选卡（复用同一次选卡）
 */
import net from 'node:net'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })

const { transportManager } = await server.ssrLoadModule('/src/platform/transport.ts')
const { A01_PROFILE } = await server.ssrLoadModule('/src/core/protocol/a01/index.ts')
const { deviceSession } = await server.ssrLoadModule('/src/core/protocol/index.ts')
const { epdSession } = await server.ssrLoadModule('/src/core/rf/session.ts')
const { activateTag, WAKE_FRAME_REQA } = await server.ssrLoadModule('/src/core/rf/isoDep.ts')
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
  const bridge = epdSession.rfBridge
  const uid = audit.fromHex('560CAEE9')
  const good = audit.fromHex('042C9C69CBD1')
  const bad = audit.fromHex('FFFFFFFFFFFF')

  async function selectCard() {
    const tag = await activateTag(bridge, WAKE_FRAME_REQA, { strictAtqa: false, requireIsoDep: false })
    if (!tag) throw new Error('选卡失败')
    return tag
  }

  async function loadKey(key) {
    await bridge.executeChipCommand(2, key, { confirmedTargetUid: uid })
  }

  async function auth(block) {
    const r = await bridge.executeChipCommand(3, new Uint8Array([0x60, block, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
    return { ok: Boolean(r.status & 0x20), error: r.error, irq0: r.irq0 }
  }

  // ---- 变体 A：完整流程（现状） ----
  const runA = async key => {
    await bridge.cycleRfField()
    await selectCard()
    await loadKey(key)
    return auth(0)
  }
  // ---- 变体 B：不复位射频场，直接选卡 ----
  const runB = async key => {
    await selectCard()
    await loadKey(key)
    return auth(0)
  }
  // ---- 变体 C：先装密钥再选卡 ----
  const runC = async key => {
    await loadKey(key)
    await bridge.cycleRfField()
    await selectCard()
    return auth(0)
  }

  for (const [name, fn] of [['A 完整流程', runA], ['B 不复位射频场', runB], ['C 先装密钥', runC]]) {
    for (const [label, key] of [['对密钥', good], ['错密钥', bad]]) {
      let ok = 0, failed = 0, total = 0, errors = []
      const t0 = now()
      const N = 8
      for (let i = 0; i < N; i++) {
        total++
        try {
          const r = await fn(key)
          if (r.ok) ok++
          else { failed++; errors.push(`0x${r.error.toString(16)}`) }
        } catch (e) {
          failed++
          errors.push('作业失败')
        }
      }
      const dt = now() - t0
      console.log(`${name.padEnd(16)} ${label}：成功 ${ok}/${N}，失败 ${failed} [${errors.join(' ')}]，平均 ${Math.round(dt / N)} ms`)
    }
  }

  await relay.disconnect()
  await server.close()
}

await main()
