import { exchangeImagePacket } from './retry'
/**
 * 华为四色墨水屏刷图流程：D1 校验、PIN、D3 分包上传、D4 刷新与 DE 状态轮询。
 */

import {
  APP_BLOCK_SIZE,
  APP_CHUNK_SIZE,
  DEFAULT_PIN,
  D3_HEADER_BYTES,
  HUAWEI_READ_STATUS,
  HUAWEI_REFRESH,
  VERIFY_PIN_HEADER,
  buildAppPacket,
  requireSuccess,
} from './commands'
import { DeviceProfile } from './profile'
import { IsoDepSession } from '../rf/isoDep'
import { lzoCompress } from './lzo'
import { buildUploadStats } from './stats'
import type { UploadStats } from './stats'

export interface UploadPhase {
  phase: 'pin' | 'upload' | 'refresh' | 'status'
  current: number
  total: number
  message: string
}

export interface UploadOptions {
  /** D3 当前包总尝试次数（含首次），默认 3。 */
  packetAttempts?: number
  pin?: Uint8Array
  /** 单次交换内部的 ISO-DEP 恢复预算（R-NAK 次数）。 */
  packetRetries?: number
  onProgress?: (progress: UploadPhase) => void
  /** 分包完成后回调：把「传给屏幕的字节数」交给界面写进日志。 */
  onStats?: (stats: UploadStats) => void
  uploadOnly?: boolean
}

/** 把点阵按 2000 字节分块并压缩，再切成应用层子包。 */
export function buildD3Packets(packed: Uint8Array, chunkSize = APP_CHUNK_SIZE): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > APP_CHUNK_SIZE) {
    throw new Error(`D3 子包长度必须为 1..${APP_CHUNK_SIZE}`)
  }
  const packets: Uint8Array[] = []
  for (let blockIndex = 0, start = 0; start < packed.length; blockIndex += 1, start += APP_BLOCK_SIZE) {
    const block = packed.slice(start, Math.min(start + APP_BLOCK_SIZE, packed.length))
    const compressed = lzoCompress(block)
    for (let subIndex = 0, offset = 0; offset < compressed.length; subIndex += 1, offset += chunkSize) {
      const chunk = compressed.slice(offset, Math.min(offset + chunkSize, compressed.length))
      const last = offset + chunk.length === compressed.length
      packets.push(
        buildAppPacket([0xf0, 0xd3, 0, last ? 1 : 0, chunk.length + 2, blockIndex, subIndex], chunk, D3_HEADER_BYTES),
      )
    }
  }
  return packets
}

/** 执行华为刷图流程。 */
export async function uploadHuawei(
  session: IsoDepSession,
  profile: DeviceProfile,
  packed: Uint8Array,
  options: UploadOptions = {}
): Promise<void> {
  const report = options.onProgress ?? (() => undefined)
  const packetRetries = options.packetRetries ?? 2
  const pin = options.pin ?? DEFAULT_PIN
  validateUpload(session, profile, packed, pin)

  if (profile.width !== 552 || profile.height !== 768 || profile.colorCount !== 4) {
    throw new Error(`华为刷图路径仅支持 552×768 四色屏，当前为 ${profile.width}×${profile.height}`)
  }
  if (!profile.compression) {
    throw new Error('设备未报告 D3 压缩支持')
  }

  report({ phase: 'pin', current: 0, total: 2, message: '正在验证 PIN' })
  const verify = new Uint8Array(VERIFY_PIN_HEADER.length + pin.length)
  verify.set(VERIFY_PIN_HEADER, 0)
  verify.set(pin, VERIFY_PIN_HEADER.length)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    requireSuccess(await session.exchange(verify, 2, profile.uid), 'PIN')
    report({ phase: 'pin', current: attempt + 1, total: 2, message: 'PIN 验证通过' })
  }

  // 子包固定 250 字节：标签按这个边界重组压缩流，改了就解不开（SW=6992）。
  // 一个 257 字节的 D3 包由 ISO-DEP 按 FSC 拆成多个 I-block，那是协议本来的分层。
  const packets = buildD3Packets(packed)
  options.onStats?.(
    buildUploadStats({
      packets,
      headerBytes: D3_HEADER_BYTES,
      packedBytes: packed.length,
      packetLabel: 'D3',
      chunkSize: APP_CHUNK_SIZE,
    }),
  )
  report({ phase: 'upload', current: 0, total: packets.length, message: `上传图像包 0/${packets.length}` })
  let lastPercent = 0
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index]
    const label = `D3 ${index + 1}/${packets.length}`
    const response = await exchangeImagePacket(session, packet, profile.uid, `${label} block=${packet[5]} subpacket=${packet[6]}`, packetRetries, message => {
      report({ phase: 'upload', current: index, total: packets.length, message })
    }, options.packetAttempts ?? 3)
    requireSuccess(response, `D3 ${index + 1}`)
    const percent = Math.floor(((index + 1) * 100) / packets.length)
    if (percent > lastPercent) {
      lastPercent = percent
      report({
        phase: 'upload',
        current: index + 1,
        total: packets.length,
        message: `上传图像包 ${index + 1}/${packets.length}（${percent}%）`,
      })
    }
  }

  if (options.uploadOnly) {
    return
  }

  report({ phase: 'refresh', current: 0, total: 1, message: '请求屏幕刷新' })
  let refreshResponse: Uint8Array
  try {
    refreshResponse = await session.exchangeOnce(HUAWEI_REFRESH, profile.uid, 120_000)
  } catch (error) {
    throw new Error(`D4 刷新结果不确定，未重发：${error instanceof Error ? error.message : String(error)}`)
  }
  requireSuccess(refreshResponse, 'D4')

  report({ phase: 'status', current: 0, total: 1, message: '等待墨水屏刷新完成' })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = requireSuccess(await session.exchange(HUAWEI_READ_STATUS, 2, profile.uid, Math.min(20_000, Math.max(1, deadline - Date.now()))), 'DE 状态查询')
    if (status.length === 1 && status[0] === 0x00) {
      report({ phase: 'status', current: 1, total: 1, message: '屏幕刷新完成' })
      return
    }
    if (status.length !== 1 || status[0] !== 0x01) {
      throw new Error(`未知的 DE 状态：${Array.from(status).map(v => v.toString(16)).join(' ')}`)
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 500)
    })
  }
  throw new Error('墨水屏刷新等待超时')
}

/** 上传前验证长度与选卡身份，避免把缓存数据写到其他屏幕。 */
export function validateUpload(session: IsoDepSession, profile: DeviceProfile, packed: Uint8Array, pin: Uint8Array): void {
  if (pin.length !== 5) throw new Error('屏幕 PIN 必须为 5 字节')
  if (!profile.uid.length || profile.uid.length !== session.uid.length || profile.uid.some((value, index) => value !== session.uid[index])) {
    throw new Error('屏幕 UID 与当前选卡不一致，请重新识别')
  }
  const expected = Math.ceil(profile.width * profile.height * (profile.colorCount === 3 ? 2 : profile.colorCount > 4 ? 4 : 2) / 8)
  if (packed.length !== expected) throw new Error(`图像数据不完整：需要 ${expected} 字节，实际 ${packed.length}`)
}
