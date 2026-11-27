/**
 * 全局状态：图片队列、连接状态镜像与运行日志。
 *
 * 与小程序版的差别只有两处，都是平台差异带来的：
 * - 本地存储换成 `localStorage`（小程序的 `wx.setStorageSync`）；
 * - 图片本体存在 IndexedDB 里，队列项只存一个 blob 键
 *   （小程序的队列项存的是本地文件路径）。
 */

import { DEFAULT_OPTIONS, ImageOptions } from '../image/pipeline'
import { IMAGE_PRESETS } from '../image/presets'
import { transportManager } from '../../platform/transport'
import { readerLogs } from '../ble/readerLogs'
import { getStorageSync, setStorageSync } from '../../platform/storage'
import { imageBlobExists, imageUrl } from '../../platform/images'
import { showToast } from '../../platform/ui'

export type QueueStatus = 'pending' | 'processing' | 'ready' | 'flashing' | 'done' | 'error'

export interface QueueItem {
  id: string
  /** 运行时可显示的图片地址（object URL）。 */
  path: string
  /** 持久化用的 blob 键，图片本体在 IndexedDB 里。 */
  blobId: string
  name: string
  sourceWidth: number
  sourceHeight: number
  /** 处理后的四色预览图。 */
  thumb: string
  selected: boolean
  status: QueueStatus
  presetId: string
  options: ImageOptions
  /** 打包后的点阵。 */
  packed?: Uint8Array
  /** 预览像素。 */
  preview?: Uint8Array
  error?: string
  progress?: number
}

export interface LogEntry {
  time: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

/**
 * 新图入队的位置。
 *
 * top：放到队列最上面（默认）。新加的图片排在最前，一进来就能看见，
 *      不用翻到长长的队尾去找。
 * bottom：追加到末尾，保留最初的加入先后顺序。
 */
export type QueueInsert = 'top' | 'bottom'

/** 入队时由调用方提供的字段，id 与状态等由 store 生成。 */
export type QueueItemInput = Omit<QueueItem, 'id' | 'selected' | 'status' | 'progress'>

type Listener = () => void

const QUEUE_STORAGE_KEY = 'image_queue'
const SETTINGS_STORAGE_KEY = 'image_settings'
const ORIENTATION_SCHEMA_KEY = 'orientation_schema'
const ORIENTATION_SCHEMA = 1

class AppStore {
  queue: QueueItem[] = []
  logs: LogEntry[] = []
  bleStatus = 'idle'
  bleMessage = ''
  /** 当前协议族提示。 */
  detectedFamily = ''

  private listeners: Listener[] = []
  private seq = 0

  constructor() {
    transportManager.onStatus((status, message) => {
      const dropped = this.bleStatus === 'connected' && status === 'error'
      if (dropped) {
        showToast('读卡器连接已断开', 'none', 3000)
      }
      this.bleStatus = status
      this.bleMessage = message
      this.emit()
    })
    transportManager.onError(message => {
      this.log('error', message)
    })
    void this.restore()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => this.unsubscribe(listener)
  }

  unsubscribe(listener: Listener): void {
    this.listeners = this.listeners.filter(item => item !== listener)
  }

  emit(): void {
    this.listeners.forEach(listener => listener())
  }

  log(level: LogEntry['level'], message: string): void {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
      now.getSeconds(),
    ).padStart(2, '0')}`
    this.logs = [{ time, level, message }, ...this.logs].slice(0, 120)
    // 运行日志也进连接日志池，连接页能看到完整过程而不只是蓝牙部分。
    readerLogs.add(level, message, 'app')
    this.emit()
  }

  clearLogs(): void {
    this.logs = []
    this.emit()
  }

  /** 读入已保存的队列与处理参数。 */
  async restore(): Promise<void> {
    try {
      const resetLegacyHalfTurn = getStorageSync(ORIENTATION_SCHEMA_KEY) !== ORIENTATION_SCHEMA
      let resetCount = 0
      const restoredOptions = (options: Partial<ImageOptions>): ImageOptions => {
        const merged = { ...DEFAULT_OPTIONS, ...options }
        if (resetLegacyHalfTurn && merged.rotation === 180) {
          merged.rotation = 0
          resetCount += 1
        }
        return merged
      }
      const savedOptions = getStorageSync(SETTINGS_STORAGE_KEY)
      if (savedOptions && typeof savedOptions === 'object') {
        this.globalOptions = restoredOptions(savedOptions as Partial<ImageOptions>)
      }
      const saved = getStorageSync(QUEUE_STORAGE_KEY)
      if (Array.isArray(saved)) {
        const items: QueueItem[] = []
        for (const raw of saved) {
          if (!raw || typeof raw !== 'object') {
            continue
          }
          const item = raw as Partial<QueueItem> & { blobId?: string }
          const blobId = item.blobId ?? ''
          // 图片本体没了（换了浏览器或清了数据）就跳过这一项。
          if (!(await imageBlobExists(blobId))) {
            continue
          }
          const url = await imageUrl(blobId)
          items.push({
            id: String(item.id ?? ''),
            blobId,
            path: url,
            name: String(item.name ?? '未命名图片'),
            sourceWidth: Number(item.sourceWidth ?? 0),
            sourceHeight: Number(item.sourceHeight ?? 0),
            thumb: url,
            selected: Boolean(item.selected),
            presetId: String(item.presetId ?? IMAGE_PRESETS[0].id),
            // 旧版本存下的参数没有饱和度，补齐默认值，避免出现 undefined。
            options: restoredOptions((item.options ?? {}) as Partial<ImageOptions>),
            status: 'pending',
            progress: 0,
          })
        }
        this.queue = items
      }
      if (resetLegacyHalfTurn && resetCount) {
        this.log('info', '已清理旧版 180° 方向设置；画面归零，倒装补偿仅用于发送')
      }
      setStorageSync(ORIENTATION_SCHEMA_KEY, ORIENTATION_SCHEMA)
      this.emit()
    } catch (error) {
      this.log('warn', `恢复本地队列失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 全局处理参数（图像处理页调整的对象）。 */
  globalOptions: ImageOptions = { ...DEFAULT_OPTIONS }
  globalPresetId = IMAGE_PRESETS[0].id

  saveSettings(): boolean {
    try {
      setStorageSync(SETTINGS_STORAGE_KEY, this.globalOptions)
      setStorageSync(
        QUEUE_STORAGE_KEY,
        this.queue.map(item => ({
          id: item.id,
          blobId: item.blobId,
          name: item.name,
          sourceWidth: item.sourceWidth,
          sourceHeight: item.sourceHeight,
          selected: item.selected,
          presetId: item.presetId,
          options: item.options,
        })),
      )
      return true
    } catch (error) {
      this.log('warn', `保存本地队列失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 生成一个队列项：id 唯一，默认勾选待刷。 */
  private createItem(item: QueueItemInput): QueueItem {
    this.seq += 1
    return {
      ...item,
      id: `img-${Date.now()}-${this.seq}`,
      selected: true,
      status: 'pending',
      progress: 0,
    }
  }

  /**
   * 把一张图片放进待刷队列。
   *
   * 默认插到队列最上面：新加的图片一眼就能看到。
   */
  addItem(item: QueueItemInput, insert: QueueInsert = 'top'): QueueItem {
    const created = this.createItem(item)
    this.queue = insert === 'top' ? [created, ...this.queue] : [...this.queue, created]
    this.saveSettings()
    this.emit()
    return created
  }

  /**
   * 批量入队：一整块插到队列顶部，块内保持传入顺序。
   *
   * 一次选多张时如果逐张插入，每张都插到最前会把顺序整个倒过来；
   * 整块插入既让新图排在最上面，又保留用户挑选时的先后顺序。
   */
  addItems(items: QueueItemInput[], insert: QueueInsert = 'top'): QueueItem[] {
    if (!items.length) {
      return []
    }
    const created = items.map(item => this.createItem(item))
    this.queue = insert === 'top' ? [...created, ...this.queue] : [...this.queue, ...created]
    this.saveSettings()
    this.emit()
    return created
  }

  removeItem(id: string): void {
    this.queue = this.queue.filter(item => item.id !== id)
    this.saveSettings()
    this.emit()
  }

  updateItem(id: string, patch: Partial<QueueItem>): void {
    this.queue = this.queue.map(item => (item.id === id ? { ...item, ...patch } : item))
    this.emit()
  }

  toggleItem(id: string): void {
    this.queue = this.queue.map(item => (item.id === id ? { ...item, selected: !item.selected } : item))
    this.saveSettings()
    this.emit()
  }

  selectAll(selected: boolean): void {
    this.queue = this.queue.map(item => ({ ...item, selected }))
    this.saveSettings()
    this.emit()
  }

  clearQueue(): void {
    this.queue = []
    this.saveSettings()
    this.emit()
  }

  get selectedItems(): QueueItem[] {
    return this.queue.filter(item => item.selected)
  }

  /** 找到第一张待刷的图。 */
  nextPending(currentId: string): QueueItem | undefined {
    const index = this.queue.findIndex(item => item.id === currentId)
    if (index < 0) {
      return this.queue.find(item => item.selected && item.status !== 'done')
    }
    for (let step = 1; step <= this.queue.length; step += 1) {
      const item = this.queue[(index + step) % this.queue.length]
      if (item.selected && item.status !== 'done') {
        return item
      }
    }
    return undefined
  }
}

export const appStore = new AppStore()
