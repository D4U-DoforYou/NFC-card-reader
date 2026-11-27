/**
 * JPEG EXIF 方向归一化：将解码副本的 Orientation 改为 1，原方向由画布显式处理。
 * 这样不依赖手机图片解码器是否自动应用 EXIF，原始文件不改写。
 * Orientation 定义：CIPA DC-008 / TIFF tag 0x0112。
 */
export interface NormalizedImage { path: string; orientation: number }
export interface JpegOrientation { orientation: number; normalizedBytes?: Uint8Array }

/** 只读取 APP1/IFD0 的 SHORT Orientation，边界异常时保留原文件。 */
export function normalizeJpegOrientation(bytes: Uint8Array): JpegOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { orientation: 1 }
  let offset = 2
  let orientation = 1
  let normalized: Uint8Array | undefined
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    const length = bytes[offset] * 256 + bytes[offset + 1]
    const end = offset + length
    if (length < 2 || end > bytes.length) break
    const start = offset + 2
    if (marker === 0xe1 && length >= 16 &&
      bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 &&
      bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0) {
      const base = start + 6
      const little = bytes[base] === 0x49 && bytes[base + 1] === 0x49
      const big = bytes[base] === 0x4d && bytes[base + 1] === 0x4d
      if (little || big) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const u16 = (at: number): number => view.getUint16(at, little)
        const u32 = (at: number): number => view.getUint32(at, little)
        if (base + 8 <= end && u16(base + 2) === 42) {
          const directory = base + u32(base + 4)
          if (directory >= base + 8 && directory + 2 <= end) {
            const count = u16(directory)
            if (directory + 2 + count * 12 <= end) {
              for (let i = 0; i < count; i++) {
                const field = directory + 2 + i * 12
                if (u16(field) !== 0x0112 || u16(field + 2) !== 3 || u32(field + 4) !== 1) continue
                const value = u16(field + 8)
                if (value < 1 || value > 8 || value === 1) continue
                if (orientation === 1) orientation = value
                normalized = normalized ?? bytes.slice()
                new DataView(normalized.buffer).setUint16(field + 8, 1, little)
              }
            }
          }
        }
      }
    }
    offset = end
  }
  return { orientation, normalizedBytes: normalized }
}

const normalizedImages = new Map<string, Promise<NormalizedImage>>()
/** 缓存仅保留轻量路径，生成的文件只属于当前运行，不保存用户原图的改写。 */
export function normalizedImage(path: string): Promise<NormalizedImage> {
  const cached = normalizedImages.get(path)
  if (cached) return cached
  const task = loadNormalized(path)
  normalizedImages.set(path, task)
  if (normalizedImages.size > 24) normalizedImages.delete(normalizedImages.keys().next().value!)
  void task.catch(() => normalizedImages.delete(path))
  return task
}

async function loadNormalized(path: string): Promise<NormalizedImage> {
  // 网页端不需要这份归一化：浏览器解码 JPEG 时**默认就会按 EXIF 方向摆正**
  // （CSS `image-orientation: from-image` 的初始值），画布 drawImage 拿到的
  // 已经是正的像素。小程序那边没有这个行为，才要自己改写文件。
  return { path, orientation: 1 }
}

/** 原始像素坐标 → 正向图像坐标；5..8 会交换宽高。 */
export function orientationTransform(orientation: number, width: number, height: number): number[] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0]
    case 3: return [-1, 0, 0, -1, width, height]
    case 4: return [1, 0, 0, -1, 0, height]
    case 5: return [0, 1, 1, 0, 0, 0]
    case 6: return [0, 1, -1, 0, height, 0]
    case 7: return [0, -1, -1, 0, height, width]
    case 8: return [0, -1, 1, 0, 0, width]
    default: return [1, 0, 0, 1, 0, 0]
  }
}
