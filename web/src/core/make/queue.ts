/**
 * 把做好的图片放进待刷队列。
 *
 * 队列项的约定：blobId 指向 IndexedDB 里的图片本体（跨刷新还在），
 * path 是运行时给界面贴的 object URL。画板与火车票生成的图都从这里入队。
 */

import { appStore, QueueItem } from '../store/index'
import { canvasToBlob, imageUrl, readImageSize, saveImageBlob } from '../../platform/images'

/** 队列上限，与导入图片一致。 */
export const MAX_QUEUE = 99

/** 从地址里取出文件名。 */
export function fileName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || '未命名图片'
}

/**
 * 把一张做好的图片加入待刷队列。
 *
 * 队列满了会抛错，由调用方提示用户。
 */
export async function addImageToQueue(blob: Blob, name: string): Promise<QueueItem> {
  if (appStore.queue.length >= MAX_QUEUE) {
    throw new Error(`队列已满，最多 ${MAX_QUEUE} 张`)
  }
  const blobId = await saveImageBlob(blob)
  if (!blobId) {
    throw new Error('图片保存失败（浏览器存储不可用）')
  }
  const url = await imageUrl(blobId)
  const size = await readImageSize(url)
  // 插到队列最上面：刚做好的图排第一，一眼就能看到。
  return appStore.addItem({
    path: url,
    blobId,
    name,
    sourceWidth: size.width,
    sourceHeight: size.height,
    thumb: url,
    presetId: appStore.globalPresetId,
    options: { ...appStore.globalOptions, rotation: 0 },
  }, 'top')
}

/**
 * 导出画布为 PNG。
 *
 * 画布必须已经画好内容；导出的是 PNG，尺寸等于画布的像素尺寸。
 */
export function exportCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return canvasToBlob(canvas)
}
