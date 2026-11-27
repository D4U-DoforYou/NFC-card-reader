/**
 * 图片的存取。
 *
 * 小程序里队列项存的是「持久化后的本地文件路径」；网页端没有文件系统，
 * 但要跨刷新保留图片，所以用 **IndexedDB 存 Blob**，localStorage 只存索引。
 *
 * 运行时给界面用的是 object URL（`:src` 直接能贴），所以：
 * - `blobId` —— IndexedDB 里的键，持久化用；
 * - `path` —— 运行时 object URL，界面显示用。
 */

const DB_NAME = 'd4u-web'
const DB_VERSION = 1
const STORE = 'blobs'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) {
    return dbPromise
  }
  dbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  return dbPromise
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    db =>
      new Promise<T | null>(resolve => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(STORE, mode)
          const request = action(tx.objectStore(STORE))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

/** 生成一个短且不会撞的 blob id。 */
function newBlobId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 把 Blob 存进 IndexedDB，返回 blob id。 */
export async function saveImageBlob(blob: Blob): Promise<string> {
  const id = newBlobId()
  const stored = await runTransaction('readwrite', store => store.put(blob, id))
  return stored === null ? '' : id
}

/** 按 id 取回 Blob。 */
export function loadImageBlob(id: string): Promise<Blob | null> {
  return runTransaction<Blob>('readonly', store => store.get(id)).then(value => value ?? null)
}

/** 判断某个 blob id 是否还在。 */
export async function imageBlobExists(id: string): Promise<boolean> {
  if (!id) {
    return false
  }
  const blob = await loadImageBlob(id)
  return blob !== null
}

/** 删除一个 blob。 */
export async function deleteImageBlob(id: string): Promise<void> {
  if (!id) {
    return
  }
  await runTransaction('readwrite', store => store.delete(id))
}

/** object URL 缓存：同一个 blob id 只创建一次。 */
const urlCache = new Map<string, string>()

/**
 * 取 blob 的可显示 URL。
 *
 * 命中缓存直接返回；否则从 IndexedDB 读出来建 object URL。
 */
export async function imageUrl(blobId: string): Promise<string> {
  if (!blobId) {
    return ''
  }
  const cached = urlCache.get(blobId)
  if (cached) {
    return cached
  }
  const blob = await loadImageBlob(blobId)
  if (!blob) {
    return ''
  }
  const url = URL.createObjectURL(blob)
  urlCache.set(blobId, url)
  return url
}

/** 同步取缓存里的 URL（还没加载完时返回空串，界面用占位图）。 */
export function cachedImageUrl(blobId: string): string {
  return urlCache.get(blobId) ?? ''
}

/** 把画布导出成 PNG Blob。 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('画布导出失败'))
      }
    }, 'image/png')
  })
}

/** 把 data URL 转成 Blob。 */
export function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl).then(response => response.blob())
}

/** 加载一个图片元素。 */
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

/** 读图片尺寸；失败时返回 0×0。 */
export async function readImageSize(src: string): Promise<{ width: number; height: number }> {
  if (!src) {
    return { width: 0, height: 0 }
  }
  try {
    const image = await loadImageElement(src)
    return { width: image.naturalWidth, height: image.naturalHeight }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * 弹出系统文件选择框。
 *
 * 小程序用 `wx.chooseMedia`，网页端没有等价 API，用隐藏的 `<input type=file>`。
 */
export function pickImageFiles(multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[]) => {
      if (settled) {
        return
      }
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => {
      finish(Array.from(input.files ?? []))
    })
    // 用户直接关掉对话框时不会触发 change，窗口重新获得焦点时按「取消」处理。
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => finish(Array.from(input.files ?? [])), 500)
      },
      { once: true },
    )
    input.click()
  })
}
