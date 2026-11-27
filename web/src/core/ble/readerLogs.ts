/**
 * 启动与连接页共用日志，页面未打开时也记录连接过程。
 *
 * 两类日志都汇到这里：
 * - `ble`：连接过程的诊断信息（扫描、连接、MTU、服务发现…）；
 * - `app`：运行过程的日志（刷图、读卡、射频场…）。
 * 之前运行日志只出现在通用 NFC 页，连接设备这边看不到完整过程。
 *
 * 日志条数多，写本地存储做了节流，避免刷图时频繁落盘拖慢主线程。
 */

import { transportManager } from '../../platform/transport'
import type { TraceLevel } from '../../platform/transport'
import { getStorageSync, removeStorageSync, setStorageSync } from '../../platform/storage'

/** 日志来源。 */
export type ReaderLogSource = 'ble' | 'app'

export interface ReaderLog {
  time: string
  level: TraceLevel
  message: string
  source: ReaderLogSource
}

const KEY = 'reader_connection_logs'
const LIMIT = 2000
/** 写盘节流间隔（毫秒）。 */
const SAVE_DEBOUNCE_MS = 500

class ReaderLogs {
  entries: ReaderLog[] = []
  private listeners: Array<() => void> = []
  private saveTimer: ReturnType<typeof setTimeout> | 0 = 0

  constructor() {
    const saved = getStorageSync(KEY)
    if (Array.isArray(saved)) {
      this.entries = saved.slice(-LIMIT)
    }
    transportManager.onTrace((message, level) => this.add(level, message, 'ble'))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  add(level: TraceLevel, message: string, source: ReaderLogSource = 'ble'): void {
    const date = new Date()
    const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map(value => String(value).padStart(2, '0'))
      .join(':')
    this.entries = [...this.entries, { time, level, message, source }].slice(-LIMIT)
    this.persist()
    this.listeners.forEach(listener => listener())
  }

  /**
   * 最近若干条日志，最新的排在最前面。
   *
   * 连接页要一次渲染整个列表，条数太多会卡，所以只取尾部。
   */
  recent(limit = 200): ReaderLog[] {
    return this.entries.slice(-limit).reverse()
  }

  clear(): void {
    this.entries = []
    if (this.saveTimer) {
      globalThis.clearTimeout(this.saveTimer)
      this.saveTimer = 0
    }
    removeStorageSync(KEY)
    this.listeners.forEach(listener => listener())
  }

  /** 合并写盘：短时间内的多条日志只写一次。 */
  private persist(): void {
    if (this.saveTimer) {
      return
    }
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = 0
      setStorageSync(KEY, this.entries)
    }, SAVE_DEBOUNCE_MS)
  }
}

export const readerLogs = new ReaderLogs()
