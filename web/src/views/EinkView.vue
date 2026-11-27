<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { runRepeatTest, validRepeatConfig, type RepeatEvent } from '@/core/guide/repeatTest'
import NavBar from '@/components/NavBar.vue'
import BlePill from '@/components/BlePill.vue'
import ModalPanel from '@/components/ModalPanel.vue'
import EinkTutorial from '@/components/EinkTutorial.vue'
import { appStore, QueueItem } from '@/core/store/index'
import { transportManager } from '@/platform'
import { epdSession } from '@/core/rf/session'
import { deviceSession } from '@/core/protocol'
import { toHex } from '@/core/hex'
import { DeviceProfile } from '@/core/epd/profile'
import { APP_BLOCK_SIZE } from '@/core/epd/commands'
import {
  CancelToken,
  ImageOptions,
  PREVIEW_CHUNK_ROWS,
  TargetSpec,
  buildPreview,
  createCancelToken,
  prepareForTarget,
  targetPalette,
} from '@/core/image/pipeline'
import { processedCache } from '@/core/image/cache'
import {
  FLASH_ROTATION,
  createPreviewBand,
  exportThumbnail,
  flipRgb180,
  putCodeBand,
  putPreviewBand,
  renderToRgbAdjusted,
} from '@/core/image/canvas'
import { ALGORITHM_OPTIONS, FIT_OPTIONS, IMAGE_PRESETS, ROTATION_OPTIONS } from '@/core/image/presets'
import { GuideBlock, buildGuideBlocks } from '@/core/guide/blocks'
import { SETTLE_MS, EpdScreenRenderer } from '@/core/guide/screen'
import { uploadHuawei } from '@/core/epd/huawei'
import { uploadWithRetry } from '@/core/epd/retry'
import { uploadPanel } from '@/core/epd/panel'
import { describeUploadStats, formatBytes } from '@/core/epd/stats'
import type { UploadStats } from '@/core/epd/stats'
import { setKeepScreenOn, resumeKeepScreenOn } from '@/core/device/screen'
import { pickImageFiles, imageUrl, saveImageBlob } from '@/platform/images'
import { showModal, showToast } from '@/platform/ui'

const router = useRouter()
const route = useRoute()

/** 队列上限与一次可选的张数，和小程序一致。 */
const MAX_QUEUE = 99
const MAX_PICK = 9

/** 未连接读卡器时的预览分辨率（华为 552×768 四色）。 */
const DEFAULT_WIDTH = 552
const DEFAULT_HEIGHT = 768

/** 预览节流窗口（毫秒）。 */
const PREVIEW_THROTTLE_MS = 60
const PREVIEW_DEBOUNCE_MS = 200
/** 拖动期间的快速预览比例。 */
const PREVIEW_FAST_SCALE = 0.35

/** 块进度格上限。 */
const BLOCK_CELLS_MAX = 48

/** 传输完成后显色动画的最短展示时长。 */
const MIN_DISPLAY_MS = 4000
const COMPLETE_HOLD_MS = 600

type Tab = 'queue' | 'process' | 'guide'

const TABS: Tab[] = ['queue', 'process', 'guide']
type GuidePhase = 'idle' | 'working' | 'waiting' | 'error'
type StepStatus = 'idle' | 'active' | 'done' | 'error'

interface GuideStep {
  key: string
  label: string
  status: StepStatus
  desc: string
}

const queue = ref<QueueItem[]>([])
const activeTab = ref<Tab>('queue')

/** 「图片制作」模态框：画板与火车票是刷图的子工具，弹窗里挑。 */
const toolsOpen = ref(false)
const tutorialOpen = ref(false)

function goTool(path: string): void {
  toolsOpen.value = false
  void router.push(path)
}
const testOpen = ref(false)
const testRunning = ref(false)
const testStopping = ref(false)
const testMessage = ref('')
const testConfig = reactive({ rounds: 10, intervalSeconds: 5, retrySeconds: 5 })
const testItem = ref<QueueItem | null>(null)
const testLogKey = 'd4u_flash_test_logs'
interface TestLog extends RepeatEvent { time: string; runId: string; image: string; config?: typeof testConfig }
interface TestRunSummary {
  runId: string
  image: string
  startedAt: string
  rounds: number
  entries: TestLog[]
  successes: number
  failures: number
  attempts: number
  successRate: number
  status: string
  durationMs: number
  roundsDetail: TestRoundSummary[]
}
interface TestRoundSummary {
  round: number
  attempts: number
  failures: number
  durationMs: number
  status: string
}
function readTestLogs(): TestLog[] {
  try { const saved = JSON.parse(localStorage.getItem(testLogKey) || '[]'); return Array.isArray(saved) ? saved.slice(-1000) : [] } catch { return [] }
}
const testLogs = ref<TestLog[]>(readTestLogs())
const currentTestRunId = ref('')
const testClock = ref(Date.now())
let testClockTimer = 0
const testRunSummaries = computed<TestRunSummary[]>(() => {
  const now = testClock.value
  const grouped = new Map<string, TestLog[]>()
  for (const entry of testLogs.value) {
    const entries = grouped.get(entry.runId) ?? []
    entries.push(entry)
    grouped.set(entry.runId, entries)
  }
  return [...grouped.entries()].reverse().map(([runId, entries]) => {
    const config = entries.find(entry => entry.type === 'start')?.config
    const successes = entries.filter(entry => entry.type === 'success').length
    const failures = entries.filter(entry => entry.type === 'failure').length
    const attempts = entries.filter(entry => entry.type === 'attempt').length
    const terminalEntry = [...entries].reverse().find(entry => entry.type === 'complete' || entry.type === 'stopped')
    const status = entries.some(entry => entry.type === 'complete')
      ? '已完成'
      : entries.some(entry => entry.type === 'stopped')
        ? '已停止'
        : currentTestRunId.value === runId ? '测试中' : '未完成'
    const startedAt = entries.find(entry => entry.type === 'start')?.time ?? entries[0]?.time ?? ''
    const roundEntriesByNumber = new Map<number, TestLog[]>()
    for (const entry of entries) {
      if (entry.round <= 0) continue
      const roundEntries = roundEntriesByNumber.get(entry.round) ?? []
      roundEntries.push(entry)
      roundEntriesByNumber.set(entry.round, roundEntries)
    }
    const roundNumbers = [...roundEntriesByNumber.keys()].sort((a, b) => a - b)
    const roundsDetail = roundNumbers.map(round => {
      const roundEntries = roundEntriesByNumber.get(round) ?? []
      const firstAttempt = roundEntries.find(entry => entry.type === 'attempt')
      const roundEnd = [...roundEntries].reverse().find(entry => entry.type === 'success' || entry.type === 'stopped')
      const isActive = currentTestRunId.value === runId && round === roundNumbers[roundNumbers.length - 1]
      const startMs = firstAttempt ? Date.parse(firstAttempt.time) : NaN
      const endMs = roundEnd ? Date.parse(roundEnd.time) : isActive ? now : startMs
      return {
        round,
        attempts: roundEntries.filter(entry => entry.type === 'attempt').length,
        failures: roundEntries.filter(entry => entry.type === 'failure').length,
        durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
        status: roundEntries.some(entry => entry.type === 'success')
          ? '成功'
          : roundEntries.some(entry => entry.type === 'stopped') ? '已停止' : isActive ? '进行中' : '未完成',
      }
    })
    const startMs = Date.parse(startedAt)
    const endMs = terminalEntry ? Date.parse(terminalEntry.time) : currentTestRunId.value === runId ? now : startMs
    return {
      runId,
      image: entries[0]?.image ?? '未知图片',
      startedAt,
      rounds: Number(config?.rounds ?? 0),
      entries,
      successes,
      failures,
      attempts,
      successRate: successes + failures ? Math.round(successes / (successes + failures) * 100) : 0,
      status,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
      roundsDetail,
    }
  })
})
const logStorageError = ref('')
let testController: AbortController | null = null
let holdTimer = 0
let held = false
function cancelHold() { window.clearTimeout(holdTimer); holdTimer = 0 }
function beginHold(event: PointerEvent) {
  if (event.button !== 0 || testRunning.value) return
  cancelHold(); held = false
  holdTimer = window.setTimeout(() => {
    held = true
    const item = guideItem.value
    if (!item) { showToast('请先选择图片'); return }
    testItem.value = { ...item, options: { ...item.options } }
    testOpen.value = true
  }, 700)
}
function clickFlash() {
  cancelHold()
  if (held) { held = false; return }
  if (!testRunning.value) void flashCurrent()
}
function stopTest() {
  testStopping.value = true
  testController?.abort()
  testMessage.value = guidePhase.value === 'working' ? '停止中，等待本次刷图结束…' : '正在停止…'
}
async function startTest() {
  if (testRunning.value || !testItem.value) return
  if (!validRepeatConfig(testConfig)) { showToast('轮数为 1–10000，等待时间为 0–86400 秒'); return }
  if (transportManager.status !== 'connected') { showToast('请先连接读卡器'); return }
  const item = { ...testItem.value, options: { ...testItem.value.options } }
  const config = { ...testConfig }
  const controller = new AbortController()
  testController = controller
  testRunning.value = true
  testStopping.value = false
  const runId = new Date().toISOString()
  currentTestRunId.value = runId
  testClock.value = Date.now()
  testClockTimer = window.setInterval(() => { testClock.value = Date.now() }, 1000)
  try {
    await runRepeatTest(config, async () => {
      const success = await flashCurrent(item)
      if (!success) throw new Error(guideNote.value || '刷图未完成')
    }, controller.signal, event => {
      testMessage.value = `第 ${event.round || 1}/${config.rounds} 轮 · ${event.message}`
      const log: TestLog = { ...event, time: new Date().toISOString(), runId, image: item.name, ...(event.type === 'start' ? { config } : {}) }
      testLogs.value = [...testLogs.value, log].slice(-1000)
      try { localStorage.setItem(testLogKey, JSON.stringify(testLogs.value)); logStorageError.value = '' }
      catch { logStorageError.value = '浏览器日志保存失败，请导出日志。' }
      appStore.log(event.type === 'failure' ? 'error' : 'info', `[测试模式] ${item.name} · ${testMessage.value}`)
    })
  } finally {
    testRunning.value = false
    testStopping.value = false
    testController = null
    currentTestRunId.value = ''
    window.clearInterval(testClockTimer)
    testClockTimer = 0
  }
}
function exportTestLogs() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(testLogs.value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'd4u-test-mode-logs.json'; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function clearTestLogs() {
  if (testRunning.value) return
  testLogs.value = []
  try {
    localStorage.removeItem(testLogKey)
    logStorageError.value = ''
  } catch {
    logStorageError.value = '浏览器日志清除失败，当前列表已清空。'
  }
}
function formatTestDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}时${minutes}分${seconds}秒` : minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}
onBeforeRouteLeave(() => {
  if (!testRunning.value) return true
  stopTest()
  if (guidePhase.value === 'working') { showToast('等待当前刷图结束后再离开'); return false }
  return true
})
const currentId = ref('')
const options = reactive<ImageOptions>({ ...appStore.globalOptions })
const activePresetId = ref(appStore.globalPresetId)

const previewInfo = ref('')
const previewBusy = ref(false)
const previewProgress = ref(0)

const guidePhase = ref<GuidePhase>('idle')
const guideScreen = ref('idle')
const guideNote = ref('')
const progress = ref(0)
const progressText = ref('')
const profileText = ref('')
const statusHint = ref('')
const guideIndex = ref(0)
const guidePrimaryText = ref('开始刷图')
const guideBlockTotal = ref(0)
const guideBlockDone = ref(0)
const guideBlockFilled = ref(0)
const guideBlockCells = ref<number[]>([])
const guidePacketCurrent = ref(0)
const guidePacketTotal = ref(0)
const guideThumb = ref('')
const guideBlocks = ref<GuideBlock[]>([])
const steps = ref<GuideStep[]>([
  { key: 'connect', label: '连接', status: 'idle', desc: '等待读卡器接入' },
  { key: 'identify', label: '识别', status: 'idle', desc: '读取屏幕档案' },
  { key: 'transfer', label: '传输', status: 'idle', desc: '拆分数据块并分包写入' },
  { key: 'display', label: '显色', status: 'idle', desc: '墨水屏刷新并显示' },
])

const previewCanvas = ref<HTMLCanvasElement | null>(null)
const workCanvas = ref<HTMLCanvasElement | null>(null)
const uploadCanvas = ref<HTMLCanvasElement | null>(null)
const epdCanvas = ref<HTMLCanvasElement | null>(null)

const screen = new EpdScreenRenderer()
let sessionProfile: DeviceProfile | null = null
let previewTimer = 0
let previewNextAt = 0
let previewRunning = false
let previewDirty = false
let previewCancel: CancelToken | null = null
let refreshTimer = 0
let unsubStore: (() => void) | null = null

const selectedItems = computed(() => queue.value.filter(item => item.selected))
const processItems = computed(() => selectedItems.value)
const allSelected = computed(() => queue.value.length > 0 && queue.value.every(item => item.selected))
const remaining = computed(() => Math.max(0, MAX_QUEUE - queue.value.length))


const guideItem = computed(() => selectedItems.value[guideIndex.value] ?? null)
const guideName = computed(() => guideItem.value?.name ?? '')
const guideHasPrev = computed(() => guideIndex.value > 0)
const guideHasNext = computed(() => guideIndex.value < selectedItems.value.length - 1)

const rotationHint = computed(() => {
  if (options.rotation === 180) {
    return '方向 180°（屏幕倒装，0° 才是正方向）'
  }
  return '方向 0°（屏幕倒装，传送时自动转 180°）'
})

/** 当前目标屏幕规格：识别到屏幕就按真实参数，否则按华为 552×768。 */
function targetSpec(): TargetSpec {
  if (sessionProfile) {
    return {
      family: sessionProfile.family,
      width: sessionProfile.width,
      height: sessionProfile.height,
      profile: sessionProfile,
    }
  }
  return { family: 'huawei', width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
}

function syncQueue(): void {
  queue.value = [...appStore.queue]
  if (!currentId.value || !appStore.queue.some(item => item.id === currentId.value)) {
    const first = appStore.selectedItems[0] ?? appStore.queue[0]
    currentId.value = first?.id ?? ''
    if (first) {
      const found = appStore.queue.find(item => item.id === first.id)
      if (found) {
        Object.assign(options, found.options)
        activePresetId.value = found.presetId
      }
    }
  }
}

function presetLabel(item: QueueItem): string {
  return IMAGE_PRESETS.find(preset => preset.id === item.presetId)?.name ?? '自定义'
}

// ---------------- 图片队列 ----------------

async function addImages(): Promise<void> {
  const count = Math.min(MAX_PICK, remaining.value)
  if (count <= 0) {
    showToast(`最多 ${MAX_QUEUE} 张`)
    return
  }
  const files = await pickImageFiles(true)
  if (!files.length) {
    return
  }
  const picked = files.slice(0, count)
  const pending: Array<Parameters<typeof appStore.addItems>[0][number]> = []
  for (const file of picked) {
    try {
      const blobId = await saveImageBlob(file)
      if (!blobId) {
        continue
      }
      const url = await imageUrl(blobId)
      const image = new Image()
      await new Promise<void>(resolve => {
        image.onload = () => resolve()
        image.onerror = () => resolve()
        image.src = url
      })
      pending.push({
        path: url,
        blobId,
        name: file.name || '未命名图片',
        sourceWidth: image.naturalWidth,
        sourceHeight: image.naturalHeight,
        thumb: url,
        presetId: appStore.globalPresetId,
        options: { ...appStore.globalOptions, rotation: 0 },
      })
    } catch {
      // 单张失败不影响其它图片入队。
    }
  }
  if (!pending.length) {
    showToast('导入失败')
    return
  }
  appStore.addItems(pending, 'top')
  showToast(`已导入 ${pending.length} 张`)
}

function toggleItem(item: QueueItem): void {
  appStore.toggleItem(item.id)
}

function removeItem(item: QueueItem): void {
  appStore.removeItem(item.id)
  processedCache.dropItem(item.id)
}

function selectAll(): void {
  appStore.selectAll(!allSelected.value)
}

async function clearQueue(): Promise<void> {
  const confirmed = await showModal({
    title: '清空队列',
    content: '将移除全部待刷图片，确定继续？',
  })
  if (!confirmed) {
    return
  }
  appStore.clearQueue()
  processedCache.clear()
}

// ---------------- 图像处理 ----------------

function applyOptions(patch: Partial<ImageOptions>, presetId = 'custom'): void {
  Object.assign(options, patch)
  appStore.globalOptions = { ...options }
  appStore.globalPresetId = presetId
  activePresetId.value = presetId
  if (currentId.value) {
    appStore.updateItem(currentId.value, { options: { ...options }, presetId })
    const item = appStore.queue.find(entry => entry.id === currentId.value)
    // 改了参数就等于换了内容，之前那次「已刷」不再作数。
    if (item && item.status === 'done') {
      appStore.updateItem(currentId.value, { status: 'ready', progress: 0, packed: undefined })
    }
  }
  appStore.saveSettings()
  schedulePreview('full')
}

function applyPreset(id: string): void {
  const preset = IMAGE_PRESETS.find(item => item.id === id)
  if (!preset) {
    return
  }
  applyOptions({ ...preset.options }, preset.id)
}

function resetRotation(): void {
  applyOptions({ rotation: 0 })
}

function applyToAll(): void {
  const items = appStore.selectedItems
  if (!items.length) {
    showToast('请先选择图片')
    return
  }
  items.forEach(item => {
    const reset = item.status === 'done' ? { status: 'ready' as const, progress: 0, packed: undefined } : {}
    appStore.updateItem(item.id, {
      options: { ...options },
      presetId: activePresetId.value,
      ...reset,
    })
  })
  appStore.saveSettings()
  showToast(`已应用到 ${items.length} 张`)
  if (activeTab.value === 'process') {
    schedulePreview('full')
  }
}

function selectCurrent(id: string): void {
  currentId.value = id
  const item = appStore.queue.find(entry => entry.id === id)
  if (item) {
    Object.assign(options, item.options)
    activePresetId.value = item.presetId
  }
  schedulePreview('full')
}

/**
 * 安排一次预览渲染（节流）。
 *
 * 拖动滑杆时事件连续到达：窗口内的第一次立刻出图，后续合并成一次尾随更新，
 * 尾随定时器不重置——重置就退化成防抖，拖动时依然一帧不动。
 */
function schedulePreview(quality: 'fast' | 'full'): void {
  const span = quality === 'fast' ? PREVIEW_THROTTLE_MS : PREVIEW_DEBOUNCE_MS
  const now = Date.now()
  const wait = previewNextAt - now
  if (wait <= 0) {
    previewNextAt = now + span
    void requestPreview(quality)
    return
  }
  if (previewTimer) {
    return
  }
  previewTimer = window.setTimeout(() => {
    previewTimer = 0
    previewNextAt = Date.now() + span
    void requestPreview(quality)
  }, wait)
}

function requestPreview(quality: 'fast' | 'full'): void {
  if (previewRunning) {
    previewDirty = true
    if (previewCancel) {
      previewCancel.cancelled = true
    }
    return
  }
  void drainPreview(quality)
}

async function drainPreview(quality: 'fast' | 'full'): Promise<void> {
  previewRunning = true
  try {
    do {
      previewDirty = false
      await renderPreview(quality)
    } while (previewDirty)
  } finally {
    previewRunning = false
  }
}

async function renderPreview(quality: 'fast' | 'full'): Promise<void> {
  const item = appStore.queue.find(entry => entry.id === currentId.value) ?? appStore.selectedItems[0]
  if (!item) {
    previewInfo.value = '请先在图片队列中选择一张图片'
    previewBusy.value = false
    return
  }
  if (!currentId.value) {
    currentId.value = item.id
  }
  const token = createCancelToken()
  previewCancel = token
  const spec = targetSpec()
  // 通用面板的点阵重排与翻转是按屏幕分辨率算死的，降分辨率预览会算错，
  // 因此只有华为路径才用缩略图档；面板路径一律按目标分辨率处理。
  const fastable = spec.family === 'huawei'
  const scale = quality === 'fast' && fastable ? PREVIEW_FAST_SCALE : 1
  const size = fastable
    ? previewRenderSize(spec.width, spec.height, scale)
    : { width: spec.width, height: spec.height }
  const currentOptions = { ...options }
  const isTargetSize = size.width === spec.width && size.height === spec.height
  const cacheKey = processedCache.key(item.id, spec, currentOptions)
  const preview = previewCanvas.value
  const work = workCanvas.value
  if (!preview || !work) {
    return
  }
  try {
    if (preview.width !== size.width) {
      preview.width = size.width
    }
    if (preview.height !== size.height) {
      preview.height = size.height
    }
    const ctx = preview.getContext('2d')
    if (!ctx) {
      return
    }
    const palette = targetPalette(spec, currentOptions)
    const band = createPreviewBand(ctx, size.width, PREVIEW_CHUNK_ROWS)
    previewBusy.value = quality === 'full'
    previewProgress.value = 0

    const cached = isTargetSize ? processedCache.get(cacheKey) : undefined
    if (cached && cached.width === size.width && cached.height === size.height) {
      if (cached.preview) {
        putPreviewBand(ctx, band, cached.preview, size.width, 0, size.height)
      } else if (cached.codes) {
        putCodeBand(ctx, band, cached.codes, palette, size.width, 0, size.height)
      }
      finishPreview(size, currentOptions, spec)
      return
    }

    const adjusted = await renderToRgbAdjusted(work, item.path, size.width, size.height, currentOptions)
    if (token.cancelled) {
      return
    }
    const progressive = spec.family !== 'panel'
    const lean = spec.family === 'huawei'
    const prepared = await prepareForTarget(adjusted, size.width, size.height, spec, currentOptions, {
      token,
      skipPacked: !isTargetSize || lean,
      skipPreview: !isTargetSize || lean,
      onProgress: ratio => {
        if (!token.cancelled) {
          previewProgress.value = Math.round(ratio * 100)
        }
      },
      onChunk: progressive
        ? (rowStart, rowEnd, codes) => {
            if (!token.cancelled) {
              putCodeBand(ctx, band, codes, palette, size.width, rowStart, rowEnd)
            }
          }
        : undefined,
    })
    if (!prepared || token.cancelled) {
      return
    }
    if (!progressive && prepared.preview) {
      putPreviewBand(ctx, band, prepared.preview, size.width, 0, size.height)
    }
    if (isTargetSize) {
      processedCache.set(cacheKey, {
        codes: prepared.codes,
        packed: prepared.packed,
        preview: prepared.preview,
        width: size.width,
        height: size.height,
      })
    }
    finishPreview(size, currentOptions, spec)
  } catch (error) {
    if (!token.cancelled) {
      appStore.log('error', `预览失败：${error instanceof Error ? error.message : String(error)}`)
      previewBusy.value = false
    }
  } finally {
    if (previewCancel === token) {
      previewCancel = null
    }
  }
}

function finishPreview(
  size: { width: number; height: number },
  currentOptions: ImageOptions,
  spec: TargetSpec,
): void {
  previewBusy.value = false
  previewProgress.value = 0
  const parts = [
    `${size.width}×${size.height}`,
    `${currentOptions.fit === 'contain' ? '留白' : '裁剪'}`,
    `旋转 ${currentOptions.rotation}°`,
  ]
  if (currentOptions.blackWhite) {
    parts.push('黑白')
  }
  parts.push(spec.family === 'huawei' ? '华为四色' : '通用面板')
  previewInfo.value = `${parts.join(' · ')} · ${rotationHint.value}`
}

// ---------------- 刷图引导 ----------------

function updateStep(key: string, status: StepStatus, desc: string): void {
  steps.value = steps.value.map(step => (step.key === key ? { ...step, status, desc } : step))
  const active = steps.value.find(step => step.status === 'active')
  guideNote.value = active ? active.desc : desc
}

function primaryText(phase: GuidePhase, total: number, index: number): string {
  if (phase === 'working') {
    return '刷图进行中…'
  }
  if (phase === 'error') {
    return '重试'
  }
  if (phase === 'waiting') {
    return index + 1 >= total ? '全部刷完' : '刷下一张 ›'
  }
  return '开始刷图'
}

async function ensureSession(): Promise<DeviceProfile> {
  if (sessionProfile && epdSession.isReady && epdSession.rfBridge.isFieldOn) {
    updateStep('connect', 'done', '读卡器已连接')
    updateStep('identify', 'done', `${sessionProfile.modelName} · ${sessionProfile.colorCount} 色`)
    return sessionProfile
  }
  updateStep('connect', 'active', '正在连接读卡器…')
  const result = await epdSession.activate(message => {
    appStore.log('info', message)
    guideNote.value = message
  })
  sessionProfile = result.profile
  updateStep('connect', 'done', '读卡器已连接')
  updateStep('identify', 'done', `${result.profile.modelName} · ${result.profile.colorCount} 色`)
  profileText.value = `${result.profile.modelName}｜协议 ${result.profile.family}｜UID ${toHex(result.profile.uid)}`
  statusHint.value = result.warning
  if (activeTab.value === 'process') {
    schedulePreview('full')
  }
  if (result.warning) {
    appStore.log('warn', result.warning)
  }
  return result.profile
}

async function attachScreen(): Promise<void> {
  const canvas = epdCanvas.value
  if (!canvas) {
    throw new Error('模拟屏画布未就绪')
  }
  await screen.attach(canvas)
  screen.setLayout(guideBlocks.value)
}

async function flashCurrent(pinnedItem?: QueueItem): Promise<boolean> {
  if (guidePhase.value === 'working') {
    return false
  }
  const items = appStore.selectedItems
  if (!items.length) {
    showToast('请先在图片队列中选择图片')
    return false
  }
  if (transportManager.status !== 'connected') {
    if (pinnedItem) { guideNote.value = '读卡器未连接'; return false }
    const confirmed = await showModal({
      title: '读卡器未连接',
      content: '请先连接读卡器，再开始刷图。',
      confirmText: '去连接',
      showCancel: true,
    })
    if (confirmed) {
      router.push('/connect?return=1')
    }
    return false
  }
  const index = Math.max(0, Math.min(guideIndex.value, items.length - 1))
  const item = pinnedItem ?? items[index]
  guidePhase.value = 'working'
  steps.value = steps.value.map(step => ({ ...step, status: 'idle' }))
  guideScreen.value = 'transfer'
  guideNote.value = '正在准备图像…'
  progress.value = 0
  progressText.value = ''
  guideBlockDone.value = 0
  guideBlockTotal.value = 0
  guideBlockFilled.value = 0
  guideBlockCells.value = []
  guideBlocks.value = []
  guidePacketCurrent.value = 0
  guidePacketTotal.value = 0
  guidePrimaryText.value = primaryText('working', items.length, index)

  // 显色动画的收尾开关：屏幕刷完（或出错）时 resolve，动画随即收尾。
  let displayStarted: Promise<void> | null = null
  let settleResolve: (success: boolean) => void = () => undefined
  const settled = new Promise<boolean>(resolve => {
    settleResolve = resolve
  })

  // 刷图期间保持屏幕常亮：息屏会让浏览器挂起定时器，分包超时与重传逻辑一起失效。
  setKeepScreenOn(true)
  const releaseField = epdSession.rfBridge.retainField()

  try {
    const profile = await ensureSession()
    updateStep('identify', 'done', `${profile.modelName} · ${profile.colorCount} 色`)

    updateStep('transfer', 'active', '正在处理并拆分数据块…')
    const prepared = await buildPacked(item, profile, Boolean(pinnedItem))
    if (!prepared) {
      throw new Error(`「${item.name}」处理失败，无法上传`)
    }
    const blockTotal = Math.max(1, Math.ceil(prepared.packed.length / APP_BLOCK_SIZE))
    const blocks = buildGuideBlocks(blockTotal)

    await attachScreen()
    screen.reset()
    screen.setLayout(blocks)
    await screen.setBaseImage(prepared.displayThumb, true)
    await screen.setBlockImage(prepared.displayThumb, true)
    screen.setState('transfer')

    guideBlockTotal.value = blockTotal
    guideBlockCells.value = buildBlockCells(blockTotal)
    guideBlocks.value = blocks
    guideNote.value = `已拆分为 ${blockTotal} 块，开始传输`

    const iso = epdSession.iso
    if (!iso) {
      throw new Error('会话已失效，请重新连接读卡器')
    }

    const startDisplay = (): void => {
      if (displayStarted) {
        return
      }
      displayStarted = playDisplay(settled)
    }

    // 只量「传输」这一段：显色动辄几十秒，混进来会看不出慢在哪。
    const transferSnapshot = () => ({
      session: deviceSession.current,
      protocol: deviceSession.current?.transferStats,
      bytes: transportManager.writtenBytes,
      count: transportManager.writeCount,
      writeMs: transportManager.writeDurationMs,
      chunkSize: transportManager.chunkSize,
    })
    let uploadSnapshot: ReturnType<typeof transferSnapshot> | null = null
    let finishSnapshot: ReturnType<typeof transferSnapshot> | null = null
    let uploadStartedAt = 0
    let uploadFinishedAt = 0
    const onProgress = (value: { phase: string; current: number; total: number; message: string }): void => {
      const ratio = value.total > 0 ? value.current / value.total : 0
      if (value.phase === 'upload') {
        if (!uploadStartedAt) {
          uploadStartedAt = Date.now()
          uploadSnapshot = transferSnapshot()
        }
        if (value.message.includes('重传当前包')) appStore.log('warn', value.message)
        const filled = Math.min(blocks.length, Math.round(ratio * blocks.length))
        screen.setLit(filled)
        progress.value = Math.round(ratio * 92)
        progressText.value = value.message
        guidePacketCurrent.value = value.current
        guidePacketTotal.value = value.total
        guideBlockDone.value = Math.min(blockTotal, Math.round(ratio * blockTotal))
        guideBlockFilled.value = filled
      } else if (value.phase === 'refresh') {
        if (!uploadFinishedAt) {
          uploadFinishedAt = Date.now()
          finishSnapshot = transferSnapshot()
        }
        if (!displayStarted) {
          updateStep('transfer', 'done', '图像已写入')
          progress.value = 94
          guideBlockDone.value = blockTotal
          guideBlockFilled.value = blocks.length
          startDisplay()
        }
        progress.value = Math.max(94, progress.value)
      } else if (value.phase === 'status') {
        progressText.value = value.message
        guideNote.value = value.message
        progress.value = Math.max(94, progress.value)
      }
    }

    // 分包一完成就把「传给屏幕的字节数」写进日志：
    // 点阵多大、压缩后多大、拆成多少包、每包多大，一次看全。
    let packetCount = 0
    const onStats = (stats: UploadStats): void => {
      packetCount = stats.packetCount
      appStore.log('info', describeUploadStats(stats))
    }

    // 链路写入量取上传前后的差值：蓝牙单次只能写 chunkSize 字节，
    // 想知道这次刷图到底往设备里塞了多少字节，看这一行。
    const overallBefore = transferSnapshot()
    await uploadWithRetry({ profile, iso }, async () => {
      if (transportManager.status !== 'connected') throw new Error('读卡器已断开，停止重试')
      const result = await epdSession.activate(message => appStore.log('info', message))
      const nextIso = epdSession.iso
      if (!nextIso) throw new Error('重新选卡失败，会话已失效')
      return { profile: result.profile, iso: nextIso }
    }, async (activeIso, activeProfile) => {
      if (activeProfile.family === 'huawei') {
        await uploadHuawei(activeIso, activeProfile, prepared.packed, { onProgress, onStats })
      } else {
        await uploadPanel(activeIso, activeProfile, prepared.packed, { onProgress, onStats })
      }
    }, message => {
      appStore.log('info', message)
      guideNote.value = message
      progressText.value = message
      progress.value = 0
      guidePacketCurrent.value = 0
      guideBlockDone.value = 0
      guideBlockFilled.value = 0
      screen.setLit(0)
    })
    const linkBefore = uploadSnapshot ?? overallBefore
    const linkAfter = finishSnapshot ?? transferSnapshot()
    const protocolBefore = linkBefore.protocol
    const protocolAfter = linkAfter.protocol
    if (protocolBefore && protocolAfter && linkBefore.session === linkAfter.session) {
      const seconds = (key: 'submitMs' | 'firstReceiveWaitMs' | 'responseReceiveMs' | 'terminalWaitMs') =>
        ((protocolAfter[key] - protocolBefore[key]) / 1000).toFixed(2)
      appStore.log('info', `协议分段（仅图像传输）：${protocolAfter.requests - protocolBefore.requests} 次请求；` +
        `提交 ${seconds('submitMs')} 秒，提交后等首条接收 ${seconds('firstReceiveWaitMs')} 秒，` +
        `首条接收到请求回执 ${seconds('responseReceiveMs')} 秒，作业回执后等终态 ${seconds('terminalWaitMs')} 秒；` +
        `接收 ${protocolAfter.receivedChunks - protocolBefore.receivedChunks} 片、${protocolAfter.receivedBytes - protocolBefore.receivedBytes} 字节`)
    }
    const linkBytes = linkAfter.bytes - linkBefore.bytes
    const linkCount = linkAfter.count - linkBefore.count
    const chunkSize = linkAfter.chunkSize
    const writeMs = linkAfter.writeMs - linkBefore.writeMs
    const perWriteMs = linkCount > 0 ? (writeMs / linkCount).toFixed(2) : '0.00'
    // 整帧重发：帧写完但设备一个字节都没回，说明这帧没被处理，
    // 只能整帧重发。次数多了说明链路在丢帧。
    const frameReplays = (linkAfter.protocol?.frameReplays ?? 0) - (linkBefore.protocol?.frameReplays ?? 0)
    appStore.log(
      'info',
      `链路写入：本次实际写入 ${formatBytes(linkBytes)} 字节（${formatBytes(linkCount)} 次，` +
        `${transportManager.kind === 'bluetooth' ? `GATT 写入累计 ${(writeMs / 1000).toFixed(1)} 秒、平均每次 ${perWriteMs} 毫秒，` : ''}单次上限 ${chunkSize} 字节，` +
        `每片等 ATT 确认；含协议分帧开销）`,
    )
    if (frameReplays > 0) {
      appStore.log(
        'warn',
        `链路写入：本次有 ${frameReplays} 帧没送达设备、已整帧重发。` +
          '写入一律等 ATT 确认，正常不该丢帧；次数多说明设备在丢包，请重试一次对比。',
      )
    }
    // 传输阶段的耗时与吞吐：慢的时候一眼能看出是「包多」还是「链路慢」。
    const transferMs = uploadStartedAt && uploadFinishedAt ? uploadFinishedAt - uploadStartedAt : 0
    if (transferMs > 0) {
      const seconds = transferMs / 1000
      const perPacket = packetCount > 0 ? Math.round(transferMs / packetCount) : 0
      const throughput = Math.round(linkBytes / seconds)
      const mtuHint = chunkSize < 244
        ? `；当前按链路报告的安全上限 ${chunkSize} 字节分片`
        : ''
      appStore.log(
        'info',
        `传输耗时：${seconds.toFixed(1)} 秒，平均每包 ${perPacket} 毫秒，` +
          `链路吞吐 ${formatBytes(throughput)} 字节/秒${mtuHint}`,
      )
    }
    if (!displayStarted) {
      updateStep('transfer', 'done', '图像已写入')
      progress.value = 94
      guideBlockDone.value = blockTotal
      guideBlockFilled.value = blocks.length
      startDisplay()
    }
    settleResolve(true)
    await displayStarted

    updateStep('display', 'done', '显色完成')
    guideScreen.value = 'done'
    progress.value = 100
    progressText.value = `第 ${index + 1}/${items.length} 张已刷入`
    guideNote.value = '已刷入，等你手动选择下一张'

    appStore.updateItem(item.id, { status: 'done', progress: 100, packed: undefined })
    appStore.log('success', `第 ${index + 1}/${items.length} 张已刷入：${item.name}`)
    guidePhase.value = 'waiting'
    guidePrimaryText.value = primaryText('waiting', items.length, index)
    return true
  } catch (error) {
    settleResolve(false)
    await Promise.resolve(displayStarted).catch(() => undefined)
    screen.setState('idle')
    if (refreshTimer) {
      window.clearInterval(refreshTimer)
      refreshTimer = 0
    }
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `刷图失败：${message}`)
    guidePhase.value = 'error'
    updateStep(steps.value.find(step => step.status === 'active')?.key ?? 'transfer', 'error', message)
    guideNote.value = `刷图失败：${message}`
    progressText.value = `刷图失败：${message}`
    guidePrimaryText.value = primaryText('error', items.length, index)
    if (!pinnedItem) showToast('刷图失败')
    return false
  } finally {
    releaseField()
    epdSession.reset()
    sessionProfile = null
    // 刷完了就不再用射频场，把场关掉别一直辐射。
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    setKeepScreenOn(false)
  }
}

async function playDisplay(settled: Promise<boolean>): Promise<void> {
  updateStep('display', 'active', '墨水屏刷新中…')
  screen.setState('complete')
  guideScreen.value = 'complete'
  progressText.value = '传输完成，准备显色'
  await delay(COMPLETE_HOLD_MS)
  screen.setState('display')
  guideScreen.value = 'display'
  progressText.value = '墨水屏刷新中…'

  const startedAt = Date.now()
  refreshTimer = window.setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    progressText.value = `墨水屏刷新中… ${seconds}s`
    guideNote.value = `屏幕刷新中 · 已用 ${seconds} 秒`
  }, 500)

  const succeeded = await settled
  if (!succeeded) {
    if (refreshTimer) { window.clearInterval(refreshTimer); refreshTimer = 0 }
    return
  }

  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_DISPLAY_MS) {
    await delay(MIN_DISPLAY_MS - elapsed)
  }
  if (refreshTimer) {
    window.clearInterval(refreshTimer)
    refreshTimer = 0
  }
  screen.finishDisplay()
  await delay(SETTLE_MS)
  updateStep('display', 'done', '显色完成')
  guideScreen.value = 'done'
}

interface PackedResult {
  packed: Uint8Array
  /** 模拟屏用的显示图地址（正向结果，不含安装补偿）。 */
  displayThumb: string
}

async function buildPacked(item: QueueItem, profile: DeviceProfile, snapshot = false): Promise<PackedResult | null> {
  const saved = snapshot ? item : appStore.queue.find(entry => entry.id === item.id) ?? item
  // 固定本次使用的参数，预览的异步更新不能改写进行中的刷图方向。
  const current = { ...saved, options: { ...saved.options } }
  const { width, height } = profile
  const spec: TargetSpec = { family: profile.family, width, height, profile }
  const displayKey = processedCache.key(current.id, spec, current.options)
  const uploadKey = processedCache.key(current.id, spec, current.options, FLASH_ROTATION)
  appStore.log('info', `图像方向 v5：编辑 ${current.options.rotation}°，仅发送补偿 180°`)
  try {
    const canvas = uploadCanvas.value
    if (!canvas) {
      throw new Error('上传画布未就绪')
    }
    const uploadCache = processedCache.get(uploadKey)
    const displayCache = processedCache.get(displayKey)
    let packed = uploadCache?.packed
    let displayPreview = uploadCache?.displayPreview ?? displayCache?.preview
    if (!displayPreview && displayCache?.codes) {
      displayPreview = buildPreview(displayCache.codes, targetPalette(spec, current.options), width, height)
    }
    if (!packed || !displayPreview) {
      const displayRgb = await renderToRgbAdjusted(canvas, current.path, width, height, current.options)
      if (!displayPreview) {
        const display = await prepareForTarget(displayRgb, width, height, spec, current.options, { skipPacked: true })
        if (!display?.preview) {
          throw new Error('正向预览生成失败')
        }
        displayPreview = display.preview
      }
      if (!packed) {
        // 唯一的硬件安装补偿：仅复制并翻转发送像素，不改 displayRgb / displayPreview。
        const wire = await prepareForTarget(flipRgb180(displayRgb), width, height, spec, current.options, {
          skipPreview: true,
        })
        if (!wire?.packed) {
          throw new Error('上传点阵生成失败')
        }
        packed = wire.packed
        processedCache.set(uploadKey, { codes: wire.codes, packed, displayPreview, width, height })
      } else if (uploadCache) {
        processedCache.set(uploadKey, { ...uploadCache, displayPreview })
      }
    }
    appStore.updateItem(current.id, { packed, status: 'ready' })
    // 图像处理后的点阵有多大：刷图出问题时先看这一行，
    // 再对下面的「传屏数据」行，就能知道是处理得不对还是传得不对。
    const pixels = width * height
    const source = current.sourceWidth && current.sourceHeight
      ? `原图 ${current.sourceWidth}×${current.sourceHeight} → `
      : ''
    appStore.log(
      'info',
      `图像处理：${source}屏幕 ${width}×${height}（${profile.colorCount} 色），` +
        `点阵 ${formatBytes(packed.length)} 字节` +
        (pixels > 0 ? `（每像素 ${((packed.length * 8) / pixels).toFixed(0)} bit）` : ''),
    )
    // 导出的就是正向结果，不添加安装旋转，不使用传输位图。
    const blob = await exportThumbnail(canvas, displayPreview, width, height, width)
    guideThumb.value = URL.createObjectURL(blob)
    return { packed, displayThumb: guideThumb.value }
  } catch (error) {
    appStore.updateItem(current.id, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    appStore.log('error', `处理「${current.name}」失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function switchGuideImage(index: number): void {
  if (testRunning.value) return
  const total = selectedItems.value.length
  if (!total) {
    return
  }
  const next = Math.max(0, Math.min(index, total - 1))
  if (next === guideIndex.value) {
    return
  }
  guideIndex.value = next
  guideScreen.value = 'idle'
  guidePhase.value = 'idle'
  guideNote.value = ''
  progressText.value = ''
  progress.value = 0
  guideBlockDone.value = 0
  guideBlockFilled.value = 0
  guidePacketCurrent.value = 0
  guidePacketTotal.value = 0
  guidePrimaryText.value = primaryText('idle', total, next)
  screen.reset()
}

function flashNext(): void {
  const total = selectedItems.value.length
  if (guideIndex.value >= total - 1) {
    showToast('已经是最后一张')
    return
  }
  switchGuideImage(guideIndex.value + 1)
}

/** 预览渲染的降分辨率档。 */
function previewRenderSize(width: number, height: number, scale: number): { width: number; height: number } {
  if (scale >= 1) {
    return { width, height }
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function buildBlockCells(total: number): number[] {
  const count = Math.max(1, Math.min(BLOCK_CELLS_MAX, total))
  const cells: number[] = []
  for (let index = 1; index <= count; index += 1) {
    cells.push(index)
  }
  return cells
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

watch(activeTab, tab => {
  // 当前分区写回地址栏，刷新后停在原处；别的页面也能直接指定分区。
  if (route.query.tab !== tab) {
    void router.replace({ path: '/eink', query: { ...route.query, tab } })
  }
  // 画布元素随标签页切换而重建，必须等 DOM 更新完再拿引用。
  void nextTick().then(() => {
    if (tab === 'process') {
      schedulePreview('full')
    }
    if (tab === 'guide') {
      void attachScreen().catch(() => undefined)
    }
  })
})

// 地址栏带 ?tab= 时按它切分区：画板 / 火车票导出后跳回队列就是这么来的。
watch(
  () => route.query.tab,
  tab => {
    if (typeof tab === 'string' && TABS.includes(tab as Tab)) {
      activeTab.value = tab as Tab
    }
  },
  { immediate: true },
)

// 带 ?added=1 进来说明刚有图进了队列，提示一下再把参数清掉。
watch(
  () => route.query.added,
  added => {
    if (added === '1') {
      showToast('已加入队列', 'success')
      void router.replace({ path: '/eink', query: { tab: activeTab.value } })
    }
  },
  { immediate: true },
)

watch(guideIndex, () => {
  const total = selectedItems.value.length
  guidePrimaryText.value = primaryText(guidePhase.value, total, guideIndex.value)
})

onMounted(() => {
  syncQueue()
  unsubStore = appStore.subscribe(() => {
    syncQueue()
  })
  document.addEventListener('visibilitychange', onVisibility)
})

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    resumeKeepScreenOn()
  }
}

onBeforeUnmount(() => {
  cancelHold()
  testController?.abort()
  if (previewTimer) {
    window.clearTimeout(previewTimer)
    previewTimer = 0
  }
  if (refreshTimer) {
    window.clearInterval(refreshTimer)
    refreshTimer = 0
  }
  if (previewCancel) {
    previewCancel.cancelled = true
  }
  screen.destroy()
  unsubStore?.()
  document.removeEventListener('visibilitychange', onVisibility)
  setKeepScreenOn(false)
})
</script>

<template>
  <div class="page eink-page">
    <main class="shell">
      <NavBar title="墨水屏刷图" subtitle="图片处理与刷入">
        <template #right>
          <button class="tool-entry" @click="tutorialOpen = true">刷图教程</button>
          <button class="tool-entry" @click="toolsOpen = true">图片制作</button>
          <BlePill compact @click="router.push('/connect')" />
        </template>
      </NavBar>

      <!-- 二级菜单 -->
      <div class="submenu">
        <button class="submenu-item" :disabled="testRunning" :class="{ active: activeTab === 'queue' }" @click="activeTab = 'queue'">
          <svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 16l5-4 4 3 3-2 6 4" />
          </svg>
          图片队列
        </button>
        <button class="submenu-item" :disabled="testRunning" :class="{ active: activeTab === 'process' }" @click="activeTab = 'process'">
          <svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="17" r="2" />
          </svg>
          图像处理
        </button>
        <button class="submenu-item" :disabled="testRunning" :class="{ active: activeTab === 'guide' }" @click="activeTab = 'guide'">
          <svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3l9 5-9 5-9-5 9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
          刷图引导
        </button>
      </div>


      <!-- 图像处理：预览 + 参数，两列并排 -->
      <div v-if="activeTab === 'process'" class="split process-split">
        <div class="process-left">
          <div class="section-head">
            <div class="section-left">
              <span class="section-index">02</span>
              <span class="section-title">图像处理</span>
            </div>
            <span class="section-aside">逐张调整</span>
          </div>

          <div v-if="!processItems.length" class="card card-pad">
            <div class="queue-empty">
              <div class="empty-icon">图像处理</div>
              <div class="empty-title">还没有选中的图片</div>
              <div class="empty-desc">在「图片队列」里勾选要处理的图片</div>
            </div>
          </div>

          <template v-else>
            <div class="strip-scroll">
              <button
                v-for="item in processItems"
                :key="item.id"
                class="strip-item"
                :class="{ on: item.id === currentId }"
                @click="selectCurrent(item.id)"
              >
                <img class="strip-img" :src="item.thumb || item.path" :alt="item.name" />
                <div class="strip-name">{{ item.name }}</div>
                <div class="strip-tag">{{ presetLabel(item) }}</div>
              </button>
            </div>

            <div class="preview-frame">
              <canvas ref="previewCanvas" class="preview-canvas" />
              <div v-if="previewBusy" class="preview-scan" />
              <div v-if="previewBusy" class="preview-badge">{{ previewProgress }}%</div>
            </div>
            <div class="preview-info">{{ previewInfo }}</div>
          </template>
        </div>
        <div class="process-right">
          <div v-if="processItems.length" class="card card-pad control-card">
              <div class="control-group">
                <div class="control-title">预设效果</div>
                <div class="preset-grid">
                  <button
                    v-for="preset in IMAGE_PRESETS"
                    :key="preset.id"
                    class="preset-chip"
                    :class="{ on: activePresetId === preset.id }"
                    @click="applyPreset(preset.id)"
                  >
                    <span class="preset-name">{{ preset.name }}</span>
                    <span class="preset-desc">{{ preset.desc }}</span>
                  </button>
                </div>
              </div>

              <div class="control-group">
                <div class="control-title">色彩处理</div>
                <div class="segment">
                  <button
                    v-for="item in ALGORITHM_OPTIONS"
                    :key="item.value"
                    class="segment-item"
                    :class="{ on: options.algorithm === item.value }"
                    @click="applyOptions({ algorithm: item.value })"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </div>

              <div class="control-group">
              <div class="control-title">适配方式</div>
              <div class="opt-grid">
                <button
                  v-for="item in FIT_OPTIONS"
                  :key="item.value"
                  class="opt-chip"
                  :class="{ on: options.fit === item.value }"
                  @click="applyOptions({ fit: item.value })"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>

            <div class="control-group">
              <div class="control-head">
                <span class="control-title">旋转</span>
                <button v-if="options.rotation !== 0" class="link muted" @click="resetRotation">方向归零</button>
              </div>
              <div class="opt-grid">
                <button
                  v-for="item in ROTATION_OPTIONS"
                  :key="item.value"
                  class="opt-chip"
                  :class="{ on: options.rotation === item.value }"
                  @click="applyOptions({ rotation: item.value })"
                >
                  {{ item.label }}
                </button>
              </div>
              <div class="direction-hint">预览按所选角度显示；仅发送数据额外旋转 180°，适配倒装屏幕。</div>
            </div>

              <div class="control-group">
                <div class="slider-head">
                  <span class="slider-label">亮度</span>
                  <span class="slider-value">{{ options.brightness.toFixed(2) }}</span>
                </div>
                <input
                  class="d4u-slider"
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  :value="options.brightness"
                  @input="applyOptions({ brightness: Number(($event.target as HTMLInputElement).value) })"
                  @change="applyOptions({ brightness: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="control-group">
                <div class="slider-head">
                  <span class="slider-label">对比度</span>
                  <span class="slider-value">{{ options.contrast.toFixed(2) }}</span>
                </div>
                <input
                  class="d4u-slider"
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  :value="options.contrast"
                  @input="applyOptions({ contrast: Number(($event.target as HTMLInputElement).value) })"
                  @change="applyOptions({ contrast: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="control-group">
                <div class="slider-head">
                  <span class="slider-label">饱和度</span>
                  <span class="slider-value">{{ options.saturation.toFixed(2) }}</span>
                </div>
                <input
                  class="d4u-slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  :value="options.saturation"
                  @input="applyOptions({ saturation: Number(($event.target as HTMLInputElement).value) })"
                  @change="applyOptions({ saturation: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="control-group">
                <div class="slider-head">
                  <span class="slider-label">缩放</span>
                  <span class="slider-value">{{ options.scale }}%</span>
                </div>
                <input
                  class="d4u-slider"
                  type="range"
                  min="10"
                  max="300"
                  step="5"
                  :value="options.scale"
                  @input="applyOptions({ scale: Number(($event.target as HTMLInputElement).value) })"
                  @change="applyOptions({ scale: Number(($event.target as HTMLInputElement).value) })"
                />
              </div>

              <div class="switch-row">
                <span class="slider-label">黑白模式</span>
                <button
                  class="switch"
                  :class="{ on: options.blackWhite }"
                  role="switch"
                  :aria-checked="options.blackWhite"
                  @click="applyOptions({ blackWhite: !options.blackWhite })"
                />
              </div>

              <button class="btn btn-primary btn-block" @click="applyToAll">同步到全部已选图片</button>
          </div>
        </div>
      </div>

      <!-- 队列 / 刷图引导：主区 + 常驻右栏 -->
      <div v-else class="workbench">
        <div class="workbench-main">
          <section v-if="activeTab === 'queue'" class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">01</span>
                <span class="section-title">图片队列</span>
                <span class="count">{{ selectedItems.length }}</span>
              </div>
            </div>

            <div class="card card-pad">
              <div class="queue-head">
                <span class="queue-title">待刷入 · {{ selectedItems.length }} 张 / 共 {{ queue.length }} 张</span>
                <button class="link muted" @click="clearQueue">清空</button>
              </div>
              <div class="queue-sub">还可添加 {{ remaining }} 张</div>

              <div v-if="!queue.length" class="queue-empty">
                <div class="empty-icon">图片队列</div>
                <div class="empty-title">还没有待刷入的图片</div>
                <div class="empty-desc">一次最多可选 {{ MAX_PICK }} 张，可多次累加，最多 {{ MAX_QUEUE }} 张</div>
                <button class="btn btn-primary btn-sm queue-empty-btn" @click="addImages">选择图片</button>
                <button class="link" @click="tutorialOpen = true">第一次刷图？观看操作教程</button>
              </div>

              <div v-for="item in queue" :key="item.id" class="queue-item" @click="toggleItem(item)">
                <div class="qthumb" :class="{ on: item.selected }">
                  <img :src="item.thumb || item.path" :alt="item.name" />
                  <span class="check" :class="{ on: item.selected }">{{ item.selected ? '✓' : '' }}</span>
                  <span v-if="item.status === 'done'" class="thumb-badge">已刷</span>
                  <span v-else-if="item.status === 'error'" class="thumb-badge err">失败</span>
                </div>
                <div class="queue-body">
                  <div class="queue-name">{{ item.name }}</div>
                  <div class="queue-meta">{{ item.sourceWidth }} × {{ item.sourceHeight }} · {{ presetLabel(item) }}</div>
                </div>
                <button class="qremove" @click.stop="removeItem(item)">×</button>
              </div>

              <button v-if="queue.length" class="queue-add" @click="addImages">＋ 添加图片</button>
            </div>
          </section>

          <section v-if="activeTab === 'guide'" class="section guide-section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">03</span>
                <span class="section-title">刷图引导</span>
              </div>
              <span class="section-aside">刷图流程</span>
            </div>

            <div v-if="profileText" class="profile-line">{{ profileText }}</div>

            <div class="gsteps">
              <div
                v-for="(step, index) in steps"
                :key="step.key"
                class="gstep"
                :class="{ active: step.status === 'active', done: step.status === 'done', error: step.status === 'error' }"
              >
                <span v-if="index < steps.length - 1" class="gstep-line" />
                <div class="gstep-dot">{{ step.status === 'done' ? '✓' : step.status === 'error' ? '×' : index + 1 }}</div>
                <div class="gstep-label">{{ step.label }}</div>
              </div>
            </div>
            <div class="gstep-note">{{ guideNote }}</div>

            <div class="guide-layout">
              <div class="guide-screen">
                <div class="epd-frame">
                  <canvas ref="epdCanvas" class="epd-canvas" />
                  <div v-if="guideScreen === 'transfer'" class="epd-badge">
                    <i />
                    {{ guideBlockDone }} / {{ guideBlockTotal }}
                  </div>
                </div>
              </div>
            </div>

            <div v-if="selectedItems.length" class="strip-scroll gstrip">
              <button
                v-for="(item, index) in selectedItems"
                :key="item.id"
                class="strip-item"
                :class="{ on: index === guideIndex }"
                @click="switchGuideImage(index)"
              >
                <img class="strip-img" :src="item.thumb || item.path" :alt="item.name" />
                <span class="gstrip-dot" :class="item.status" />
              </button>
            </div>
            <div class="guide-actions">
              <button class="btn btn-primary btn-block" :disabled="!guideItem || guidePhase === 'working' || testRunning" @pointerdown="beginHold" @pointerup="cancelHold" @pointerleave="cancelHold" @pointercancel="cancelHold" @contextmenu.prevent @click="clickFlash">
                {{ guidePrimaryText }}
              </button>
              <button
                v-if="guidePhase === 'waiting'"
                class="link guide-retry"
                :disabled="testRunning"
                @pointerdown="beginHold" @pointerup="cancelHold" @pointerleave="cancelHold" @pointercancel="cancelHold" @contextmenu.prevent
                @click="clickFlash"
              >
                重刷这张
              </button>
            </div>

            <div v-if="testRunning" class="test-status">
              <span>{{ testMessage }}</span><button class="link" @click="testOpen = true">测试详情</button>
              <button class="link" :disabled="testStopping" @click="stopTest">{{ testStopping ? '停止中' : '停止测试' }}</button>
            </div>
            <div class="guide-hint guide-foot">
              刷完一张会停在等待状态，由你手动选择下一张；点缩略图可先切换目标图片。
            </div>
            <div v-if="statusHint" class="status-hint">{{ statusHint }}</div>
          </section>

        </div>

        <aside class="workbench-aside scroll">
            <div v-if="activeTab === 'queue'" class="card card-pad aside-card">
              <div class="control-title">队列操作</div>
              <div class="kv">
                <span class="k">已选</span><span class="v">{{ selectedItems.length }} 张</span>
              </div>
              <div class="kv">
                <span class="k">队列</span><span class="v">{{ queue.length }} 张</span>
              </div>
              <div class="kv">
                <span class="k">还可添加</span><span class="v">{{ remaining }} 张</span>
              </div>
              <div class="aside-actions">
                <button class="btn btn-ghost btn-sm" @click="selectAll">全选</button>
                <button class="btn btn-primary btn-sm" @click="addImages">＋ 添加图片</button>
              </div>
            </div>

            <template v-if="activeTab === 'guide'">
              <div class="card card-pad guide-card">
            <div class="guide-side">
              <div class="guide-side-title">图片队列</div>
              <div class="guide-side-index">{{ selectedItems.length ? `第 ${guideIndex + 1} / ${selectedItems.length} 张` : '暂无已选图片' }}</div>
              <div class="guide-side-name">{{ guideName }}</div>
              <div class="guide-nav">
                <button class="btn btn-ghost btn-sm" :disabled="!guideHasPrev" @click="switchGuideImage(guideIndex - 1)">
                  ‹ 上一张
                </button>
                <button class="btn btn-ghost btn-sm" :disabled="!guideHasNext" @click="flashNext">下一张 ›</button>
              </div>
            </div>
              </div>
              <div class="card card-pad xfer-card">
            <div class="xfer-head">
              <span class="xfer-stage">{{ progressText || '等待开始' }}</span>
              <span class="xfer-num">{{ progress }}%</span>
            </div>
            <div class="progress-wrap">
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${progress}%` }">
                  <span class="progress-shine" />
                </div>
              </div>
            </div>
            <div class="bcells">
              <i
                v-for="cell in guideBlockCells"
                :key="cell"
                class="bcell"
                :class="{ on: cell <= guideBlockFilled }"
              />
            </div>
            <div class="xfer-foot">
              <span>块 {{ guideBlockDone }} / {{ guideBlockTotal }}</span>
              <span>包 {{ guidePacketCurrent }} / {{ guidePacketTotal }}</span>
            </div>
              </div>
            </template>
        </aside>
      </div>

      <!-- 隐藏画布：始终存在，图像处理时用它做中间缓冲 -->
      <EinkTutorial :open="tutorialOpen" @close="tutorialOpen = false" @start="tutorialOpen = false; activeTab = 'queue'" />
      <ModalPanel :open="testOpen" title="测试模式" :width="720" @close="testOpen = false">
        <p class="test-note">{{ testItem?.name }} · 固定使用打开配置时的图片与参数。成功计一轮，失败重试本轮，直到成功或手动停止。</p>
        <div class="test-fields">
          <label>刷图轮数<input v-model.number="testConfig.rounds" class="input" type="number" min="1" max="10000" step="1" :disabled="testRunning" /></label>
          <label>轮间等待（秒）<input v-model.number="testConfig.intervalSeconds" class="input" type="number" min="0" max="86400" :disabled="testRunning" /></label>
          <label>失败后等待（秒）<input v-model.number="testConfig.retrySeconds" class="input" type="number" min="0" max="86400" :disabled="testRunning" /></label>
        </div>
        <p class="test-note">{{ testMessage || '等待开始' }}</p>
        <div class="test-buttons">
          <button v-if="!testRunning" class="btn btn-primary btn-sm" @click="startTest">开始测试</button>
          <button v-else class="btn btn-dark btn-sm" :disabled="testStopping" @click="stopTest">{{ testStopping ? '等待当前刷图结束…' : '停止测试' }}</button>
          <button class="btn btn-ghost btn-sm" :disabled="!testLogs.length" @click="exportTestLogs">导出日志</button>
          <button class="btn btn-ghost btn-sm" :disabled="!testLogs.length || testRunning" @click="clearTestLogs">清除日志</button>
        </div>
        <p class="test-note">日志保存在当前浏览器，最多保留最近 1000 条。成功率按刷图尝试计算；每轮耗时包含失败重试与等待时间。停止会等待正在进行的刷图结束。</p>
        <p v-if="logStorageError" class="text-danger">{{ logStorageError }}</p>
        <div v-if="testRunSummaries.length" class="test-runs" role="log" aria-label="测试模式运行记录">
          <section v-for="run in testRunSummaries" :key="run.runId" class="test-run">
            <header class="test-run-head">
              <div><strong>{{ run.image }}</strong><span>{{ new Date(run.startedAt).toLocaleString() }}</span></div>
              <b>{{ run.status }}</b>
            </header>
            <div class="test-run-meta">总耗时 {{ formatTestDuration(run.durationMs) }} · 成功轮数 {{ run.successes }} / {{ run.rounds || '未知' }}</div>
            <div class="test-run-stats">
              <div><strong>{{ run.successes }}</strong><span>成功尝试</span></div>
              <div><strong>{{ run.failures }}</strong><span>失败尝试</span></div>
              <div><strong>{{ run.attempts }}</strong><span>总尝试</span></div>
              <div><strong>{{ run.successRate }}%</strong><span>尝试成功率</span></div>
            </div>
            <div v-if="run.roundsDetail.length" class="test-rounds">
              <div v-for="round in run.roundsDetail" :key="round.round" class="test-round">
                <strong>第 {{ round.round }} 轮 · {{ round.status }}</strong>
                <span>{{ formatTestDuration(round.durationMs) }} · {{ round.attempts }} 次尝试 · {{ round.failures }} 次失败</span>
              </div>
            </div>
            <details class="test-run-events">
              <summary>过程日志（{{ run.entries.length }} 条）</summary>
              <div v-for="(entry, index) in run.entries.slice(-30).reverse()" :key="`${run.runId}-${index}`">
                {{ entry.time }} · 第 {{ entry.round }} 轮 / 第 {{ entry.attempt }} 次 · {{ entry.message }}
              </div>
            </details>
          </section>
        </div>
        <div v-else class="test-log-empty">暂无测试记录</div>
      </ModalPanel>
      <canvas ref="workCanvas" class="work-canvas" />
      <canvas ref="uploadCanvas" class="work-canvas" />

      <!-- 图片制作：画板与火车票是刷图的子工具 -->
      <ModalPanel :open="toolsOpen" title="图片制作" :width="820" @close="toolsOpen = false">
        <div class="tools-grid">
              <button class="tool-card tool-card-big" @click="goTool('/draw')">
                <div class="tool-card-glyph">
                  <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="#14161a" stroke-width="2.2">
                    <path d="M6 24c4-10 10-16 20-16-2 10-8 16-20 16z" />
                    <path d="M10 20c4-4 8-7 13-9" />
                  </svg>
                </div>
                <div>
                  <div class="tool-card-title">画板</div>
                  <div class="tool-card-desc">手绘、写文字、插图片</div>
                </div>
                <span class="tool-chevron">›</span>
              </button>
              <button class="tool-card tool-card-big" @click="goTool('/ticket')">
                <div class="tool-card-glyph">
                  <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="#14161a" stroke-width="2.2">
                    <rect x="4" y="9" width="24" height="15" rx="3" />
                    <path d="M8 14h6M8 19h12" stroke-dasharray="2 2" />
                  </svg>
                </div>
                <div>
                  <div class="tool-card-title">火车票生成</div>
                  <div class="tool-card-desc">票面信息都能改，能存条目</div>
                </div>
                <span class="tool-chevron">›</span>
              </button>
        </div>
      </ModalPanel>
    </main>
  </div>
</template>

<style scoped>
.test-fields { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; }
.test-fields label { font-size: 12px; color: var(--ink-70); }.test-fields input { margin-top: 8px; }
.test-note { font-size: 12px; line-height: 1.7; color: var(--ink-70); }
.test-buttons, .test-status { display: flex; align-items: center; gap: 12px; }.test-status { flex-wrap: wrap; font-size: 11px; padding-top: 8px; }
.test-runs { display: flex; flex-direction: column; gap: 10px; max-height: 420px; overflow: auto; padding-right: 3px; }
.test-run { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: #f5f8f5; }
.test-run-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.test-run-head > div { display: grid; gap: 3px; min-width: 0; }
.test-run-head strong { overflow-wrap: anywhere; }
.test-run-head span, .test-run-meta { color: var(--ink-45); font-size: 11px; }
.test-run-head b { flex: none; font-size: 11px; color: var(--olive); }
.test-run-meta { margin-top: 5px; }
.test-run-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.test-run-stats > div { display: grid; gap: 2px; padding: 8px; border-radius: 8px; background: #fff; }
.test-run-stats strong { font-size: 18px; line-height: 1.1; }
.test-run-stats small { color: var(--ink-45); font-size: 11px; font-weight: 500; }
.test-run-stats span, .test-round { color: var(--ink-45); font-size: 10px; }
.test-rounds { display: grid; gap: 5px; margin-top: 9px; }
.test-round { display: flex; justify-content: space-between; gap: 12px; padding: 5px 7px; border-radius: 6px; background: #fff; }
.test-round strong { color: var(--ink); font-size: 10px; }
.test-run-events { margin-top: 8px; color: var(--ink-45); font: 10px/1.8 var(--mono); overflow-wrap: anywhere; }
.test-run-events summary { cursor: pointer; font: 11px/1.6 var(--sans); }
.test-run-events > div { margin-top: 4px; }
.test-log-empty { padding: 18px; border-radius: 10px; background: #eaf0eb; color: var(--ink-45); text-align: center; font-size: 12px; }

.tool-chevron {
  font-size: 26px;
  color: var(--ink-45);
}

.queue-sub {
  font-size: 16px;
  color: var(--ink-45);
  margin-bottom: 6px;
}

.queue-body {
  flex: 1;
  min-width: 0;
}

.queue-name {
  font-size: 19px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-meta {
  font-size: 16px;
  color: var(--ink-45);
  margin-top: 2px;
}

.queue-empty-btn {
  margin-top: 16px;
}

.preview-info {
  font-size: 16px;
  color: var(--ink-45);
  margin-top: 9px;
  line-height: 1.6;
}

.control-card {
  margin-top: 0;
}

.aside-card {
  display: block;
}

.aside-actions {
  display: flex;
  gap: 11px;
  margin-top: 14px;
}

.aside-actions .btn {
  flex: 1;
}

.guide-card {
  display: block;
}

/* 图像处理分区：预览与参数并排，与工作区边缘对齐。 */
.process-split {
  grid-template-columns: minmax(0, 1fr) minmax(340px, 0.95fr);
  align-items: start;
}

.process-left,
.process-right {
  min-width: 0;
}

.process-right {
  position: sticky;
  top: 24px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

/* 预览别铺满：图太大反而看不清细节，限宽后与右侧参数等宽 */
.process-left .strip-scroll,
.process-left .preview-frame,
.process-left .preview-info {
  max-width: 460px;
  margin-left: auto;
  margin-right: auto;
}

/* 预设：两列网格，每格都带说明，不用横向滚动 */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

/* 适配 / 旋转：小方块按钮，两列 */
.opt-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.opt-chip {
  height: 46px;
  border-radius: 13px;
  border: 1px solid var(--line);
  background: var(--paper);
  color: var(--ink-70);
  font-family: inherit;
  font-size: 17px;
  cursor: pointer;
  padding: 0 10px;
}

.opt-chip.on {
  background: var(--lime);
  border-color: var(--lime-deep);
  color: var(--ink);
  font-weight: 600;
}

/* 图片制作模态框 */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.tool-card-big {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 18px;
  gap: 14px;
}

.tool-card-big:hover {
  border-color: var(--lime-deep);
}

.control-group {
  margin-bottom: 20px;
}

.control-title {
  font-size: 18px;
  color: var(--ink-70);
  margin-bottom: 9px;
  display: block;
}

.control-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.preset-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 16px;
  border-radius: 14px;
  background: var(--paper);
  border: none;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  flex: none;
}

.preset-chip.on {
  background: var(--ink);
  color: #fff;
}

.preset-name {
  font-size: 18px;
  font-weight: 600;
}

.preset-desc {
  font-size: 15px;
  opacity: 0.66;
}

.direction-hint {
  font-size: 16px;
  color: var(--ink-45);
  margin-top: 8px;
  line-height: 1.6;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.guide-layout {
  display: flex;
  gap: 16px;
  margin-top: 18px;
  align-items: flex-start;
  justify-content: center;
}

.guide-screen {
  flex: none;
  width: 440px;
}

.guide-side {
  flex: 1;
  min-width: 0;
  padding-top: 6px;
}

.guide-side-title {
  font-size: 18px;
  color: var(--ink-45);
}

.guide-side-index {
  font-size: 21px;
  font-weight: 600;
  margin-top: 6px;
}

.guide-side-name {
  font-size: 17px;
  color: var(--ink-45);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guide-nav {
  display: flex;
  gap: 9px;
  margin-top: 14px;
}

.guide-nav .btn {
  flex: 1;
}

.gstrip {
  margin-top: 16px;
}

.gstrip-dot {
  position: absolute;
  left: 8px;
  bottom: 8px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ink-25);
}

.gstrip-dot.ready {
  background: var(--olive);
}

.gstrip-dot.flashing {
  background: var(--lime);
}

.gstrip-dot.done {
  background: var(--olive);
  box-shadow: 0 0 0 2px #fff;
}

.gstrip-dot.error {
  background: var(--danger);
}

.strip-item {
  position: relative;
}

.xfer-card {
  margin-top: 0;
}

.bcells {
  margin-top: 11px;
}

.guide-actions {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.guide-retry {
  margin: 11px 0 0;
}

.guide-foot {
  margin-top: 14px;
  text-align: center;
}

.work-canvas {
  position: fixed;
  left: 0;
  top: 0;
  width: 2px;
  height: 2px;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
}

@media (max-width: 640px) {
  .guide-layout {
    flex-direction: column;
  }
  .guide-screen {
    width: 100%;
  }
}
.gstep.error .gstep-dot { background: #f2e0db; color: #a45442; border-color: #d9b8ae; }
</style>
