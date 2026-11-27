/**
 * 处理结果缓存：图像处理页与刷图引导共用同一份结果。
 *
 * 之前两处各算一遍：图像处理页出一遍预览，刷图引导再把同一张图处理一遍去打包。
 * 仅复用同一图片、参数、目标屏幕及安装方向的结果。
 * 手机预览为 0°，上传为 180°，不能共用同一个条目。
 */

import { ImageOptions, TargetSpec, targetKey } from './pipeline'

/** 缓存条目：处理后的色码与（面板路径直接产出的）点阵、预览位图。 */
export interface ProcessedEntry {
  /**
   * 每像素的色码。
   *
   * 华为路径靠它按需生成点阵与预览位图——这两样都能从色码里很快算出来，
   * 没必要在预览阶段就算好再缓存：色码 424KB，点阵 + 位图要 1.8MB。
   */
  codes: Uint8Array
  /** 打包后的点阵（通用面板路径直接复用）。 */
  packed?: Uint8Array
  /** 四色预览位图（通用面板路径直接复用），用于导出显色缩略图。 */
  preview?: Uint8Array
  /** 上传缓存专用：独立生成的正向手机画面，不能与传输坐标混用。 */
  displayPreview?: Uint8Array
  width: number
  height: number
}

/** 图像参数的指纹：任何影响结果的参数都算进去。 */
export function optionsKey(options: ImageOptions): string {
  return [
    options.algorithm,
    options.fit,
    options.rotation,
    options.brightness,
    options.contrast,
    options.saturation ?? 1,
    options.scale,
    options.blackWhite ? 1 : 0,
  ].join('|')
}

/**
 * 处理结果缓存。
 *
 * 容量按「点阵 + 预览位图」算：华为 552×768 一条约 1.8MB，
 * 因此只留最近两条，既够图像处理页与刷图引导来回切换，又不会把内存吃满。
 */
class ProcessedCache {
  private entries = new Map<string, ProcessedEntry>()

  /** 缓存条目上限。 */
  limit = 2

  /** 拼出缓存键：图片 + 目标屏幕 + 参数 + 安装方向补偿。 */
  key(itemId: string, spec: TargetSpec, options: ImageOptions, baseRotation = 0): string {
    const orientation = ((baseRotation % 360) + 360) % 360
    return `${itemId}#${targetKey(spec)}#${optionsKey(options)}#base:${orientation}#display-and-wire-exif:v5`
  }

  get(key: string): ProcessedEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    // 命中后移到队尾，方便按最近使用顺序淘汰
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: ProcessedEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.entries.delete(oldest)
    }
  }

  /** 丢弃某张图片的所有缓存（换图、删图时调用）。 */
  dropItem(itemId: string): void {
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(`${itemId}#`)) {
        this.entries.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

export const processedCache = new ProcessedCache()
