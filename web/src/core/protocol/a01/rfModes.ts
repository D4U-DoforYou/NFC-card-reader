/**
 * CLRC663 的射频模式预设。
 *
 * 编号与 CLRC663 数据手册 Rev 5.4 的 Table 47（接收）与 Table 48（发送）一致，
 * 也与 tmp/rf_device_platform/protocol/device.proto 的 RfRxMode / RfTxMode 一致。
 *
 * 固件按编号配置调制、码率与 CRC 寄存器默认值；帧本身仍是原始字节，
 * 寻卡、防冲突、ISO-DEP 等协议流程由主机侧代码处理。
 */

/** 接收模式。 */
export interface RfMode {
  /** 协议里的编号。 */
  id: number
  /** 枚举名。 */
  name: string
  /** 中文说明。 */
  label: string
}

/** 19 个接收预设（Table 47）。 */
export const RF_RX_MODES: RfMode[] = [
  { id: 0, name: 'ISO14443A_106', label: 'ISO-14443A 106 kbit/s' },
  { id: 1, name: 'ISO14443A_212', label: 'ISO-14443A 212 kbit/s' },
  { id: 2, name: 'ISO14443A_424', label: 'ISO-14443A 424 kbit/s' },
  { id: 3, name: 'ISO14443A_848', label: 'ISO-14443A 848 kbit/s' },
  { id: 4, name: 'ISO14443B_106', label: 'ISO-14443B 106 kbit/s' },
  { id: 5, name: 'ISO14443B_212', label: 'ISO-14443B 212 kbit/s' },
  { id: 6, name: 'ISO14443B_424', label: 'ISO-14443B 424 kbit/s' },
  { id: 7, name: 'ISO14443B_848', label: 'ISO-14443B 848 kbit/s' },
  { id: 8, name: 'FELICA_212', label: 'FeliCa 212 kbit/s' },
  { id: 9, name: 'FELICA_424', label: 'FeliCa 424 kbit/s' },
  { id: 10, name: 'ISO15693_26_SSC', label: 'ISO-15693 26 kbit/s SSC' },
  { id: 11, name: 'ISO15693_52_SSC', label: 'ISO-15693 52 kbit/s SSC' },
  { id: 12, name: 'ISO15693_26_DSC', label: 'ISO-15693 26 kbit/s DSC' },
  { id: 13, name: 'EPC_UID_26_SSC', label: 'EPC UID 26 kbit/s SSC' },
  { id: 14, name: 'ISO18000_3_EPC_V2_2_424', label: 'EPC Gen2 2 标签 424 kbit/s' },
  { id: 15, name: 'ISO18000_3_EPC_V2_4_424', label: 'EPC Gen2 4 标签 424 kbit/s' },
  { id: 16, name: 'ISO18000_3_EPC_V2_2_848', label: 'EPC Gen2 2 标签 848 kbit/s' },
  { id: 17, name: 'ISO18000_3_EPC_V2_4_848', label: 'EPC Gen2 4 标签 848 kbit/s' },
  { id: 18, name: 'JEWEL', label: 'Jewel' },
]

/** 19 个发送预设（Table 48）。 */
export const RF_TX_MODES: RfMode[] = [
  { id: 0, name: 'ISO14443A_106', label: 'ISO-14443A 106 kbit/s' },
  { id: 1, name: 'ISO14443A_212', label: 'ISO-14443A 212 kbit/s' },
  { id: 2, name: 'ISO14443A_424', label: 'ISO-14443A 424 kbit/s' },
  { id: 3, name: 'ISO14443A_848', label: 'ISO-14443A 848 kbit/s' },
  { id: 4, name: 'ISO14443B_106', label: 'ISO-14443B 106 kbit/s' },
  { id: 5, name: 'ISO14443B_212', label: 'ISO-14443B 212 kbit/s' },
  { id: 6, name: 'ISO14443B_424', label: 'ISO-14443B 424 kbit/s' },
  { id: 7, name: 'ISO14443B_848', label: 'ISO-14443B 848 kbit/s' },
  { id: 8, name: 'FELICA_212', label: 'FeliCa 212 kbit/s' },
  { id: 9, name: 'FELICA_424', label: 'FeliCa 424 kbit/s' },
  { id: 10, name: 'ISO15693_1_OF_4_26_ID_10', label: 'ISO-15693 1/4 26 kbit/s ID=10' },
  { id: 11, name: 'ISO15693_1_OF_4_26_ID_11', label: 'ISO-15693 1/4 26 kbit/s ID=11' },
  { id: 12, name: 'ISO15693_1_OF_256_1_66_KBIT', label: 'ISO-15693 1/256 1.66 kbit/s' },
  { id: 13, name: 'EPC_UID_53_UNITRAY', label: 'EPC UID 53 bit/s 单边沿' },
  { id: 14, name: 'ISO18000_3_EPC_V2_2_424', label: 'EPC Gen2 2 标签 424 kbit/s' },
  { id: 15, name: 'ISO18000_3_EPC_V2_4_424', label: 'EPC Gen2 4 标签 424 kbit/s' },
  { id: 16, name: 'ISO18000_3_EPC_V2_2_848', label: 'EPC Gen2 2 标签 848 kbit/s' },
  { id: 17, name: 'ISO18000_3_EPC_V2_4_848', label: 'EPC Gen2 4 标签 848 kbit/s' },
  { id: 18, name: 'JEWEL', label: 'Jewel' },
]

/** 默认模式：ISO-14443A 106 kbit/s，与旧固件的行为一致。 */
export const DEFAULT_RX_MODE = 0
export const DEFAULT_TX_MODE = 0

/** 按编号找接收模式。 */
export function rxModeById(id: number): RfMode | null {
  return RF_RX_MODES.find(mode => mode.id === id) ?? null
}

/** 按编号找发送模式。 */
export function txModeById(id: number): RfMode | null {
  return RF_TX_MODES.find(mode => mode.id === id) ?? null
}
