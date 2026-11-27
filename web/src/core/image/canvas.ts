/**
 * Canvas 图像处理辅助：把本地图片按几何参数绘制到指定尺寸并读回像素。
 *
 * 几何语义与参考实现一致：先旋转，再按留白/裁剪适配，最后按百分比缩放并居中。
 */

import { ImageOptions } from './pipeline'
import { normalizedImage, orientationTransform } from './orientation'
import { PaletteEntry, saturateChannel } from './dither'
import { readImageSize as readSourceImageSize, canvasToBlob } from '../../platform/images'

/** 解码后的图片缓存，避免同一张图反复解码。 */
let imageCaches = new WeakMap<HTMLCanvasElement, Map<string, HTMLImageElement>>()
const canvasIds = new WeakMap<HTMLCanvasElement, number>()
let canvasSequence = 0
function canvasId(canvas: HTMLCanvasElement): number {
  let id = canvasIds.get(canvas)
  if (id === undefined) { id = ++canvasSequence; canvasIds.set(canvas, id) }
  return id
}
const sizeCache = new Map<string, { width: number; height: number }>()
/** 缓存上限，防止大量图片占用过多内存。 */
const IMAGE_CACHE_LIMIT = 12

/**
 * 源像素缓存：滑杆变化时不必重新画图 + 读回像素。
 *
 * 一次 `drawImage` + `getImageData` 要把整幅 RGBA 搬过线程边界，
 * 手机上往往比整条图像管线还贵。几何参数不变时，源像素是不变的，
 * 只有亮度/对比度/饱和度需要重算——缓存住源像素就能把这块开销全省掉。
 */
interface SourceEntry {
  /** 已按白底合成的 RGB（不含亮度/对比度/饱和度）。 */
  rgb: Uint8Array
  width: number
  height: number
}

const sourceCache = new Map<string, SourceEntry>()
/** 源像素缓存上限：拖动档与全分辨率各一份，够用了。 */
const SOURCE_CACHE_LIMIT = 4

/** 清空图片缓存（内存吃紧或队列变更时可调用）。 */
export function clearImageCache(): void {
  imageCaches = new WeakMap()
  sizeCache.clear()
  sourceCache.clear()
}

/** 源像素的缓存键：路径 + 几何 + 分辨率 + 安装方向补偿。 */
function sourceKey(
  canvas: HTMLCanvasElement,
  imagePath: string,
  width: number,
  height: number,
  options: ImageOptions,
  baseRotation: number
): string {
  return `${canvasId(canvas)}|${imagePath}|${width}x${height}|${options.rotation}|${options.fit}|${options.scale}|${baseRotation}`
}

/**
 * 取源像素（已按白底合成，不含色调调整）。
 *
 * 命中缓存就直接给现成的，省掉一次 drawImage + getImageData。
 */
async function sourcePixels(
  canvas: HTMLCanvasElement,
  imagePath: string,
  width: number,
  height: number,
  options: ImageOptions,
  baseRotation: number
): Promise<Uint8Array> {
  const key = sourceKey(canvas, imagePath, width, height, options, baseRotation)
  const cached = sourceCache.get(key)
  if (cached && cached.width === width && cached.height === height) {
    return cached.rgb
  }

  await drawSource(canvas, imagePath, width, height, options, baseRotation)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('无法获取 Canvas 上下文')
  }
  const pixels = ctx.getImageData(0, 0, width, height).data
  const rgb = new Uint8Array(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 4
    const target = index * 3
    const alpha = pixels[source + 3] / 255
    rgb[target] = Math.round(pixels[source] * alpha + 255 * (1 - alpha))
    rgb[target + 1] = Math.round(pixels[source + 1] * alpha + 255 * (1 - alpha))
    rgb[target + 2] = Math.round(pixels[source + 2] * alpha + 255 * (1 - alpha))
  }

  sourceCache.set(key, { rgb, width, height })
  while (sourceCache.size > SOURCE_CACHE_LIMIT) {
    const oldest = sourceCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    sourceCache.delete(oldest)
  }
  return rgb
}

/** 读取图片的原始像素尺寸。 */
export function readImageSize(path: string): Promise<{ width: number; height: number }> {
  const cached = sizeCache.get(path)
  if (cached) {
    return Promise.resolve(cached)
  }
  return readSourceImageSize(path)
    .then(size => {
      sizeCache.set(path, size)
      return size
    })
    .catch(error => {
      throw error instanceof Error ? error : new Error(String(error))
    })
}

/** 加载图片对象。 */
export function loadCanvasImage(canvas: HTMLCanvasElement, path: string): Promise<HTMLImageElement> {
  let imageCache = imageCaches.get(canvas)
  if (!imageCache) { imageCache = new Map(); imageCaches.set(canvas, imageCache) }
  const canvasImages = imageCache
  const cached = canvasImages.get(path)
  if (cached) {
    return Promise.resolve(cached)
  }
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (canvasImages.size >= IMAGE_CACHE_LIMIT) {
        const oldest = canvasImages.keys().next().value
        if (oldest) {
          canvasImages.delete(oldest)
        }
      }
      canvasImages.set(path, image)
      resolve(image)
    }
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = path
  })
}

/** 把字节值夹到 0..255。 */
function clampByte(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 255) {
    return 255
  }
  return value
}

/**
 * 刷图时的安装方向补偿。
 *
 * 屏幕的物理朝向和图片坐标差 180°，所以**传送给屏幕的数据**要统一先转 180°，
 * 刷到屏上才是正的。前端预览显示的是原图（不转），前端的旋转控件也从 0° 起算——
 * 用户转的是相对这个基准的角度。
 *
 * 与参考实现（tmp/demo/python 的 BASE_ROTATION）保持一致。
 */
export const FLASH_ROTATION = 180

/**
 * 按参数把源图绘制到画布（旋转 + 适配 + 缩放），不读回像素。
 *
 * baseRotation 为兼容调用保留；页面预览与刷图绘制均传 0，硬件补偿在 RGB 数组中完成。
 */
async function drawSource(
  canvas: HTMLCanvasElement,
  imagePath: string,
  width: number,
  height: number,
  options: ImageOptions,
  baseRotation: number
): Promise<void> {
  if (canvas.width !== width) {
    canvas.width = width
  }
  if (canvas.height !== height) {
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('无法获取 Canvas 上下文')
  }
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  const normalized = await normalizedImage(imagePath)
  const image = await loadCanvasImage(canvas, normalized.path)
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight
  const swapped = normalized.orientation >= 5 && normalized.orientation <= 8
  const uprightWidth = swapped ? sourceHeight : sourceWidth
  const uprightHeight = swapped ? sourceWidth : sourceHeight
  // 叠加安装方向补偿：0° + 180° = 180°，宽高不互换；90°/270° 时互换。
  const totalRotation = options.rotation + baseRotation
  const rotated = totalRotation % 180 !== 0
  const naturalWidth = rotated ? uprightHeight : uprightWidth
  const naturalHeight = rotated ? uprightWidth : uprightHeight

  const fitFactor =
    options.fit === 'cover'
      ? Math.max(width / naturalWidth, height / naturalHeight)
      : Math.min(width / naturalWidth, height / naturalHeight)
  const factor = fitFactor * (options.scale / 100)
  const drawWidth = sourceWidth * factor
  const drawHeight = sourceHeight * factor

  ctx.save()
  ctx.translate(width / 2, height / 2)
  // PIL 的 rotate(angle) 为逆时针，画布 rotate 为顺时针，这里取负号保持一致。
  ctx.rotate((-totalRotation * Math.PI) / 180)
  ctx.translate(-uprightWidth * factor / 2, -uprightHeight * factor / 2)
  if (normalized.orientation !== 1) {
    const [a, b, c, d, e, f] = orientationTransform(normalized.orientation, sourceWidth, sourceHeight)
    ctx.transform(a, b, c, d, e * factor, f * factor)
  }
  ctx.drawImage(image, 0, 0, drawWidth, drawHeight)
  ctx.restore()
}

/**
 * 把图片按参数绘制到画布并返回 RGB 数据（不含 alpha）。
 *
 * baseRotation 为可选绘制偏移；实际上传使用 flipRgb180，避免二次补偿。
 */
export async function renderToRgb(
  canvas: HTMLCanvasElement,
  imagePath: string,
  width: number,
  height: number,
  options: ImageOptions,
  baseRotation = 0
): Promise<Uint8Array> {
  await drawSource(canvas, imagePath, width, height, options, baseRotation)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('无法获取 Canvas 上下文')
  }
  const data = ctx.getImageData(0, 0, width, height)
  const pixels = data.data
  const rgb = new Uint8Array(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 4
    const target = index * 3
    const alpha = pixels[source + 3] / 255
    rgb[target] = Math.round(pixels[source] * alpha + 255 * (1 - alpha))
    rgb[target + 1] = Math.round(pixels[source + 1] * alpha + 255 * (1 - alpha))
    rgb[target + 2] = Math.round(pixels[source + 2] * alpha + 255 * (1 - alpha))
  }
  return rgb
}

/**
 * 绘制源图并一次性完成「去 alpha + 亮度 + 对比度 + 饱和度」，返回处理后的 RGB。
 *
 * 几何处理后的源像素是缓存的，滑杆变化时只需要重算色调部分，
 * 省掉每次 drawImage + getImageData 的跨线程往返。
 *
 * 与 renderToRgb + applyBrightnessContrast 的结果逐字节一致：
 * 亮度 → 对比度 → 饱和度，顺序与 PIL 的 ImageEnhance 一致。
 * 对比度和饱和度合到同一遍遍历里（同一像素上依次算，结果与分开算相同）。
 *
 * baseRotation：额外的安装方向补偿。**预览传 0（显示原图）**，
 * 上传路径先按预览方向绘制，再用 flipRgb180 在像素层补偿 180°。
 */
export async function renderToRgbAdjusted(
  canvas: HTMLCanvasElement,
  imagePath: string,
  width: number,
  height: number,
  options: ImageOptions,
  baseRotation = 0
): Promise<Uint8Array> {
  const source = await sourcePixels(canvas, imagePath, width, height, options, baseRotation)
  const count = width * height
  const rgb = new Uint8Array(source)
  const brightness = options.brightness
  const contrast = options.contrast
  const applyBrightness = brightness !== 1
  const applyContrast = contrast !== 1
  // 灰度算法下颜色本来就要丢掉，饱和度没有意义。
  const saturation = options.saturation ?? 1
  const applySaturation = saturation !== 1 && options.algorithm !== 'grayscale'

  let lumaSum = 0
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    let red = rgb[offset]
    let green = rgb[offset + 1]
    let blue = rgb[offset + 2]
    if (applyBrightness) {
      red = clampByte(Math.round(red * brightness))
      green = clampByte(Math.round(green * brightness))
      blue = clampByte(Math.round(blue * brightness))
      rgb[offset] = red
      rgb[offset + 1] = green
      rgb[offset + 2] = blue
    }
    if (applyContrast) {
      lumaSum += 0.299 * red + 0.587 * green + 0.114 * blue
    }
  }
  if (applyContrast || applySaturation) {
    const mean = applyContrast && count > 0 ? lumaSum / count : 0
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3
      let red = rgb[offset]
      let green = rgb[offset + 1]
      let blue = rgb[offset + 2]
      if (applyContrast) {
        red = clampByte(Math.round(mean + (red - mean) * contrast))
        green = clampByte(Math.round(mean + (green - mean) * contrast))
        blue = clampByte(Math.round(mean + (blue - mean) * contrast))
      }
      if (applySaturation) {
        // 饱和度放在最后：对齐 PIL 的处理顺序，也因为对比度会把颜色往灰度均值上压，
        // 最后再补回饱和度才能抵消这一步的掉色。
        const luma = 0.299 * red + 0.587 * green + 0.114 * blue
        red = saturateChannel(red, luma, saturation)
        green = saturateChannel(green, luma, saturation)
        blue = saturateChannel(blue, luma, saturation)
      }
      rgb[offset] = red
      rgb[offset + 1] = green
      rgb[offset + 2] = blue
    }
  }
  return rgb
}

/** 把 RGBA 预览写入画布。 */
export function drawPreview(canvas: HTMLCanvasElement, preview: Uint8Array, width: number, height: number): void {
  if (canvas.width !== width) {
    canvas.width = width
  }
  if (canvas.height !== height) {
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(preview)
  ctx.putImageData(imageData, 0, 0)
}

/**
 * 预览位图取反色。
 *
 * 四色墨水屏在颗粒重排阶段，旧颜色已经退出观察面、目标颜色还没到位，
 * 屏幕上会短暂出现互补色（黄↔蓝、红↔青、黑↔白），这就是「颜色反转」现象。
 * 直接对最终预览取反，几何与调色板路径完全一致，不用为华为/面板两条链路各写一份。
 */
export function invertRgba(preview: Uint8Array): Uint8Array {
  const inverted = new Uint8Array(preview.length)
  for (let offset = 0; offset < preview.length; offset += 4) {
    inverted[offset] = 255 - preview[offset]
    inverted[offset + 1] = 255 - preview[offset + 1]
    inverted[offset + 2] = 255 - preview[offset + 2]
    inverted[offset + 3] = preview[offset + 3]
  }
  return inverted
}

/**
 * 预览用画布带：复用同一块 ImageData，逐段上传到画布。
 *
 * 整图 putImageData 每次都要搬运 width*height*4 字节，分 16 段上传等于把
 * 传输量放大 16 倍；改成带状上传后总传输量与一次整图上传持平。
 */
export interface PreviewBand {
  imageData: ImageData
  width: number
  rows: number
}

/** Canvas 2D 上下文（getContext 返回 any，这里只收窄用到的方法）。 */
export interface CanvasContext2D {
  createImageData(width: number, height: number): ImageData
  putImageData(imageData: ImageData, dx: number, dy: number, dirtyX?: number, dirtyY?: number, dirtyWidth?: number, dirtyHeight?: number): void
}

/** 创建一条预览带。 */
export function createPreviewBand(ctx: CanvasContext2D, width: number, rows: number): PreviewBand {
  return { imageData: ctx.createImageData(width, rows), width, rows }
}

/**
 * 把 [rowStart, rowEnd) 区间的色码写入带并上传到画布。
 *
 * 请求范围可跨越多条预览带；末尾只写入有效行，不覆盖范围外的像素。
 */
export function putCodeBand(
  ctx: CanvasContext2D,
  band: PreviewBand,
  codes: Uint8Array,
  palette: PaletteEntry[],
  width: number,
  rowStart: number,
  rowEnd: number
): void {
  const data = band.imageData.data
  // Callers can restore a full cached image, not just one progressive chunk.
  for (let start = rowStart; start < rowEnd; start += band.rows) {
    const rows = Math.min(band.rows, rowEnd - start)
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const entry = palette[codes[(start + y) * width + x]] ?? palette[0]
        const offset = (y * width + x) * 4
        data[offset] = entry.r
        data[offset + 1] = entry.g
        data[offset + 2] = entry.b
        data[offset + 3] = 255
      }
    }
    ctx.putImageData(band.imageData, 0, start, 0, 0, width, rows)
  }
}

/**
 * 把 RGBA 预览的 [rowStart, rowEnd) 区间写入带并上传到画布。
 *
 * 与 putCodeBand 等价，但直接搬运已经算好的预览位图：
 * 通用面板的色码要按扫描顺序与翻转换算之后才对应屏幕像素，
 * 这条路径用最终位图上屏，方向才不会错。
 */
export function putPreviewBand(
  ctx: CanvasContext2D,
  band: PreviewBand,
  preview: Uint8Array,
  width: number,
  rowStart: number,
  rowEnd: number
): void {
  const data = band.imageData.data
  for (let start = rowStart; start < rowEnd; start += band.rows) {
    const rows = Math.min(band.rows, rowEnd - start)
    const sourceStart = start * width * 4
    data.set(preview.subarray(sourceStart, sourceStart + rows * width * 4))
    ctx.putImageData(band.imageData, 0, start, 0, 0, width, rows)
  }
}

/** 上传前在像素数组中精确旋转 180°，不依赖平台画布的旋转或导出状态。 */
export function flipRgb180(rgb: Uint8Array): Uint8Array {
  if (rgb.length % 3 !== 0) throw new Error('RGB 像素长度必须是 3 的倍数')
  const flipped = new Uint8Array(rgb.length)
  for (let source = 0, target = rgb.length - 3; source < rgb.length; source += 3, target -= 3) {
    flipped[target] = rgb[source]
    flipped[target + 1] = rgb[source + 1]
    flipped[target + 2] = rgb[source + 2]
  }
  return flipped
}

/**
 * 把 RGBA 位图翻转 180°。
 *
 * 传送给屏幕的数据按安装方向转了 180°，但模拟屏要显示「用户抬头看到的样子」，
 * 所以导出显色缩略图时再翻回来，预览与动画里看到的都是正的。
 */
export function flipRgba180(preview: Uint8Array): Uint8Array {
  const flipped = new Uint8Array(preview.length)
  const pixels = preview.length / 4
  for (let index = 0; index < pixels; index += 1) {
    const source = index * 4
    const target = (pixels - 1 - index) * 4
    flipped[target] = preview[source]
    flipped[target + 1] = preview[source + 1]
    flipped[target + 2] = preview[source + 2]
    flipped[target + 3] = preview[source + 3]
  }
  return flipped
}

/**
 * 导出预览缩略图，供队列列表使用。
 *
 * 直接把处理结果写入画布，再缩放到目标宽度导出成 PNG。
 * 网页端没有「临时文件路径」，这里返回 Blob，由调用方存进 IndexedDB。
 */
export async function exportThumbnail(
  canvas: HTMLCanvasElement,
  preview: Uint8Array,
  width: number,
  height: number,
  targetWidth: number
): Promise<Blob> {
  const targetHeight = Math.round((height / width) * targetWidth)
  drawPreview(canvas, preview, width, height)
  // 先画到目标尺寸的离屏画布上，再导出，等价于小程序版的 destWidth/destHeight。
  const scaled = document.createElement('canvas')
  scaled.width = targetWidth
  scaled.height = targetHeight
  const ctx = scaled.getContext('2d')
  if (!ctx) {
    throw new Error('无法获取 Canvas 上下文')
  }
  ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight)
  return canvasToBlob(scaled)
}
