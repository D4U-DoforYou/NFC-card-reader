<script setup lang="ts">
/**
 * 画板：手绘、文字、插图，元素可以选中、移动、缩放，成图后可直接进待刷队列。
 *
 * 交互按画板软件的惯例来：一个统一工具栏切换工具，工具栏上方一条选项条
 * 放当前工具的参数；指针工具下点元素选中，拖动移动，拖角手柄缩放。
 *
 * 网页端没有小程序运行时：触摸事件换成指针事件（鼠标/触控笔/触摸都走一套），
 * 坐标用 `getBoundingClientRect()` 换算回画布逻辑坐标。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import {hideLoading, showLoading, showModal, showToast } from '@/platform/ui'
import { pickImageFiles, readImageSize } from '@/platform/images'
import { addImageToQueue, exportCanvas } from '@/core/make/queue'
import {
  BOARD_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  adaptElementsToBoard,
  bringToFront,
  cloneElements,
  createBoard,
  createImage,
  createStroke,
  createText,
  elementScale,
  fitImage,
  hitHandle,
  hitTest,
  measureText,
  moveBox,
  renderBoard,
  resizeBox,
} from '@/core/make/drawboard'
import type { BoardContext, DrawElement, ElementBox, HandleId, Point } from '@/core/make/drawboard'

/** 画板工具。 */
type BoardTool = 'pointer' | 'draw' | 'text' | 'image' | 'erase'

/** 画布方向。 */
type BoardOrientation = 'portrait' | 'landscape'

/** 指针工具的拖动模式。 */
type DragMode = 'none' | 'move' | 'resize'

/** 竖版画布尺寸，与墨水屏一致。 */
const router = useRouter()

const PORTRAIT_SIZE = { width: BOARD_WIDTH, height: BOARD_HEIGHT }

/** 横版画布尺寸。 */
const LANDSCAPE_SIZE = { width: 768, height: 552 }

/** 导出到队列的尺寸，恒为墨水屏的 552×768。 */
const OUTPUT_SIZE = { width: 552, height: 768 }

/** 撤销栈最多保留多少步。 */
const MAX_HISTORY = 60

/** 工具栏上的五个工具。 */
const TOOLS: { id: BoardTool; label: string }[] = [
  { id: 'pointer', label: '选择' },
  { id: 'draw', label: '画笔' },
  { id: 'text', label: '文字' },
  { id: 'image', label: '图片' },
  { id: 'erase', label: '橡皮' },
]

/** 各工具的提示语。 */
const TOOL_HINTS: Record<BoardTool, string> = {
  pointer: '点一下画布上的元素就能选中它',
  draw: '在画布上拖动即可手绘',
  text: '在画布上点一下放置文字',
  image: '从相册选一张插进画布',
  erase: '点一下要删掉的元素',
}

// ---------------- 界面状态 ----------------

/** 当前工具。 */
const tool = ref<BoardTool>('pointer')
/** 画布方向。 */
const orientation = ref<BoardOrientation>('portrait')
/** 当前颜色索引。 */
const colorIndex = ref(0)
/** 画笔粗细。 */
const brush = ref(10)
/** 字号。 */
const fontSize = ref(48)
/** 待添加的文字。 */
const textValue = ref('')
/** 元素数量。 */
const elementCount = ref(0)
/** 是否可以撤销。 */
const canUndo = ref(false)
/** 当前是否有选中元素。 */
const selected = ref(false)
/** 选中元素的缩放比例（百分比）。 */
const selectedScale = ref(100)
/** 导出中。 */
const busy = ref(false)
/** 提示。 */
const hint = ref(TOOL_HINTS.pointer)

/** 画布节点。 */
const boardRef = ref<HTMLCanvasElement | null>(null)

/** 画板内容。 */
const board = createBoard(PORTRAIT_SIZE.width, PORTRAIT_SIZE.height)

/** 可选颜色。 */
const colors = BOARD_COLORS

/** 画布上的绘图上下文（元素模型的接口）。 */
let ctx: BoardContext | null = null
/** 同一个上下文的原生句柄，用来设置设备像素比变换。 */
let rawCtx: CanvasRenderingContext2D | null = null
/** 插入的图片，路径到图片对象。 */
const images = new Map<string, HTMLImageElement>()
/** 自己建的 object URL，离开页面时回收。 */
const objectUrls: string[] = []
/** 当前选中的元素。 */
let selectedElement: DrawElement | null = null
/** 拖动模式。 */
let dragMode: DragMode = 'none'
/** 拖动起点。 */
let dragStart: Point = { x: 0, y: 0 }
/** 拖动开始时的包围盒。 */
let dragStartBox: ElementBox = { x: 0, y: 0, width: 0, height: 0 }
/** 正在拖的手柄。 */
let dragHandle: HandleId | null = null
/** 正在画的那一笔（世界坐标点）。 */
let activePoints: number[] = []
/** 历史快照。 */
const history: DrawElement[][] = []
/** 重绘是否已排队。 */
let redrawQueued = false
/** 待执行的重绘帧。 */
let rafId = 0
/** 当前捕获的指针。 */
let pointerId: number | null = null

/** 方向徽标上的文字。 */
const orientationLabel = computed(() =>
  orientation.value === 'portrait' ? '竖版 552×768' : '横版 768×552',
)

/** 画布的显示比例，跟着方向走。 */
const canvasAspect = computed(() => {
  const size = orientation.value === 'portrait' ? PORTRAIT_SIZE : LANDSCAPE_SIZE
  return `${size.width} / ${size.height}`
})

// ---------------- 画布 ----------------

/**
 * 按当前方向与设备像素比重设画布尺寸。
 *
 * 位图按 dpr 放大，绘图时用 `setTransform` 缩回去，
 * 这样线条和文字在高分屏上依然锐利。
 */
function syncCanvasSize(): void {
  const canvas = boardRef.value
  if (!canvas) {
    return
  }
  const dpr = window.devicePixelRatio || 1
  const width = Math.round(board.width * dpr)
  const height = Math.round(board.height * dpr)
  if (canvas.width !== width) {
    canvas.width = width
  }
  if (canvas.height !== height) {
    canvas.height = height
  }
  const context = canvas.getContext('2d')
  rawCtx = context
  ctx = context as unknown as BoardContext | null
  rawCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** 整幅重绘。 */
function redraw(showSelection = true): void {
  if (!ctx) {
    return
  }
  renderBoard(ctx, board, images, showSelection ? selectedElement : null)
}

/**
 * 排队一次重绘。
 *
 * 拖动时每一帧都可能改元素位置，整幅重绘又比较重，
 * 这里用 rAF 合并到一帧一次，避免把帧率拖垮。
 */
function scheduleRedraw(): void {
  if (redrawQueued) {
    return
  }
  redrawQueued = true
  rafId = requestAnimationFrame(() => {
    rafId = 0
    redrawQueued = false
    redraw()
  })
}

/** 指针坐标换算成画布坐标。 */
function toCanvasPoint(event: PointerEvent): Point | null {
  const canvas = boardRef.value
  if (!canvas) {
    return null
  }
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  return {
    x: ((event.clientX - rect.left) * board.width) / rect.width,
    y: ((event.clientY - rect.top) * board.height) / rect.height,
  }
}

// ---------------- 历史 ----------------

/** 记一次快照，撤销时整体回滚。 */
function pushHistory(): void {
  history.push(cloneElements(board.elements))
  if (history.length > MAX_HISTORY) {
    history.shift()
  }
  canUndo.value = history.length > 0
}

/** 撤销上一步。 */
function undo(): void {
  const snapshot = history.pop()
  if (!snapshot) {
    return
  }
  board.elements = snapshot
  // 选中的元素可能已经被撤销掉了
  if (selectedElement && !board.elements.includes(selectedElement)) {
    selectElement(null)
  }
  redraw()
  syncState()
}

// ---------------- 指针 ----------------

/** 按下：分派到各个工具。 */
function onPointerDown(event: PointerEvent): void {
  const canvas = boardRef.value
  if (!canvas) {
    return
  }
  const point = toCanvasPoint(event)
  if (!point) {
    return
  }
  event.preventDefault()
  try {
    canvas.setPointerCapture(event.pointerId)
    pointerId = event.pointerId
  } catch {
    // 捕获失败也不影响操作，只是拖出画布时会丢事件
  }

  if (tool.value === 'draw') {
    activePoints = [point.x, point.y]
    paintSegment(point.x, point.y, point.x, point.y)
    return
  }

  if (tool.value === 'erase') {
    eraseAt(point)
    return
  }

  if (tool.value === 'text') {
    placeText(point)
    return
  }

  // 指针工具：先看有没有点中手柄，再看有没有点中元素
  if (selectedElement) {
    const handle = hitHandle(selectedElement.box, point.x, point.y)
    if (handle) {
      dragMode = 'resize'
      dragHandle = handle
      dragStart = point
      dragStartBox = { ...selectedElement.box }
      pushHistory()
      return
    }
  }

  const hit = hitTest(board, point.x, point.y)
  if (hit) {
    selectElement(hit)
    dragMode = 'move'
    dragStart = point
    dragStartBox = { ...hit.box }
    pushHistory()
    return
  }

  selectElement(null)
  dragMode = 'none'
}

/** 拖动。 */
function onPointerMove(event: PointerEvent): void {
  if (tool.value === 'draw') {
    const point = toCanvasPoint(event)
    if (!point) {
      return
    }
    const points = activePoints
    if (points.length < 2) {
      return
    }
    const lastX = points[points.length - 2]
    const lastY = points[points.length - 1]
    // 抖动过小的点直接丢掉，省内存也省重绘
    if (Math.abs(point.x - lastX) + Math.abs(point.y - lastY) < 1.2) {
      return
    }
    points.push(point.x, point.y)
    paintSegment(lastX, lastY, point.x, point.y)
    return
  }

  if (dragMode === 'none' || !selectedElement) {
    return
  }
  const point = toCanvasPoint(event)
  if (!point) {
    return
  }
  if (dragMode === 'move') {
    const dx = point.x - dragStart.x
    const dy = point.y - dragStart.y
    const box = moveBox(dragStartBox, dx, dy)
    // 允许拖出画布，但至少留一截在画布里，别把元素整个拖丢
    const keep = 24
    box.x = Math.max(-box.width + keep, Math.min(box.x, board.width - keep))
    box.y = Math.max(-box.height + keep, Math.min(box.y, board.height - keep))
    selectedElement.box = box
  } else if (dragMode === 'resize' && dragHandle) {
    selectedElement.box = resizeBox(dragStartBox, dragHandle, dragStart, point)
  }
  scheduleRedraw()
  syncState()
}

/** 松手：收尾。 */
function onPointerUp(): void {
  const canvas = boardRef.value
  if (canvas && pointerId !== null) {
    try {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId)
      }
    } catch {
      // 元素已经卸载，释放失败无所谓
    }
  }
  pointerId = null

  if (tool.value === 'draw') {
    commitStroke()
    return
  }
  if (dragMode === 'none') {
    return
  }
  // 没真的动过就别留一条历史
  if (selectedElement) {
    const box = selectedElement.box
    const start = dragStartBox
    if (box.x === start.x && box.y === start.y && box.width === start.width && box.height === start.height) {
      history.pop()
      canUndo.value = history.length > 0
    }
  }
  dragMode = 'none'
  dragHandle = null
  redraw()
}

/** 补画一段笔迹。 */
function paintSegment(x1: number, y1: number, x2: number, y2: number): void {
  if (!ctx) {
    return
  }
  const color = BOARD_COLORS[colorIndex.value].value
  ctx.strokeStyle = color
  ctx.lineWidth = brush.value
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

/** 把这一笔落成元素。 */
function commitStroke(): void {
  const points = activePoints
  activePoints = []
  if (points.length < 2) {
    return
  }
  if (points.length === 2) {
    // 点一下也算一笔
    points.push(points[0] + 0.01, points[1])
  }
  const stroke = createStroke(points, BOARD_COLORS[colorIndex.value].value, brush.value)
  if (!stroke) {
    return
  }
  pushHistory()
  pushOnTop(stroke)
  redraw()
  syncState()
}

/** 擦除命中的元素。 */
function eraseAt(point: Point): void {
  const hit = hitTest(board, point.x, point.y)
  if (!hit) {
    return
  }
  pushHistory()
  board.elements = board.elements.filter(item => item !== hit)
  if (selectedElement === hit) {
    selectElement(null)
  }
  redraw()
  syncState()
}

// ---------------- 元素管理 ----------------

/** 选中或取消选中。 */
function selectElement(element: DrawElement | null): void {
  selectedElement = element
  selected.value = !!element
  selectedScale.value = element ? Math.round(elementScale(element) * 100) : 100
}

/**
 * 加一个元素，并把它提到最上层。
 *
 * 渲染顺序就是数组顺序，后画的盖在前面，所以末尾即最上层——
 * 新加的图片会压在已有内容上面。
 */
function pushOnTop(element: DrawElement): void {
  board.elements.push(element)
  bringToFront(board, element)
}

/** 同步界面上的计数与按钮状态。 */
function syncState(): void {
  elementCount.value = board.elements.length
  canUndo.value = history.length > 0
  selectedScale.value = selectedElement ? Math.round(elementScale(selectedElement) * 100) : 100
}

// ---------------- 画布方向 ----------------

/**
 * 切换横竖方向。
 *
 * 换尺寸的话已有内容会跑出画布，所以先等比缩放并居中到新画布，
 * 比例不变、内容不丢。
 */
async function toggleOrientation(): Promise<void> {
  const next: BoardOrientation = orientation.value === 'portrait' ? 'landscape' : 'portrait'
  const from = { width: board.width, height: board.height }
  const to = next === 'portrait' ? PORTRAIT_SIZE : LANDSCAPE_SIZE
  pushHistory()
  adaptElementsToBoard(board.elements, from, to)
  board.width = to.width
  board.height = to.height
  orientation.value = next
  // 等样式里的比例先落下来，再按新的方向重设位图
  await nextTick()
  syncCanvasSize()
  redraw()
  syncState()
}

// ---------------- 工具 ----------------

/** 切换工具。 */
function pickTool(next: BoardTool): void {
  tool.value = next
  hint.value = TOOL_HINTS[next]
  // 换工具时取消选中，避免选中框留在别的工具下
  if (next !== 'pointer' && selectedElement) {
    selectElement(null)
    redraw()
  }
}

/** 选颜色。 */
function pickColor(index: number): void {
  colorIndex.value = index
}

/** 放一段文字到指定位置。 */
function placeText(point: Point): void {
  const text = (textValue.value || '').trim()
  if (!text) {
    showToast('先在下面写点文字')
    return
  }
  if (!ctx) {
    return
  }
  const size = fontSize.value
  const color = BOARD_COLORS[colorIndex.value].value
  const width = measureText(ctx, text, size)
  // 贴边时把文字往里挪，别让它跑出画布
  const x = Math.max(0, Math.min(point.x, board.width - width))
  const y = Math.max(0, Math.min(point.y, board.height - size * 1.2))
  const element = createText(ctx, text, x, y, color, size)
  if (!element) {
    return
  }
  pushHistory()
  pushOnTop(element)
  redraw()
  syncState()
}

/** 插入一张图片。 */
async function insertImage(): Promise<void> {
  const files = await pickImageFiles(false)
  const file = files[0]
  if (!file) {
    return
  }
  const url = URL.createObjectURL(file)
  objectUrls.push(url)
  const size = await readImageSize(url)
  const fitted = fitImage(size.width || 200, size.height || 200, board)
  const element = createImage(
    url,
    Math.round((board.width - fitted.width) / 2),
    Math.round((board.height - fitted.height) / 2),
    fitted.width,
    fitted.height,
  )
  await loadImage(url)
  pushHistory()
  pushOnTop(element)
  redraw()
  syncState()
}

/** 载入图片对象。 */
function loadImage(src: string): Promise<void> {
  if (images.has(src)) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const image = new Image()
    image.onload = () => {
      images.set(src, image)
      resolve()
    }
    image.onerror = () => resolve()
    image.src = src
  })
}

// ---------------- 选中元素的操作 ----------------

/** 删掉选中的元素。 */
function deleteSelected(): void {
  if (!selectedElement) {
    return
  }
  pushHistory()
  board.elements = board.elements.filter(item => item !== selectedElement)
  selectElement(null)
  redraw()
  syncState()
}

/** 复制选中的元素，位置错开一点。 */
function duplicateSelected(): void {
  const element = selectedElement
  if (!element) {
    return
  }
  if (!ctx) {
    return
  }
  pushHistory()
  const copy =
    element.kind === 'stroke'
      ? createStroke(
          element.points.map((value, index) =>
            index % 2 === 0 ? value + element.box.x + 18 : value + element.box.y + 18,
          ),
          element.color,
          element.width,
        )
      : element.kind === 'text'
        ? createText(
            ctx,
            element.text,
            element.box.x + 18,
            element.box.y + 18,
            element.color,
            element.size,
          )
        : createImage(
            element.src,
            element.box.x + 18,
            element.box.y + 18,
            element.box.width,
            element.box.height,
          )
  if (!copy) {
    history.pop()
    canUndo.value = history.length > 0
    return
  }
  pushOnTop(copy)
  selectElement(copy)
  redraw()
  syncState()
}

/** 把选中的元素提到最上层。 */
function raiseSelected(): void {
  const element = selectedElement
  if (!element) {
    return
  }
  const index = board.elements.indexOf(element)
  if (index < 0 || index === board.elements.length - 1) {
    return
  }
  pushHistory()
  board.elements.splice(index, 1)
  pushOnTop(element)
  redraw()
}

/** 把选中的元素压到最底层。 */
function lowerSelected(): void {
  const element = selectedElement
  if (!element) {
    return
  }
  const index = board.elements.indexOf(element)
  if (index <= 0) {
    return
  }
  pushHistory()
  board.elements.splice(index, 1)
  board.elements.unshift(element)
  redraw()
}

/** 清空画布。 */
async function clearBoard(): Promise<void> {
  if (!board.elements.length) {
    return
  }
  const confirmed = await showModal({
    title: '清空画布',
    content: '画布上的内容会全部删除，确定继续？',
  })
  if (!confirmed) {
    return
  }
  pushHistory()
  board.elements = []
  selectElement(null)
  redraw()
  syncState()
}

// ---------------- 导出 ----------------

/**
 * 导出并放进待刷队列。
 *
 * 导出的图**统一是 552×768 的竖图**，方向由画板自己调好：
 * 竖版画布直接导出，横版画布转 90° 再导出。
 * 这样进队列后在图像处理页不用手动转角度，0° 档位看到的就是最终效果。
 *
 * 导出用的是**另一块离屏画布**，与屏幕上的画布完全分开：
 * 屏幕上的选中框与手柄只画在预览画布上，导出画布从一开始就没有它们。
 */
async function exportBoard(): Promise<void> {
  if (!boardRef.value || !board.elements.length) {
    showToast('画布还是空的')
    return
  }
  busy.value = true
  showLoading('导出中')
  let queued = false
  try {
    const output = document.createElement('canvas')
    output.width = OUTPUT_SIZE.width
    output.height = OUTPUT_SIZE.height
    const outputCtx = output.getContext('2d') as unknown as BoardContext | null
    if (!outputCtx) {
      throw new Error('画布上下文不可用')
    }
    // 导出时不能带上选中框与手柄，它们只是画布上的辅助线
    const rotation: 0 | 90 = board.width > board.height ? 90 : 0
    renderBoard(outputCtx, board, images, null, rotation)
    const blob = await exportCanvas(output)
    const name = `画板 ${board.elements.length} 个元素`
    await addImageToQueue(blob, name)
    queued = true
  } catch {
    showToast('导出失败')
  } finally {
    busy.value = false
    hideLoading()
  }
  if (queued) {
    // 导出完直接回墨水屏的队列，立刻能看到刚导出的这张图
    await router.push('/eink?tab=queue&added=1')
  }
}

onMounted(() => {
  syncCanvasSize()
  redraw()
})

onBeforeUnmount(() => {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  redrawQueued = false
  const canvas = boardRef.value
  if (canvas && pointerId !== null) {
    try {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId)
      }
    } catch {
      // 画布已经卸载，释放失败无所谓
    }
  }
  pointerId = null
  for (const url of objectUrls) {
    URL.revokeObjectURL(url)
  }
  objectUrls.length = 0
})
</script>

<template>
  <div class="page">
    <main class="shell">
      <NavBar title="画板" subtitle="元素可移动可缩放" fallback="/eink" />

      <div class="workbench">
        <!-- 左主区：画布舞台 -->
        <div class="workbench-main">
          <section class="board-wrap">
            <div class="board-stage">
              <canvas
                ref="boardRef"
                class="board-canvas"
                :class="`tool-${tool}`"
                :style="{ aspectRatio: canvasAspect }"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
              />
              <div class="board-badge mono">{{ elementCount }} 个元素</div>
              <button class="board-orient mono" type="button" @click="toggleOrientation">
                {{ orientationLabel }}
              </button>
            </div>
          </section>
        </div>

        <!-- 右栏：工具栏 + 选项条 + 提示 -->
        <aside class="workbench-aside scroll">
          <!-- 统一工具栏 -->
          <section class="toolbar-card">
            <div class="tool-row">
              <button
                v-for="item in TOOLS"
                :key="item.id"
                class="tool"
                :class="{ on: tool === item.id }"
                type="button"
                @click="pickTool(item.id)"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="tool-row">
              <button
                class="tool"
                :class="{ off: !canUndo }"
                type="button"
                :disabled="!canUndo"
                @click="undo"
              >
                撤销
              </button>
              <button
                class="tool"
                :class="{ off: elementCount === 0 }"
                type="button"
                :disabled="elementCount === 0"
                @click="clearBoard"
              >
                清空
              </button>
              <button class="tool primary" type="button" :disabled="busy" @click="exportBoard">导出</button>
            </div>
          </section>

          <!-- 工具选项条：随当前工具切换 -->
          <section class="opts-card">
            <!-- 选择 -->
            <template v-if="tool === 'pointer'">
              <div class="opts-line">
                <span class="opts-hint">{{ hint }}</span>
                <span v-if="selected" class="opts-scale">{{ selectedScale }}%</span>
              </div>
              <div v-if="selected" class="tool-row opt-row">
                <button class="opt" type="button" @click="duplicateSelected">复制</button>
                <button class="opt" type="button" @click="raiseSelected">置顶</button>
                <button class="opt" type="button" @click="lowerSelected">置底</button>
                <button class="opt danger" type="button" @click="deleteSelected">删除</button>
              </div>
            </template>

            <!-- 画笔 -->
            <template v-else-if="tool === 'draw'">
              <div class="opts-line swatches">
                <button
                  v-for="(color, index) in colors"
                  :key="color.value"
                  class="swatch"
                  :class="{ on: colorIndex === index }"
                  :style="{ background: color.value }"
                  :title="color.name"
                  :aria-label="color.name"
                  type="button"
                  @click="pickColor(index)"
                />
              </div>
              <div class="opts-line">
                <span class="opts-label">笔触</span>
                <input v-model.number="brush" class="slider grow" type="range" min="4" max="40" step="2" />
                <span class="opts-num">{{ brush }}px</span>
              </div>
            </template>

            <!-- 文字 -->
            <template v-else-if="tool === 'text'">
              <div class="opts-line">
                <input v-model="textValue" class="input" type="text" placeholder="要写的内容" />
              </div>
              <div class="opts-line">
                <div class="swatches compact">
                  <button
                    v-for="(color, index) in colors"
                    :key="color.value"
                    class="swatch"
                    :class="{ on: colorIndex === index }"
                    :style="{ background: color.value }"
                    :title="color.name"
                    :aria-label="color.name"
                    type="button"
                    @click="pickColor(index)"
                  />
                </div>
                <input
                  v-model.number="fontSize"
                  class="slider grow"
                  type="range"
                  min="20"
                  max="120"
                  step="4"
                />
                <span class="opts-num">{{ fontSize }}px</span>
              </div>
            </template>

            <!-- 图片 -->
            <template v-else-if="tool === 'image'">
              <div class="opts-line">
                <button class="opt wide" type="button" @click="insertImage">从相册插入</button>
                <span class="opts-hint">插进来的图可以选中后缩放</span>
              </div>
            </template>

            <!-- 橡皮 -->
            <template v-else>
              <div class="opts-line">
                <span class="opts-hint">{{ hint }}</span>
              </div>
            </template>
          </section>

          <!-- 操作提示：纯静态说明 -->
          <section class="draw-tips">
            <div class="mono draw-tips-title">操作提示</div>
            <ul class="draw-tips-list">
              <li>选好工具后在画布上操作，右边的选项条会跟着工具变</li>
              <li>选择工具：点一下元素选中，拖动移动，拖角手柄缩放</li>
              <li>导出成图统一是 552×768 的竖图，直接进待刷队列</li>
            </ul>
          </section>
        </aside>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 画布：显示尺寸由比例决定，位图按设备像素比绘制 */
/* 画布跟着主区宽度伸展，上限 780px（竖版就是 780×1086），再宽就没法一眼看全了 */
.board-wrap {
  max-width: 806px;
  margin: 0 auto;
}

.board-stage {
  width: 100%;
}

.board-canvas {
  width: 100%;
  max-width: 780px;
  height: auto;
  user-select: none;
}

.board-canvas.tool-pointer {
  cursor: default;
}

.board-canvas.tool-erase {
  cursor: crosshair;
}

/* 方向徽标是个按钮，去掉浏览器默认样式 */
.board-orient {
  border: none;
  font-family: var(--mono);
  cursor: pointer;
}

/* 工具选项条 */
.opts-line {
  display: flex;
  align-items: center;
  min-height: 51px;
  gap: 10px;
}

.opts-line + .opts-line {
  margin-top: 8px;
}

.opts-hint {
  flex: 1;
  font-size: 18px;
  color: var(--ink-45);
  line-height: 1.6;
}

.opts-label {
  font-size: 18px;
  color: var(--ink-45);
  flex: none;
}

.opts-scale {
  font-size: 18px;
  color: var(--ink-70);
  font-family: var(--mono);
  flex: none;
}

.opts-num {
  font-size: 17px;
  color: var(--ink-45);
  font-family: var(--mono);
  width: 53px;
  text-align: right;
  flex: none;
}

/* 滑块 */
.slider.grow {
  flex: 1;
  min-width: 0;
  margin: 0;
  accent-color: var(--lime-deep);
  cursor: pointer;
}

/* 色板 */
.swatches {
  display: flex;
  align-items: center;
  gap: 11px;
  flex-wrap: wrap;
}

.swatches.compact {
  gap: 8px;
}

.swatches.compact .swatch {
  width: 34px;
  height: 34px;
  border-width: 2px;
}

/* 选项条里的小按钮 */
.opt-row {
  gap: 9px;
}

.opt-row .opt {
  flex: 1;
}

.opt.wide {
  flex: none;
  width: 176px;
}

.opt.danger {
  border-color: rgba(192, 0, 0, 0.4);
  color: #c00000;
}

/* 工具栏：两行 */
.toolbar-card .tool-row + .tool-row {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}

/* ---------------- 右栏（工具面板） ---------------- */

/* 选项条进了右栏，间距交给 workbench-aside 的 gap */
.workbench-aside .opts-card {
  margin-top: 0;
}

/* 右栏窄，工具按钮要能一行排下五个 */
.workbench-aside .toolbar-card .tool {
  min-width: 0;
}

/* 右栏窄，色板缩小一点，八个颜色排一行 */
.workbench-aside .opts-card .swatch {
  width: 34px;
  height: 34px;
}

/* 操作提示卡 */
.draw-tips {
  background: #fff;
  border-radius: 22px;
  padding: 16px 18px;
}

.draw-tips-title {
  margin-bottom: 9px;
}

.draw-tips-list {
  margin: 0;
  padding-left: 20px;
  font-size: 16px;
  color: var(--ink-45);
  line-height: 1.7;
}

.draw-tips-list li + li {
  margin-top: 5px;
}
</style>
