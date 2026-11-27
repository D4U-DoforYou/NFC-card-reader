/**
 * 接收增益的两档设置对比。
 *
 * 增益高：芯片看得见卡拒绝握手时回的 4 位 NAK（错误寄存器是 MINFRAMEERR），
 *         能分清「卡拒了握手」和「卡没应答」，错密钥不用重试——但也更容易收到噪声。
 * 增益低：噪声少，但芯片看不见那 4 位 NAK，错误寄存器是空的，每把错密钥都要重跑一遍。
 *
 * 这里两种都跑一遍：各试 N 次正确密钥（看成功率）与 M 次错误密钥（看耗时与判定）。
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
  const bridge = epdSession.rfBridge
  const good = audit.fromHex('042C9C69CBD1')
  const bad = audit.fromHex('FFFFFFFFFFFF')
  const original = await bridge.readChipRegister(0x39)
  console.log(`RxAna(0x39) 默认值 0x${original.toString(16).padStart(2, '0')}\n`)

  async function run(label, gain) {
    await bridge.writeChipRegister(0x39, gain)
    const lines = []
    const session = new MifareClassicSession(bridge, message => lines.push(message))
    await session.open(audit.fromHex('560CAEE9'))
    let ok = 0
    let sum = 0
    const errors = []
    for (let i = 0; i < 12; i++) {
      const before = lines.length
      const t0 = now()
      const probe = await session.probeAuthenticate(0, good, 'A')
      sum += now() - t0
      if (probe === 'ok') ok++
      else errors.push(lines.slice(before).filter(l => l.includes('认证未')).join(' '))
    }
    const correctOk = ok
    const correctMs = Math.round(sum / 12)
    let rejected = 0
    sum = 0
    for (let i = 0; i < 8; i++) {
      const t0 = now()
      const probe = await session.probeAuthenticate(0, bad, 'A')
      sum += now() - t0
      if (probe !== 'ok') rejected++
    }
    console.log(`${label}：`)
    console.log(`  正确密钥 ${correctOk}/12 通过，平均 ${correctMs} ms`)
    if (errors.length) console.log(`  失败样本：${errors.slice(0, 3).join(' ｜ ')}`)
    console.log(`  错误密钥 ${rejected}/8 判定为不通过，平均 ${Math.round(sum / 8)} ms`)
    await session.close().catch(() => undefined)
  }

  await run('增益 2（芯片默认）', original & 0xfc | 2)
  await run('增益 1（降一档）    ', original & 0xfc | 1)
  await run('增益 2（芯片默认，再来一轮）', original & 0xfc | 2)

  await bridge.writeChipRegister(0x39, original)
  await relay.disconnect()
  await server.close()
}

await main()
