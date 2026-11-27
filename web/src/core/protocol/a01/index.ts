/**
 * A01 硬件方案档案。
 *
 * A01 是目前的唯一方案：ESP32-C3 + CLRC663，GATT 走 FF10/FF11/FF12，
 * 帧格式是 COBS + CRC32，消息契约是 rfplatform.v1。
 *
 * 别的方案（后续硬件）各自建目录，实现同一套接口即可，
 * 上层射频桥与界面层不需要知道差异。
 */

import { HardwareProfile } from '../types'
import { A01Session } from './session'
import { RF_RX_MODES, RF_TX_MODES } from './rfModes'

/** A01 的 GATT 布局。 */
export const A01_SERVICE_UUID = '0000ff10-0000-1000-8000-00805f9b34fb'
export const A01_RX_CHARACTERISTIC_UUID = '0000ff11-0000-1000-8000-00805f9b34fb'
export const A01_TX_CHARACTERISTIC_UUID = '0000ff12-0000-1000-8000-00805f9b34fb'

/** A01 方案档案。 */
export const A01_PROFILE: HardwareProfile = {
  scheme: 'A01',
  label: 'D4U-NFC A01（CLRC663）',
  namePrefix: 'D4U-NFC',
  serviceUuid: A01_SERVICE_UUID,
  rxUuid: A01_RX_CHARACTERISTIC_UUID,
  txUuid: A01_TX_CHARACTERISTIC_UUID,
  firmwareTarget: { chipId: 5, label: 'ESP32-C3' },
  rfPresets: {
    rxModes: RF_RX_MODES, txModes: RF_TX_MODES,
    typeA: { rx: 0, tx: 0 }, typeB: { rx: 4, tx: 4 },
    felica: { rx: 8, tx: 8 }, typeV: { rx: 10, tx: 10 },
  },
  createSession(channel) {
    return new A01Session(A01_PROFILE, channel)
  },
}

export { A01Session }
export * from './messages'
export * from './rfModes'
