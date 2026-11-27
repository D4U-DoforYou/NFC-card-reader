/** ESP-IDF application images; reject merged flash images and bootloaders. */
import type { FirmwareImageInfo } from '../types'
export function inspectFirmwareImage(image: Uint8Array, expectedChipId?: number): FirmwareImageInfo {
  if (image.length < 288 || image.length > 4 * 1024 * 1024 || image[0] !== 0xe9) throw new Error('请选择 ESP-IDF 应用固件 .bin（不是合并镜像或 bootloader）')
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  if (image[1] < 1 || image[1] > 16 || view.getUint32(28, true) < 256 || view.getUint32(32, true) !== 0xabcd5432) throw new Error('文件没有有效的应用描述信息，请选择应用固件 .bin')
  const chipId = view.getUint16(12, true)
  if (expectedChipId !== undefined && chipId !== expectedChipId) throw new Error('固件目标芯片与当前硬件方案不匹配')
  const readText = (offset: number) => new TextDecoder().decode(image.slice(offset, offset + 32)).split('\0')[0].trim()
  return { chipId, version: readText(48), project: readText(80) }
}
