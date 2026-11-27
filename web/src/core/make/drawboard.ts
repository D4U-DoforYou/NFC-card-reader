/**
 * 画板：元素模型与画布渲染。
 *
 * 画板内容是一条元素栈：手绘笔迹、自定义文字、插入的图片。
 * 每次改动都整幅重绘，撤销靠快照回滚——比记录增量补丁简单得多，
 * 也不会出现「撤不干净」的残留。
 *
 * 元素的位置与大小统一记在**世界包围盒** `box` 里：
 * `box` 是元素在画布上的实际矩形，`localWidth` / `localHeight` 是它的「原始尺寸」。
 * 画的时候先把原点搬到 `box` 左上角，再按 `box / local` 缩放，
 * 这样移动就是改 `box.x/y`，缩放就是改 `box.width/height`，
 * 角手柄等比缩放、边手柄单轴缩放都能用同一套公式。
 */

/** 元素在世界坐标下的包围盒。 */
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

/** 手绘笔迹。 */
export interface StrokeElement {
  kind: 'stroke'
  /** 本地坐标顶点，交替存放 x、y，原点在包围盒左上角。 */
  points: number[]
  color: string
  width: number
  /** 未缩放时的本地尺寸。 */
  localWidth: number
  localHeight: number
  /** 世界包围盒。 */
  box: ElementBox
}

/** 文字。 */
export interface TextElement {
  kind: 'text'
  text: string
  color: string
  /** 原始字号，缩放后按比例变化。 */
  size: number
  localWidth: number
  localHeight: number
  box: ElementBox
}

/** 插入的图片。 */
export interface ImageElement {
  kind: 'image'
  src: string
  localWidth: number
  localHeight: number
  box: ElementBox
}

/** 画板元素。 */
export type DrawElement = StrokeElement | TextElement | ImageElement

/** 画板。 */
export interface DrawBoard {
  width: number
  height: number
  background: string
  elements: DrawElement[]
}

/** 画布上下文（getContext 返回 any，这里只收窄用到的方法）。 */
export interface BoardContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineCap: 'butt' | 'round' | 'square'
  lineJoin: 'bevel' | 'miter' | 'round'
  font: string
  textAlign: 'left' | 'center' | 'right'
  textBaseline: 'top' | 'middle' | 'bottom' | 'alphabetic' | 'hanging' | 'ideographic'
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fill(): void
  save(): void
  restore(): void
  clearRect(x: number, y: number, w: number, h: number): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  rotate(angle: number): void
  setLineDash(segments: number[]): void
  drawImage(image: HTMLImageElement, ...args: number[]): void
  measureText(text: string): { width: number }
}

/** 画布尺寸，默认按华为 552×768 面板出图。 */
export const BOARD_WIDTH = 552
export const BOARD_HEIGHT = 768

/** 可选颜色：四色面板的四种主色 + 常用色。 */
export const BOARD_COLORS = [
  { name: '黑', value: '#14161a' },
  { name: '白', value: '#ffffff' },
  { name: '黄', value: '#f5cd00' },
  { name: '红', value: '#c00000' },
  { name: '蓝', value: '#1f5fd0' },
  { name: '绿', value: '#2f9e44' },
  { name: '橙', value: '#f08c00' },
  { name: '灰', value: '#8b9099' },
]

/** 选中框与手柄的配色。 */
export const SELECTION_COLORS = {
  frame: '#1f5fd0',
  handle: '#1f5fd0',
}

/** 手柄边长（画布像素）。 */
export const HANDLE_SIZE = 26

/** 最小尺寸，缩到比它还小就没法操作了。 */
export const MIN_ELEMENT_SIZE = 8

/** 新建一块空白画板。 */
export function createBoard(width = BOARD_WIDTH, height = BOARD_HEIGHT): DrawBoard {
  return { width, height, background: '#ffffff', elements: [] }
}

/** 设置文字字体。 */
function useFont(ctx: BoardContext, size: number): void {
  ctx.font = `${size}px sans-serif`
}

/**
 * 量一段文字的尺寸。
 */
export function measureText(ctx: BoardContext, text: string, size: number): number {
  useFont(ctx, size)
  return ctx.measureText(text).width
}

// ---------------- 元素构造 ----------------

/**
 * 由世界坐标的笔迹点造一个笔迹元素。
 *
 * 点集会先算出包围盒，再换算成本地坐标——笔迹因此也能被移动和缩放。
 */
export function createStroke(
  worldPoints: number[],
  color: string,
  width: number
): StrokeElement | null {
  if (worldPoints.length < 2) {
    return null
  }
  let minX = worldPoints[0]
  let maxX = worldPoints[0]
  let minY = worldPoints[1]
  let maxY = worldPoints[1]
  for (let index = 0; index + 1 < worldPoints.length; index += 2) {
    minX = Math.min(minX, worldPoints[index])
    maxX = Math.max(maxX, worldPoints[index])
    minY = Math.min(minY, worldPoints[index + 1])
    maxY = Math.max(maxY, worldPoints[index + 1])
  }
  // 线宽的一半露在包围盒外，补进去才不会在边缘被裁掉
  const pad = width / 2
  const boxX = minX - pad
  const boxY = minY - pad
  const boxWidth = Math.max(MIN_ELEMENT_SIZE, maxX - minX + width)
  const boxHeight = Math.max(MIN_ELEMENT_SIZE, maxY - minY + width)
  const points = worldPoints.map((value, index) => (index % 2 === 0 ? value - boxX : value - boxY))
  return {
    kind: 'stroke',
    points,
    color,
    width,
    localWidth: boxWidth,
    localHeight: boxHeight,
    box: { x: boxX, y: boxY, width: boxWidth, height: boxHeight },
  }
}

/** 造一个文字元素。 */
export function createText(
  ctx: BoardContext,
  text: string,
  x: number,
  y: number,
  color: string,
  size: number
): TextElement | null {
  if (!text) {
    return null
  }
  const width = Math.max(1, measureText(ctx, text, size))
  const height = size * 1.2
  return {
    kind: 'text',
    text,
    color,
    size,
    localWidth: width,
    localHeight: height,
    box: { x, y, width, height },
  }
}

/** 造一个图片元素。 */
export function createImage(
  src: string,
  x: number,
  y: number,
  width: number,
  height: number
): ImageElement {
  return {
    kind: 'image',
    src,
    localWidth: Math.max(1, width),
    localHeight: Math.max(1, height),
    box: { x, y, width: Math.max(1, width), height: Math.max(1, height) },
  }
}

/** 深拷贝一个元素，复制与历史快照都用它。 */
export function cloneElement(element: DrawElement): DrawElement {
  if (element.kind === 'stroke') {
    return { ...element, points: [...element.points], box: { ...element.box } }
  }
  return { ...element, box: { ...element.box } }
}

/** 深拷贝整块画板。 */
export function cloneElements(elements: DrawElement[]): DrawElement[] {
  return elements.map(item => cloneElement(item))
}

// ---------------- 渲染 ----------------

/**
 * 画一段笔迹（本地坐标）。
 */
function drawStrokeLocal(ctx: BoardContext, element: StrokeElement): void {
  const points = element.points
  if (points.length < 4) {
    return
  }
  ctx.save()
  ctx.strokeStyle = element.color
  ctx.lineWidth = element.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(points[0], points[1])
  for (let index = 2; index + 1 < points.length; index += 2) {
    ctx.lineTo(points[index], points[index + 1])
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * 画一个文字元素（本地坐标）。
 */
function drawTextLocal(ctx: BoardContext, element: TextElement): void {
  if (!element.text) {
    return
  }
  ctx.save()
  ctx.fillStyle = element.color
  useFont(ctx, element.size)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(element.text, 0, 0)
  ctx.restore()
}

/**
 * 画一个图片元素（本地坐标）。
 */
function drawImageLocal(
  ctx: BoardContext,
  element: ImageElement,
  image: HTMLImageElement | null
): void {
  if (!image) {
    return
  }
  ctx.drawImage(image, 0, 0, element.localWidth, element.localHeight)
}

/**
 * 画一个元素：先把原点搬到包围盒左上角，再按包围盒缩放。
 */
export function drawElement(
  ctx: BoardContext,
  element: DrawElement,
  image: HTMLImageElement | null
): void {
  ctx.save()
  ctx.translate(element.box.x, element.box.y)
  ctx.scale(element.box.width / element.localWidth, element.box.height / element.localHeight)
  if (element.kind === 'stroke') {
    drawStrokeLocal(ctx, element)
  } else if (element.kind === 'text') {
    drawTextLocal(ctx, element)
  } else {
    drawImageLocal(ctx, element, image)
  }
  ctx.restore()
}

/**
 * 画选中框与缩放手柄。
 *
 * 这只是画布上的辅助线，导出成图时不能带上，所以整幅重绘时由
 * `selection` 参数控制开不开。
 *
 * 辅助线要压在任何背景上都看得清，所以包围框是「白色垫底 + 深蓝虚线」两层，
 * 手柄是白底蓝框——深色图片上不会糊成一片。
 */
export function drawSelection(ctx: BoardContext, element: DrawElement): void {
  const box = element.box
  ctx.save()
  ctx.setLineDash([6, 5])
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 5
  ctx.strokeRect(box.x, box.y, box.width, box.height)
  ctx.strokeStyle = SELECTION_COLORS.frame
  ctx.lineWidth = 2
  ctx.strokeRect(box.x, box.y, box.width, box.height)
  ctx.setLineDash([])

  ctx.fillStyle = '#ffffff'
  for (const handle of handlePoints(box)) {
    ctx.fillRect(
      handle.x - HANDLE_SIZE / 2,
      handle.y - HANDLE_SIZE / 2,
      HANDLE_SIZE,
      HANDLE_SIZE
    )
  }
  ctx.strokeStyle = SELECTION_COLORS.handle
  ctx.lineWidth = 3
  for (const handle of handlePoints(box)) {
    ctx.strokeRect(
      handle.x - HANDLE_SIZE / 2,
      handle.y - HANDLE_SIZE / 2,
      HANDLE_SIZE,
      HANDLE_SIZE
    )
  }
  ctx.restore()
}

/**
 * 整幅重绘。
 *
 * `images` 是路径到图片对象的映射，插入的图片按路径取；
 * `selection` 是当前选中的元素，传 null 时不画辅助线（导出用这个）；
 * `rotation` 为 90 时整幅转 90° 再画，用来把横版画布填进竖屏的画布。
 */
export function renderBoard(
  ctx: BoardContext,
  board: DrawBoard,
  images: Map<string, HTMLImageElement>,
  selection?: DrawElement | null,
  rotation: 0 | 90 = 0
): void {
  ctx.save()
  if (rotation === 90) {
    // 顺时针转 90°：画布左上角落到目标画布的右上角
    ctx.translate(board.height, 0)
    ctx.rotate(Math.PI / 2)
  }
  ctx.clearRect(0, 0, board.width, board.height)
  ctx.fillStyle = board.background
  ctx.fillRect(0, 0, board.width, board.height)
  for (const element of board.elements) {
    if (element.kind === 'stroke') {
      drawElement(ctx, element, null)
    } else if (element.kind === 'text') {
      drawElement(ctx, element, null)
    } else {
      drawElement(ctx, element, images.get(element.src) ?? null)
    }
  }
  if (selection) {
    drawSelection(ctx, selection)
  }
  ctx.restore()
}

/**
 * 把元素提到最上层。
 *
 * 渲染顺序就是数组顺序，后面的盖在前面，所以「最上层」= 数组末尾。
 */
export function bringToFront(board: DrawBoard, element: DrawElement): void {
  const index = board.elements.indexOf(element)
  if (index < 0 || index === board.elements.length - 1) {
    return
  }
  board.elements.splice(index, 1)
  board.elements.push(element)
}

/**
 * 换画布方向时，把已有内容等比缩放并居中到新画布。
 *
 * 直接换尺寸的话内容会跑出画布，缩放后能完整保留，比例不变。
 */
export function adaptElementsToBoard(
  elements: DrawElement[],
  from: { width: number; height: number },
  to: { width: number; height: number }
): void {
  if (!from.width || !from.height) {
    return
  }
  const scale = Math.min(to.width / from.width, to.height / from.height)
  const dx = (to.width - from.width * scale) / 2
  const dy = (to.height - from.height * scale) / 2
  for (const element of elements) {
    element.box.x = element.box.x * scale + dx
    element.box.y = element.box.y * scale + dy
    element.box.width = element.box.width * scale
    element.box.height = element.box.height * scale
  }
}

// ---------------- 命中与几何 ----------------

/** 二维点。 */
export interface Point {
  x: number
  y: number
}

/** 点到线段的距离。 */
function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 0) {
    return Math.hypot(px - x1, py - y1)
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 找出某个点下面的元素（从上往下找，命中最上层）。
 *
 * 笔迹按线段距离判定，文字与图片按包围盒判定。
 */
export function hitTest(
  board: DrawBoard,
  x: number,
  y: number
): DrawElement | null {
  for (let index = board.elements.length - 1; index >= 0; index -= 1) {
    const element = board.elements[index]
    const box = element.box
    if (element.kind === 'stroke') {
      // 把查询点换算回本地坐标，才能按笔触粗细判定
      const localX = ((x - box.x) * element.localWidth) / box.width
      const localY = ((y - box.y) * element.localHeight) / box.height
      const radius = element.width / 2 + 5
      const points = element.points
      if (points.length < 4) {
        if (Math.hypot(localX - points[0], localY - points[1]) <= radius) {
          return element
        }
        continue
      }
      for (let p = 0; p + 3 < points.length; p += 2) {
        const distance = distanceToSegment(
          localX,
          localY,
          points[p],
          points[p + 1],
          points[p + 2],
          points[p + 3]
        )
        if (distance <= radius) {
          return element
        }
      }
      continue
    }
    if (
      x >= box.x - 4 &&
      x <= box.x + box.width + 4 &&
      y >= box.y - 4 &&
      y <= box.y + box.height + 4
    ) {
      return element
    }
  }
  return null
}

/** 缩放手柄的位置。 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** 一个手柄。 */
export interface Handle {
  id: HandleId
  x: number
  y: number
}

/**
 * 算出包围盒上八个手柄的位置。
 */
export function handlePoints(box: ElementBox): Handle[] {
  const { x, y, width, height } = box
  const midX = x + width / 2
  const midY = y + height / 2
  const right = x + width
  const bottom = y + height
  return [
    { id: 'nw', x, y },
    { id: 'n', x: midX, y },
    { id: 'ne', x: right, y },
    { id: 'e', x: right, y: midY },
    { id: 'se', x: right, y: bottom },
    { id: 's', x: midX, y: bottom },
    { id: 'sw', x, y: bottom },
    { id: 'w', x, y: midY },
  ]
}

/**
 * 找出被点中的手柄。
 *
 * 手柄挨得近（窄元素上只隔十几像素），所以取**离得最近**的那个，
 * 而不是第一个落在判定半径内的——否则点右下角会先命中右中点。
 */
export function hitHandle(
  box: ElementBox,
  x: number,
  y: number,
  tolerance = 10
): HandleId | null {
  const radius = HANDLE_SIZE / 2 + tolerance
  let best: HandleId | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const handle of handlePoints(box)) {
    const distance = Math.hypot(handle.x - x, handle.y - y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = handle.id
    }
  }
  return bestDistance <= radius ? best : null
}

/**
 * 按手柄拖动算出新的包围盒。
 *
 * 角手柄等比缩放（对角那个点保持不动），边手柄只缩一条轴。
 */
export function resizeBox(
  startBox: ElementBox,
  handle: HandleId,
  startPointer: Point,
  pointer: Point,
  minSize = MIN_ELEMENT_SIZE
): ElementBox {
  const isCorner = handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw'
  if (isCorner) {
    // 对角点是锚点，拖动时它保持不动
    let anchorX = startBox.x
    let anchorY = startBox.y
    if (handle === 'nw') {
      anchorX = startBox.x + startBox.width
      anchorY = startBox.y + startBox.height
    } else if (handle === 'ne') {
      anchorX = startBox.x
      anchorY = startBox.y + startBox.height
    } else if (handle === 'sw') {
      anchorX = startBox.x + startBox.width
      anchorY = startBox.y
    }
    const d0x = startPointer.x - anchorX
    const d0y = startPointer.y - anchorY
    const d1x = pointer.x - anchorX
    const d1y = pointer.y - anchorY
    const len0 = Math.hypot(d0x, d0y)
    const len1 = Math.hypot(d1x, d1y)
    let scale = len0 > 0.001 ? len1 / len0 : 1
    // 拖到锚点另一侧时不让它翻过去
    if (d0x * d1x + d0y * d1y < 0) {
      scale = Math.abs(scale)
    }
    scale = Math.max(0.05, scale)
    const width = Math.max(minSize, startBox.width * scale)
    const height = Math.max(minSize, startBox.height * scale)
    const result: ElementBox = { x: startBox.x, y: startBox.y, width, height }
    if (handle === 'nw') {
      result.x = anchorX - width
      result.y = anchorY - height
    } else if (handle === 'ne') {
      result.x = anchorX
      result.y = anchorY - height
    } else if (handle === 'sw') {
      result.x = anchorX - width
      result.y = anchorY
    } else {
      result.x = anchorX
      result.y = anchorY
    }
    return result
  }

  // 边手柄：只动一条轴
  const result: ElementBox = { ...startBox }
  if (handle === 'e') {
    result.width = Math.max(minSize, pointer.x - startBox.x)
  } else if (handle === 'w') {
    result.width = Math.max(minSize, startBox.x + startBox.width - pointer.x)
    result.x = startBox.x + startBox.width - result.width
  } else if (handle === 's') {
    result.height = Math.max(minSize, pointer.y - startBox.y)
  } else {
    result.height = Math.max(minSize, startBox.y + startBox.height - pointer.y)
    result.y = startBox.y + startBox.height - result.height
  }
  return result
}

/**
 * 移动包围盒。
 */
export function moveBox(box: ElementBox, dx: number, dy: number): ElementBox {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }
}

/**
 * 元素相对于原始尺寸的缩放倍数。
 */
export function elementScale(element: DrawElement): number {
  if (!element.localWidth || !element.localHeight) {
    return 1
  }
  return element.box.width / element.localWidth
}

/**
 * 按目标画布缩放插入的图片。
 *
 * 保持原图比例，最大不超过画布的八成。
 */
export function fitImage(
  sourceWidth: number,
  sourceHeight: number,
  board: DrawBoard
): { width: number; height: number } {
  const limit = Math.min(board.width, board.height) * 0.8
  const factor = Math.min(limit / sourceWidth, limit / sourceHeight, 1)
  return {
    width: Math.max(1, Math.round(sourceWidth * factor)),
    height: Math.max(1, Math.round(sourceHeight * factor)),
  }
}
