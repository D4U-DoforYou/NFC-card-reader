<script setup lang="ts">
/**
 * 火车票生成：所有票面信息都可编辑，可保存成条目随时取用，成图后进待刷队列。
 *
 * 小程序版用选择器查询拿画布节点，网页端直接用模板引用取 canvas。
 * 其余流程（画布尺寸、旋转出图、条目存取、提示文案）与小程序版一一对应。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import { showToast, showModal, showLoading, hideLoading } from '@/platform/ui'
import { getStorageSync, setStorageSync } from '@/platform/storage'
import { addImageToQueue, exportCanvas } from '@/core/make/queue'
import { encodeQr } from '@/core/make/qr'
import type { QrCode } from '@/core/make/qr'
import {
  TICKET_HEIGHT,
  TICKET_WIDTH,
  defaultTicketFields,
  renderTicket,
} from '@/core/make/ticket'
import type { TicketContext, TicketFields } from '@/core/make/ticket'
import { appStore } from '@/core/store/index'

/** 保存条目的本地存储键。 */
const router = useRouter()

const ENTRY_STORAGE_KEY = 'd4u_ticket_entries'

/** 导出到队列的尺寸，恒为墨水屏的 552×768。 */
const OUTPUT_WIDTH = 552
const OUTPUT_HEIGHT = 768

/** 一条保存下来的票。 */
interface TicketEntry {
  id: string
  name: string
  fields: TicketFields
  updatedAt: number
}

/** 表单里的一个字段。 */
interface FieldDef {
  key: keyof TicketFields
  label: string
}

/**
 * 票面信息表的排布：一行放两个字段的是两列，放一个的是整行。
 *
 * 顺序与小程序版一致：票号、检票口、出发站、拼音、到达站、拼音、车次、席别、
 * 日期、时间、车厢、座位、票价、渠道、检票状态、开车、证件号、乘车人、提示语、
 * 祝福语、二维码内容、底部编码、发售站。
 */
const ROWS: FieldDef[][] = [
  [
    { key: 'ticketNo', label: '票号' },
    { key: 'gate', label: '检票口' },
  ],
  [
    { key: 'fromStation', label: '出发站' },
    { key: 'fromPinyin', label: '拼音' },
  ],
  [
    { key: 'toStation', label: '到达站' },
    { key: 'toPinyin', label: '拼音' },
  ],
  [
    { key: 'trainNo', label: '车次' },
    { key: 'seatClass', label: '席别' },
  ],
  [
    { key: 'date', label: '日期' },
    { key: 'time', label: '时间' },
  ],
  [
    { key: 'carriage', label: '车厢' },
    { key: 'seat', label: '座位' },
  ],
  [
    { key: 'price', label: '票价' },
    { key: 'channel', label: '渠道' },
  ],
  [
    { key: 'checked', label: '检票状态' },
    { key: 'departLabel', label: '开车' },
  ],
  [{ key: 'idNumber', label: '证件号' }],
  [{ key: 'passenger', label: '乘车人' }],
  [{ key: 'slogan', label: '提示语' }],
  [{ key: 'wish', label: '祝福语' }],
  [{ key: 'qrContent', label: '二维码内容' }],
  [
    { key: 'bottomCode', label: '底部编码' },
    { key: 'bottomOffice', label: '发售站' },
  ],
]

/** 当前票面字段。 */
const fields = ref<TicketFields>(defaultTicketFields())
/** 保存的条目。 */
const entries = ref<TicketEntry[]>([])
/** 当前条目的名字。 */
const entryName = ref('新建车票')
/** 当前选中的条目 id，空表示是新建的。 */
const entryId = ref('')
/** 二维码内容过长时提示。 */
const qrHint = ref('')
const busy = ref(false)

/** 票面预览画布。 */
const canvasRef = ref<HTMLCanvasElement | null>(null)

/** 重画定时器。 */
let renderTimer = 0

/** 取画布上下文；浏览器里的 2D 上下文比小程序多不少方法，取用到的子集即可。 */
function getContext(): TicketContext | null {
  const canvas = canvasRef.value
  if (!canvas) {
    return null
  }
  const ctx = canvas.getContext('2d')
  return ctx ? (ctx as unknown as TicketContext) : null
}

/** 绑定画布。 */
function attachCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas) {
    return
  }
  if (canvas.width !== TICKET_WIDTH) {
    canvas.width = TICKET_WIDTH
  }
  if (canvas.height !== TICKET_HEIGHT) {
    canvas.height = TICKET_HEIGHT
  }
  render()
}

/** 重画票面。 */
function render(): void {
  const ctx = getContext()
  if (!ctx) {
    return
  }
  const qr = buildQr(fields.value.qrContent)
  renderTicket(ctx, fields.value, qr ? qr.modules : null)
}

/**
 * 生成二维码。
 *
 * 内容太长会超出二维码容量，这时给提示并先画空框，别让整页报错。
 */
function buildQr(content: string): QrCode | null {
  const text = (content || '').trim()
  if (!text) {
    qrHint.value = '二维码内容为空'
    return null
  }
  try {
    const qr = encodeQr(text, 'M')
    qrHint.value = ''
    return qr
  } catch {
    qrHint.value = '二维码内容太长，超出容量'
    return null
  }
}

/** 改一个字段。 */
function onFieldInput(key: keyof TicketFields, event: Event): void {
  const target = event.target as HTMLInputElement | null
  const value = target ? target.value : ''
  fields.value = { ...fields.value, [key]: value }
  scheduleRender()
}

/** 合并输入，避免每敲一个字就重画一次。 */
function scheduleRender(): void {
  if (renderTimer) {
    window.clearTimeout(renderTimer)
  }
  renderTimer = window.setTimeout(() => {
    renderTimer = 0
    render()
  }, 120)
}

// ---------------- 条目 ----------------

/** 读出保存的条目。 */
function loadEntries(): void {
  try {
    const saved = getStorageSync(ENTRY_STORAGE_KEY)
    entries.value = Array.isArray(saved) ? (saved as TicketEntry[]) : []
  } catch {
    entries.value = []
  }
}

/** 写入条目。 */
function saveEntries(list: TicketEntry[]): void {
  try {
    setStorageSync(ENTRY_STORAGE_KEY, list)
    entries.value = list
  } catch {
    showToast('保存失败')
  }
}

/** 切换到某个条目。 */
function pickEntry(id: string): void {
  const entry = entries.value.find(item => item.id === id)
  if (!entry) {
    return
  }
  entryId.value = entry.id
  entryName.value = entry.name
  fields.value = { ...entry.fields }
  render()
}

/** 新建一张空票。 */
function newEntry(): void {
  entryId.value = ''
  entryName.value = '新建车票'
  fields.value = defaultTicketFields()
  render()
}

/** 保存当前票。 */
function saveEntry(): void {
  const name = (entryName.value || '').trim() || '未命名车票'
  const snapshot: TicketFields = { ...fields.value }
  const list = [...entries.value]
  const id = entryId.value
  const now = Date.now()
  if (id) {
    const index = list.findIndex(item => item.id === id)
    if (index >= 0) {
      list[index] = { id, name, fields: snapshot, updatedAt: now }
    }
  } else {
    const newId = `ticket-${now}`
    list.unshift({ id: newId, name, fields: snapshot, updatedAt: now })
    entryId.value = newId
  }
  saveEntries(list)
  entryName.value = name
  showToast('已保存', 'success')
}

/** 删除当前条目。 */
async function deleteEntry(): Promise<void> {
  const id = entryId.value
  if (!id) {
    showToast('这张还没保存')
    return
  }
  const confirmed = await showModal({
    title: '删除条目',
    content: '这条车票会从本地删掉，确定继续？',
  })
  if (!confirmed) {
    return
  }
  saveEntries(entries.value.filter(item => item.id !== id))
  entryId.value = ''
  entryName.value = '新建车票'
}

// ---------------- 出图 ----------------

/**
 * 生成票面图片并放进待刷队列。
 *
 * 导出的图统一是 **552×768 的竖图**：票面本身是横版，导出时转 90°。
 * 这样进队列后在图像处理页不用手动转角度，0° 档位看到的就是最终效果——
 * 把标签横过来拿，票面是正的。
 */
async function generate(): Promise<void> {
  const canvas = canvasRef.value
  if (!canvas) {
    showToast('画布未就绪')
    return
  }
  busy.value = true
  showLoading('生成中')
  let queued = false
  const previewWidth = canvas.width
  const previewHeight = canvas.height
  try {
    const current = fields.value
    const qr = buildQr(current.qrContent)
    // 临时把画布换成输出尺寸，转 90° 再画
    canvas.width = OUTPUT_WIDTH
    canvas.height = OUTPUT_HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('画布上下文不可用')
    }
    renderTicket(ctx as unknown as TicketContext, current, qr ? qr.modules : null, 90)
    const blob = await exportCanvas(canvas)
    // 恢复预览画布
    canvas.width = previewWidth
    canvas.height = previewHeight
    render()
    const name = `${current.fromStation} → ${current.toStation} ${current.trainNo}`
    await addImageToQueue(blob, name)
    queued = true
  } catch (error) {
    if (canvasRef.value) {
      canvasRef.value.width = previewWidth
      canvasRef.value.height = previewHeight
      render()
    }
    appStore.log('error', `生成车票失败：${error instanceof Error ? error.message : String(error)}`)
    showToast('生成失败')
  } finally {
    busy.value = false
    hideLoading()
  }
  if (queued) {
    // 出图完直接回墨水屏的队列，立刻能看到刚生成的这张票
    await router.push('/eink?tab=queue&added=1')
  }
}

onMounted(() => {
  loadEntries()
  attachCanvas()
})

onBeforeUnmount(() => {
  if (renderTimer) {
    window.clearTimeout(renderTimer)
    renderTimer = 0
  }
})
</script>

<template>
  <div class="page">
    <div class="shell">
      <NavBar title="火车票" subtitle="信息都能改" fallback="/eink" />

      <div class="workbench">
        <!-- 左主区：票面预览 + 出图 -->
        <div class="workbench-main">
          <!-- 预览 -->
          <section class="section">
            <div class="ticket-wrap">
              <canvas ref="canvasRef" class="ticket-canvas" width="768" height="552"></canvas>
            </div>
            <p v-if="qrHint" class="ticket-note warn">{{ qrHint }}</p>
            <p class="ticket-note">
              票面是横版（768×552）。生成时会转 90° 输出成 552×768 的竖图，进队列后角度保持 0° 即可。
            </p>
          </section>

          <!-- 出图 -->
          <section class="section">
            <button class="btn btn-primary btn-block" type="button" :disabled="busy" @click="generate">
              生成并加入队列
            </button>
            <p class="ticket-note">票面按墨水屏的竖版比例出图，字段与参考样式一致。</p>
          </section>
        </div>

        <!-- 右栏：条目 + 票面信息 -->
        <aside class="workbench-aside scroll">
          <!-- 条目 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">01</span>
                <span class="section-title">条目</span>
                <span class="count">{{ entries.length }}</span>
              </div>
              <div class="head-actions">
                <button class="link lime" type="button" @click="newEntry">＋ 新建</button>
              </div>
            </div>

            <div v-if="entries.length > 0" class="strip-scroll">
              <button
                v-for="entry in entries"
                :key="entry.id"
                class="entry"
                :class="{ on: entryId === entry.id }"
                type="button"
                @click="pickEntry(entry.id)"
              >
                <span class="entry-name">{{ entry.name }}</span>
                <span class="entry-train">{{ entry.fields.trainNo }}</span>
              </button>
            </div>

            <div class="card card-pad">
              <input class="input" v-model="entryName" placeholder="条目名称" />
              <div class="entry-actions">
                <button class="btn btn-ghost entry-action" type="button" @click="saveEntry">保存条目</button>
                <button class="btn btn-ghost entry-action" type="button" @click="deleteEntry">删除条目</button>
              </div>
            </div>
          </section>

          <!-- 票面信息 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">02</span>
                <span class="section-title">票面信息</span>
              </div>
              <span class="section-aside mono">全部可改</span>
            </div>

            <div class="card card-pad">
              <div v-for="(row, index) in ROWS" :key="index" :class="row.length === 2 ? 'grid' : 'field-row'">
                <div v-for="item in row" :key="item.key" class="field">
                  <label class="field-label" :for="`ticket-field-${item.key}`">{{ item.label }}</label>
                  <input
                    :id="`ticket-field-${item.key}`"
                    class="input input-sm"
                    :value="fields[item.key]"
                    @input="onFieldInput(item.key, $event)"
                  />
                </div>
              </div>
            </div>
          </section>

          <!-- 提示 -->
          <section class="section">
            <div class="card card-pad">
              <p class="ticket-note aside-note">在右栏改字段，左边的票面预览会跟着重画；调好之后存成条目，下次直接取用。</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 票面预览：横版 768×552，比例 1.39。
   位图尺寸写在 canvas 的 width/height 属性上，这里只管显示大小：
   跟着左主区宽度自适应放大并居中，不动绘制与导出。 */
.ticket-canvas {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
  aspect-ratio: 768 / 552;
}

/* 预览卡居中，宽度不超出主区 */
.ticket-wrap {
  max-width: 100%;
  margin: 0 auto;
}

/* 预览下方的说明与提示 */
.ticket-note {
  margin: 13px 0 0;
  font-size: 17px;
  color: var(--ink-45);
  line-height: 1.7;
}

.ticket-note.warn {
  color: var(--danger);
}

/* 右栏提示卡里的文字不留上边距 */
.aside-note {
  margin: 0;
}

/* 条目条：名字在上、车次在下 */
.entry {
  display: flex;
  flex-direction: column;
}

/* 条目操作 */
.entry-actions {
  display: flex;
  gap: 13px;
  margin-top: 16px;
}

.entry-action {
  flex: 1;
  height: 61px;
  border-radius: 14px;
  font-size: 20px;
}

/* 字段表：整行的字段占满一整行 */
.field-row {
  display: block;
}

.field {
  margin-bottom: 13px;
}

/* 短字段并排，长字段保留整行。 */
.workbench-aside .grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.workbench-aside .input { min-width: 0; }
</style>
