/**
 * 平台装配入口。
 *
 * 启动时把真实的传输实现装进 `transportManager`，并把传输方式的选择
 * 存到本地，下次打开沿用上次的设置（蓝牙 / USB）。
 */

import { TransportKind, transportManager } from './transport'
import { WebBluetoothTransport } from './webBluetooth'
import { UsbHidTransport } from './usbHid'
import { getStorageSync, setStorageSync } from './storage'

const KIND_KEY = 'transport_kind'

let bluetooth: WebBluetoothTransport | null = null
let usb: UsbHidTransport | null = null

/** 当前生效的传输实现。 */
export function activeTransport(): WebBluetoothTransport | UsbHidTransport {
  if (transportManager.kind === 'usb') {
    if (!usb) {
      usb = new UsbHidTransport()
    }
    return usb
  }
  if (!bluetooth) {
    bluetooth = new WebBluetoothTransport()
  }
  return bluetooth
}

/** 切换传输方式。会先断开当前连接。 */
export function switchTransport(kind: TransportKind): void {
  // Choosing the current mode is still an explicit preference.
  setStorageSync(KIND_KEY, kind)
  if (transportManager.kind === kind) {
    return
  }
  transportManager.use(activeTransportFor(kind))
}

export function hasTransportPreference(): boolean {
  return ['bluetooth', 'usb'].includes(getStorageSync(KIND_KEY))
}

function activeTransportFor(kind: TransportKind): WebBluetoothTransport | UsbHidTransport {
  if (kind === 'usb') {
    if (!usb) {
      usb = new UsbHidTransport()
    }
    return usb
  }
  if (!bluetooth) {
    bluetooth = new WebBluetoothTransport()
  }
  return bluetooth
}

/** 装好默认传输方式。 */
export function installTransport(): void {
  const saved = getStorageSync(KIND_KEY)
  const kind: TransportKind = saved === 'usb' ? 'usb' : 'bluetooth'
  transportManager.use(activeTransportFor(kind))
}

export { bluetoothAvailable } from './webBluetooth'
export { usbAvailable } from './usbHid'
export { transportManager } from './transport'
export type { TransportKind, TransportStatus } from './transport'
