/**
 * 作业失败（芯片命令没跑完）之后，错误寄存器里还留着线索吗？
 *
 * 固件的等待逻辑：ERROR 正好是 MINFRAMEERR(0x10) 时它不当成「命令结束」，
 * 于是一直等到超时 → 作业失败 → 网页端以为要重试。
 * 如果这时能读到 ERROR 寄存器，就能分清「卡拒了握手」和「卡没应答」，
 * 前者不用重试，后者才值得重试。
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
const now = () => Number(process.hrtime.bigint() / 1000000n)
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

  async function registers() {
    const irq0 = await bridge.readChipRegister(0x06)
    const error = await bridge.readChipRegister(0x0a)
    const status = await bridge.readChipRegister(0x0b)
    return `IRQ0=0x${irq0.toString(16).padStart(2, '0')} ERROR=0x${error.toString(16).padStart(2, '0')} STATUS=0x${status.toString(16).padStart(2, '0')}`
  }

  async function attempt(key) {
    await bridge.cycleRfField()
    await selectCard()
    await bridge.executeChipCommand(2, key, { confirmedTargetUid: uid })
    try {
      const r = await bridge.executeChipCommand(3, new Uint8Array([0x60, 0, ...uid.slice(-4)]), { timeoutMs: 300, confirmedTargetUid: uid })
      return `完成：error 0x${r.error.toString(16)} status 0x${r.status.toString(16)}`
    } catch (error) {
      return `作业失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  console.log('错密钥（每次失败后立刻读寄存器）：')
  for (let i = 0; i < 8; i++) {
    const result = await attempt(bad)
    console.log(`  第 ${i + 1} 次：${result}；${await registers()}`)
  }
  console.log('\n对密钥：')
  for (let i = 0; i < 3; i++) {
    const result = await attempt(good)
    console.log(`  第 ${i + 1} 次：${result}；${await registers()}`)
  }

  await relay.disconnect()
  await server.close()
}

await main()
