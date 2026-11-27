/**
 * 模拟墨水屏的分块布局。
 *
 * 屏幕里的图像被切成若干块，每块用「外层裁剪框 + 内层整图」实现切片：
 * 外层 overflow 隐藏，内层图按列/行数放大后向上、向左偏移，正好露出该块
 * 对应的区域。屏幕与图像同宽高比，所以切片不会被拉伸变形。
 */

/** 分块列数。 */
export const GUIDE_BLOCK_COLS = 6
/** 分块行数上下限。 */
export const GUIDE_BLOCK_ROWS_MIN = 4
export const GUIDE_BLOCK_ROWS_MAX = 12

export interface GuideBlock {
  /** 1 起的编号，用于判断是否已点亮。 */
  no: number
  /** 所在列 / 行（0 起）。 */
  col: number
  row: number
  /** 块在屏幕里的位置与大小（百分比）。 */
  left: string
  top: string
  width: string
  height: string
  /** 内层图相对块的偏移与尺寸，用来把这一块从整图里裁出来。 */
  cropLeft: string
  cropTop: string
  cropWidth: string
  cropHeight: string
  /** 动画错峰延时（毫秒）。 */
  delay: number
  /** 入场轨迹分组（0..3），对应四种飞入方向。 */
  mod: number
  /** 飞入起点的偏移，单位是块自身尺寸。 */
  flyX: number
  flyY: number
}

/** 四种飞入轨迹：起点相对块自身尺寸的偏移。 */
const FLY_PATHS: Array<{ x: number; y: number }> = [
  { x: -1.3, y: -2.5 },
  { x: 1.1, y: -2.9 },
  { x: -0.8, y: -2.1 },
  { x: 1.5, y: -2.6 },
]

/**
 * 按块数生成模拟屏的分块布局。
 *
 * @param blockCount 实际的数据块数，决定网格的疏密
 */
export function buildGuideBlocks(blockCount: number): GuideBlock[] {
  const cols = GUIDE_BLOCK_COLS
  const rows = Math.max(
    GUIDE_BLOCK_ROWS_MIN,
    Math.min(GUIDE_BLOCK_ROWS_MAX, Math.ceil(Math.max(1, blockCount) / cols))
  )
  const cellWidth = 100 / cols
  const cellHeight = 100 / rows
  const blocks: GuideBlock[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const no = row * cols + col + 1
      const mod = (row + col) % 4
      blocks.push({
        no,
        col,
        row,
        left: `${(col * cellWidth).toFixed(4)}%`,
        top: `${(row * cellHeight).toFixed(4)}%`,
        width: `${cellWidth.toFixed(4)}%`,
        height: `${cellHeight.toFixed(4)}%`,
        cropLeft: `${(-col * 100).toFixed(4)}%`,
        cropTop: `${(-row * 100).toFixed(4)}%`,
        cropWidth: `${cols * 100}%`,
        cropHeight: `${rows * 100}%`,
        // 错峰延时，让整块图像不是齐刷刷地一起落下
        delay: (no * 37) % 120,
        mod,
        flyX: FLY_PATHS[mod].x,
        flyY: FLY_PATHS[mod].y,
      })
    }
  }
  return blocks
}
