/**
 * 用网页端自己的代码验证真机与真卡。
 *
 * 链路：TCP 传输层 → 协议层（帧格式 / protobuf / 会话）→ 射频桥 →
 *       MIFARE Classic 会话 → 审计引擎
 *
 * 与浏览器里跑的差别只有传输层（这里是 TCP，浏览器里是 Web Bluetooth），
 * 其它全部是 src/ 下的真实实现。
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

const HOST = '127.0.0.1'
const PORT = 8791

/** 通过 TCP 连到转发进程的传输层。 */
class RelayTransport {
  kind = 'bluetooth'
  status = 'idle'
  chunkSize = 244
  connectedName = 'D4U-NFCA01-relay'
  connectedDeviceId = 'relay'
  connectedAt = 0
  hardwareProfile = A01_PROFILE
  lastRssi = null
  connectedDurationMs = 0

  socket = null
  buffer = Buffer.alloc(0)
  dataListeners = []
  statusListeners = []
  traceListeners = []
  errorListeners = []

  onStatus(listener) { this.statusListeners.push(listener) }
  onData(listener) { this.dataListeners.push(listener); return () => {} }
  onTrace(listener) { this.traceListeners.push(listener) }
  onError(listener) { this.errorListeners.push(listener) }

  emitStatus(status, message) {
    this.status = status
    this.statusListeners.forEach(listener => listener(status, message))
  }

  async connect() {
    this.emitStatus('connecting', '正在连接转发进程…')
    this.socket = net.createConnection({ host: HOST, port: PORT })
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      for (;;) {
        if (this.buffer.length < 2) return
        const length = this.buffer.readUInt16BE(0)
        if (this.buffer.length < 2 + length) return
        const payload = this.buffer.subarray(2, 2 + length)
        this.buffer = this.buffer.subarray(2 + length)
        const copy = new Uint8Array(payload)
        this.dataListeners.forEach(listener => listener(copy))
      }
    })
    this.connectedAt = Date.now()
    this.emitStatus('connected', '已连接读卡器')
  }

  async writeChunk(bytes) {
    const header = Buffer.alloc(2)
    header.writeUInt16BE(bytes.length, 0)
    this.socket.write(Buffer.concat([header, Buffer.from(bytes)]))
  }

  async disconnect() {
    this.socket?.destroy()
    this.socket = null
    this.emitStatus('idle', '')
  }
}

const relay = new RelayTransport()
transportManager.use(relay)

const ANSWERS = [
  { sector: 0, blocks: [1, 2], key: '042C9C69CBD1' },
  { sector: 1, blocks: [4, 5, 6], key: '8DDA647A31AF' },
  { sector: 2, blocks: [9], key: '6FEF5882D1D0' },
  { sector: 3, blocks: [12, 14], key: '76156B34062E' },
]

async function main() {
  console.log('连接转发进程…')
  await relay.connect()
  console.log('等待握手…')
  const session = await deviceSession.require()
  console.log(`握手完成：能力 ${session.capabilities.map(c => `${c.id} v${c.majorVersion}.${c.minorVersion}`).join('、')}`)

  // ---- 1. 选卡 ----
  const bridge = epdSession.rfBridge
  const { activateTag, WAKE_FRAME_REQA, WAKE_FRAME_WUPA } = await server.ssrLoadModule('/src/core/rf/isoDep.ts')
  await bridge.cycleRfField()
  // 先 REQA 后 WUPA：部分克隆卡只应 REQA。
  let tag = null
  for (const wake of [WAKE_FRAME_REQA, WAKE_FRAME_WUPA]) {
    try {
      tag = await activateTag(bridge, wake, { strictAtqa: false, requireIsoDep: false })
      break
    } catch {
      await bridge.cycleRfField()
    }
  }
  if (!tag) throw new Error('卡片没有应答')
  console.log(`选卡：UID=${audit.toHex(tag.uid)} SAK=0x${tag.sak.toString(16).padStart(2, '0')}`)

  // ---- 2. 按题目给的密钥读块 ----
  const classic = new MifareClassicSession(bridge, message => console.log(`  · ${message}`))
  await classic.open(tag.uid)
  let ok = 0
  let fail = 0
  try {
    for (const item of ANSWERS) {
      for (const block of item.blocks) {
        try {
          const data = await classic.readBlock(block, audit.fromHex(item.key), 'A')
          console.log(`  扇区${item.sector} 块${String(block).padStart(2)} OK  ${audit.toHex(data)}`)
          ok += 1
        } catch (error) {
          console.log(`  扇区${item.sector} 块${String(block).padStart(2)} FAIL ${error.message}`)
          fail += 1
        }
      }
    }
    console.log(`\n读块：成功 ${ok}，失败 ${fail}`)

    // ---- 3. 字典穷举：拿真卡验证「密钥不对」与「射频异常」能分开 ----
    console.log('\n字典穷举验证（扇区 0）：')
    const candidates = ['FFFFFFFFFFFF', '042C9C69CBD1', '8DDA647A31AF']
    const search = await audit.searchSectorKey(classic, 0, candidates, {
      onProgress: item => { if (item.tested) process.stdout.write(`\r  试到第 ${item.tested} 把…`) },
    })
    console.log(`\n  命中=${search.key} 试过=${search.tested} 射频异常=${search.inconclusive}`)
    console.log(`  明细：${search.log.map(item => `${item.key}:${item.result}`).join(' ')}`)

    // ---- 4. 整卡读卡（只读有密钥的扇区）----
    console.log('\n整卡读卡：')
    const dump = audit.emptyDump()
    dump.uid = audit.toHex(tag.uid)
    for (const item of ANSWERS) {
      dump.keys[item.sector].keyA = item.key
    }
    const result = await audit.readFullDump(classic, dump, {
      onProgress: item => process.stdout.write(`\r  ${item.done}/${item.total} ${item.message}`),
    })
    console.log('')
    for (const sector of result.sectors) {
      if (sector.state === 'ok') {
        const first = result.blocks[sector.sector * 4]
        console.log(`  扇区 ${String(sector.sector).padStart(2)} ${sector.state.padEnd(10)} ${sector.message} · 首块 ${audit.toHex(first)}`)
      }
    }
    console.log(`  dump 文本共 ${audit.serializeDump(result).split('\n').length - 1} 行`)

    // ---- 5. UID 块（第 0 块）只读 ----
    const uidBlock = await audit.readUidBlock(classic, audit.fromHex('042C9C69CBD1'))
    console.log(`\nUID 块（第 0 块）：${audit.toHex(uidBlock)}`)
    console.log(`  与卡片 UID 对比：${audit.toHex(uidBlock).startsWith(audit.toHex(tag.uid)) ? '一致（这是 UID 卡）' : '不一致'}`)

    // ---- 6. dump 往返 ----
    const roundTrip = audit.parseDump(audit.serializeDump(result))
    const changed = audit.diffDumps(result, roundTrip)
    console.log(`\ndump 往返：差异块 ${changed.length === 0 ? '无' : changed.join(',')}`)
  } finally {
    await classic.close().catch(() => undefined)
    await relay.disconnect()
    await server.close()
  }
}

await main()
