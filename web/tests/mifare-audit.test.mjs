import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const audit = await server.ssrLoadModule('/src/core/nfc/audit.ts')

test('a key must be six bytes of hex', () => {
  assert.equal(audit.isValidKey('042C9C69CBD1'), true)
  assert.equal(audit.isValidKey('042c9c69cbd1'), true)
  assert.equal(audit.isValidKey('04 2C 9C 69 CB D1'), true)
  assert.equal(audit.isValidKey('FFFFFFFFFFF'), false)
  assert.equal(audit.isValidKey('GGGGGGGGGGGG'), false)
  assert.throws(() => audit.normalizeKey('1234'), /12 位十六进制/)
})

test('the key list parser accepts lines, separators and comments', () => {
  const keys = audit.parseKeyList(`
    # 注释行
    FFFFFFFFFFFF
    042C9C69CBD1, 8DDA647A31AF
    6FEF5882D1D0 ; 76156B34062E
  `)
  assert.deepEqual(keys, [
    'FFFFFFFFFFFF',
    '042C9C69CBD1',
    '8DDA647A31AF',
    '6FEF5882D1D0',
    '76156B34062E',
  ])
})

test('the key list parser drops duplicates', () => {
  assert.deepEqual(audit.parseKeyList('FFFFFFFFFFFF\nFFFFFFFFFFFF'), ['FFFFFFFFFFFF'])
})

test('a dump round-trips through text', () => {
  const dump = audit.emptyDump()
  dump.uid = '560CAEE9'
  dump.keys[0].keyA = '042C9C69CBD1'
  dump.keys[3].keyB = '76156B34062E'
  dump.blocks[1] = audit.fromHex('4131382D573000004746413138000000')
  dump.blocks[63] = audit.fromHex('00112233445566778899AABBCCDDEEFF')

  const text = audit.serializeDump(dump)
  const parsed = audit.parseDump(text)
  assert.equal(parsed.uid, '560CAEE9')
  assert.equal(parsed.keys[0].keyA, '042C9C69CBD1')
  assert.equal(parsed.keys[3].keyB, '76156B34062E')
  assert.equal(audit.toHex(parsed.blocks[1]), '4131382D573000004746413138000000')
  assert.equal(audit.toHex(parsed.blocks[63]), '00112233445566778899AABBCCDDEEFF')
  assert.equal(parsed.blocks[2], null)
})

test('a block list round-trips through plain hex', () => {
  const dump = audit.emptyDump()
  dump.blocks[0] = audit.fromHex('560CAEE91D080400052B707A1AC3DB90')
  dump.blocks[4] = audit.fromHex('504C41204C6974650000000000000000')
  const text = audit.serializeBlocks(dump)
  const parsed = audit.parseBlocks(text)
  assert.equal(audit.toHex(parsed[0]), '560CAEE91D080400052B707A1AC3DB90')
  assert.equal(audit.toHex(parsed[4]), '504C41204C6974650000000000000000')
  assert.equal(parsed[1].length, 16)
})

test('a malformed dump is rejected instead of silently truncated', () => {
  assert.throws(() => audit.parseDump('BLOCK 00 AABB'), /32 位十六进制|16 字节/)
  assert.throws(() => audit.parseDump('BLOCK FF 00112233445566778899AABBCCDDEEFF'), /块号非法/)
  assert.throws(() => audit.parseDump('KEY 10 A FFFFFFFFFFFF'), /扇区号非法/)
})

test('the standard trailer carries the factory access bits', () => {
  const trailer = audit.standardTrailer()
  assert.equal(trailer.length, 16)
  assert.equal(audit.toHex(trailer.slice(0, 6)), 'FFFFFFFFFFFF')
  assert.equal(audit.toHex(trailer.slice(6, 10)), 'FFFFFF07')
})

test('a blank dump leaves the manufacturer block alone and fills the rest', () => {
  const blank = audit.blankDump()
  assert.equal(blank.blocks[0], null)
  assert.equal(audit.toHex(blank.blocks[1]), '00000000000000000000000000000000')
  // 出廠尾块：Key A 全 FF，访问位 FF FF FF 07，GP 与特殊字节全 FF。
  assert.equal(audit.toHex(blank.blocks[3]), 'FFFFFFFFFFFFFFFFFF07FFFFFFFFFFFF')
  assert.equal(audit.toHex(blank.blocks[63]), 'FFFFFFFFFFFFFFFFFF07FFFFFFFFFFFF')
})

test('dump diffing reports only the blocks that changed', () => {
  const left = audit.emptyDump()
  const right = audit.emptyDump()
  left.blocks[1] = audit.fromHex('00'.repeat(16))
  right.blocks[1] = audit.fromHex('00'.repeat(16))
  right.blocks[2] = audit.fromHex('01'.repeat(16))
  right.blocks[0] = audit.fromHex('00'.repeat(16))
  assert.deepEqual(audit.diffDumps(left, right), [0, 2])
})

test('block summaries show printable characters only', () => {
  assert.equal(audit.blockSummary(audit.fromHex('4142430000')), 'ABC..')
  assert.equal(audit.blockSummary(null), '—')
})

test('locking the UID block only changes the lock byte', () => {
  const current = audit.fromHex('560CAEE91D080400052B707A1AC3DB90')
  const locked = audit.buildLockedUidBlock(current, 0x01)
  assert.equal(audit.toHex(locked), '560CAEE91D080400052B707A1AC3DB01')
  // 锁字节之前的每一个字节都原样保留：锁错了也不会把 UID 写坏。
  assert.deepEqual(Array.from(locked.slice(0, 15)), Array.from(current.slice(0, 15)))
  // 原数组不能被就地改掉。
  assert.equal(current[15], 0x90)
})

test('a bad lock byte is rejected', () => {
  const current = new Uint8Array(16)
  assert.throws(() => audit.buildLockedUidBlock(current, 256), /0..255/)
  assert.throws(() => audit.buildLockedUidBlock(current, -1), /0..255/)
  assert.throws(() => audit.buildLockedUidBlock(new Uint8Array(4), 1), /16 字节/)
})

test('the UID block is read with the given sector key', async () => {
  const calls = []
  const session = {
    async readBlocks(blocks, key, keyType) {
      calls.push({ blocks, key: Array.from(key), keyType })
      return new Map([[0, audit.fromHex('560CAEE91D080400052B707A1AC3DB90')]])
    },
  }
  const data = await audit.readUidBlock(session, audit.fromHex('042C9C69CBD1'))
  assert.equal(audit.toHex(data), '560CAEE91D080400052B707A1AC3DB90')
  assert.deepEqual(calls[0].blocks, [0])
  assert.deepEqual(calls[0].key, [0x04, 0x2c, 0x9c, 0x69, 0xcb, 0xd1])
  assert.equal(calls[0].keyType, 'A')
})

test('the crack reports progress with a phase, a count and an estimate', async () => {
  const session = {
    async probeAuthenticate() {
      return 'wrong-key'
    },
    async readBlocks() {
      return new Map()
    },
  }
  const progress = []
  const result = await audit.crackCard(session, {
    keys: ['FFFFFFFFFFFF', '042C9C69CBD1'],
    keyTypes: ['A'],
    readSectors: false,
    onProgress: item => progress.push(item),
  })
  assert.equal(result.tested, 2)
  assert.equal(result.attempts, 2)
  assert.equal(result.total, 2)
  assert.equal(result.inconclusive, 0)
  assert.ok(result.elapsedMs >= 0)
  // 阶段要一路走到 done，进度不能只有开头那一帧。
  assert.equal(progress[0].phase, 'probing')
  assert.equal(progress[progress.length - 1].phase, 'done')
  assert.equal(progress[0].total, 2)
  assert.equal(progress[0].current, 'FFFFFFFFFFFF')
  // 候选都试完了，剩余时间应当是 0 而不是 null。
  assert.equal(progress[progress.length - 1].etaMs, 0)
})

test('a hit unlocks the sector and previews the sector state', async () => {
  const session = {
    async probeAuthenticate(block) {
      // 扇区 0 与扇区 1 的密钥相同：命中之后扫其它扇区时应该把扇区 1 也打开。
      return block === 0 || block === 4 ? 'ok' : 'wrong-key'
    },
    async readBlocks(blocks) {
      const map = new Map()
      for (const block of blocks) {
        map.set(block, audit.fromHex('4131382D573000004746413138000000'))
      }
      return map
    },
  }
  const updates = []
  const result = await audit.crackCard(session, {
    keys: ['042C9C69CBD1'],
    keyTypes: ['A'],
    onUpdate: snapshot => updates.push(snapshot),
  })
  assert.equal(result.sectors[0].unlocked, true)
  assert.equal(result.sectors[0].keyA, '042C9C69CBD1')
  assert.equal(result.sectors[1].unlocked, true)
  assert.equal(result.keys[0].keyA, '042C9C69CBD1')
  assert.equal(result.keys[1].keyA, '042C9C69CBD1')
  // 读出来的块要落在它自己的块号上，不是从 0 开始挤着放。
  assert.equal(audit.toHex(result.blocks[0]), '4131382D573000004746413138000000')
  assert.equal(audit.toHex(result.blocks[4]), '4131382D573000004746413138000000')
  assert.equal(result.blocks[3], null)
  // 预览回调至少推了「解锁」和「读到数据」两次。
  assert.ok(updates.length >= 2)
  assert.equal(updates[updates.length - 1].sectors[1].unlocked, true)
  assert.ok(updates[updates.length - 1].blocks[4])
})

test('an inconclusive attempt is counted apart from a wrong key', async () => {
  const session = {
    async probeAuthenticate() {
      throw new Error('射频错误')
    },
    async readBlocks() {
      return new Map()
    },
  }
  const result = await audit.crackCard(session, {
    keys: ['FFFFFFFFFFFF'],
    keyTypes: ['A'],
    readSectors: false,
  })
  assert.equal(result.inconclusive, 1)
  assert.equal(result.sectors[0].unlocked, false)
})

test('the remaining time estimate scales with the remaining candidates', () => {
  assert.equal(audit.estimateRemaining(1000, 0, 10), null)
  assert.equal(audit.estimateRemaining(1000, 10, 0), 0)
  // 10 次认证花了 1 秒，还剩 10 个候选 → 大约还要 1 秒。
  assert.equal(audit.estimateRemaining(1000, 10, 10), 1000)
})
