import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())
const { deriveBambuKeys, parseBambuSpool, readBambuSpool } = await server.ssrLoadModule('/src/core/nfc/bambu.ts')
const { MifareClassicSession, MifareClassicRfError } = await server.ssrLoadModule('/src/core/nfc/mifareClassic.ts')
const uid = Uint8Array.of(0x56, 0x0c, 0xae, 0xe9)
const hex = bytes => Buffer.from(bytes).toString('hex').toUpperCase()
const textBlock = text => { const data = new Uint8Array(16); data.set(new TextEncoder().encode(text)); return data }
function fixture() {
  const blocks = new Map([[1, textBlock('A18-W0\0\0GFA18')], [2, textBlock('PLA')], [4, textBlock('PLA Basic')],
    [5, Uint8Array.from(Buffer.from('ffffffffe80300000000e03f00000000', 'hex'))],
    [6, Uint8Array.from(Buffer.from('3700080000000000f000be0000000000', 'hex'))],
    [9, Uint8Array.from({ length: 16 }, (_, index) => index)], [12, textBlock('2025_11_03_19_23')], [14, new Uint8Array(16)]])
  new DataView(blocks.get(14).buffer).setUint16(4, 330, true)
  return blocks
}

test('per-UID Key A derivation matches independently calculated, hardware-tested sectors', async () => {
  const keys = await deriveBambuKeys(uid)
  assert.equal(keys.length, 16)
  assert.ok(keys.every(key => key.length === 6))
  assert.deepEqual(keys.slice(0, 4).map(hex), ['042C9C69CBD1', '8DDA647A31AF', '6FEF5882D1D0', '76156B34062E'])
  const other = await deriveBambuKeys(Uint8Array.of(1, 2, 3, 4))
  assert.ok(other.every((key, sector) => hex(key) !== hex(keys[sector])))
  await assert.rejects(deriveBambuKeys(new Uint8Array(7)), /4 字节/)
})

test('parser handles little-endian values, float32 diameter, binary tray UID and raw block copies', () => {
  const blocks = fixture(), spool = parseBambuSpool(uid, blocks)
  assert.equal(spool.materialId, 'GFA18'); assert.equal(spool.variantId, 'A18-W0')
  assert.equal(spool.material, 'PLA'); assert.equal(spool.materialDetail, 'PLA Basic')
  assert.equal(spool.colorRgba, 'FFFFFFFF'); assert.equal(spool.weightGrams, 1000); assert.equal(spool.diameterMm, 1.75)
  assert.equal(spool.dryingTemperature, 55); assert.equal(spool.dryingHours, 8)
  assert.equal(spool.nozzleMinTemperature, 190); assert.equal(spool.nozzleMaxTemperature, 240)
  assert.equal(spool.trayUid, '000102030405060708090A0B0C0D0E0F')
  assert.equal(spool.productionDate, '2025_11_03_19_23'); assert.equal(spool.lengthMeters, 330)
  blocks.get(1).fill(0); assert.equal(hex(spool.blocks.get(1)).slice(0, 6), '413138')
})

test('missing, truncated and unrelated Classic data are not shown as a Bambu spool', () => {
  const missing = fixture(); missing.delete(14)
  assert.throws(() => parseBambuSpool(uid, missing), /块 14/)
  const short = fixture(); short.set(5, new Uint8Array(15))
  assert.throws(() => parseBambuSpool(uid, short), /块 5/)
  const unrelated = fixture(); unrelated.set(1, new Uint8Array(16))
  assert.throws(() => parseBambuSpool(uid, unrelated), /格式/)
  const invalid = fixture(); new DataView(invalid.get(5).buffer).setFloat32(8, NaN, true)
  assert.throws(() => parseBambuSpool(uid, invalid), /格式/)
})

async function withReader(readBlocks, run) {
  const proto = MifareClassicSession.prototype
  const saved = { open: proto.open, readBlocks: proto.readBlocks, close: proto.close }
  let closed = 0
  proto.open = async expected => assert.deepEqual(expected, uid)
  proto.readBlocks = readBlocks
  proto.close = async () => { closed++ }
  try { await run(() => closed) }
  finally { Object.assign(proto, saved) }
}

test('spool reader uses the matching sector keys, reports progress and erases every key', async () => {
  const expected = await deriveBambuKeys(uid), used = [], progress = [], shownKeys = [], blocks = fixture()
  await withReader(async (group, key) => {
    const sector = Math.floor(group[0] / 4)
    assert.deepEqual(key, expected[sector]); used.push(key)
    return new Map(group.map(block => [block, blocks.get(block)]))
  }, async closed => {
    const result = await readBambuSpool({}, uid, { onProgress: (done, total) => progress.push([done, total]), onSectorKey: key => shownKeys.push(key) })
    assert.equal(result.blocks.size, 8); assert.equal(closed(), 1)
    assert.deepEqual(progress, [[0, 8], [2, 8], [5, 8], [6, 8], [8, 8]])
    assert.equal(used.length, 4); assert.ok(used.every(key => key.every(byte => byte === 0)))
    assert.deepEqual(shownKeys, [[1, 2], [4, 5, 6], [9], [12, 14]].map((blocks, sector) => ({ sector, blocks, keyA: hex(expected[sector]) })))
  })
})

test('shared Classic reader failures stop the spool operation and clear secrets without adding another retry', async () => {
  for (const kind of ['rf', 'key']) {
    let calls = 0; const used = []
    await withReader(async (_group, key) => {
      used.push(key); calls++
      if (kind === 'key') throw new Error('未建立 Crypto1 会话')
      throw new MifareClassicRfError('RF', { error: 3, irq0: 0x32, irq1: 0x40, status: 0 })
    }, async closed => {
      await assert.rejects(readBambuSpool({}, uid)); assert.equal(calls, 1)
      assert.equal(closed(), 1); assert.ok(used.every(key => key.every(byte => byte === 0)))
    })
  }
})
