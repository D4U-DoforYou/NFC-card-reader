/**
 * B01 硬件方案档案。
 *
 * B01 是 D4U 的第二版读卡器，广播名 `D4U-NFCB01-XXXX`。
 *
 * 目前 B01 的通信协议与 A01 完全一致：同样的 GATT 布局（FF10/FF11/FF12）、
 * 同样的帧格式与消息契约、同样的射频预设，所以这里直接复用 A01 的会话实现，
 * 只在档案上区分方案编号。上层（射频桥、界面）不需要知道方案之间有差异。
 *
 * 将来 B01 的协议一旦分叉——帧格式、消息契约、能力 ID、射频预设或芯片型号变了——
 * 改动只落在这个目录里：把需要变的部分在这里单独实现，
 * 不动 `a01/`，也不动上层的射频桥与界面。
 */

import { HardwareProfile } from '../types'
import {
  A01_RX_CHARACTERISTIC_UUID,
  A01_SERVICE_UUID,
  A01_TX_CHARACTERISTIC_UUID,
  A01Session,
  RF_RX_MODES,
  RF_TX_MODES,
} from '../a01'

/** B01 方案档案。 */
export const B01_PROFILE: HardwareProfile = {
  scheme: 'B01',
  label: 'D4U-NFC B01',
  namePrefix: 'D4U-NFC',
  serviceUuid: A01_SERVICE_UUID,
  rxUuid: A01_RX_CHARACTERISTIC_UUID,
  txUuid: A01_TX_CHARACTERISTIC_UUID,
  /**
   * 目前 B01 与 A01 同芯片。换了芯片这里要改 chipId，
   * 否则固件升级会把「芯片对不上」的镜像当成不匹配的固件直接拒掉。
   */
  firmwareTarget: { chipId: 5, label: 'ESP32-C3' },
  /**
   * B01 的升压电路在射频场关闭时负载太轻，供电会自行断掉，设备随即掉电。
   * 所以闲时不能把场一关了事，得用短脉冲保活（core/rf/autoSleep.ts）。
   */
  supportsAutoSleep: true,
  rfPresets: {
    rxModes: RF_RX_MODES,
    txModes: RF_TX_MODES,
    typeA: { rx: 0, tx: 0 },
    typeB: { rx: 4, tx: 4 },
    felica: { rx: 8, tx: 8 },
    typeV: { rx: 10, tx: 10 },
  },
  createSession(channel) {
    return new A01Session(B01_PROFILE, channel)
  },
}
