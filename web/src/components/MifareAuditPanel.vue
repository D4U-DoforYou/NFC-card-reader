<script setup lang="ts">
/**
 * MIFARE Classic 安全审计面板。
 *
 * 这一版按 Proxmark3 的能力面重排，但只做当前固件能做的事：
 * 认证由 CLRC663 芯片完成，主机拿不到卡的随机数，所以
 * darkside / nested / hardnested 与离线解密都做不了——
 * 能做的是在线字典穷举、整卡读写、dump 离线分析。
 */
import { computed, ref, watch } from 'vue'
import { epdSession } from '@/core/rf/session'
import { MifareClassicSession } from '@/core/nfc/mifareClassic'
import {
  ClassicDump,
  ClassicSectorKey,
  CLASSIC_SECTORS,
  CrackProgress,
  CrackResult,
  DEFAULT_KEY,
  SectorCrack,
  analyzeDump,
  blockSummary,
  buildLockedUidBlock,
  checkKeyOnCard,
  crackCard,
  defaultKeys,
  diffDumps,
  emptyDump,
  formatCard,
  fromHex,
  parseBlocks,
  parseDump,
  parseKeyList,
  readFullDump,
  readUidBlock,
  searchSectorKey,
  serializeBlocks,
  serializeDump,
  toHex as auditToHex,
  writeDump,
} from '@/core/nfc/audit'
import { BUILTIN_KEYS } from '@/core/nfc/mifareTools'
import { showModal } from '@/platform/ui'

const props = defineProps<{
  /** 设备是否支持芯片原语。 */
  available: boolean
  /** 读卡器是否已连接。 */
  connected: boolean
  /** 是否正在忙（由页面统一管理）。 */
  busy: boolean
  /** 当前卡片的 UID（十六进制，无分隔）。 */
  uid: string
  /** 当前卡片是不是 Classic 1K。 */
  classic1k: boolean
}>()
const emit = defineEmits<{
  busy: [value: boolean]
  log: [level: 'info' | 'warn' | 'error' | 'success', message: string]
}>()

const keys = ref<ClassicSectorKey[]>(defaultKeys())
const dump = ref<ClassicDump>(emptyDump())
const status = ref('')
const progress = ref('')
const cancelled = ref(false)

// ---- 一键解卡 ----
const crackKeySource = ref<'builtin' | 'user' | 'both'>('builtin')
const crackUserKeys = ref('')
const crackResult = ref<CrackResult | null>(null)
const crackReadSectors = ref(true)
/** 实时进度：进度条、剩余时间都从这里来。 */
const crackProgress = ref<CrackProgress | null>(null)
/** 实时预览：解开的扇区与读到的数据块。 */
const crackLive = ref<{ sectors: SectorCrack[]; blocks: (Uint8Array | null)[] } | null>(null)

// ---- 密钥检测 ----
const checkKey = ref('')
const checkKeyType = ref<'A' | 'B'>('A')
const checkResult = ref('')

// ---- 指定扇区穷举 ----
const searchSector = ref(0)
const searchKeyType = ref<'A' | 'B'>('A')
const searchList = ref('')
const searchLog = ref('')

// ---- dump ----
const includeTrailers = ref(false)
const skipDefaultKeys = ref(false)
const writeTrailers = ref(false)
const writeManufacturer = ref(false)
const importText = ref('')
const compareText = ref('')
const compareResult = ref('')
const uidBlockHex = ref('')
const lockByte = ref('01')

/** 表格里显示的块，按扇区分组。 */
const sectors = computed(() =>
  Array.from({ length: CLASSIC_SECTORS }, (_, sector) => ({
    sector,
    blocks: [0, 1, 2, 3].map(index => sector * 4 + index),
  })),
)

/** 当前 dump 的离线分析结果。 */
const analysis = computed(() => analyzeDump(dump.value))

/** 解卡结果里已解开的扇区数。 */
const crackedCount = computed(() => crackResult.value?.sectors.filter(item => item.unlocked).length ?? 0)

/** 解卡预览的扇区列表：优先用实时快照，跑完后再用最终结果。 */
const crackPreviewSectors = computed(() => crackLive.value?.sectors ?? crackResult.value?.sectors ?? [])

/** 解卡预览的块数据。 */
const crackPreviewBlocks = computed(() => crackLive.value?.blocks ?? crackResult.value?.blocks ?? [])

/** 进度百分比（按候选密钥数算）。 */
const crackPercent = computed(() => {
  const item = crackProgress.value
  if (!item || !item.total) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round((item.tested / item.total) * 100)))
})

/**
 * 扫其它扇区与读数据这两段不按候选数推进，
 * 这时候进度条走不确定动画，免得看着像卡住了。
 */
const crackIndeterminate = computed(() => {
  const phase = crackProgress.value?.phase
  return phase === 'sweeping' || phase === 'reading'
})

/** 阶段名。 */
const crackPhaseLabel = computed(() => {
  switch (crackProgress.value?.phase) {
    case 'probing':
      return '逐把试密钥'
    case 'sweeping':
      return '命中，扫其它扇区'
    case 'reading':
      return '读出数据块'
    default:
      return '已完成'
  }
})

/** 把毫秒说成人话。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`
  }
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** 一个扇区第一块的预览（前 8 字节 hex + 可打印字符）。 */
function crackPreviewText(sector: number): string {
  const data = crackPreviewBlocks.value[sector * 4]
  if (!data) {
    return '—'
  }
  const head = data.slice(0, 8)
  const hex = Array.from(head, byte => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase()
  let text = ''
  for (const byte of head) {
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
  }
  return `${hex}  ${text}`
}

watch(
  () => props.uid,
  value => {
    if (value) {
      dump.value.uid = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
    }
  },
  { immediate: true },
)

function keyOf(sector: number, type: 'A' | 'B'): string {
  return type === 'A' ? keys.value[sector].keyA : keys.value[sector].keyB
}

function setKey(sector: number, type: 'A' | 'B', value: string): void {
  const cleaned = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (cleaned.length !== 12) {
    return
  }
  if (type === 'A') {
    keys.value[sector].keyA = cleaned
  } else {
    keys.value[sector].keyB = cleaned
  }
}

async function run(task: () => Promise<void>): Promise<void> {
  if (props.busy) {
    return
  }
  emit('busy', true)
  cancelled.value = false
  status.value = ''
  progress.value = ''
  try {
    await task()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status.value = message
    emit('log', 'error', `[审计] ${message}`)
  } finally {
    emit('busy', false)
  }
}

/** 开一个 Classic 会话。 */
async function openSession(): Promise<MifareClassicSession> {
  const uid = fromHex(props.uid)
  if (![4, 7].includes(uid.length)) {
    throw new Error('请先在「卡片」页识别 Classic 1K 卡片')
  }
  const session = new MifareClassicSession(epdSession.rfBridge, message =>
    emit('log', 'info', `[审计] ${message}`),
  )
  await session.open(uid)
  return session
}

/** 一键解卡。 */
function onCrack(): void {
  void run(async () => {
    const userKeys = parseKeyList(crackUserKeys.value)
    let candidates: string[]
    if (crackKeySource.value === 'builtin') {
      candidates = BUILTIN_KEYS
    } else if (crackKeySource.value === 'user') {
      candidates = userKeys
    } else {
      candidates = Array.from(new Set([...BUILTIN_KEYS, ...userKeys]))
    }
    if (!candidates.length) {
      throw new Error('候选密钥是空的')
    }
    const session = await openSession()
    crackProgress.value = null
    crackLive.value = null
    try {
      const result = await crackCard(session, {
        keys: candidates,
        readSectors: crackReadSectors.value,
        onProgress: item => {
          crackProgress.value = item
          progress.value = item.current
            ? `${crackPhaseLabel.value} · ${item.tested} / ${item.total} 把候选 · 第 ${item.attempts} 次认证 · 扇区 ${item.sector} · 试 ${item.current}`
            : `${crackPhaseLabel.value} · 扇区 ${item.sector}`
        },
        onUpdate: snapshot => {
          // 预览：解开的扇区与读到的数据块实时回填，主表也跟着动。
          crackLive.value = snapshot
          keys.value = snapshot.sectors.map((item, sector) => ({
            keyA: item.keyA || keys.value[sector]?.keyA || DEFAULT_KEY,
            keyB: item.keyB || keys.value[sector]?.keyB || DEFAULT_KEY,
          }))
          dump.value = {
            ...dump.value,
            blocks: snapshot.blocks.map(block => (block ? block.slice() : null)),
          }
        },
        shouldStop: () => cancelled.value,
      })
      crackResult.value = result
      keys.value = result.keys
      dump.value = {
        ...dump.value,
        keys: result.keys,
        blocks: result.blocks.map(block => (block ? block.slice() : null)),
      }
      const unlocked = result.sectors.filter(item => item.unlocked).length
      status.value =
        `解卡完成：${unlocked} / ${CLASSIC_SECTORS} 个扇区，试了 ${result.tested} 把候选、` +
        `${result.attempts} 次认证，用时 ${formatDuration(result.elapsedMs)}` +
        (result.inconclusive ? `（其中 ${result.inconclusive} 次射频没定论）` : '')
      emit('log', unlocked ? 'success' : 'warn', `[审计] ${status.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 拿一把密钥扫全卡。 */
function onCheckKey(): void {
  void run(async () => {
    if (!/^[0-9a-fA-F]{12}$/.test(checkKey.value.replace(/\s/g, ''))) {
      throw new Error('请填写 12 位十六进制的密钥')
    }
    const session = await openSession()
    try {
      const opened = await checkKeyOnCard(
        session,
        checkKey.value.replace(/\s/g, ''),
        checkKeyType.value,
        item => {
          progress.value = `扇区 ${item.sector} / ${item.total}`
        },
        () => cancelled.value,
      )
      checkResult.value = opened.length
        ? `Key ${checkKeyType.value} ${checkKey.value.replace(/\s/g, '').toUpperCase()} 能打开扇区：${opened.join('、')}`
        : `Key ${checkKeyType.value} ${checkKey.value.replace(/\s/g, '').toUpperCase()} 打不开任何扇区`
      emit('log', opened.length ? 'success' : 'info', `[审计] ${checkResult.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 对指定扇区穷举候选密钥。 */
function onSearchKey(): void {
  void run(async () => {
    const candidates = parseKeyList(searchList.value)
    if (!candidates.length) {
      throw new Error('请填写候选密钥，每行一个')
    }
    const session = await openSession()
    try {
      searchLog.value = ''
      const result = await searchSectorKey(session, searchSector.value, candidates, {
        keyType: searchKeyType.value,
        onProgress: item => {
          progress.value = `${item.tested} / ${item.total} · ${item.current}`
        },
        shouldStop: () => cancelled.value,
      })
      searchLog.value = result.log
        .slice(-40)
        .map(item => `${item.result === 'hit' ? '★' : item.result === 'miss' ? '·' : '!'} ${item.key} ${item.note}`)
        .join('\n')
      if (result.key) {
        const sector = searchSector.value
        if (searchKeyType.value === 'A') {
          keys.value[sector].keyA = result.key
        } else {
          keys.value[sector].keyB = result.key
        }
        status.value = `命中：扇区 ${sector} 的 Key ${searchKeyType.value} = ${result.key}`
        emit('log', 'success', `[审计] ${status.value}`)
      } else {
        status.value = `没有命中：试了 ${result.tested} 把（射频异常 ${result.inconclusive} 次）`
        emit('log', 'warn', `[审计] ${status.value}`)
      }
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 按密钥表读整卡。 */
function onReadDump(): void {
  void run(async () => {
    const session = await openSession()
    try {
      const result = await readFullDump(session, { ...dump.value, keys: keys.value }, {
        includeTrailers: includeTrailers.value,
        skipDefaultKeys: skipDefaultKeys.value,
        onProgress: item => {
          progress.value = `${item.done} / ${item.total} · ${item.message}`
        },
        shouldStop: () => cancelled.value,
      })
      dump.value = result
      keys.value = result.keys
      const ok = result.sectors.filter(item => item.state === 'ok').length
      status.value = `读卡完成：${ok} / ${CLASSIC_SECTORS} 个扇区`
      emit('log', 'success', `[审计] ${status.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 把 dump 写回卡片。 */
function onWriteDump(): void {
  void run(async () => {
    const session = await openSession()
    try {
      const ok = await showModal({
        title: '写回 dump',
        content:
          `将把 dump 写回卡片 UID ${props.uid}。\n` +
          `写入 ${dump.value.blocks.filter(Boolean).length} 个已知块，扇区尾块${writeTrailers.value ? '会被覆盖' : '保持不动'}，` +
          `厂商块${writeManufacturer.value ? '会被覆盖' : '保持不动'}。\n写错扇区尾块会让卡片再也读不出，请确认。`,
        confirmText: '写入',
      })
      if (!ok) {
        return
      }
      const result = await writeDump(session, { ...dump.value, keys: keys.value }, {
        includeTrailers: writeTrailers.value,
        includeManufacturerBlock: writeManufacturer.value,
        onProgress: item => {
          progress.value = `${item.done} / ${item.total} · ${item.message}`
        },
        shouldStop: () => cancelled.value,
      })
      status.value = `写入完成：${result.written} 块成功，${result.skipped} 块跳过，${result.failed.length} 块失败`
      emit('log', result.failed.length ? 'warn' : 'success', `[审计] ${status.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 格式化：数据块清零，尾块恢复成标准状态。 */
function onFormat(): void {
  void run(async () => {
    const session = await openSession()
    try {
      const ok = await showModal({
        title: '格式化卡片',
        content:
          '格式化会把数据块清零、扇区尾块恢复成出廠状态（Key A/B = FFFFFFFFFFFF，访问位 FFFFFF07）。\n' +
          '卡片上已有的数据会全部丢失，且不可撤销。确认继续？',
        confirmText: '格式化',
      })
      if (!ok) {
        return
      }
      const result = await formatCard(session, { ...dump.value, keys: keys.value }, {
        onProgress: item => {
          progress.value = `${item.done} / ${item.total} · ${item.message}`
        },
        shouldStop: () => cancelled.value,
      })
      status.value = `格式化完成：${result.written} 块写入，${result.failed.length} 块失败`
      emit('log', result.failed.length ? 'warn' : 'success', `[审计] ${status.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 读出第 0 块：UID 卡的 UID 就在这里。 */
function onReadUidBlock(): void {
  void run(async () => {
    const session = await openSession()
    try {
      const data = await readUidBlock(session, fromHex(keys.value[0].keyA))
      uidBlockHex.value = auditToHex(data)
      status.value = '已读出第 0 块'
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 锁死 UID：把第 0 块原样写回，只改最后一个字节。 */
function onLockUid(): void {
  void run(async () => {
    if (!uidBlockHex.value) {
      throw new Error('请先读出第 0 块')
    }
    const byte = Number.parseInt(lockByte.value.trim(), 16)
    const current = fromHex(uidBlockHex.value)
    const next = buildLockedUidBlock(current, byte)
    const ok = await showModal({
      title: '锁死 UID 块',
      content:
        '这一步会重写第 0 块（UID 所在处），只改最后一个字节，其余原样保留。\n' +
        `当前：${uidBlockHex.value}\n将写：${auditToHex(next)}\n` +
        '锁字节的约定各卡不同（常见 0x01 为已锁定、0x00 为未锁定）。\n' +
        '写完不可撤销，确认继续？',
      confirmText: '锁定',
    })
    if (!ok) {
      return
    }
    const session = await openSession()
    try {
      await session.writeUidBlock(next, fromHex(keys.value[0].keyA), 'A')
      uidBlockHex.value = auditToHex(next)
      status.value = 'UID 块已锁定并通过回读校验'
      emit('log', 'success', `[审计] ${status.value}`)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

/** 导出 dump 文本。 */
function onExport(): void {
  importText.value = serializeDump({ ...dump.value, keys: keys.value })
  status.value = 'dump 已导出到下方文本框，可复制走'
}

/** 从文本框导入 dump。 */
function onImport(): void {
  try {
    const parsed = parseDump(importText.value)
    dump.value = parsed
    keys.value = parsed.keys.map(item => ({ ...item }))
    status.value = `已导入：UID ${parsed.uid || '未知'}，${parsed.blocks.filter(Boolean).length} 个块`
    emit('log', 'success', `[审计] ${status.value}`)
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error)
  }
}

/** 从「每块一行」的 hex 导入。 */
function onImportBlocks(): void {
  try {
    dump.value = { ...dump.value, blocks: parseBlocks(importText.value) }
    status.value = '已导入块数据'
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error)
  }
}

/** 导出成每块一行的 hex。 */
function onExportBlocks(): void {
  importText.value = serializeBlocks({ ...dump.value, keys: keys.value })
  status.value = '已导出为每块一行的 hex'
}

/** 与另一份 dump 比较。 */
function onCompare(): void {
  try {
    const other = parseDump(compareText.value)
    const changed = diffDumps(dump.value, other)
    compareResult.value = changed.length
      ? `差异块：${changed.map(block => block.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`
      : '两份 dump 完全一致'
    emit('log', 'info', `[审计] ${compareResult.value}`)
  } catch (error) {
    compareResult.value = error instanceof Error ? error.message : String(error)
  }
}

/** 编辑一个块的内容。 */
function editBlock(block: number, value: string): void {
  const cleaned = value.replace(/[^0-9a-fA-F]/g, '')
  if (cleaned.length !== 32) {
    return
  }
  dump.value.blocks[block] = fromHex(cleaned)
}

function blockHex(block: number): string {
  const data = dump.value.blocks[block]
  return data ? auditToHex(data) : ''
}

function blockText(block: number): string {
  return blockSummary(dump.value.blocks[block])
}

function sectorStateText(sector: number): string {
  const item = dump.value.sectors[sector]
  if (!item) {
    return ''
  }
  if (item.state === 'ok') {
    return '已读出'
  }
  if (item.state === 'no-key') {
    return '密钥未知'
  }
  return item.state === 'auth-failed' ? '认证失败' : '读取失败'
}

function sectorStateClass(sector: number): string {
  return dump.value.sectors[sector]?.state ?? 'no-key'
}
</script>

<template>
  <div class="audit">
    <p v-if="!available" class="hint">
      当前固件未声明芯片原语能力（需要 raw RF 1.2），MIFARE Classic 的认证与读写都用不了。
    </p>
    <p v-else-if="!classic1k" class="hint">
      请先在「卡片」页识别一张 MIFARE Classic 1K 卡片（SAK 08），审计工具才知道对谁操作。
    </p>

    <!-- 一键解卡 -->
    <details class="card card-pad" open>
      <summary>一键解卡 <span>AUTOPWN</span></summary>
      <p class="hint">
        逐把候选密钥真卡认证，命中就把扇区解开并读出来。内置字典含出廠默认密钥与各家公开默认值，
        也可加上自己的字典。
        每试一把都要复位射频场再重新选卡（卡拒绝过一次握手后会回到初始态），一把密钥约 2 秒；
        候选先试完 Key A 再试 Key B，命中会早一半。命中后还要拿这把钥匙扫其它扇区，那一段更慢。
      </p>
      <div class="audit-fields">
        <label class="field-label">密钥来源
          <select v-model="crackKeySource" class="input" :disabled="busy">
            <option value="builtin">内置字典（{{ BUILTIN_KEYS.length }} 条）</option>
            <option value="user">只用我自己的字典</option>
            <option value="both">内置 + 我的字典</option>
          </select>
        </label>
        <label class="audit-opt"><input type="checkbox" v-model="crackReadSectors" :disabled="busy" /> 命中后顺便读出数据块</label>
      </div>
      <label v-if="crackKeySource !== 'builtin'" class="field-label">我的字典（每行一个 12 位十六进制）
        <textarea class="input mono" v-model="crackUserKeys" rows="4" spellcheck="false" placeholder="FFFFFFFFFFFF&#10;042C9C69CBD1" :disabled="busy" />
      </label>
      <div class="audit-buttons">
        <button class="btn btn-primary btn-sm" :disabled="busy || !connected || !classic1k" @click="onCrack">
          开始解卡
        </button>
        <button v-if="busy" class="btn btn-ghost btn-sm" @click="cancelled = true">中断</button>
      </div>

      <!-- 进度：候选数、认证次数、已解开扇区、剩余时间 -->
      <div v-if="crackProgress" class="crack-progress">
        <div class="crack-bar" :class="{ indeterminate: crackIndeterminate }">
          <div class="crack-bar-fill" :style="{ width: crackPercent + '%' }"></div>
        </div>
        <div class="crack-meta">
          <span class="crack-percent">{{ crackPercent }}%</span>
          <span>{{ crackPhaseLabel }}</span>
          <span>已试 {{ crackProgress.tested }} / {{ crackProgress.total }} 把候选</span>
          <span>第 {{ crackProgress.attempts }} 次认证</span>
          <span>已解开 {{ crackProgress.unlocked }} / {{ CLASSIC_SECTORS }} 扇区</span>
          <span>用时 {{ formatDuration(crackProgress.elapsedMs) }}</span>
          <span v-if="crackProgress.etaMs !== null">剩余 ≈ {{ formatDuration(crackProgress.etaMs) }}</span>
        </div>
        <div v-if="crackProgress.current" class="crack-current mono">
          当前：{{ crackProgress.current }} · 扇区 {{ crackProgress.sector }}
        </div>
      </div>

      <!-- 预览：实时显示解开的扇区、密钥与数据块 -->
      <table v-if="crackPreviewSectors.length" class="audit-table-result" aria-label="解卡实时预览">
        <thead>
          <tr><th>扇区</th><th>Key A</th><th>Key B</th><th>状态</th><th>数据预览</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in crackPreviewSectors" :key="item.sector" :class="{ hit: item.unlocked }">
            <td>{{ item.sector }}</td>
            <td class="mono">{{ item.keyA || '—' }}</td>
            <td class="mono">{{ item.keyB || '—' }}</td>
            <td>{{ item.message }}</td>
            <td class="mono preview">{{ crackPreviewText(item.sector) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="crackResult" class="hint">
        已解开 {{ crackedCount }} / {{ CLASSIC_SECTORS }} 个扇区，试了 {{ crackResult.tested }} 把候选、
        {{ crackResult.attempts }} 次认证，用时 {{ formatDuration(crackResult.elapsedMs) }}。
      </p>
    </details>

    <!-- 密钥检测 -->
    <details class="card card-pad">
      <summary>密钥检测 <span>CHK</span></summary>
      <p class="hint">
        拿一把密钥扫全卡，看它能打开哪些扇区。密钥对不对当场就有结论，不用先读出数据。
      </p>
      <div class="audit-fields">
        <label class="field-label">密钥（12 位十六进制）
          <input class="input mono" v-model="checkKey" placeholder="FFFFFFFFFFFF" :disabled="busy" />
        </label>
        <label class="field-label">类型
          <select v-model="checkKeyType" class="input" :disabled="busy">
            <option value="A">Key A</option>
            <option value="B">Key B</option>
          </select>
        </label>
      </div>
      <div class="audit-buttons">
        <button class="btn btn-dark btn-sm" :disabled="busy || !connected || !classic1k" @click="onCheckKey">
          扫全卡
        </button>
      </div>
      <div v-if="checkResult" class="result-box">{{ checkResult }}</div>
    </details>

    <!-- 指定扇区穷举 -->
    <details class="card card-pad">
      <summary>指定扇区穷举 <span>BRUTE</span></summary>
      <p class="hint">
        只针对一个扇区逐把试。卡片没应答时不能断言密钥错了，所以工具会把「没定论」单独计数，
        不会把一次射频抖动当成密钥错误。
      </p>
      <div class="audit-fields">
        <label class="field-label">扇区
          <select v-model.number="searchSector" class="input" :disabled="busy">
            <option v-for="index in CLASSIC_SECTORS" :key="index" :value="index - 1">扇区 {{ index - 1 }}</option>
          </select>
        </label>
        <label class="field-label">密钥类型
          <select v-model="searchKeyType" class="input" :disabled="busy">
            <option value="A">Key A</option>
            <option value="B">Key B</option>
          </select>
        </label>
      </div>
      <label class="field-label">候选密钥（每行一个，12 位十六进制）
        <textarea class="input mono" v-model="searchList" rows="5" spellcheck="false" placeholder="FFFFFFFFFFFF&#10;042C9C69CBD1" :disabled="busy" />
      </label>
      <div class="audit-buttons">
        <button class="btn btn-dark btn-sm" :disabled="busy || !connected || !classic1k" @click="onSearchKey">
          开始穷举
        </button>
        <button v-if="busy" class="btn btn-ghost btn-sm" @click="cancelled = true">中断</button>
      </div>
      <pre v-if="searchLog" class="result-box" role="status">{{ searchLog }}</pre>
    </details>

    <!-- 扇区密钥 -->
    <details class="card card-pad">
      <summary>扇区密钥 <span>{{ props.uid || '未识别卡片' }}</span></summary>
      <p class="hint">
        Key A 用于读数据块，Key B 用于写。保持 {{ DEFAULT_KEY }} 表示「还没找到密钥」，读卡时会跳过这些扇区。
      </p>
      <div class="key-grid">
        <div v-for="sector in sectors" :key="sector.sector" class="key-row">
          <span class="key-name">扇区 {{ sector.sector }}</span>
          <input
            class="input mono"
            :value="keyOf(sector.sector, 'A')"
            aria-label="扇区密钥 A"
            :disabled="busy"
            @input="setKey(sector.sector, 'A', ($event.target as HTMLInputElement).value)"
          />
          <input
            class="input mono"
            :value="keyOf(sector.sector, 'B')"
            aria-label="扇区密钥 B"
            :disabled="busy"
            @input="setKey(sector.sector, 'B', ($event.target as HTMLInputElement).value)"
          />
          <span class="key-state" :class="sectorStateClass(sector.sector)">{{ sectorStateText(sector.sector) }}</span>
        </div>
      </div>
      <div class="audit-buttons">
        <button class="btn btn-dark btn-sm" :disabled="busy || !connected || !classic1k" @click="onReadDump">
          读整卡
        </button>
        <label class="audit-opt"><input type="checkbox" v-model="includeTrailers" :disabled="busy" /> 连尾块一起读</label>
        <label class="audit-opt"><input type="checkbox" v-model="skipDefaultKeys" :disabled="busy" /> 跳过默认密钥扇区</label>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="keys = defaultKeys()">全部恢复默认</button>
      </div>
    </details>

    <!-- dump 编辑 -->
    <details class="card card-pad">
      <summary>dump 编辑 <span>{{ dump.blocks.filter(Boolean).length }} / 64 块</span></summary>
      <div class="audit-table">
        <div v-for="group in sectors" :key="group.sector" class="dump-row">
          <span class="dump-sector">扇区 {{ group.sector }}</span>
          <div v-for="block in group.blocks" :key="block" class="dump-cell">
            <span class="dump-index">{{ block.toString(16).padStart(2, '0').toUpperCase() }}</span>
            <input
              class="input mono dump-input"
              :value="blockHex(block)"
              :aria-label="`块 ${block}`"
              :disabled="busy"
              @input="editBlock(block, ($event.target as HTMLInputElement).value)"
            />
            <span class="dump-text">{{ blockText(block) }}</span>
          </div>
        </div>
      </div>
      <div class="audit-buttons">
        <button class="btn btn-dark btn-sm" :disabled="busy || !connected || !classic1k" @click="onWriteDump">
          写回 dump
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="busy || !connected || !classic1k" @click="onFormat">
          格式化卡片
        </button>
        <label class="audit-opt"><input type="checkbox" v-model="writeTrailers" :disabled="busy" /> 覆盖扇区尾块</label>
        <label class="audit-opt"><input type="checkbox" v-model="writeManufacturer" :disabled="busy" /> 覆盖厂商块</label>
      </div>
    </details>

    <!-- dump 离线分析 -->
    <details class="card card-pad">
      <summary>dump 分析 <span>ACL / MAD / 值块</span></summary>
      <p class="hint">纯计算，不碰射频。</p>
      <div class="field-label mono">卡片布局</div>
      <div class="result-box">{{ analysis.mad.layout }}</div>
      <div v-for="note in analysis.mad.notes" :key="note" class="hint">{{ note }}</div>
      <template v-if="analysis.access.length">
        <div class="field-label mono">各扇区访问权限</div>
        <details v-for="item in analysis.access" :key="item.sector" class="acl-item">
          <summary>扇区 {{ item.sector }}<span v-if="!item.valid" class="acl-bad">访问位已损坏</span></summary>
          <div v-for="line in item.lines" :key="line" class="kv"><span class="v wrap">{{ line }}</span></div>
        </details>
      </template>
      <template v-if="analysis.valueBlocks.length">
        <div class="field-label mono">值块</div>
        <div v-for="item in analysis.valueBlocks" :key="item.block" class="kv">
          <span class="k">块 {{ item.block }}</span>
          <span class="v mono">值 {{ item.value }} · 地址 {{ item.address }}</span>
        </div>
      </template>
    </details>

    <!-- 锁定 UID -->
    <details class="card card-pad">
      <summary>锁定 UID 块 <span>UFUID</span></summary>
      <p class="hint">
        UID / FUID 这类克隆卡的第 0 块存的就是 UID。把它原样写回、只改最后一个字节，
        卡就再也不能改 UID 了。锁字节的约定各卡不同，这里不替你猜，请按卡的说明填。
      </p>
      <button class="btn btn-ghost btn-sm" :disabled="busy || !connected || !classic1k" @click="onReadUidBlock">
        读出第 0 块
      </button>
      <div v-if="uidBlockHex" class="field-label mono">当前第 0 块</div>
      <pre v-if="uidBlockHex" class="result-box">{{ uidBlockHex }}</pre>
      <label class="field-label">锁字节（hex）
        <input class="input mono" v-model="lockByte" maxlength="2" :disabled="busy" />
      </label>
      <div class="audit-buttons">
        <button
          class="btn btn-dark btn-sm"
          :disabled="busy || !connected || !classic1k || !uidBlockHex"
          @click="onLockUid"
        >
          锁定 UID
        </button>
      </div>
    </details>

    <!-- 导入导出 -->
    <details class="card card-pad">
      <summary>导入 / 导出 / 比较</summary>
      <label class="field-label">dump 文本
        <textarea class="input mono" v-model="importText" rows="6" spellcheck="false" :disabled="busy" />
      </label>
      <div class="audit-buttons">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="onExport">导出 dump</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="onExportBlocks">导出每块一行</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="onImport">导入 dump</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="onImportBlocks">导入每块一行</button>
      </div>
      <label class="field-label">另一份 dump（用来比较）
        <textarea class="input mono" v-model="compareText" rows="4" spellcheck="false" :disabled="busy" />
      </label>
      <div class="audit-buttons">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="onCompare">比较两份 dump</button>
      </div>
      <pre v-if="compareResult" class="result-box" role="status">{{ compareResult }}</pre>
    </details>

    <p v-if="progress" class="hint" role="status">{{ progress }}</p>
    <pre v-if="status" class="result-box" role="status">{{ status }}</pre>
  </div>
</template>

<style scoped>
.audit { display: grid; gap: 20px; min-width: 0; }
/* 面板里全是定长 hex：任何一格都不许把主栏撑宽，长内容自己折行。 */
.audit, .audit * { min-width: 0; }
.audit .mono, .audit .result-box, .audit .dump-text { overflow-wrap: anywhere; }
.audit details summary { cursor: pointer; font-size: 13px; }
.audit details summary span { font-size: 10px; color: var(--ink-45); margin-left: 12px; }
.audit .hint { margin-top: 14px; }
.key-grid { display: grid; gap: 6px; margin-top: 16px; }
.key-row { display: grid; grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr) 78px; gap: 8px; align-items: center; }
.key-row .input { width: 100%; }
.key-name { font-size: 11px; color: var(--ink-45); }
.key-state { font-size: 10px; color: var(--ink-45); text-align: right; }
.key-state.ok { color: #3f7d55; }
.key-state.auth-failed { color: #b4703a; }
.key-state.error { color: #a8453c; }
.audit-buttons { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }
.audit-fields { display: grid; grid-template-columns: minmax(0, 200px) minmax(0, 160px); gap: 14px; margin-top: 16px; }
/* 复选框选项行。
   类名必须带 audit- 前缀：全局样式里 .check 是墨水屏缩略图上的圆形对勾徽章
   （position:absolute; 29x29）、.opt 是画板工具条上的大按钮（高 50px、圆角边框），
   撞名的话这行文字会被压成竖排、飘到页面左上角，或者套上一个输入框的外壳。 */
.audit-opt { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-70); }
.audit-table { display: grid; gap: 4px; margin-top: 16px; }
.dump-row { display: grid; grid-template-columns: 62px repeat(4, minmax(0, 1fr)); gap: 8px; align-items: center; }
.dump-sector { font-size: 10px; color: var(--ink-45); }
.dump-cell { display: grid; gap: 2px; }
.dump-index { font-size: 9px; color: var(--ink-45); }
.dump-input { font-size: 10px; padding: 4px 6px; margin: 0; width: 100%; }
.dump-text { font-size: 9px; color: var(--ink-45); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea.input { font-size: 11px; line-height: 1.6; resize: vertical; }
.audit-table-result { width: 100%; margin-top: 16px; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
.audit-table-result td.mono { overflow-wrap: anywhere; }
.audit-table-result td.preview { font-size: 10px; color: var(--ink-45); }
.audit-table-result th, .audit-table-result td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(20, 22, 26, .08); }
.audit-table-result th { font-weight: 400; color: var(--ink-45); font-size: 10px; }
.audit-table-result tr.hit td { color: #3f7d55; }
/* 解卡进度条 */
.crack-progress { margin-top: 16px; display: grid; gap: 8px; }
.crack-bar { position: relative; height: 8px; border-radius: 4px; background: rgba(20, 22, 26, .09); overflow: hidden; }
.crack-bar-fill { height: 100%; border-radius: 4px; background: #3f7d55; transition: width .25s ease; }
/* 扫其它扇区与读数据时进度不按候选数推进，用滚动条纹表示「还在动」。 */
.crack-bar.indeterminate .crack-bar-fill {
  width: 100% !important;
  background-image: repeating-linear-gradient(115deg, rgba(63, 125, 85, .35) 0 10px, #3f7d55 10px 20px);
  background-size: 200% 100%;
  animation: crack-stripes 1.1s linear infinite;
}
@keyframes crack-stripes { from { background-position: 0 0; } to { background-position: 40px 0; } }
.crack-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--ink-70); }
.crack-percent { font-weight: 600; color: var(--ink); }
.crack-current { font-size: 11px; color: var(--ink-45); overflow-wrap: anywhere; }
.acl-item { margin-top: 8px; }
@media (max-width: 900px) {
  .key-row { grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr); }
  .key-state { grid-column: 1 / -1; text-align: left; }
  .audit-fields { grid-template-columns: minmax(0, 1fr); }
  .dump-row { grid-template-columns: 62px repeat(2, minmax(0, 1fr)); }
}
.acl-item summary { font-size: 12px; }
.acl-bad { color: #a8453c; margin-left: 10px; font-size: 10px; }
</style>
