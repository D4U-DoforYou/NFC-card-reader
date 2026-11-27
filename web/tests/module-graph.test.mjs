import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const MODULES = [
  '/src/core/protocol/index.ts',
  '/src/core/protocol/hardware.ts',
  '/src/core/rf/bridge.ts',
  '/src/core/rf/session.ts',
  '/src/core/rf/probe.ts',
  '/src/core/nfc/type2Session.ts',
  '/src/core/nfc/storage.ts',
  '/src/platform/transport.ts',
  '/src/platform/webBluetooth.ts',
  '/src/platform/usbHid.ts',
  '/src/views/NfcView.vue',
  '/src/views/ConnectView.vue',
  '/src/views/EinkView.vue',
]

test('every module of the protocol stack evaluates without a cycle', async () => {
  for (const path of MODULES) {
    const module = await server.ssrLoadModule(path)
    assert.ok(module, `${path} 没有导出`)
  }
})

test('the key objects are real, not undefined', async () => {
  const bridge = await server.ssrLoadModule('/src/core/rf/bridge.ts')
  assert.equal(typeof bridge.RfBridge, 'function')

  const protocol = await server.ssrLoadModule('/src/core/protocol/index.ts')
  assert.ok(protocol.deviceSession)
  assert.equal(typeof protocol.deviceSession.require, 'function')

  const hardware = await server.ssrLoadModule('/src/core/protocol/hardware.ts')
  assert.ok(hardware.profileByScheme('A01'))
})
