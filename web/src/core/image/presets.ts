/**
 * 预设图像处理模式。
 *
 * 每一项都是一组完整的处理参数，套用后仍可在「图像处理」中自由微调。
 */

import { DEFAULT_OPTIONS, ImageOptions } from './pipeline'

export interface ImagePreset {
  id: string
  name: string
  desc: string
  options: ImageOptions
}

export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id: 'standard',
    name: '标准四色',
    desc: '标准网点 · 留白适配',
    options: { ...DEFAULT_OPTIONS },
  },
  {
    id: 'vivid-4color',
    name: '四色增强',
    desc: '提对比 · 加饱和 · 更接近原图',
    options: { ...DEFAULT_OPTIONS, contrast: 1.15, saturation: 1.25 },
  },
  {
    id: 'contrast-mono',
    name: '高对比黑白',
    desc: '仅黑白双色 · 强对比',
    options: { ...DEFAULT_OPTIONS, blackWhite: true, contrast: 1.15, brightness: 1.05 },
  },
  {
    id: 'photo',
    name: '照片质感',
    desc: '裁剪铺满 · 轻微提亮',
    options: { ...DEFAULT_OPTIONS, fit: 'cover', brightness: 1.05, contrast: 1.1, saturation: 1.15 },
  },
  {
    id: 'floyd',
    name: '细腻网点',
    desc: '细腻网点 · 误差扩散',
    options: { ...DEFAULT_OPTIONS, algorithm: 'floyd' },
  },
  {
    id: 'pure-color',
    name: '纯色量化',
    desc: '不做抖动 · 保留色块',
    options: { ...DEFAULT_OPTIONS, algorithm: 'color' },
  },
  {
    id: 'grayscale',
    name: '灰度网点',
    desc: '先转灰度再抖动',
    options: { ...DEFAULT_OPTIONS, algorithm: 'grayscale' },
  },
  {
    id: 'zoom',
    name: '放大留白',
    desc: '120% 放大 · 居中留白',
    options: { ...DEFAULT_OPTIONS, scale: 120 },
  },
]

/** 抖动算法选项。 */
export const ALGORITHM_OPTIONS: Array<{ value: ImageOptions['algorithm']; label: string }> = [
  { value: 'atkinson', label: '标准网点' },
  { value: 'floyd', label: '细腻网点' },
  { value: 'color', label: '纯色' },
  { value: 'grayscale', label: '灰度' },
]

/** 适配方式选项。 */
export const FIT_OPTIONS: Array<{ value: ImageOptions['fit']; label: string }> = [
  { value: 'contain', label: '留白' },
  { value: 'cover', label: '裁剪' },
]

/** 旋转选项。 */
export const ROTATION_OPTIONS: Array<{ value: ImageOptions['rotation']; label: string }> = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
]
