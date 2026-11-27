/**
 * 墨水屏显影示意：整屏复位脉冲与黑、黄、红颗粒逐步稳定。
 * 上传时按进度分块飞入；显影时保持整幅固定，循环至设备确认完成。
 */
import { GuideBlock } from './blocks'

export type EpdScreenState = 'idle' | 'transfer' | 'complete' | 'display' | 'settle' | 'done'
export const SETTLE_MS = 900
const FLY_MS = 420

type Pigment = 'black' | 'yellow' | 'red'
interface PigmentLayer { kind: Pigment; canvas: OffscreenCanvas }
type DrivePhase = 'mono' | 'reverse' | 'redPass' | 'yellowPass'
interface DriveLayer { kind: DrivePhase; canvas: OffscreenCanvas }
export interface InkAppearance {
  target: number
  black: number
  yellow: number
  red: number
  white: number
  dark: number
  redWash: number
  yellowWash: number
  mono: number
  reverse: number
  redPass: number
  yellowPass: number
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)) }
function smooth(value: number): number {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}
const FINAL_INK: InkAppearance = {
  target: 1, black: 1, yellow: 1, red: 1,
  white: 0, dark: 0, redWash: 0, yellowWash: 0,
  mono: 0, reverse: 0, redPass: 0, yellowPass: 0,
}
interface DriveStep { duration: number; ink: InkAppearance }
function step(duration: number, patch: Partial<InkAppearance>): DriveStep {
  return { duration, ink: { ...FINAL_INK, ...patch } }
}

/**
 * 有保持时间的短驱动脉冲，40ms 内翻转，替代秒级正弦渐变。
 * 分组：黑白清屏 → 红黄试驱动 → 图案正反相 → 多次分色重写。
 * 是视觉示意，不代表特定面板的电压或私有 LUT。
 */
const DRIVE_STEPS: DriveStep[] = [
  step(220, { white: 1 }), step(200, { dark: .99 }),
  step(180, { white: 1 }), step(240, { reverse: 1 }),
  step(200, { white: .98 }), step(200, { dark: 1 }),
  step(260, { mono: 1 }), step(200, { white: 1 }),
  step(240, { reverse: 1 }), step(220, { dark: .97 }),
  step(220, { white: 1 }), step(300, { mono: 1 }),
  step(380, { yellowPass: 1, yellowWash: .65 }),
  step(220, { white: 1 }), step(360, { redPass: 1, redWash: .62 }),
  step(200, { dark: .96 }), step(340, { yellowPass: 1, yellowWash: .45 }),
  step(180, { white: 1 }), step(360, { redPass: 1 }),
  step(220, { reverse: 1 }), step(200, { white: 1 }),
  step(420, { mono: 1 }), step(240, { reverse: 1 }),
  step(360, { redPass: 1, redWash: .34 }), step(180, { white: 1 }),
  step(400, { yellowPass: 1 }), step(220, { dark: .92 }),
  step(380, { reverse: 1 }), step(180, { white: 1 }),
  step(480, { red: .04, yellow: 1, black: 1 }),
  step(200, { white: .96 }), step(420, { red: 1, yellow: .04, black: .08 }),
  step(200, { mono: 1 }), step(520, { redPass: 1 }),
  step(180, { dark: .94 }), step(520, { yellowPass: 1 }),
  step(200, { reverse: 1 }), step(560, { red: .35, yellow: 1 }),
  step(200, { white: .92 }), step(640, {}),
  step(180, { mono: 1 }), step(560, { red: 1, yellow: .35 }),
  step(200, { reverse: 1 }), step(720, {}),
  step(200, { white: .96 }), step(540, {}), step(240, { white: 1 }),
]
export const DISPLAY_CYCLE_MS = DRIVE_STEPS.reduce((sum, item) => sum + item.duration, 0)
const INK_CHANNELS = Object.keys(FINAL_INK) as Array<keyof InkAppearance>

function roundInk(ink: InkAppearance, round: number): InkAppearance {
  if (round % 2 === 0) return ink
  return { ...ink, redPass: ink.yellowPass, yellowPass: ink.redPass, redWash: ink.yellowWash, yellowWash: ink.redWash }
}

/** 循环到实际完成回执；每轮交换红黄试驱动顺序，长等待仍持续强烈闪烁。 */
export function inkAppearance(elapsed: number): InkAppearance {
  const total = Math.max(0, elapsed)
  let local = total % DISPLAY_CYCLE_MS
  const round = Math.floor(total / DISPLAY_CYCLE_MS)
  let previous = DRIVE_STEPS[DRIVE_STEPS.length - 1].ink
  for (const current of DRIVE_STEPS) {
    if (local < current.duration) {
      const from = roundInk(previous, round)
      const to = roundInk(current.ink, round)
      const t = smooth(local / 40)
      const result = { ...to }
      for (const key of INK_CHANNELS) result[key] = from[key] + (to[key] - from[key]) * t
      return result
    }
    local -= current.duration
    previous = current.ink
  }
  return { ...FINAL_INK }
}

const DRIVE_COLORS = {
  black: [18, 17, 15], white: [255, 254, 248], red: [202, 30, 28], yellow: [248, 211, 0],
} as const
/** 不使用 RGB 互补色，所有暂态图案仍只包含黑、白、红、黄。 */
export function driveColor(phase: DrivePhase, pigment: Pigment | 'white'): readonly number[] {
  const { black, white, red, yellow } = DRIVE_COLORS
  if (phase === 'mono') return pigment === 'white' ? white : black
  if (phase === 'reverse') {
    return pigment === 'white' ? black : pigment === 'black' ? white : pigment === 'red' ? yellow : red
  }
  if (pigment === 'white') return white
  if (pigment === 'black') return black
  return phase === 'redPass' ? red : yellow
}

/** 对四色点阵归类；白色由纸底表现，不需要单独图层。 */
export function pigmentOf(r: number, g: number, b: number): Pigment | 'white' {
  if (r > 145 && r > g * 1.45 && r > b * 1.4) return 'red'
  if (r > 145 && g > 125 && b < Math.min(r, g) * 0.72) return 'yellow'
  return (r + g + b) / 3 < 140 ? 'black' : 'white'
}

export class EpdScreenRenderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: any = null
  private baseImage: HTMLImageElement | null = null
  private targetImage: HTMLImageElement | null = null
  private layers: PigmentLayer[] = []
  private driveLayers: DriveLayer[] = []
  private layout: GuideBlock[] = []
  private litAt: Array<number | null> = []
  private basePath = ''
  private targetPath = ''
  private state: EpdScreenState = 'idle'
  private stateAt = 0
  private settleFrom: InkAppearance = inkAppearance(12000)
  private running = false
  private frameHandle = 0
  private lastFrameAt = 0

  async attach(canvas: HTMLCanvasElement): Promise<void> {
    this.stopLoop()
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    // 模拟屏只承担界面显示，避免每帧重画全分辨率面板。
    canvas.width = 360
    canvas.height = 500
    this.layers = []
    this.driveLayers = []
    if (this.basePath) this.baseImage = await this.loadImage(this.basePath)
    if (this.targetPath) {
      this.targetImage = await this.loadImage(this.targetPath)
      this.buildLayers()
    }
    this.render(Date.now())
    if (this.state !== 'idle' && this.state !== 'done') this.ensureLoop()
  }

  async setBaseImage(path: string, reload = false): Promise<void> {
    if (!path || !this.canvas) return
    if (reload || path !== this.basePath || !this.baseImage) {
      this.basePath = path
      this.baseImage = await this.loadImage(path)
    }
    this.render(Date.now())
  }

  async setBlockImage(path: string, reload = false): Promise<void> {
    if (!path || !this.canvas) return
    if (reload || path !== this.targetPath || !this.targetImage) {
      this.targetPath = path
      this.targetImage = await this.loadImage(path)
      this.buildLayers()
    }
    this.render(Date.now())
  }

  /** 上传切片与显影图层分开，显影阶段不会使用切片布局。 */
  setLayout(blocks: GuideBlock[]): void {
    this.layout = blocks
    this.litAt = blocks.map(() => null)
  }

  setLit(count: number, now = Date.now()): void {
    const limit = Math.max(0, Math.min(count, this.layout.length))
    for (let index = 0; index < limit; index++) {
      if (this.litAt[index] === null) this.litAt[index] = now + this.layout[index].delay
    }
  }

  setState(state: EpdScreenState, now = Date.now()): void {
    this.state = state
    this.stateAt = now
    if (state === 'complete') this.setLit(this.layout.length, now)
    if (state === 'idle' || state === 'done') this.stopLoop()
    else this.ensureLoop()
    this.render(now)
  }

  finishDisplay(now = Date.now()): void {
    this.settleFrom = this.state === 'display' ? inkAppearance(now - this.stateAt) : inkAppearance(12000)
    this.setState('settle', now)
  }

  renderFrame(now: number): void { this.render(now) }

  reset(): void {
    this.litAt = this.layout.map(() => null)
    this.setState('idle')
  }

  destroy(): void {
    this.stopLoop()
    this.canvas = null
    this.ctx = null
    this.baseImage = null
    this.targetImage = null
    this.basePath = ''
    this.targetPath = ''
    this.layers = []
    this.driveLayers = []
    this.layout = []
    this.litAt = []
  }

  /** 图片加载后只拆色一次；显影素材预计算，帧内只混合整幅画布，避免读像素与逐像素计算。 */
  private buildLayers(): void {
    this.layers = []
    this.driveLayers = []
    if (!this.targetImage || !this.canvas || typeof OffscreenCanvas === 'undefined') return
    try {
      const width = this.canvas.width
      const height = this.canvas.height
      const source = new OffscreenCanvas(width, height)
      const sourceCtx = source.getContext('2d') as any
      this.drawContain(sourceCtx, this.targetImage, width, height)
      const pixels = sourceCtx.getImageData(0, 0, width, height).data
      // 六色等面板保留整幅渐显，避免四色拆层丢失蓝／绿色。
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (!pixels[offset + 3]) continue
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2]
        if (b > r * 1.3 + 20 || g > r * 1.3 + 20) return
      }
      const layers: PigmentLayer[] = []
      for (const kind of ['black', 'yellow', 'red'] as Pigment[]) {
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d') as any
        const image = ctx.createImageData(width, height)
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (!pixels[offset + 3] || pigmentOf(pixels[offset], pixels[offset + 1], pixels[offset + 2]) !== kind) continue
          image.data[offset] = pixels[offset]
          image.data[offset + 1] = pixels[offset + 1]
          image.data[offset + 2] = pixels[offset + 2]
          image.data[offset + 3] = pixels[offset + 3]
        }
        ctx.putImageData(image, 0, 0)
        layers.push({ kind, canvas })
      }
      const driveLayers: DriveLayer[] = []
      for (const kind of ['mono', 'reverse', 'redPass', 'yellowPass'] as DrivePhase[]) {
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d') as any
        const image = ctx.createImageData(width, height)
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const pigment = pixels[offset + 3] ? pigmentOf(pixels[offset], pixels[offset + 1], pixels[offset + 2]) : 'white'
          const color = driveColor(kind, pigment)
          image.data[offset] = color[0]
          image.data[offset + 1] = color[1]
          image.data[offset + 2] = color[2]
          image.data[offset + 3] = 255
        }
        ctx.putImageData(image, 0, 0)
        driveLayers.push({ kind, canvas })
      }
      this.driveLayers = driveLayers
      this.layers = layers
    } catch (_) {
      // 旧基础库不支持离屏像素操作时，仍用整幅画面渐显。
      this.layers = []
      this.driveLayers = []
    }
  }

  private appearance(now: number): InkAppearance {
    if (this.state === 'display') return inkAppearance(now - this.stateAt)
    const t = smooth((now - this.stateAt) / SETTLE_MS)
    const from = this.settleFrom
    const result = { ...FINAL_INK }
    for (const key of INK_CHANNELS) result[key] = from[key] + (FINAL_INK[key] - from[key]) * t
    return result
  }

  private render(now: number): void {
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas) return
    const { width, height } = canvas
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    if (this.state === 'display' || this.state === 'settle') {
      const ink = this.appearance(now)
      if (this.layers.length) {
        for (const layer of this.layers) {
          ctx.globalAlpha = ink[layer.kind]
          ctx.drawImage(layer.canvas, 0, 0, width, height)
        }
      } else if (this.targetImage) {
        ctx.globalAlpha = ink.target
        this.drawContain(ctx, this.targetImage, width, height)
      }
      // 暂态图案用预生成整幅素材，不在闪烁帧里处理像素。
      for (const layer of this.driveLayers) {
        if (ink[layer.kind] <= .001) continue
        ctx.globalAlpha = ink[layer.kind]
        ctx.drawImage(layer.canvas, 0, 0, width, height)
      }
      for (const [alpha, color] of [
        [ink.dark, '#12110f'], [ink.redWash, '#ca1e1c'],
        [ink.yellowWash, '#f8d300'], [ink.white, '#fffef8'],
      ] as Array<[number, string]>) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.fillRect(0, 0, width, height)
      }
    } else if (this.state === 'transfer' || this.state === 'complete') {
      if (this.baseImage) {
        ctx.globalAlpha = 0.22
        this.drawContain(ctx, this.baseImage, width, height)
      }
      this.drawUploadBlocks(ctx, now, width, height)
    } else {
      const image = this.state === 'done' ? this.targetImage : (this.baseImage || this.targetImage)
      if (image) {
        ctx.globalAlpha = 1
        this.drawContain(ctx, image, width, height)
      }
    }
    ctx.globalAlpha = 1
  }

  /** 只有上传阶段切片飞入；同一块只设置一次开始时刻，不会随通知反复跳动。 */
  private drawUploadBlocks(ctx: any, now: number, width: number, height: number): void {
    const image = this.targetImage
    if (!image || !this.layout.length) return
    const cols = Math.max(...this.layout.map(block => block.col)) + 1
    const rows = Math.max(...this.layout.map(block => block.row)) + 1
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
    const contentWidth = image.naturalWidth * scale
    const contentHeight = image.naturalHeight * scale
    const x = (width - contentWidth) / 2
    const y = (height - contentHeight) / 2
    const cellWidth = contentWidth / cols
    const cellHeight = contentHeight / rows
    for (let index = 0; index < this.layout.length; index++) {
      const started = this.litAt[index]
      if (started === null || now < started) continue
      const block = this.layout[index]
      const progress = clamp01((now - started) / FLY_MS)
      const eased = 1 - Math.pow(1 - progress, 3)
      const size = 0.84 + 0.16 * eased
      ctx.globalAlpha = Math.min(1, progress * 1.6)
      ctx.drawImage(
        image,
        block.col * image.naturalWidth / cols, block.row * image.naturalHeight / rows,
        image.naturalWidth / cols, image.naturalHeight / rows,
        x + block.col * cellWidth + cellWidth * (1 - size) / 2 + block.flyX * cellWidth * (1 - eased),
        y + block.row * cellHeight + cellHeight * (1 - size) / 2 + block.flyY * cellHeight * (1 - eased),
        cellWidth * size, cellHeight * size
      )
    }
  }

  private drawContain(ctx: any, image: HTMLImageElement, width: number, height: number): void {
    const factor = Math.min(width / image.naturalWidth, height / image.naturalHeight)
    const w = image.naturalWidth * factor
    const h = image.naturalHeight * factor
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h)
  }

  private loadImage(path: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      if (!this.canvas) return reject(new Error('画布未就绪'))
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('模拟屏素材加载失败'))
      image.src = path
    })
  }

  private stopLoop(): void {
    this.running = false
    if (this.canvas && this.frameHandle) window.cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
  }
  private ensureLoop(): void {
    if (this.running || !this.canvas) return
    this.running = true
    this.frameHandle = window.requestAnimationFrame(this.frame)
  }
  private frame = (): void => {
    if (!this.canvas || !this.running) return
    const now = Date.now()
    if (now - this.lastFrameAt >= 40) {
      this.lastFrameAt = now
      this.render(now)
    }
    if (this.state === 'settle' && now - this.stateAt >= SETTLE_MS) {
      this.setState('done', now)
      return
    }
    this.frameHandle = window.requestAnimationFrame(this.frame)
  }
}
