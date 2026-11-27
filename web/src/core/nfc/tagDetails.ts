import type { Type2TagInfo } from './type2Session'

/** GET_VERSION layout from NXP NTAG213/215/216 data sheet, table 28. */
export function ntagModel(version: Uint8Array | null): { name: string; configPage: number; physicalBytes: number } | null {
  if (!version || version.length !== 8 || version[0] !== 0 || version[1] !== 4 || version[2] !== 4 || version[3] !== 2 || version[4] !== 1 || version[5] !== 0 || version[7] !== 3) return null
  return ({ 15: { name: 'NTAG213', configPage: 0x29, physicalBytes: 144 }, 17: { name: 'NTAG215', configPage: 0x83, physicalBytes: 504 }, 19: { name: 'NTAG216', configPage: 0xe3, physicalBytes: 888 } } as Record<number, { name: string; configPage: number; physicalBytes: number }>)[version[6]] ?? null
}
export function type2WriteStatus(tag: Type2TagInfo): { allowed: boolean; label: string; reason: string; maxTlvBytes: number; model: string } {
  const known = ntagModel(tag.version)
  const v = tag.version
  const i2c = v?.length === 8 && v[0] === 0 && v[1] === 4 && v[2] === 4 && v[3] === 5 && v[7] === 3
  const base = { model: known?.name ?? (i2c ? 'NTAG I2C' : 'Type 2（型号待确认）'), maxTlvBytes: 0 }
  const deny = (label: string, reason: string) => ({ ...base, allowed: false, label, reason })
  if ((tag.capabilityContainer[3] & 15) !== 0) return deny('只读 / 写入受限', '能力容器不允许自由写入。')
  if (!known && !i2c) return deny('写入支持未确认', '已读取标签；当前型号没有自动写入适配。')
  if (tag.hasControlTlv || tag.hasTlvAfterNdef) return deny('包含特殊内存布局', '含锁控制、内存控制或其他 TLV，仅提供读取。')
  if (!tag.staticLocks) return deny('锁状态未读取', '请重新读取标签以检查静态锁。')
  const start = tag.ndefTlv?.start ?? tag.appendOffset
  let end = Math.min(48, tag.userMemory.length)
  for (let page = 4 + Math.floor(start / 4); page <= 15; page++) {
    const locked = page < 8 ? tag.staticLocks[0] & (1 << page) : tag.staticLocks[1] & (1 << (page - 8))
    if (locked) { end = Math.min(end, (page - 4) * 4); break }
  }
  if (known) {
    if (tag.auth0 === undefined) return deny('密码状态未确认', '无法读取 AUTH0 配置，不推断为可写。')
    if (!tag.authenticated) end = Math.min(end, Math.max(0, (tag.auth0 - 4) * 4))
  }
  const maxTlvBytes = Math.max(0, end - start)
  if (maxTlvBytes < 4) return deny('目标区域不可写', 'NDEF 起始页已锁定、受密码保护，或不在当前支持区域内。')
  return { ...base, maxTlvBytes, allowed: true, label: '支持短内容写入', reason: '已检查 CC、静态锁及已知密码配置；本工具只写用户页 4–15，不修改锁位或密码。' }
}
