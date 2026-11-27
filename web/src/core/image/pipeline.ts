/**
 * 图像处理管线：几何变换、亮度/对比度、抖动量化与点阵打包。
 *
 * 华为路径对齐 tmp/demo/python/epaper_ble_suite/huawei.py：
 *   2bit 色码 + 列优先反向打包。
 * 通用面板路径对齐 panel_image.py：
 *   平面/扫描方向/翻转感知的位打包，并支持 ZHX 重排。
 */

import { DeviceProfile } from '../epd/profile'
import {
  ATKINSON_RULE,
  DiffuseRule,
  FLOYD_RULE,
  PaletteEntry,
  diffuseCodes,
  diffuseCodesRange,
  grayscaleMean,
  grayscaleRgbFrom,
  nearestCodes,
  nearestCodesRange,
  nearestIndex,
} from './dither'

export type DitherAlgorithm = 'atkinson' | 'floyd' | 'color' | 'grayscale'
export type FitMode = 'contain' | 'cover'

export interface ImageOptions {
  algorithm: DitherAlgorithm
  fit: FitMode
  rotation: 0 | 90 | 180 | 270
  brightness: number
  contrast: number
  /** 饱和度：1 为原样，>1 更鲜艳，0 为去色。 */
  saturation: number
  scale: number
  blackWhite: boolean
}

export const DEFAULT_OPTIONS: ImageOptions = {
  algorithm: 'atkinson',
  fit: 'contain',
  rotation: 0,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  scale: 100,
  blackWhite: false,
}

/** 华为四色调色板。 */
export const HUAWEI_PALETTE: PaletteEntry[] = [
  { r: 0, g: 0, b: 0, code: 0 },
  { r: 255, g: 255, b: 255, code: 1 },
  { r: 245, g: 205, b: 0, code: 2 },
  { r: 200, g: 0, b: 0, code: 3 },
]

/** 面板色码对应的显示色。 */
const PANEL_RGB: Record<string, [number, number, number]> = {
  '00': [0, 0, 0],
  '01': [255, 255, 255],
  '02': [255, 0, 0],
  '03': [255, 255, 0],
  '04': [255, 128, 0],
  '05': [0, 255, 0],
  '06': [0, 255, 255],
  '07': [0, 0, 255],
  '08': [128, 0, 128],
}

export interface PreparedImage {
  /** 每像素的 2bit 色码（华为路径为调色板下标，面板路径为面板色码）。 */
  codes: Uint8Array
  /** 打包后的点阵数据（skipPacked 时不生成）。 */
  packed?: Uint8Array
  /** RGBA 预览图，长度为 width*height*4（skipPreview 时不生成）。 */
  preview?: Uint8Array
  width: number
  height: number
}

/**
 * 取消令牌：分块处理中随时中止，避免过期任务继续占用主线程。
 */
export interface CancelToken {
  cancelled: boolean
}

/** 创建一个取消令牌。 */
export function createCancelToken(): CancelToken {
  return { cancelled: false }
}

/**
 * 分块处理的附加控制项。
 */
export interface PrepareOptions {
  /** 已完成的比例（0..1），用于驱动进度动画。 */
  onProgress?: (ratio: number) => void
  /** 分块回调，用于把色码逐段画到预览画布。 */
  onChunk?: (rowStart: number, rowEnd: number, codes: Uint8Array) => void
  /** 取消令牌；被取消时立即返回 null。 */
  token?: CancelToken
  /** 跳过点阵打包（纯预览场景不需要）。 */
  skipPacked?: boolean
  /** 跳过预览位图生成（渐进绘制时不需要）。 */
  skipPreview?: boolean
}

/** 单次分块处理覆盖的行数；越小越流畅，开销越大。 */
export const PREVIEW_CHUNK_ROWS = 48

/** 应用亮度与对比度，语义对齐 PIL 的 ImageEnhance。 */
export function applyBrightnessContrast(rgb: Uint8Array, brightness: number, contrast: number): Uint8Array {
  const result = new Uint8Array(rgb)
  if (brightness !== 1) {
    for (let index = 0; index < result.length; index += 1) {
      result[index] = clamp(Math.round(result[index] * brightness))
    }
  }
  if (contrast !== 1) {
    const mean = grayscaleMean(result)
    for (let index = 0; index < result.length; index += 1) {
      result[index] = clamp(Math.round(mean + (result[index] - mean) * contrast))
    }
  }
  return result
}

/**
 * 把指定行的色码写入预览缓冲区（用于分块渐进式绘制）。
 */
export function fillPreviewRows(
  target: Uint8ClampedArray,
  codes: Uint8Array,
  palette: PaletteEntry[],
  width: number,
  rowStart: number,
  rowEnd: number
): void {
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const entry = palette[codes[index]] ?? palette[0]
      const offset = index * 4
      target[offset] = entry.r
      target[offset + 1] = entry.g
      target[offset + 2] = entry.b
      target[offset + 3] = 255
    }
  }
}

/** 生成预览 RGBA 数据。 */
export function buildPreview(codes: Uint8Array, palette: PaletteEntry[], width: number, height: number): Uint8Array {
  const preview = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const entry = palette[codes[index]] ?? palette[0]
    const offset = index * 4
    preview[offset] = entry.r
    preview[offset + 1] = entry.g
    preview[offset + 2] = entry.b
    preview[offset + 3] = 255
  }
  return preview
}

/** 选择实际使用的调色板。 */
export function resolvePalette(options: ImageOptions, base: PaletteEntry[]): PaletteEntry[] {
  if (options.blackWhite) {
    return [
      { r: 0, g: 0, b: 0, code: 0 },
      { r: 255, g: 255, b: 255, code: 1 },
    ]
  }
  return base
}

/** 华为四色调色板（黑白模式下退化为两色）。 */
export function resolveHuaweiPalette(options: ImageOptions): PaletteEntry[] {
  return resolvePalette(options, HUAWEI_PALETTE)
}

/** 量化参数：源像素、扩散规则与误差处理方式。 */
interface QuantizePlan {
  source: Uint8Array
  /** source 是否为本次独占（可直接就地扩散，不必再拷贝一份）。 */
  owned: boolean
  rule: DiffuseRule[]
  truncate: boolean
  wrapLeft: boolean
  nearest: boolean
}

/** 解析一次量化所需的全部参数。 */
function planQuantize(
  rgb: Uint8Array,
  options: ImageOptions,
  baseRule: DiffuseRule[],
  truncate: boolean,
  wrapLeft: boolean
): QuantizePlan {
  const grayscale = options.algorithm === 'grayscale'
  // 灰度分支自己产出一份缓冲区，后续扩散可就地写，无需再拷贝。
  const source = grayscale ? grayscaleRgbFrom(rgb) : rgb
  return {
    source,
    owned: grayscale,
    rule: options.algorithm === 'floyd' ? FLOYD_RULE : baseRule,
    truncate,
    wrapLeft,
    nearest: options.algorithm === 'color',
  }
}

/** 按算法求色码。 */
function quantize(
  rgb: Uint8Array,
  width: number,
  height: number,
  palette: PaletteEntry[],
  options: ImageOptions,
  rule: DiffuseRule[],
  truncate: boolean,
  wrapLeft = false
): Uint8Array {
  const plan = planQuantize(rgb, options, rule, truncate, wrapLeft)
  if (plan.nearest) {
    return nearestCodes(plan.source, width, height, palette)
  }
  return diffuseCodes(plan.source, width, height, palette, plan.rule, plan.truncate, plan.wrapLeft)
}

/** 让出主线程一个时间片。 */
function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

/** 华为 552×768 四色路径：2bit 色码 + 列优先反向打包。 */
export function prepareHuawei(
  rgb: Uint8Array,
  width: number,
  height: number,
  options: ImageOptions
): PreparedImage {
  const palette = resolvePalette(options, HUAWEI_PALETTE)
  const codes = quantize(rgb, width, height, palette, options, ATKINSON_RULE, true, true)
  const packed = packHuaweiCodes(codes, width, height)
  return { codes, packed, preview: buildPreview(codes, palette, width, height), width, height }
}

/** 华为点阵打包：列优先（从右到左），列内每 4 行一个字节。 */
export function packHuaweiCodes(codes: Uint8Array, width: number, height: number): Uint8Array {
  if (height % 4 !== 0 || codes.length !== width * height) {
    throw new Error('2bit 色码尺寸或内容错误')
  }
  const packed = new Uint8Array(width * (height / 4))
  let offset = 0
  for (let x = width - 1; x >= 0; x -= 1) {
    for (let y = height - 1; y >= 0; y -= 4) {
      let value = 0
      for (let bit = 0; bit < 4; bit += 1) {
        value += codes[(y - bit) * width + x] << (6 - 2 * bit)
      }
      packed[offset] = value & 0xff
      offset += 1
    }
  }
  return packed
}

/** 构造面板调色板：顺序与色码来自 D1 扩展信息。 */
export function panelPalette(profile: DeviceProfile): PaletteEntry[] {
  const mapping = profile.colorCodes ?? {}
  const order = profile.colorCount === 3 ? ['00', '01', '02'] : Object.keys(mapping)
  return order.map(key => {
    const rgb = PANEL_RGB[key] ?? [0, 0, 0]
    return { r: rgb[0], g: rgb[1], b: rgb[2], code: mapping[key] ?? 0 }
  })
}

/** 通用面板路径：平面、扫描方向与翻转感知的位打包。 */
export function preparePanel(
  rgb: Uint8Array,
  width: number,
  height: number,
  profile: DeviceProfile,
  options: ImageOptions
): PreparedImage {
  const palette = panelPalette(profile)
  if (!palette.length) {
    throw new Error('面板没有可用调色板')
  }
  const plan = planQuantize(rgb, options, ATKINSON_RULE, false, false)
  const codes = new Uint8Array(width * height)
  if (plan.nearest) {
    codes.set(nearestCodes(plan.source, width, height, palette))
  } else {
    codes.set(quantize(plan.source, width, height, palette, options, ATKINSON_RULE, false, false))
  }
  const result = packPanelInternal(codes, plan.source, width, height, profile, options, palette)
  return { codes, packed: result.packed, preview: result.preview, width, height }
}

/**
 * 面板位打包与预览生成（同步与异步两条路径共用）。
 *
 * skipPacked / skipPreview 让「只要预览」的场景不必把点阵也打出来。
 */
function packPanelInternal(
  choices: Uint8Array,
  source: Uint8Array,
  width: number,
  height: number,
  profile: DeviceProfile,
  options: ImageOptions,
  palette: PaletteEntry[],
  flags: { skipPacked?: boolean; skipPreview?: boolean } = {}
): { packed?: Uint8Array; preview?: Uint8Array } {
  const colorCount = profile.colorCount
  const planes: Uint8Array[] = colorCount === 3 ? [new Uint8Array(0), new Uint8Array(0)] : [new Uint8Array(0)]
  const planeUnits = [0, 0]
  let packedUnit = 0
  const buildPreview = !flags.skipPreview
  const preview = buildPreview ? new Uint8Array(width * height * 4) : undefined

  for (let index = 0; index < width * height; index += 1) {
    let originalX: number
    let originalY: number
    if (profile.scanVertical) {
      originalX = Math.floor(index / height)
      originalY = index % height
    } else {
      originalX = index % width
      originalY = Math.floor(index / width)
    }
    const remainder =
      profile.scanVertical ? originalY % (colorCount > 4 ? 2 : 8) : originalX % (colorCount > 4 ? 2 : 8)
    const x = profile.flipHorizontal ? width - 1 - originalX : originalX
    const y = profile.flipVertical ? height - 1 - originalY : originalY
    const pixelOffset = (y * width + x) * 3

    let colorCode: number
    if (colorCount === 3 && options.algorithm === 'color') {
      const map = profile.colorCodes ?? {}
      const r = source[pixelOffset]
      const g = source[pixelOffset + 1]
      const b = source[pixelOffset + 2]
      if (r > 0xa0 && g < 0x80 && b < 0x80) {
        colorCode = map['02'] ?? 1
      } else if (Math.min(r, g, b) >= 0x50) {
        colorCode = map['01'] ?? 2
      } else {
        colorCode = map['00'] ?? 0
      }
    } else if (options.algorithm === 'color') {
      // 纯色量化按实际像素取最近色（与参考实现一致，翻转面板也不会错位）。
      const nearest = nearestIndex(source[pixelOffset], source[pixelOffset + 1], source[pixelOffset + 2], palette)
      colorCode = palette[nearest] ? palette[nearest].code : 0
    } else {
      const choice = choices[y * width + x]
      colorCode = palette[choice] ? palette[choice].code : 0
    }

    const display = palette.find(item => item.code === colorCode) ?? palette[0]
    if (preview) {
      const previewOffset = (y * width + x) * 4
      preview[previewOffset] = display.r
      preview[previewOffset + 1] = display.g
      preview[previewOffset + 2] = display.b
      preview[previewOffset + 3] = 255
    }

    if (colorCount === 3) {
      const bits = [(colorCode >> 1) & 1, colorCode & 1]
      bits.forEach((bit, plane) => {
        if (remainder === 0) {
          planeUnits[plane] = 0
        }
        planeUnits[plane] |= bit << (7 - remainder)
        if (remainder === 7) {
          appendPlane(planes, plane, planeUnits[plane])
        } else if (profile.scanVertical && originalY === height - 1 && height % 8 !== 0) {
          appendPlane(planes, plane, planeUnits[plane])
        } else if (!profile.scanVertical && originalX === width - 1 && width % 8 !== 0) {
          appendPlane(planes, plane, planeUnits[plane])
        }
      })
      continue
    }

    if (colorCount === 4) {
      const offset = remainder % 4
      if (offset === 0) {
        packedUnit = 0
      }
      packedUnit |= ((colorCode >> 1) & 1) << (7 - 2 * offset)
      packedUnit |= (colorCode & 1) << (6 - 2 * offset)
      if (offset === 3) {
        appendPlane(planes, 0, packedUnit & 0xff)
      }
    } else {
      const offset = remainder % 2
      if (offset === 0) {
        packedUnit = 0
      }
      for (let bitIndex = 0; bitIndex < 4; bitIndex += 1) {
        const bit = (colorCode >> (3 - bitIndex)) & 1
        packedUnit |= bit << (7 - 4 * offset - bitIndex)
      }
      if (offset === 1) {
        appendPlane(planes, 0, packedUnit & 0xff)
      }
    }
  }

  const secondPlane = planes[1]
  if (flags.skipPacked) {
    return { packed: undefined, preview }
  }
  let packed: Uint8Array = new Uint8Array(planes[0].length + (secondPlane ? secondPlane.length : 0))
  packed.set(planes[0], 0)
  if (secondPlane) {
    packed.set(secondPlane, planes[0].length)
  }
  if (profile.isZhx) {
    packed = zhxC21Reorder(packed)
  }
  return { packed, preview }
}

function appendPlane(planes: Uint8Array[], plane: number, value: number): void {
  const next = new Uint8Array(planes[plane].length + 1)
  next.set(planes[plane], 0)
  next[planes[plane].length] = value & 0xff
  planes[plane] = next
}

/** ZHX C2-1 面板点阵重排。 */
export function zhxC21Reorder(data: Uint8Array): Uint8Array {
  const width = 552
  const height = 768
  const rowBytes = height / 4
  const planeSize = rowBytes * (width / 2)
  if (data.length !== planeSize * 2) {
    throw new Error(`C2-1 点阵长度应为 ${planeSize * 2}，实际 ${data.length}`)
  }
  const first = new Uint8Array(planeSize)
  const second = new Uint8Array(planeSize)

  const copyColumns = (begin: number, end: number, target: Uint8Array, map: (column: number) => number): void => {
    for (let column = begin; column <= end; column += 1) {
      const targetStart = rowBytes * map(column)
      const sourceStart = column * rowBytes
      target.set(data.slice(sourceStart, sourceStart + rowBytes), targetStart)
    }
  }

  copyColumns(138, 275, first, column => width - 1 - 2 * column)
  copyColumns(276, 413, first, column => 2 * (column - width / 2))
  copyColumns(0, 137, second, column => width - 1 - 2 * column - 276)
  copyColumns(414, 551, second, column => 2 * (column - width / 2) - 276)

  const result = new Uint8Array(planeSize * 2)
  result.set(first, 0)
  result.set(second, planeSize)
  return result
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


/**
 * 分块执行华为路径的量化与打包，避免长时间占用小程序主线程。
 *
 * 两条分支（最近色 / 误差扩散）统一按块推进，便于渐进式绘制与随时取消。
 * 被取消时返回 null。
 */
export async function prepareHuaweiAsync(
  rgb: Uint8Array,
  width: number,
  height: number,
  options: ImageOptions,
  prepare: PrepareOptions = {}
): Promise<PreparedImage | null> {
  const palette = resolvePalette(options, HUAWEI_PALETTE)
  const plan = planQuantize(rgb, options, ATKINSON_RULE, true, true)
  const codes = new Uint8Array(width * height)
  // 误差扩散要就地写回像素；独占缓冲可直接用，共享的必须先复制一份。
  const pixels = plan.owned ? plan.source : new Uint8Array(plan.source)
  for (let start = 0; start < height; start += PREVIEW_CHUNK_ROWS) {
    const end = Math.min(start + PREVIEW_CHUNK_ROWS, height)
    if (plan.nearest) {
      nearestCodesRange(plan.source, width, palette, start, end, codes)
    } else {
      diffuseCodesRange(pixels, width, height, palette, plan.rule, plan.truncate, plan.wrapLeft, start, end, codes)
    }
    prepare.onProgress?.(end / height)
    prepare.onChunk?.(start, end, codes)
    if (prepare.token?.cancelled) {
      return null
    }
    await yieldToMain()
  }
  const packed = prepare.skipPacked ? undefined : packHuaweiCodes(codes, width, height)
  const preview = prepare.skipPreview ? undefined : buildPreview(codes, palette, width, height)
  prepare.onProgress?.(1)
  return { codes, packed, preview, width, height }
}

/**
 * 分块执行通用面板路径的量化与打包。
 *
 * 与华为路径一样支持 skipPacked / skipPreview：图像处理页拖动时只要预览，
 * 不用每次都把点阵也打出来。
 */
export async function preparePanelAsync(
  rgb: Uint8Array,
  width: number,
  height: number,
  profile: DeviceProfile,
  options: ImageOptions,
  prepare: PrepareOptions = {}
): Promise<PreparedImage | null> {
  const palette = panelPalette(profile)
  if (!palette.length) {
    throw new Error('面板没有可用调色板')
  }
  const plan = planQuantize(rgb, options, ATKINSON_RULE, false, false)
  const codes = new Uint8Array(width * height)
  const pixels = plan.owned ? plan.source : new Uint8Array(plan.source)
  for (let start = 0; start < height; start += PREVIEW_CHUNK_ROWS) {
    const end = Math.min(start + PREVIEW_CHUNK_ROWS, height)
    if (plan.nearest) {
      nearestCodesRange(plan.source, width, palette, start, end, codes)
    } else {
      diffuseCodesRange(pixels, width, height, palette, plan.rule, plan.truncate, plan.wrapLeft, start, end, codes)
    }
    prepare.onProgress?.((end / height) * 0.7)
    if (prepare.token?.cancelled) {
      return null
    }
    await yieldToMain()
  }
  const result = packPanelInternal(codes, plan.source, width, height, profile, options, palette, {
    skipPacked: prepare.skipPacked,
    skipPreview: prepare.skipPreview,
  })
  prepare.onProgress?.(1)
  return {
    codes,
    packed: result.packed,
    preview: result.preview,
    width,
    height,
  }
}

/**
 * 目标屏幕规格：图像处理页的预览与刷图引导共用同一套几何与调色板。
 *
 * 两者只要规格一致，图像处理页算出的结果就能直接给刷图引导用，不必再处理一遍。
 */
export interface TargetSpec {
  family: 'huawei' | 'panel'
  width: number
  height: number
  /** 通用面板路径需要屏幕档案（扫描方向、翻转、ZHX 重排等）。 */
  profile?: DeviceProfile
}

/**
 * 目标规格的指纹：凡是会影响点阵的几何与调色板特征都算进去。
 *
 * 注意华为路径不掺屏幕档案：它的打包只跟分辨率有关（`packHuaweiCodes`），
 * 档案里的扫描方向、翻转、ZHX 重排、色码映射一概不参与。
 * 要是把它们也算进指纹，「没连读卡器时的预览」和「刷图」就会算成两个条目，
 * 缓存永远命中不了，同一张图还是会被处理两遍。
 */
export function targetKey(spec: TargetSpec): string {
  const profile = spec.profile
  if (!profile || spec.family !== 'panel') {
    return `${spec.family}|${spec.width}x${spec.height}`
  }
  const codes = profile.colorCodes
    ? Object.entries(profile.colorCodes)
        .sort()
        .map(([key, value]) => `${key}:${value}`)
        .join(',')
    : ''
  return [
    spec.family,
    `${spec.width}x${spec.height}`,
    profile.colorCount,
    profile.scanVertical ? 'sv' : 'sh',
    profile.flipHorizontal ? 'fh' : '',
    profile.flipVertical ? 'fv' : '',
    profile.isZhx ? 'zhx' : '',
    codes,
  ].join('|')
}

/** 目标屏幕的显示调色板（预览上色用）。 */
export function targetPalette(spec: TargetSpec, options: ImageOptions): PaletteEntry[] {
  if (spec.family === 'panel' && spec.profile) {
    return resolvePalette(options, panelPalette(spec.profile))
  }
  return resolveHuaweiPalette(options)
}

/**
 * 按目标屏幕统一处理图像：华为路径与通用面板路径共用这一个入口。
 *
 * 图像处理页用它出预览，刷图引导用它打包，两边走同一条代码路径，
 * 结果一致，也避免了「同一张图处理两遍」。
 *
 * width/height 是实际处理的分辨率：图像处理页拖动时用的是降分辨率档，
 * 和目标屏幕的分辨率并不相同，所以这里要显式传进来。
 */
export async function prepareForTarget(
  rgb: Uint8Array,
  width: number,
  height: number,
  spec: TargetSpec,
  options: ImageOptions,
  prepare: PrepareOptions = {}
): Promise<PreparedImage | null> {
  if (spec.family === 'panel') {
    if (!spec.profile) {
      throw new Error('通用面板缺少屏幕档案')
    }
    return preparePanelAsync(rgb, width, height, spec.profile, options, prepare)
  }
  return prepareHuaweiAsync(rgb, width, height, options, prepare)
}
