import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())
const { cardAppearance } = await server.ssrLoadModule('/src/core/nfc/appearance.ts')

test('unread card differs from a reported unknown card', () => {
  assert.equal(cardAppearance(null).key, 'idle')
  assert.equal(cardAppearance({ protocol: 'unknown', modelId: 'unknown' }).key, 'unknown')
})
test('generic Type A and future models keep the Type A design', () => {
  for (const modelId of ['unknown', 'iso14443a', 'new-model']) {
    assert.equal(cardAppearance({ protocol: 'iso14443a', modelId }).key, 'iso14443a')
  }
})
test('all supported Type A models have distinct designs', () => {
  const ids = ['mifare-classic', 'mifare-plus', 'mifare-desfire', 'ultralight', 'iso-dep', 'epaper-tag']
  const appearances = ids.map(modelId => cardAppearance({ protocol: 'iso14443a', modelId }))
  assert.deepEqual(appearances.map(face => face.key), ids)
  assert.equal(new Set(appearances.map(face => face.background)).size, ids.length)
})
test('protocol takes precedence over a conflicting model hint', () => {
  for (const protocol of ['iso14443b', 'felica', 'iso15693']) {
    assert.equal(cardAppearance({ protocol, modelId: 'mifare-classic' }).key, protocol)
  }
})
