/**
 * 真机验证「一键解卡」。
 *
 * 用真卡跑两轮：
 *   1. 字典里只有错误的密钥 → 应该一个扇区都打不开；
 *   2. 字典里放进真密钥 → 应该打开对应的扇区，并把数据读出来。
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
const tools = await server.ssrLoadModule('/src/core/nfc/mifareTools.ts')

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

const WRONG_KEYS = ['FFFFFFFFFFFF', '000000000000', 'A0A1A2A3A4A5', '123456789ABC']
const REAL_KEYS = {
  0: '042C9C69CBD1',
  1: '8DDA647A31AF',
  2: '6FEF5882D1D0',
  3: '76156B34062E',
}

const relay = new RelayTransport()
transportManager.use(relay)

async function main() {
  await relay.connect()
  await deviceSession.require()
  const session = new MifareClassicSession(epdSession.rfBridge)
  await session.open(audit.fromHex('560CAEE9'))
  console.log('真卡已选上\n')

  // ---- 1. 字典里全是错的密钥 ----
  console.log('第 1 轮：字典里只有错误密钥')
  const wrong = await audit.crackCard(session, { keys: WRONG_KEYS, readSectors: false })
  console.log(`  试了 ${wrong.tested} 把，解开 ${wrong.sectors.filter(s => s.unlocked).length} 个扇区`)
  console.log(`  内置字典共 ${tools.BUILTIN_KEYS.length} 条，首条 ${tools.BUILTIN_KEYS[0]}`)

  // ---- 2. 字典里放进真密钥 ----
  console.log('\n第 2 轮：字典里加入真密钥')
  const started = Date.now()
  const real = await audit.crackCard(session, {
    keys: [...WRONG_KEYS, ...Object.values(REAL_KEYS)],
    readSectors: true,
    onProgress: item => {
      if (item.current) process.stdout.write(`\r  ${item.tested}/${item.total} 试 ${item.current} …`)
    },
  })
  console.log(`\n  试了 ${real.tested} 把，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  for (const item of real.sectors) {
    console.log(`  扇区 ${String(item.sector).padStart(2)}  ${item.unlocked ? '解锁 ' + item.keyA : '未解开'}  ${item.message}`)
  }
  // 读出来的数据要和已知 dump 一致
  const expect = { 1: '4131382D573000004746413138000000', 2: '504C4100000000000000000000000000', 4: '504C41204C6974650000000000000000' }
  let match = 0
  for (const [block, hex] of Object.entries(expect)) {
    const got = real.blocks[Number(block)]
    if (got && audit.toHex(got) === hex) match += 1
    else console.log(`  !! 块 ${block} 数据不符：${got ? audit.toHex(got) : '无'}`)
  }
  console.log(`  读出的块与已知 dump 一致：${match}/${Object.keys(expect).length}`)

  // ---- 3. dump 离线分析 ----
  const dump = audit.emptyDump()
  dump.uid = '560CAEE9'
  real.sectors.forEach(item => {
    dump.keys[item.sector].keyA = item.keyA || 'FFFFFFFFFFFF'
  })
  const trailer = real.blocks[3]
  if (trailer) dump.blocks[3] = trailer
  const analysis = audit.analyzeDump(dump)
  console.log(`\n  卡片布局：${analysis.mad.layout}`)
  console.log(`  访问位：${analysis.access.map(a => `扇区${a.sector}=${a.lines[0]}`).join(' | ') || '（没读到尾块）'}`)

  await session.close().catch(() => undefined)
  await relay.disconnect()
  await server.close()
}

await main()
