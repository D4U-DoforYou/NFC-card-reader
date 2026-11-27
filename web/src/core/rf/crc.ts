/**
 * NFC 射频层：CRC_A 计算与 CLRC663 状态位解释。
 */

/** 计算 ISO14443-3 CRC_A。 */
export function crcA(data: Uint8Array): Uint8Array {
  let crc = 0x6363
  for (let i = 0; i < data.length; i += 1) {
    let value = data[i] ^ (crc & 0xff)
    value ^= (value << 4) & 0xff
    crc = ((crc >> 8) ^ (value << 8) ^ (value << 3) ^ (value >> 4)) & 0xffff
  }
  return new Uint8Array([crc & 0xff, (crc >> 8) & 0xff])
}

/** 解释 CLRC663 的 ERROR 寄存器位。 */
export function describeErrorBits(error: number): string[] {
  const flags: Array<[number, string]> = [
    [0x80, 'EE_ERR'],
    [0x40, 'FIFOWRERR'],
    [0x20, 'FIFOOVL'],
    [0x10, 'MINFRAMEERR'],
    [0x08, 'NODATAERR'],
    [0x04, 'COLLDET'],
    [0x02, 'PROTERR'],
    [0x01, 'INTEGERR'],
  ]
  return flags.filter(([mask]) => (error & mask) !== 0).map(([, name]) => name)
}

/** 桥接层拒绝原因（AF 帧长度为 2 时的 status）。 */
export function describeBridgeRejection(status: number): string {
  switch (status) {
    case 0x0a:
      return '读卡器拒绝射频场控制：请求无效或读卡器不可用'
    case 0x0b:
      return '读卡器射频请求队列已满'
    case 0x0c:
      return 'CLRC663 未就绪，拒绝开启射频场'
    default:
      return `读卡器拒绝请求 status=0x${status.toString(16).padStart(2, '0').toUpperCase()}`
  }
}
