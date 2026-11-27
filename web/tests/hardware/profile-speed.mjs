/**
 * 量一���一次认证到底花在哪：复位射频场 / 选卡 / 装密钥 / 认证。
 *
 * 一次「试一把密钥」= 上面四步串起来，哪一步慢就改哪一步。
 */
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

const now = () => Number(process.hrtime.bigint() / 1000000n)
const ms = a => `${a} ms`

async function main() {
  await relay.connect()
  await deviceSession.require()
  const bridge = epdSession.rfBridge
  const uid = audit.fromHex('560CAEE9')
  const wrongKey = audit.fromHex('FFFFFFFFFFFF')
  const rightKey = audit.fromHex('042C9C69CBD1')

  // 1) 单次复位射频场
  let t = now(); await bridge.cycleRfField(); const tCycle = now() - t

  // 2) 选卡：分别量唤醒与防冲突/选卡
  t = now()
  const wakeStart = now()
  const tag = await activateTag(bridge, WAKE_FRAME_REQA, { strictAtqa: false, requireIsoDep: false })
  const tSelect = now() - t

  // 3) 装密钥 + 认证（错密钥）
  t = now()
  await bridge.executeChipCommand(2, wrongKey, { confirmedTargetUid: uid })
  const tLoad = now() - t
  t = now()
  try {
    await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
  } catch { /* 作业失败也是一次完整往返 */ }
  const tAuthWrong = now() - t

  // 4) 认证（对密钥）
  t = now()
  await bridge.executeChipCommand(2, rightKey, { confirmedTargetUid: uid })
  await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
  const tAuthRight = now() - t

  // 5) 一次纯射频帧（不涉及认证）
  t = now()
  await bridge.exchange(new Uint8Array([0x26]), { txLastBits: 7, timeoutMs: 100 })
  const tRf = now() - t

  console.log(`复位射频场        ${ms(tCycle)}`)
  console.log(`选卡（唤醒+防冲突+选卡） ${ms(tSelect)}`)
  console.log(`装密钥 LOADKEY   ${ms(tLoad)}`)
  console.log(`认证（错密钥）    ${ms(tAuthWrong)}`)
  console.log(`认证（对密钥）    ${ms(tAuthRight)}`)
  console.log(`纯射频帧一次      ${ms(tRf)}`)
  console.log(`\n一轮「试一把密钥」预估 = 复位 ${tCycle} + 选卡 ${tSelect} + 装密钥 ${tLoad} + 认证 ${tAuthWrong} ≈ ${tCycle + tSelect + tLoad + tAuthWrong} ms`)

  // 6) 连续 10 次选卡，看唤醒要试几次
  console.log('\n连续 10 次选卡：')
  for (let i = 0; i < 10; i += 1) {
    const s = now()
    await bridge.cycleRfField()
    let ok = false
    try {
      await activateTag(bridge, WAKE_FRAME_REQA, { strictAtqa: false, requireIsoDep: false })
      ok = true
    } catch { /* 失败 */ }
    console.log(`  第 ${i + 1} 次：${ok ? '选中' : '没应答'} 用时 ${ms(now() - s)}`)
  }

  await relay.disconnect()
  await server.close()
}

await main()
