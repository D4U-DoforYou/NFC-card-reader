import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const {
  DEVICE_NAME_PREFIX,
  listProfiles,
  matchReaderDevice,
  parseDeviceName,
  profileByScheme,
  resolveProfileByName,
} = await server.ssrLoadModule('/src/core/protocol/hardware.ts')

test('the device name splits into scheme and mac tail', () => {
  const parsed = parseDeviceName('D4U-NFCA01-1A2B')
  assert.equal(parsed.scheme, 'A01')
  assert.equal(parsed.macTail, '1A2B')
})

test('the fixed part of the name is D4U-NFC', () => {
  assert.equal(DEVICE_NAME_PREFIX, 'D4U-NFC')
})

test('names are matched case-insensitively and tolerate whitespace', () => {
  assert.equal(parseDeviceName('d4u-nfca01-1a2b').scheme, 'A01')
  assert.equal(parseDeviceName('  D4U-NFCA01-1A2B  ').macTail, '1A2B')
})

test('a name without a scheme or mac tail is rejected', () => {
  assert.equal(parseDeviceName('D4U-NFC'), null)
  assert.equal(parseDeviceName('D4U-NFC-'), null)
  assert.equal(parseDeviceName('ESP32C3-BLE'), null)
  assert.equal(parseDeviceName(''), null)
})

test('the mac tail length is not fixed', () => {
  // A01 广播后两字节，B01 广播 5 字节；两种都要认得出方案。
  assert.equal(parseDeviceName('D4U-NFCA01-1A2B').macTail, '1A2B')
  assert.equal(parseDeviceName('D4U-NFCB01-30CEF9F517').macTail, '30CEF9F517')
  assert.equal(parseDeviceName('D4U-NFCB01-30CEF9F517').scheme, 'B01')
  assert.equal(parseDeviceName('D4U-NFCA01-001122334455').macTail, '001122334455')
  // 超过 6 字节就不是 MAC 尾段了。
  assert.equal(parseDeviceName('D4U-NFCB01-0011223344556677'), null)
  // 尾段必须是十六进制。
  assert.equal(parseDeviceName('D4U-NFCB01-ZZ'), null)
})

test('the A01 scheme is registered', () => {
  const profile = profileByScheme('A01')
  assert.ok(profile)
  assert.equal(profile.serviceUuid, '0000ff10-0000-1000-8000-00805f9b34fb')
  assert.equal(profile.rxUuid, '0000ff11-0000-1000-8000-00805f9b34fb')
  assert.equal(profile.txUuid, '0000ff12-0000-1000-8000-00805f9b34fb')
  assert.equal(profileByScheme('a01'), profile)
})

test('the B01 scheme is registered next to A01', () => {
  const profile = profileByScheme('B01')
  assert.ok(profile)
  assert.equal(profile.scheme, 'B01')
  assert.equal(profile.namePrefix, DEVICE_NAME_PREFIX)
  assert.equal(profileByScheme('b01'), profile)
  // B01 目前与 A01 通信协议一致：GATT 布局相同。
  const a01 = profileByScheme('A01')
  assert.equal(profile.serviceUuid, a01.serviceUuid)
  assert.equal(profile.rxUuid, a01.rxUuid)
  assert.equal(profile.txUuid, a01.txUuid)
})

test('a B01 device name resolves to the B01 profile, not to A01', () => {
  const profile = resolveProfileByName('D4U-NFCB01-1A2B')
  assert.ok(profile)
  assert.equal(profile.scheme, 'B01')
  assert.equal(parseDeviceName('d4u-nfcb01-1a2b').scheme, 'B01')
  assert.equal(parseDeviceName('D4U-NFCB01-1A2B').macTail, '1A2B')
})

test('a real B01 broadcast name resolves to the B01 profile', () => {
  // 实测广播名：尾巴是 5 字节，不是旧规则里的 2 字节。
  const profile = resolveProfileByName('D4U-NFCB01-30CEF9F517')
  assert.ok(profile)
  assert.equal(profile.scheme, 'B01')
  assert.equal(profile.macTail ?? parseDeviceName('D4U-NFCB01-30CEF9F517').macTail, '30CEF9F517')
})

test('a B01 device is matched by name', () => {
  const matched = matchReaderDevice('D4U-NFCB01-1A2B', false)
  assert.equal(matched.matched, true)
  assert.equal(matched.profile?.scheme, 'B01')
})

test('the B01 session reuses the A01 protocol but keeps its own scheme', () => {
  const profile = profileByScheme('B01')
  const channel = {
    chunkSize: 20,
    writeChunk: async () => {},
    onData: () => () => {},
  }
  const session = profile.createSession(channel)
  assert.equal(session.profile.scheme, 'B01')
  assert.equal(session.profile.label, profile.label)
  // 协议实现与 A01 是同一套。
  assert.equal(session.constructor.name, profileByScheme('A01').createSession(channel).constructor.name)
})

test('a device name resolves to its hardware profile', () => {
  const profile = resolveProfileByName('D4U-NFCA01-1A2B')
  assert.ok(profile)
  assert.equal(profile.scheme, 'A01')
})

test('an unregistered scheme is not resolved to another scheme', () => {
  // 以后出 A02，协议可能不一样，不能拿 A01 去硬碰。
  assert.equal(resolveProfileByName('D4U-NFCA02-1A2B'), null)
  assert.equal(profileByScheme('A02'), null)
})

test('a matching device is recognised by name and by service', () => {
  const byName = matchReaderDevice('D4U-NFCA01-1A2B', false)
  assert.equal(byName.matched, true)
  assert.equal(byName.profile?.scheme, 'A01')

  const byService = matchReaderDevice('某台没名字的设备', true)
  assert.equal(byService.matched, true)

  const neither = matchReaderDevice('无线耳机', false)
  assert.equal(neither.matched, false)
})

test('every registered profile carries its own protocol adapter', () => {
  for (const profile of listProfiles()) {
    assert.ok(profile.createSession)
    assert.ok(profile.namePrefix.startsWith(DEVICE_NAME_PREFIX))
  }
})
