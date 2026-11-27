import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const { cobsDecode, cobsEncode, crc32, decodeFrame, encodeFrame, FrameStreamDecoder } =
  await server.ssrLoadModule('/src/core/protocol/a01/framing.ts')
const { proto } = await server.ssrLoadModule('/src/core/protocol/a01/messages.ts')

const HELLO_PAYLOAD = '08012501000000520408011001'
const HELLO_FRAME = '020d0101050801250101010b52040801100108feae9b00'

function toHex(bytes) {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(text) {
  const clean = text.replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(clean.substr(index * 2, 2), 16)
  }
  return bytes
}

test('CRC32 matches the reference zlib implementation', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('COBS round-trips payloads with and without zero bytes', () => {
  for (const payload of [
    new Uint8Array([0]),
    new Uint8Array([0, 0, 0]),
    new Uint8Array([1, 2, 3, 0, 4]),
    new Uint8Array(300).fill(0x7f),
  ]) {
    assert.deepEqual(cobsDecode(cobsEncode(payload)), payload)
  }
})

test('the hello request encodes to the reference protobuf bytes', () => {
  const payload = proto.encode('Envelope', {
    protocol_major: 1,
    request_id: 1,
    hello_request: { min_protocol_major: 1, max_protocol_major: 1 },
  })
  assert.equal(toHex(payload), HELLO_PAYLOAD)
})

test('the hello request frames to the reference wire bytes', () => {
  const frame = encodeFrame(fromHex(HELLO_PAYLOAD))
  assert.equal(toHex(frame), HELLO_FRAME)
})

test('the reference frame decodes back to its payload', () => {
  const frame = fromHex(HELLO_FRAME)
  assert.equal(toHex(decodeFrame(frame.subarray(0, frame.length - 1))), HELLO_PAYLOAD)
})

test('frames split across arbitrary chunk boundaries are reassembled', () => {
  const frame = encodeFrame(fromHex(HELLO_PAYLOAD))
  const decoder = new FrameStreamDecoder()
  for (let offset = 0; offset < frame.length; offset += 7) {
    const chunk = frame.subarray(offset, Math.min(offset + 7, frame.length))
    const frames = decoder.feed(chunk)
    if (offset + 7 < frame.length) {
      assert.equal(frames.length, 0)
    } else {
      assert.equal(frames.length, 1)
      assert.equal(toHex(frames[0]), HELLO_PAYLOAD)
    }
  }
})

test('a corrupted frame is dropped without breaking the stream', () => {
  const good = encodeFrame(fromHex(HELLO_PAYLOAD))
  const bad = encodeFrame(new Uint8Array([1, 2, 3, 4]))
  bad[6] ^= 0xff
  const decoder = new FrameStreamDecoder()
  assert.equal(decoder.feed(bad).length, 0)
  const frames = decoder.feed(good)
  assert.equal(frames.length, 1)
  assert.equal(toHex(frames[0]), HELLO_PAYLOAD)
})

test('proto3 omits default values but keeps explicit presence', () => {
  // level 是 optional：值为 0 也必须写出去，否则固件认为参数没给。
  const withZero = proto.encode('TxAmplitudeRequest', { level: 0 })
  assert.equal(toHex(withZero), '0800')
  const withoutLevel = proto.encode('TxAmplitudeRequest', {})
  assert.equal(toHex(withoutLevel), '')
  // 普通字段等于默认值时不写。
  assert.equal(toHex(proto.encode('RfFieldRequest', { enabled: false })), '')
  assert.equal(toHex(proto.encode('RfFieldRequest', { enabled: true })), '0801')
})

test('the 64 bit session id survives a round trip', () => {
  const sessionId = 0x0123456789abcdefn
  const encoded = proto.encode('Envelope', { protocol_major: 1, session_id: sessionId })
  const decoded = proto.decode('Envelope', encoded)
  assert.equal(decoded.session_id, sessionId)
})
