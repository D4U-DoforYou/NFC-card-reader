import type { RfBridge } from '../rf/bridge'
import { MifareClassicSession } from './mifareClassic'

/**
 * Public tag format / KDF research:
 * https://github.com/Bambu-Research-Group/RFID-Tag-Guide
 * This reader derives Key A per UID using Web Crypto HKDF-SHA256.
 */
const KDF_SALT = Uint8Array.of(0x9a, 0x75, 0x9c, 0xf2, 0xc4, 0xf7, 0xca, 0xff, 0x22, 0x2c, 0xb9, 0x76, 0x9b, 0x41, 0xbc, 0x96)
const BLOCK_GROUPS = [[1, 2], [4, 5, 6], [9], [12, 14]] as const

export interface BambuSpoolInfo {
  uid: Uint8Array
  variantId: string
  materialId: string
  material: string
  materialDetail: string
  colorRgba: string
  weightGrams: number
  diameterMm: number
  dryingTemperature: number
  dryingHours: number
  bedTemperature: number
  nozzleMinTemperature: number
  nozzleMaxTemperature: number
  trayUid: string
  productionDate: string
  lengthMeters: number
  blocks: Map<number, Uint8Array>
}

export async function deriveBambuKeys(uid: Uint8Array): Promise<Uint8Array[]> {
  if (uid.length !== 4) throw new Error('拓竹料盘读取目前支持 4 字节 UID 的 Classic 1K 标签')
  const key = await crypto.subtle.importKey('raw', uid.slice(), 'HKDF', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: KDF_SALT, info: new TextEncoder().encode('RFID-A\0'),
  }, key, 16 * 6 * 8))
  try { return Array.from({ length: 16 }, (_, sector) => bits.slice(sector * 6, sector * 6 + 6)) }
  finally { bits.fill(0) }
}

export interface BambuReadOptions {
  trace?: (message: string) => void
  onProgress?: (completedBlocks: number, totalBlocks: number) => void
  /** Explicit key display for the diagnostic toolbox; never written to logs. */
  onSectorKey?: (key: { sector: number; blocks: readonly number[]; keyA: string }) => void
}

/** Reads only material blocks; retries a sector once on a reported RF error. */
export async function readBambuSpool(bridge: RfBridge, expectedUid: Uint8Array, options: BambuReadOptions = {}): Promise<BambuSpoolInfo> {
  const uid = expectedUid.slice()
  const keys = await deriveBambuKeys(uid)
  const session = new MifareClassicSession(bridge, options.trace)
  const blocks = new Map<number, Uint8Array>()
  const total = BLOCK_GROUPS.reduce((sum, group) => sum + group.length, 0)
  try {
    await session.open(uid)
    options.onProgress?.(0, total)
    for (const group of BLOCK_GROUPS) {
      const sector = Math.floor(group[0] / 4)
      options.onSectorKey?.({ sector, blocks: [...group], keyA: hex(keys[sector]) })
      const data = await session.readBlocks(group, keys[sector])
      for (const [block, bytes] of data) blocks.set(block, bytes)
      options.onProgress?.(blocks.size, total)
    }
    return parseBambuSpool(uid, blocks)
  } finally {
    keys.forEach(key => key.fill(0))
    await session.close()
  }
}

export function parseBambuSpool(uid: Uint8Array, source: ReadonlyMap<number, Uint8Array>): BambuSpoolInfo {
  if (uid.length !== 4) throw new Error('拓竹料盘 UID 长度无效')
  const blocks = new Map<number, Uint8Array>()
  for (const group of BLOCK_GROUPS) for (const block of group) {
    const bytes = source.get(block)
    if (bytes?.length !== 16) throw new Error(`拓竹料盘块 ${block} 缺失或长度无效`)
    blocks.set(block, bytes.slice())
  }
  const block = (index: number) => blocks.get(index)!
  const view = (index: number) => { const data = block(index); return new DataView(data.buffer, data.byteOffset, data.byteLength) }
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/s, '').trim()
  const materialId = text(block(1).slice(8))
  const material = text(block(2))
  const diameter = view(5).getFloat32(8, true)
  if (!/^GF[A-Z0-9]+$/.test(materialId) || !/^[\x20-\x7e]{1,16}$/.test(material) || !Number.isFinite(diameter) || diameter <= 0) {
    throw new Error('已认证读取，但数据不符合当前支持的拓竹料盘格式')
  }
  return {
    uid: uid.slice(), variantId: text(block(1).slice(0, 8)), materialId, material,
    materialDetail: text(block(4)),
    colorRgba: hex(block(5).slice(0, 4)), weightGrams: view(5).getUint16(4, true), diameterMm: diameter,
    dryingTemperature: view(6).getUint16(0, true), dryingHours: view(6).getUint16(2, true),
    bedTemperature: view(6).getUint16(6, true), nozzleMaxTemperature: view(6).getUint16(8, true), nozzleMinTemperature: view(6).getUint16(10, true),
    trayUid: hex(block(9)), productionDate: text(block(12)), lengthMeters: view(14).getUint16(4, true), blocks,
  }
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('') }
