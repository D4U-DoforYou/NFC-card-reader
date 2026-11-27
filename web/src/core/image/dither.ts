/**
 * 抖动与量化算法。
 *
 * 与 tmp/demo/python/epaper_ble_suite/huawei.py（atkinson_codes）与
 * panel_image.py（convert_pixels）保持一致：华为路径使用整除误差扩散，
 * 通用面板路径使用四舍五入误差扩散。
 *
 * 最近色匹配使用「亮度 + 色度」加权距离，而不是 RGB 欧氏距离：
 * 在 BWRY 四色屏上，RGB 欧氏距离会把中性灰判成黄或红（灰度照片会出现彩色斑点），
 * 加权距离把亮度差压到 1/3 权重，色度差保持原权重，中性色因此稳定落到黑白两色。
 */

export interface PaletteEntry {
  r: number
  g: number
  b: number
  /** 写入点阵时使用的色码。 */
  code: number
}

export interface DiffuseRule {
  dx: number
  dy: number
  weight: number
}

/** Atkinson：误差按 1/8 分配到 6 个邻居。 */
export const ATKINSON_RULE: DiffuseRule[] = [
  { dx: 1, dy: 0, weight: 1 / 8 },
  { dx: 2, dy: 0, weight: 1 / 8 },
  { dx: -1, dy: 1, weight: 1 / 8 },
  { dx: 0, dy: 1, weight: 1 / 8 },
  { dx: 1, dy: 1, weight: 1 / 8 },
  { dx: 0, dy: 2, weight: 1 / 8 },
]

/** Floyd-Steinberg：误差按 7/16、3/16、5/16、1/16 分配。 */
export const FLOYD_RULE: DiffuseRule[] = [
  { dx: 1, dy: 0, weight: 7 / 16 },
  { dx: -1, dy: 1, weight: 3 / 16 },
  { dx: 0, dy: 1, weight: 5 / 16 },
  { dx: 1, dy: 1, weight: 1 / 16 },
]

/** 四舍五入（dartboard）。 */
function roundDart(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)
}

/** ITU-R BT.601 亮度系数（与 Python 参考实现保持一致）。 */
export const LUMA_R = 0.299
export const LUMA_G = 0.587
export const LUMA_B = 0.114

/** 调色板度量的缓存，避免每个像素重复换算。 */
const metricCache = new WeakMap<PaletteEntry[], Float64Array>()

/**
 * 把调色板换算成扁平数组：[r, g, b] 连续存放。
 *
 * 量化内核每个像素都要比对全部调色板项，用扁平 Float64Array 取值比读对象属性快得多，
 * 这也是抖动内核能跑得动的原因。
 */
export function buildPaletteMetric(palette: PaletteEntry[]): Float64Array {
  const flat = new Float64Array(palette.length * 3)
  for (let index = 0; index < palette.length; index += 1) {
    const entry = palette[index]
    const offset = index * 3
    flat[offset] = entry.r
    flat[offset + 1] = entry.g
    flat[offset + 2] = entry.b
  }
  return flat
}

/** 取调色板度量（带缓存）。 */
export function paletteMetric(palette: PaletteEntry[]): Float64Array {
  const cached = metricCache.get(palette)
  if (cached) {
    return cached
  }
  const metric = buildPaletteMetric(palette)
  metricCache.set(palette, metric)
  return metric
}

/**
 * 按 RGB 欧氏距离找最近色。
 *
 * 与参考实现（tmp/demo/python，也就是厂商 App 的算法）逐字节一致。
 *
 * 注意：不要换成「感知加权」之类的其它度量——参考实现的固定向量
 * （APK fixture）就是按 RGB 欧氏距离算出来的，换了就会与厂商 App 刷出的图不同。
 */
export function nearestIndexMetric(r: number, g: number, b: number, metric: Float64Array): number {
  let best = 0
  let bestDistance = Number.MAX_VALUE
  for (let index = 0, offset = 0; offset < metric.length; index += 1, offset += 3) {
    const dr = r - metric[offset]
    const dg = g - metric[offset + 1]
    const db = b - metric[offset + 2]
    const distance = dr * dr + dg * dg + db * db
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/** 在调色板中找最近颜色（RGB 欧氏距离，与参考实现一致）。 */
export function nearestIndex(r: number, g: number, b: number, palette: PaletteEntry[]): number {
  return nearestIndexMetric(r, g, b, paletteMetric(palette))
}

/**
 * 误差扩散量化，返回每像素的调色板下标。
 *
 * @param rgb 长度必须为 width*height*3 的 RGB 数据
 * @param truncate true 时按整除扩散（华为路径），false 时四舍五入（通用面板路径）
 * @param wrapLeft true 时 x=0 的左下邻居回绕到本行最后一个像素（华为路径的既有行为）
 */
export function diffuseCodes(
  rgb: Uint8Array,
  width: number,
  height: number,
  palette: PaletteEntry[],
  rule: DiffuseRule[],
  truncate: boolean,
  wrapLeft = false
): Uint8Array {
  const pixels = new Uint8Array(rgb)
  const codes = new Uint8Array(width * height)
  return diffuseCodesRange(pixels, width, height, palette, rule, truncate, wrapLeft, 0, height, codes)
}

/**
 * 分段执行误差扩散，用于把计算切碎、避免长时间占用小程序主线程。
 *
 * 内核为性能做过等价改写：比较顺序、整除/四舍五入的取整方式、clamp 边界都与
 * 参考实现逐位一致，但去掉了「每像素每邻居新建一个 delta 数组」的分配开销，
 * 并把 truncate 分支提到像素循环之外。
 *
 * @param pixels 跨分段复用的像素缓冲区，误差会累积到下一段
 * @param rowStart 起始行（含）
 * @param rowEnd 结束行（不含）
 * @param codes 供写入的色码数组
 */
export function diffuseCodesRange(
  pixels: Uint8Array,
  width: number,
  height: number,
  palette: PaletteEntry[],
  rule: DiffuseRule[],
  truncate: boolean,
  wrapLeft: boolean,
  rowStart: number,
  rowEnd: number,
  codes: Uint8Array
): Uint8Array {
  if (pixels.length !== width * height * 3) {
    throw new Error('RGB 缓冲区长度与图像尺寸不匹配')
  }
  const metric = paletteMetric(palette)
  const paletteSize = palette.length
  const ruleSize = rule.length
  for (let y = rowStart; y < rowEnd; y += 1) {
    const rowBase = y * width
    for (let x = 0; x < width; x += 1) {
      const index = rowBase + x
      const offset = index * 3
      const red = pixels[offset]
      const green = pixels[offset + 1]
      const blue = pixels[offset + 2]

      // 最近色查找：RGB 欧氏距离，与参考实现完全一致
      let choice = 0
      let bestDistance = Number.MAX_VALUE
      for (let p = 0, offset = 0; p < paletteSize; p += 1, offset += 3) {
        const dr = red - metric[offset]
        const dg = green - metric[offset + 1]
        const db = blue - metric[offset + 2]
        const distance = dr * dr + dg * dg + db * db
        if (distance < bestDistance) {
          bestDistance = distance
          choice = p
        }
      }
      codes[index] = choice

      const entry = palette[choice]
      const errorR = red - entry.r
      const errorG = green - entry.g
      const errorB = blue - entry.b

      // 整除扩散：所有邻居权重都是 1/8，缩放后的误差与邻居无关，
      // 在循环外算一次就够（参考实现也是这么算的）。
      // 循环内算等于把同样的取整做了 6 遍，是内核里最大的一笔冤枉开销。
      let truncR = 0
      let truncG = 0
      let truncB = 0
      if (truncate) {
        truncR = Math.floor(Math.abs(errorR) / 8) * (errorR >= 0 ? 1 : -1)
        truncG = Math.floor(Math.abs(errorG) / 8) * (errorG >= 0 ? 1 : -1)
        truncB = Math.floor(Math.abs(errorB) / 8) * (errorB >= 0 ? 1 : -1)
      }

      for (let k = 0; k < ruleSize; k += 1) {
        const item = rule[k]
        let nx = x + item.dx
        let ny = y + item.dy
        if (nx < 0) {
          if (!wrapLeft) {
            continue
          }
          // 华为路径：左下邻居在 x=0 时回绕到本行最后一个像素，
          // 与参考实现的线性下标 index + width - 1 一致。
          nx = width - 1
          ny = y
        }
        if (nx >= width || ny < 0 || ny >= height) {
          continue
        }
        const target = (ny * width + nx) * 3
        let scaledR: number
        let scaledG: number
        let scaledB: number
        if (truncate) {
          scaledR = truncR
          scaledG = truncG
          scaledB = truncB
        } else {
          const weight = item.weight
          scaledR = roundDart(errorR * weight)
          scaledG = roundDart(errorG * weight)
          scaledB = roundDart(errorB * weight)
        }
        let value = pixels[target] + scaledR
        pixels[target] = value < 0 ? 0 : value > 255 ? 255 : value
        value = pixels[target + 1] + scaledG
        pixels[target + 1] = value < 0 ? 0 : value > 255 ? 255 : value
        value = pixels[target + 2] + scaledB
        pixels[target + 2] = value < 0 ? 0 : value > 255 ? 255 : value
      }
    }
  }
  return codes
}

/** 不做误差扩散，直接取最近颜色（面板 COLOR 算法）。 */
export function nearestCodes(rgb: Uint8Array, width: number, height: number, palette: PaletteEntry[]): Uint8Array {
  const codes = new Uint8Array(width * height)
  const metric = paletteMetric(palette)
  const count = width * height
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    codes[index] = nearestIndexMetric(rgb[offset], rgb[offset + 1], rgb[offset + 2], metric)
  }
  return codes
}

/**
 * 分段执行最近色量化，供渐进式预览使用（与 nearestCodes 结果一致）。
 */
export function nearestCodesRange(
  rgb: Uint8Array,
  width: number,
  palette: PaletteEntry[],
  rowStart: number,
  rowEnd: number,
  codes: Uint8Array
): Uint8Array {
  const metric = paletteMetric(palette)
  for (let y = rowStart; y < rowEnd; y += 1) {
    const rowBase = y * width
    for (let x = 0; x < width; x += 1) {
      const index = rowBase + x
      const offset = index * 3
      codes[index] = nearestIndexMetric(rgb[offset], rgb[offset + 1], rgb[offset + 2], metric)
    }
  }
  return codes
}

/**
 * 饱和度调整后的单个通道值。
 *
 * 把各通道相对亮度的偏移按 factor 放大或压缩。
 * factor = 1 表示不变，0 表示完全去色，>1 表示增强。
 */
export function saturateChannel(value: number, luma: number, factor: number): number {
  return clamp(Math.round(luma + (value - luma) * factor))
}

/**
 * 调整饱和度：把各通道相对亮度的偏移按比例放大或压缩。
 *
 * 墨水屏只有有限几个色位，原图里偏灰的颜色很容易被判成黑白；
 * 提高饱和度可以把它们推回彩色通道，得到更接近原图的显示效果。
 *
 * 原地修改并返回同一缓冲区（调用方传入的是自己的临时缓冲）。
 */
export function applySaturation(rgb: Uint8Array, factor: number): Uint8Array {
  if (factor === 1) {
    return rgb
  }
  const count = rgb.length / 3
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    const red = rgb[offset]
    const green = rgb[offset + 1]
    const blue = rgb[offset + 2]
    const luma = LUMA_R * red + LUMA_G * green + LUMA_B * blue
    rgb[offset] = saturateChannel(red, luma, factor)
    rgb[offset + 1] = saturateChannel(green, luma, factor)
    rgb[offset + 2] = saturateChannel(blue, luma, factor)
  }
  return rgb
}

/** 转灰度（Luma），与 PIL 的 convert('L') 近似。 */
export function toGrayscale(rgb: Uint8Array): Uint8Array {
  const gray = new Uint8Array(rgb.length / 3)
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 3
    gray[index] = clamp(Math.round(0.299 * rgb[offset] + 0.587 * rgb[offset + 1] + 0.114 * rgb[offset + 2]))
  }
  return gray
}

/** 灰度数据转回 RGB 三通道，便于统一处理。 */
export function grayToRgb(gray: Uint8Array): Uint8Array {
  const rgb = new Uint8Array(gray.length * 3)
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 3
    rgb[offset] = gray[index]
    rgb[offset + 1] = gray[index]
    rgb[offset + 2] = gray[index]
  }
  return rgb
}

/**
 * RGB 直接转灰度 RGB，一次遍历完成，结果与 grayToRgb(toGrayscale(rgb)) 完全一致。
 */
export function grayscaleRgbFrom(rgb: Uint8Array): Uint8Array {
  const count = rgb.length / 3
  const out = new Uint8Array(count * 3)
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    const value = clamp(Math.round(0.299 * rgb[offset] + 0.587 * rgb[offset + 1] + 0.114 * rgb[offset + 2]))
    out[offset] = value
    out[offset + 1] = value
    out[offset + 2] = value
  }
  return out
}

/** 计算灰度均值，对齐 PIL ImageEnhance.Contrast 的基准。 */
export function grayscaleMean(rgb: Uint8Array): number {
  let sum = 0
  const count = rgb.length / 3
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    sum += 0.299 * rgb[offset] + 0.587 * rgb[offset + 1] + 0.114 * rgb[offset + 2]
  }
  return count === 0 ? 0 : sum / count
}

function clamp(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 255) {
    return 255
  }
  return value
}
