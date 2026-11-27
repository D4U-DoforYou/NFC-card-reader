import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const tools = await server.ssrLoadModule('/src/core/nfc/mifareTools.ts')
const audit = await server.ssrLoadModule('/src/core/nfc/audit.ts')

/** 造一个扇区尾块：Key A(6) | 访问位(3) | GP(1) | Key B(6)。 */
function trailer(accessHex, gp = 0x69) {
  return audit.fromHex(
    'FFFFFFFFFFFF' + accessHex + gp.toString(16).padStart(2, '0') + 'FFFFFFFFFFFF',
  )
}

test('the transport configuration decodes like Proxmark3 does', () => {
  const access = tools.analyzeTrailerAccess(trailer('FF0780'))
  assert.equal(access.valid, true)
  assert.equal(access.raw, 'FF0780')
  assert.ok(access.configuration.includes('运输配置'))
  // 数据块：两把钥匙都能读写、加值、减值。
  for (const block of access.blocks.slice(0, 3)) {
    assert.equal(block.cond, 0)
    assert.equal(block.description, 'read AB; write AB; increment AB; decrement transfer restore AB')
    assert.equal(block.kind, 'transport config')
  }
  // 尾块：只有 Key A 能写 Key A、读写访问位与 Key B。
  const trailerBlock = access.blocks[3]
  assert.equal(trailerBlock.cond, 1)
  assert.equal(trailerBlock.description, 'write A by A; read/write ACCESS by A; read/write B by A')
})

test('the known access configurations are named', () => {
  assert.ok(tools.analyzeTrailerAccess(trailer('FF0780')).configuration.includes('运输配置'))
  assert.ok(tools.analyzeTrailerAccess(trailer('7F0788')).configuration.includes('Key B'))
  assert.ok(tools.analyzeTrailerAccess(trailer('787788')).configuration.includes('值块命令'))
  assert.ok(tools.analyzeTrailerAccess(trailer('123456')).configuration.includes('自定义'))
})

test('the key B enabler configuration gives Key B trailer access', () => {
  const access = tools.analyzeTrailerAccess(trailer('7F0788'))
  assert.equal(access.valid, true)
  // 尾块条件 3：Key B 能写 Key A、写访问位、写 Key B。
  assert.equal(access.blocks[3].cond, 3)
  assert.equal(access.blocks[3].description, 'write A by B; read ACCESS by AB; write ACCESS by B; write B by B')
  // 数据块仍然是 0：两把钥匙都能读写。
  assert.equal(access.blocks[0].cond, 0)
})

test('the no value-commands configuration removes increment and decrement', () => {
  const access = tools.analyzeTrailerAccess(trailer('787788'))
  assert.equal(access.blocks[0].cond, 4)
  assert.equal(access.blocks[0].description, 'read AB; write B')
  assert.equal(access.blocks[0].kind, 'read/write block')
})

test('broken access bits are reported instead of being trusted', () => {
  const broken = trailer('FF0781')
  assert.equal(tools.validateAccessConditions(broken), false)
  const access = tools.analyzeTrailerAccess(broken)
  assert.equal(access.valid, false)
  assert.ok(tools.describeAccess(access).some(line => line.includes('写坏了')))
})

test('a value block is recognised and can be rebuilt', () => {
  const block = tools.buildValueBlock(1000, 5)
  const info = tools.detectValueBlock(block)
  assert.ok(info)
  assert.equal(info.value, 1000)
  assert.equal(info.address, 5)
  assert.equal(tools.detectValueBlock(new Uint8Array(16)), null)
})

test('the MAD layout tells a clone card from a standard one', () => {
  const uid = audit.fromHex('560CAEE9')
  const clone = tools.analyzeMad([audit.fromHex('560CAEE91D080400052B707A1AC3DB90'), null, null, null], uid)
  assert.equal(clone.standard, false)
  assert.equal(clone.uidBlock, true)
  assert.ok(clone.notes.join('').includes('UID / FUID 克隆卡'))

  const standard = tools.analyzeMad([new Uint8Array(16), audit.fromHex('0011223344556708'), null, null])
  assert.equal(standard.standard, true)
})

test('the built-in dictionary starts with the factory key and holds no duplicates', () => {
  const keys = tools.BUILTIN_KEYS
  assert.equal(keys[0], 'FFFFFFFFFFFF')
  assert.ok(keys.includes('A0A1A2A3A4A5'))
  assert.ok(keys.includes('D3F7D3F7D3F7'))
  assert.equal(new Set(keys).size, keys.length)
  for (const key of keys) {
    assert.match(key, /^[0-9A-F]{12}$/)
  }
})

test('the crack engine finds the key that opens each sector', async () => {
  // 假卡：扇区 0 用 111111111111，扇区 1 用 222222222222，其它打不开。
  const truth = new Map([[0, '111111111111'], [1, '222222222222']])
  const tried = []
  const session = {
    async probeAuthenticate(block, key, keyType) {
      const sector = Math.floor(block / 4)
      const hex = audit.toHex(key)
      tried.push({ sector, hex, keyType })
      return truth.get(sector) === hex ? 'ok' : 'wrong-key'
    },
    async readBlocks(blocks) {
      return new Map(blocks.map(block => [block, new Uint8Array(16).fill(block)]))
    },
  }
  const result = await audit.crackCard(session, { keys: ['111111111111', '222222222222', '333333333333'] })
  assert.equal(result.sectors[0].keyA, '111111111111')
  assert.equal(result.sectors[1].keyA, '222222222222')
  assert.equal(result.sectors[2].unlocked, false)
  // 一把密钥先试一个扇区，命中后再扫剩下的扇区。
  // 三把候选 × 两种密钥类型 = 6 次「拿一把密钥试一个扇区」。
  assert.equal(result.tested, 6)
  assert.ok(tried.length > 6, '命中后还会拿同一把密钥扫其它扇区')
})

test('the crack engine reports a sector it could not open', async () => {
  const session = {
    async probeAuthenticate() {
      return 'wrong-key'
    },
    async readBlocks() {
      return new Map()
    },
  }
  const result = await audit.crackCard(session, { keys: ['111111111111'] })
  assert.equal(result.sectors.filter(item => item.unlocked).length, 0)
  assert.ok(result.sectors[0].message.includes('没找到'))
})

test('the key check lists the sectors a key opens', async () => {
  const session = {
    async probeAuthenticate(block, key) {
      return audit.toHex(key) === 'FFFFFFFFFFFF' && Math.floor(block / 4) === 3 ? 'ok' : 'wrong-key'
    },
  }
  const opened = await audit.checkKeyOnCard(session, 'FFFFFFFFFFFF', 'A')
  assert.deepEqual(opened, [3])
})

test('the dump analysis reports layout, access rights and value blocks', () => {
  const dump = audit.emptyDump()
  dump.uid = '560CAEE9'
  dump.blocks[0] = audit.fromHex('560CAEE91D080400052B707A1AC3DB90')
  dump.blocks[3] = trailer('FF0780')
  dump.blocks[4] = tools.buildValueBlock(500, 4)
  const analysis = audit.analyzeDump(dump)
  assert.equal(analysis.mad.uidBlock, true)
  assert.equal(analysis.access.length, 1)
  assert.equal(analysis.access[0].sector, 0)
  assert.equal(analysis.valueBlocks.length, 1)
  assert.equal(analysis.valueBlocks[0].block, 4)
  assert.equal(analysis.valueBlocks[0].value, 500)
})
