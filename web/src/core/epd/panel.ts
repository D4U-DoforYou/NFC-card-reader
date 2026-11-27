import { exchangeImagePacket } from './retry'
/**
 * 通用面板刷图流程：D8 扩展信息、PIN、D2/D3 分包上传与 D4 刷新。
 */

import {
  APP_BLOCK_SIZE,
  APP_CHUNK_SIZE,
  C1_MAX_COMPRESSED_BYTES,
  C1_MAX_PACKET_BYTES,
  D2_HEADER_BYTES,
  D3_HEADER_BYTES,
  DEFAULT_PIN,
  PANEL_READ_CUSTOM_INFO,
  PANEL_REFRESH,
  VERIFY_PIN_HEADER,
  buildAppPacket,
  requireSuccess,
} from './commands'
import { DeviceProfile } from './profile'
import { IsoDepSession } from '../rf/isoDep'
import { lzoCompress } from './lzo'
import { UploadPhase, validateUpload } from './huawei'
import { buildUploadStats } from './stats'
import type { UploadStats } from './stats'

export interface PanelUploadOptions {
  /** D3 当前包总尝试次数（含首次），默认 3。 */
  packetAttempts?: number
  /** 单次交换内部的 ISO-DEP 恢复预算（R-NAK 次数）。 */
  packetRetries?: number
  onProgress?: (progress: UploadPhase) => void
  /** 分包完成后回调：把「传给屏幕的字节数」交给界面写进日志。 */
  onStats?: (stats: UploadStats) => void
  pin?: Uint8Array
  uploadOnly?: boolean
}

/**
 * 普通（非压缩）D2 分包。
 *
 * @param chunkSize 单包载荷上限；按会话的 ISO-DEP 帧上限收紧，避免一包拆成多帧。
 */
export function buildNormalD2Packets(data: Uint8Array, colorCount: number, chunkSize = APP_CHUNK_SIZE): Uint8Array[] {
  const planes: Uint8Array[] = []
  if (colorCount === 3) {
    const split = Math.ceil(data.length / 2)
    planes.push(data.slice(0, split), data.slice(split))
  } else {
    planes.push(data)
  }
  const packets: Uint8Array[] = []
  planes.forEach((plane, planeIndex) => {
    for (let packetIndex = 0, offset = 0; offset < plane.length; packetIndex += 1, offset += chunkSize) {
      const chunk = plane.slice(offset, Math.min(offset + chunkSize, plane.length))
      packets.push(buildAppPacket([0xf0, 0xd2, planeIndex, packetIndex, chunk.length], chunk, D2_HEADER_BYTES))
    }
  })
  return packets
}

/**
 * 高清压缩 D3 分包。
 *
 * @param chunkSize 单包载荷上限；按会话的 ISO-DEP 帧上限收紧，避免一包拆成多帧。
 */
export function buildHdD3Packets(data: Uint8Array, colorCount: number, chunkSize = APP_CHUNK_SIZE): Uint8Array[] {
  const planes: Uint8Array[] = []
  if (colorCount === 6) {
    const partition = Math.floor(data.length / 4)
    for (let index = 0; index < 4; index += 1) {
      planes.push(data.slice(index * partition, (index + 1) * partition))
    }
  } else if (colorCount === 4) {
    planes.push(data)
  } else {
    throw new Error(`HD 压缩暂不支持 ${colorCount} 色`)
  }
  const packets: Uint8Array[] = []
  planes.forEach((plane, imageIndex) => {
    for (let blockIndex = 0, offset = 0; offset < plane.length; blockIndex += 1, offset += APP_BLOCK_SIZE) {
      const block = plane.slice(offset, Math.min(offset + APP_BLOCK_SIZE, plane.length))
      const compressed = lzoCompress(block)
      for (let subIndex = 0, subOffset = 0; subOffset < compressed.length; subIndex += 1, subOffset += chunkSize) {
        const chunk = compressed.slice(subOffset, Math.min(subOffset + chunkSize, compressed.length))
        const last = subOffset + chunk.length === compressed.length
        packets.push(
          buildAppPacket(
            [0xf0, 0xd3, imageIndex, last ? 1 : 0, chunk.length + 2, blockIndex, subIndex],
            chunk,
            D3_HEADER_BYTES,
          ),
        )
      }
    }
  })
  return packets
}

/** 旧版 C1 面板驱动初始化命令序列。 */
export function legacyC1Initialization(screenType: string): Uint8Array[] {
  const hex = (text: string): Uint8Array => {
    const clean = text.replace(/\s+/g, '')
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
    }
    return bytes
  }
  let size: Uint8Array
  let registers: Uint8Array
  if (screenType === 'c1_1') {
    size = hex('A0 06 07 30 01 A0 00 F0')
    registers = hex(
      'A4 01 0C A5 02 00 0A A4 01 08 A5 02 00 0A ' +
        'A4 01 0C A5 02 00 0A A1 02 50 07 A1 02 00 03 ' +
        'A1 04 61 F0 01 A0 A3 02 10 13 A2 01 04 A4 01 03 ' +
        'A2 01 12 A4 01 03'
    )
  } else if (screenType === 'c1_2') {
    size = hex('A0 06 07 20 01 A0 01 E0')
    registers = hex(
      'A4 01 0C A5 02 00 0A A4 01 08 A5 02 00 0A ' +
        'A4 01 0C A5 02 00 0A A4 01 03 A1 03 00 C3 09 ' +
        'A1 02 01 07 A1 04 03 10 54 44 A1 04 06 40 00 00 ' +
        'A1 02 30 02 A1 02 50 37 A1 03 60 03 03 ' +
        'A1 05 61 00 F0 01 A0 A1 05 65 00 00 00 00 ' +
        'A1 02 E7 1C A1 02 E9 01 A1 02 FF A5 A1 02 C3 FD ' +
        'A1 02 DC 01 A1 02 DD 08 A1 02 DE 41 A1 02 FD 01 ' +
        'A1 02 E8 03 A1 02 DA 08 A1 02 C9 00 A1 02 A8 0F ' +
        'A1 02 FF E3 A1 02 E0 02 A1 02 E6 18 A1 01 A5 ' +
        'A4 01 03 A5 02 00 0A A1 01 04 A4 01 03 ' +
        'A4 01 03 A5 02 00 0A'
    )
  } else {
    throw new Error(`无旧版 C1 驱动配置：${screenType}`)
  }
  const init = new Uint8Array(5 + size.length + registers.length)
  init[0] = 0xf0
  init[1] = 0xdb
  init[2] = 0x00
  init[3] = 0x00
  init[4] = size.length + registers.length
  init.set(size, 5)
  init.set(registers, 5 + size.length)
  return [init]
}

/** 执行通用面板刷图流程。 */
export async function uploadPanel(
  session: IsoDepSession,
  profile: DeviceProfile,
  packed: Uint8Array,
  options: PanelUploadOptions = {}
): Promise<void> {
  const report = options.onProgress ?? (() => undefined)
  const pin = options.pin ?? DEFAULT_PIN
  validateUpload(session, profile, packed, pin)
  const isC1 = profile.firmware === 10 && profile.colorCount === 4 && profile.screenType === 'c1_2'
  if (isC1 && (profile.width !== 240 || profile.height !== 416 || !profile.compression)) {
    throw new Error('当前 C1 刷图仅支持 240×416 四色竖屏与 D3 压缩')
  }
  // C1 固件 1.0 的 D3 不能跨 ISO-DEP 帧：帧装不下就宁可不刷，
  // 跨帧发过去只会让设备拒收，白白占满一整轮传输。
  if (isC1 && session.maxInf < C1_MAX_PACKET_BYTES) {
    throw new Error(
      `C1 的 D3 不能跨帧，当前一帧只能装 ${session.maxInf} 字节（需要 ${C1_MAX_PACKET_BYTES} 字节），已停止上传`,
    )
  }
  // 子包固定 250 字节：标签按这个边界重组压缩流，改了就解不开（SW=6992）。
  // 先完成全部分包检查，再发送任何屏幕修改命令。
  const plan = isC1
    ? { packets: buildC1D3Packets(packed), headerBytes: D3_HEADER_BYTES, packetLabel: 'D3' }
    : profile.firmware === 10 && !profile.compression
      ? { packets: buildNormalD2Packets(packed, profile.colorCount), headerBytes: D2_HEADER_BYTES, packetLabel: 'D2' }
      : { packets: buildHdD3Packets(packed, profile.colorCount), headerBytes: D3_HEADER_BYTES, packetLabel: 'D3' }
  const packets = plan.packets
  options.onStats?.(
    buildUploadStats({
      packets,
      headerBytes: plan.headerBytes,
      packedBytes: packed.length,
      packetLabel: plan.packetLabel,
      chunkSize: APP_CHUNK_SIZE,
    }),
  )

  report({ phase: 'pin', current: 0, total: 1, message: '读取屏幕扩展信息' })
  const custom = await session.exchange(PANEL_READ_CUSTOM_INFO)
  if (custom.length < 2) {
    throw new Error('D8 响应缺少状态字')
  }
  const sw = custom[custom.length - 2] << 8 | custom[custom.length - 1]
  if (sw === 0x6985) {
    profile.pinEnabled = true
  } else if (sw === 0x9000) {
    profile.pinEnabled = false
  } else {
    throw new Error(`D8 配置读取失败 SW=${sw.toString(16).toUpperCase()}`)
  }
  report({
    phase: 'pin',
    current: 0,
    total: 1,
    message: `扩展信息：PIN=${profile.pinEnabled ? '启用' : '未启用'}，色码映射=${JSON.stringify(profile.colorCodes)}`,
  })

  if (profile.pinEnabled) {
    report({ phase: 'pin', current: 0, total: 1, message: '正在验证 PIN' })
    const verify = new Uint8Array(VERIFY_PIN_HEADER.length + pin.length)
    verify.set(VERIFY_PIN_HEADER, 0)
    verify.set(pin, VERIFY_PIN_HEADER.length)
    requireSuccess(await session.exchange(verify, 2, profile.uid), 'PIN')
  }

  if (
    profile.firmware === 10 &&
    (profile.screenType === 'c1_1' || profile.screenType === 'c1_2') &&
    profile.width === 416 &&
    profile.height === 240
  ) {
    for (const command of legacyC1Initialization(profile.screenType)) {
      requireSuccess(await session.exchange(command), 'C1 驱动初始化')
    }
  }

  report({ phase: 'upload', current: 0, total: packets.length, message: `上传图像包 0/${packets.length}` })
  let lastPercent = 0
  const packetRetries = options.packetRetries ?? 2
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index]
    const label = `图像包 ${index + 1}/${packets.length}`
    const response = await exchangeImagePacket(session, packet, profile.uid, label, packetRetries, message => {
      report({ phase: 'upload', current: index, total: packets.length, message })
    }, options.packetAttempts ?? 3)
    requireSuccess(response, `图像包 ${index + 1}`)
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
    refreshResponse = await session.exchangeOnce(PANEL_REFRESH, profile.uid, isC1 ? 190_000 : 120_000)
  } catch (error) {
    throw new Error(
      `D4 刷新失败，刷新结果不确定，不会重发：${error instanceof Error ? error.message : String(error)}`
    )
  }
  requireSuccess(refreshResponse, 'D4')
  report({ phase: 'status', current: 1, total: 1, message: '屏幕刷新完成' })
}

/** C1 固件 1.0 不接受跨 ISO-DEP 帧的 D3，整块压缩结果必须 <=246 字节。 */
export function buildC1D3Packets(data: Uint8Array): Uint8Array[] {
  if (data.length !== 240 * 416 / 4) throw new Error('C1 图像必须为 24960 字节')
  const packets: Uint8Array[] = []
  for (let offset = 0, block = 0; offset < data.length; offset += APP_BLOCK_SIZE, block++) {
    const compressed = lzoCompress(data.slice(offset, offset + APP_BLOCK_SIZE))
    if (compressed.length > C1_MAX_COMPRESSED_BYTES) {
      throw new Error(`C1 第 ${block + 1} 块压缩后为 ${compressed.length} 字节，超过 ${C1_MAX_COMPRESSED_BYTES} 字节上限；请选择纯色量化或简化图片`)
    }
    packets.push(buildAppPacket([0xf0, 0xd3, 0, 1, compressed.length + 2, block, 0], compressed, D3_HEADER_BYTES))
  }
  return packets
}
