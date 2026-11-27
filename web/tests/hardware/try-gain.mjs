/**
 * 作业失败后错误寄存器里到底留了什么？
 *
 * 重点对比「会话打开时把接收增益调低」与「保持默认增益」两种情况：
 * 增益调低后芯片可能根本收不到卡回的 4 位 NAK，错误寄存器就空了，
 * 那样就没法区分「卡拒了握手」和「卡没应答」。
 */
import net from 'node:net'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })

const { transportManager } = await server.ssrLoadModule('/src/platform/transport.ts')
const { A01_PROFILE } = await server.ssrLoadModule('/src/core/protocol/a01/index.ts')
const { deviceSession } = await server.ssrLoadModule('/src/core/protocol/index.ts')
const { epdSession } = await server.ssrLoadModule('/src/core/rf/session.ts')
const { crcA } = await server.ssrLoadModule('/src/core/rf/crc.ts')
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
const withCrc = data => Uint8Array.from([...data, ...crcA(data)])

async function main() {
  await relay.connect()
  await deviceSession.require()
  const bridge = epdSession.rfBridge
  const uid = audit.fromHex('560CAEE9')
  const bad = audit.fromHex('FFFFFFFFFFFF')
  const good = audit.fromHex('042C9C69CBD1')
  const selectFrame = withCrc(Uint8Array.from([0x93, 0x70, ...uid, uid.reduce((a, b) => a ^ b, 0)]))

  async function selectCard() {
    await bridge.exchange(Uint8Array.of(0x26), { txLastBits: 7, shortResponse: 'atqa', timeoutMs: 100 })
    await bridge.exchange(selectFrame, { timeoutMs: 120, shortResponse: 'sak' })
  }

  async function attempt(key) {
    await bridge.cycleRfField()
    await selectCard()
    await bridge.executeChipCommand(2, key, { confirmedTargetUid: uid })
    let outcome
    try {
      const r = await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
      outcome = `完成 error 0x${r.error.toString(16)} status 0x${r.status.toString(16)}`
    } catch (error) {
      outcome = '作业失败'
    }
    const irq0 = await bridge.readChipRegister(0x06)
    const errorBits = await bridge.readChipRegister(0x0a)
    const status = await bridge.readChipRegister(0x0b)
    return `${outcome}；IRQ0=0x${irq0.toString(16).padStart(2, '0')} ERROR=0x${errorBits.toString(16).padStart(2, '0')} STATUS=0x${status.toString(16).padStart(2, '0')}`
  }

  console.log('默认增益：')
  for (let i = 0; i < 4; i++) {
    console.log(`  错密钥 ${i + 1}：${await attempt(bad)}`)
  }
  console.log(`  对密钥：${await attempt(good)}`)

  const rxAna = await bridge.readChipRegister(0x39)
  console.log(`\nRxAna(0x39) 当前值 0x${rxAna.toString(16).padStart(2, '0')}`)
  const restore = await bridge.prepareClassicRf()
  const rxAna2 = await bridge.readChipRegister(0x39)
  console.log(`调低之后 0x${rxAna2.toString(16).padStart(2, '0')}`)
  console.log('调低增益：')
  for (let i = 0; i < 4; i++) {
    console.log(`  错密钥 ${i + 1}：${await attempt(bad)}`)
  }
  console.log(`  对密钥：${await attempt(good)}`)
  await restore()

  await relay.disconnect()
  await server.close()
}

await main()
