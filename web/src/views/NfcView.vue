<script setup lang="ts">
/**
 * 通用 NFC 读写页。
 *
 * 小程序版：miniprogram/pages/nfc/nfc.ts + nfc.wxml + nfc.wxss。
 * 网页版没有微信运行时：轻提示与确认框改用 @/platform/ui，
 * 页面跳转改用 vue-router，射频与协议逻辑全部复用 @/core 下已移植的模块。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import BlePill from '@/components/BlePill.vue'
import NfcCardFace from '@/components/NfcCardFace.vue'
import ChipTools from '@/components/ChipTools.vue'
import { epdSession } from '@/core/rf/session'
import { Activation, IsoDepSession, WAKE_FRAME_REQA, activateTag } from '@/core/rf/isoDep'
import { ProbeAttempt, probeProtocol } from '@/core/rf/probe'
import { CardIdentification, identifyCard } from '@/core/nfc/cards'
import { FileEntry } from '@/core/nfc/apdu'
import { listIsoDepFiles, readIsoDepFile, writeIsoDepFile } from '@/core/nfc/storage'
import { diffHex, formatDiffLines, formatDiffSummary, parseHex } from '@/core/nfc/hex'
import {
  MifareMemorySize,
  mifareBlockType,
  mifareSectorOfBlock,
  mifareSectors,
} from '@/core/nfc/mifare'
import { readType2Pages } from '@/core/nfc/type2'
import {
  Type2Session,
  Type2TagInfo,
  type Type2Credentials,
  decodeTextRecord,
  decodeUriRecord,
  encodeTextRecord,
  encodeUriRecord,
  encodeNdefTlv,
} from '@/core/nfc/type2Session'
import { ntagModel, type2WriteStatus } from '@/core/nfc/tagDetails'
import { deviceSession, supportsChipPrimitives } from '@/core/protocol'
import { MifareClassicSession } from '@/core/nfc/mifareClassic'
import MifareAuditPanel from '@/components/MifareAuditPanel.vue'
import { readBambuSpool, type BambuSpoolInfo } from '@/core/nfc/bambu'
import { toHex } from '@/core/hex'
import { LogEntry, appStore } from '@/core/store/index'
import { transportManager } from '@/platform'
import { showModal, showToast } from '@/platform/ui'

type TabKey = 'card' | 'storage' | 'tools' | 'raw'

/** 分区切换的四个页签。 */
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'card', label: '卡片' },
  { key: 'storage', label: '存储' },
  { key: 'tools', label: '工具' },
  { key: 'raw', label: '原始' },
]

/** 扇区（分区）地图的一行。 */
interface SectorRow {
  index: number
  start: number
  end: number
  count: number
  kinds: string
}

/** Type 2 分页读取的一页。 */
interface TagPageRow {
  page: number
  hex: string
}

const router = useRouter()
const route = useRoute()
const tabFromQuery = (value: unknown): TabKey => TABS.some(tab => tab.key === value) ? value as TabKey : 'card'

// ---------------- 通用状态 ----------------

const activeTab = ref<TabKey>(tabFromQuery(route.query.tab))
const busy = ref(false)
const connected = ref(false)
const logs = ref<LogEntry[]>([])

// ---------------- 卡片 ----------------

const card = ref({ uid: '', atqa: '', sak: '', ats: '', kind: '' })
const info = ref<CardIdentification | null>(null)
const probeAttempts = ref<ProbeAttempt[]>([])
const probeNote = ref('')

// ---------------- 存储 ----------------

const storageHint = ref('先读取卡片，再浏览它的存储分区。')
const files = ref<FileEntry[]>([])
const fileStatus = ref('')
const selectedFid = ref(0)
const fileHex = ref('')
const fileAscii = ref('')
/** 读出内容是否加密。 */
const fileEncrypted = ref('')
/** 射频场是否开着。 */
const fieldOn = ref(false)
/** MIFARE Classic 的扇区地图。 */
const sectors = ref<SectorRow[]>([])
const isMifare = ref(false)
const chipSupported = ref(false)
const classicKey = ref('')
const classicKeyType = ref<'A' | 'B'>('A')
const classicBlock = ref(4)
const classicReadMode = ref<'block' | 'sector'>('block')
const classicSector = ref(1)
const classicIncludeTrailer = ref(false)
const classicRows = ref<Array<{ block: number; kind: string; hex: string; ascii: string }>>([])
const classicSelectedSector = computed(() => classicReadMode.value === 'sector' ? classicSector.value : Math.floor(classicBlock.value / 4))
const classicWriteData = ref('')
const classicResult = ref('')
const classicStatus = ref('')
const bambuResult = ref<BambuSpoolInfo | null>(null)
const bambuStatus = ref('')
const bambuReading = ref(false)
const bambuKeys = ref<Array<{ sector: number; blocks: readonly number[]; keyA: string }>>([])
const bambuKeyUid = ref('')
const classic1k = computed(() => isMifare.value && Number.parseInt(card.value.sak, 16) === 8)
const classicWritable = computed(() => Number.isInteger(classicBlock.value) && classicBlock.value > 0 && classicBlock.value < 64 && classicBlock.value % 4 !== 3)
const tagPage = ref('0')
const tagPages = ref<TagPageRow[]>([])
/** Type 2 标签信息。 */
const type2Info = ref<Type2TagInfo | null>(null)
/** Type 2 上的 NDEF 文本。 */
const type2Text = ref('')
/** Type 2 上的 NDEF URI。 */
const type2Uri = ref('')
/** 要写入 Type 2 的 NDEF 文本。 */
const type2WriteText = ref('')
const type2WriteKind = ref<'text' | 'uri'>('text')
const type2ReadError = ref('')
const type2UsePassword = ref(false)
const type2Password = ref('')
const type2Pack = ref('')
watch([type2UsePassword, type2Password, type2Pack], () => {
  if (type2Info.value?.authenticated) type2Info.value = { ...type2Info.value, authenticated: false }
})
function tagCredentials(): Type2Credentials | undefined {
  if (!type2UsePassword.value) return undefined
  const password = type2Password.value.replace(/\s/g, '')
  const pack = type2Pack.value.replace(/\s/g, '')
  if (!/^[0-9a-fA-F]{8}$/.test(password)) throw new Error('NTAG 密码应为 8 位十六进制（4 字节）')
  if (pack && !/^[0-9a-fA-F]{4}$/.test(pack)) throw new Error('PACK 应为 4 位十六进制（2 字节）')
  const uid = parseHex(card.value.uid)
  if (![4,7,10].includes(uid.length)) throw new Error('请先识别卡片，确认目标 UID 后再认证')
  return { password: parseHex(password), expectedPack: pack ? parseHex(pack) : undefined, uid }
}
function createType2Session() {
  return new Type2Session(epdSession.rfBridge, message => appStore.log('info', `[Type 2] ${message}`), tagCredentials())
}
const tagWriteStatus = computed(() => type2Info.value ? type2WriteStatus(type2Info.value) : null)
const writePayload = computed(() => {
  if (!type2WriteText.value.trim()) return { error: '请填写要写入的内容', bytes: 0 }
  try {
    const message = type2WriteKind.value === 'uri' ? encodeUriRecord(type2WriteText.value.trim()) : encodeTextRecord(type2WriteText.value)
    return { error: '', bytes: encodeNdefTlv(message, type2Info.value?.ndefTlv?.lengthWidth === 3).length }
  } catch (error) { return { error: error instanceof Error ? error.message : String(error), bytes: 0 } }
})
const writeBlocked = computed(() => !tagWriteStatus.value?.allowed ? tagWriteStatus.value?.reason || '请先读取标签'
  : writePayload.value.error || (writePayload.value.bytes > tagWriteStatus.value.maxTlvBytes ? '内容超出当前可写区域，请缩短内容' : ''))
async function exportTagMemory() {
  let tag = type2Info.value
  if (!tag || busy.value || !connected.value) return
  busy.value = true
  let session: Type2Session | undefined
  try {
    if (tag.memoryComplete === false) {
      session = createType2Session()
      const full = await session.open()
      if (toHex(full.uid) !== toHex(tag.uid)) throw new Error('卡片已更换，未导出其他标签的数据')
      tag = full
      type2Info.value = full
    }
    const url = URL.createObjectURL(new Blob([tag.userMemory.slice()], { type: 'application/octet-stream' }))
    const link = document.createElement('a'); link.href = url; link.download = `type2-${toHex(tag.uid).replaceAll(' ', '')}-user-memory.bin`; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    appStore.log('success', `已导出完整用户内存 ${tag.userMemory.length} 字节`)
  } catch (error) {
    appStore.log('error', `导出用户内存失败：${error instanceof Error ? error.message : String(error)}`)
    showToast('导出失败')
  } finally {
    if (session) await session.close().catch(() => undefined)
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}
/** 写入 Type 2 时用户确认的 UID。 */
const type2ConfirmUid = ref('')
/** 要写入 ISO-DEP 文件的内容。 */
const fileWriteText = ref('')

// ---------------- 工具 ----------------

const hexLeft = ref('')
const hexRight = ref('')
const diffSummary = ref('')
const diffText = ref('')
const diffCount = ref(0)
const mifareSize = ref<MifareMemorySize>('1K')

// ---------------- 原始 ----------------

const hasIsoDep = ref(false)
const rawHex = ref('300000000000')
const rawTxLastBits = ref(0)
const rawCrcTx = ref(false)
const rawCrcRx = ref(false)
const rawTimeout = ref(100)
const rawResult = ref('')
const rawRxMode = ref(0)
const rawTxMode = ref(-1)
const rawRxModes = ref<ReadonlyArray<{ id: number; label: string }>>([])
const rawTxModes = ref<ReadonlyArray<{ id: number; label: string }>>([])
const rawModeSupported = ref(false)
async function loadRawModes() {
  if (transportManager.status !== 'connected') return
  try {
    const session = await deviceSession.require()
    rawRxModes.value = session.profile.rfPresets?.rxModes ?? []
    rawTxModes.value = session.profile.rfPresets?.txModes ?? []
    rawModeSupported.value = session.capabilities.some(c => c.id === 'org.example.rf.raw' && c.majorVersion === 1 && c.minorVersion >= 1)
  } catch { rawModeSupported.value = false }
}
const apduHex = ref('00A40000023F00')
const apduResult = ref('')

// ---------------- 派生值 ----------------

/** 卡片可视化下方的型号标签。 */

/** 是否是 MIFARE Ultralight / NTAG（决定是否显示分页读取卡片）。 */
const isUltralight = computed(() => info.value?.protocol === 'iso14443a' && Number.parseInt(info.value.sak, 16) === 0)

/** 是否显示「文件内容」卡片。 */
const showFileContent = computed(() => Boolean(fileHex.value || fileEncrypted.value))

/**
 * 设备是否支持指定射频模式。
 *
 * A01 固件提供 19 组收发预设（org.example.rf.raw 1.1）。
 * 不支持时协议探测只能试 Type A，其余协议连听都听不见。
 */
function supportsRfModes(): boolean {
  const session = deviceSession.current
  if (!session) {
    return false
  }
  const capability = session.capabilities.find(item => item.id === 'org.example.rf.raw')
  return Boolean(capability && capability.majorVersion === 1 && capability.minorVersion >= 1)
}

// ---------------- 运行时对象 ----------------

let activation: Activation | null = null
let isoDep: IsoDepSession | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeField: (() => void) | null = null
let unsubscribeStatus: (() => void) | null = null
let capabilityRevision = 0

// ---------------- 行为 ----------------

function goConnect(): void {
  router.push('/connect')
}

function switchTab(tab: TabKey): void {
  if (tab === 'raw') void loadRawModes()
  activeTab.value = tab
  void router.replace({ query: { ...route.query, tab } })
}

function resetCardState(): void {
  card.value = { uid: '', atqa: '', sak: '', ats: '', kind: '' }
  probeAttempts.value = []
  probeNote.value = ''
  storageHint.value = '先读取卡片，再浏览它的存储分区。'
  fileStatus.value = ''
  activation = null
  isoDep = null
  info.value = null
  hasIsoDep.value = false
  isMifare.value = false
  sectors.value = []
  files.value = []
  selectedFid.value = 0
  fileHex.value = ''
  fileAscii.value = ''
  fileEncrypted.value = ''
  tagPages.value = []
  type2ReadError.value = ''
  type2Info.value = null
  type2Text.value = ''
  type2Uri.value = ''
  type2ConfirmUid.value = ''
  type2Password.value = ''; type2Pack.value = ''; type2UsePassword.value = false
  classicKey.value = ''; classicResult.value = ''; classicStatus.value = ''; classicWriteData.value = ''; classicRows.value = []
  bambuResult.value = null; bambuStatus.value = ''; bambuKeys.value = []; bambuKeyUid.value = ''
}

watch(() => route.query.tab, value => {
  activeTab.value = tabFromQuery(value)
  if (activeTab.value === 'raw') void loadRawModes()
})

/** 读取卡片：先探协议，再按协议激活，最后给出识别报告。 */
async function onIdentify(): Promise<void> {
  if (busy.value) {
    return
  }
  if (transportManager.status !== 'connected') {
    showToast('请先连接读卡器')
    return
  }
  resetCardState()
  probeNote.value = '正在探测协议…'
  busy.value = true
  try {
    const bridge = epdSession.rfBridge
    await bridge.cycleRfField()
    // 设备支持射频模式预设时，Type B / FeliCa / Type V 都能真正问一遍。
    await deviceSession.require()
    const probe = await probeProtocol(bridge, !supportsRfModes())
    probeAttempts.value = probe.attempts
    probeNote.value = ''

    if (probe.protocol !== 'iso14443a') {
      // Type B / FeliCa / Type V 目前只做识别，不做后续读卡。
      isoDep = null
      activation = null
      const uid =
        probe.protocol === 'iso15693'
          ? probe.uid15693
          : probe.protocol === 'felica'
          ? probe.idm
          : new Uint8Array(0)
      const identified: CardIdentification = {
        protocol: probe.protocol,
        protocolName: probe.protocolName,
        modelId: probe.protocol,
        modelName: `${probe.protocolName} 卡片`,
        vendor: '未知',
        capacity: '未知',
        evidence: probe.attempts.map(attempt => `${attempt.protocol}：${attempt.note}`),
        uid: uid.length ? toHex(uid) : '未取到',
        uidKind: 'unknown',
        uidKindName: '未知',
        atqa: '—',
        sak: '—',
        ats: '—',
        isoDep: false,
        sakFlags: [],
        fsc: 0,
        fwtMs: 0,
        cidSupported: false,
        hint: '已识别该协议；除 Type A 外的协议暂不支持后续读卡流程，可到「原始」页手动收发帧',
      }
      info.value = identified
      card.value = {
        uid: identified.uid,
        atqa: '—',
        sak: '—',
        ats: '—',
        kind: identified.modelName,
      }
      hasIsoDep.value = false
      isMifare.value = false
      sectors.value = []
      storageHint.value = `探测到 ${probe.protocolName}，当前只支持 Type A 的完整读取流程。`
      appStore.log('info', `协议探测：${probe.protocolName}`)
      showToast(probe.protocolName)
      return
    }

    await bridge.cycleRfField()
    const activated = await activateTag(bridge, WAKE_FRAME_REQA, { strictAtqa: false, requireIsoDep: false })
    activation = activated
    isoDep = activated.sak & 0x20 ? new IsoDepSession(bridge, activated) : null
    const identified = identifyCard({
      uid: activated.uid,
      sak: activated.sak,
      atqa: activated.atqa,
      ats: activated.ats,
      protocol: 'iso14443a',
      // 这里用的是标准 REQA(0x26)：墨水屏标签只应答 0x7A，
      // 所以这一页识别出来的卡不可能是墨水屏标签。
      wakeFrame: WAKE_FRAME_REQA,
    })
    const mifare = identified.modelId === 'mifare-classic'
    isMifare.value = mifare
    sectors.value = mifare ? buildSectorMap(mifareSizeOf(identified.capacity)) : []
    card.value = {
      uid: toHex(activated.uid),
      atqa: toHex(activated.atqa),
      sak: activated.sak.toString(16).padStart(2, '0').toUpperCase(),
      ats: activated.ats.length ? toHex(activated.ats) : '非 ISO-DEP 卡片',
      kind: identified.modelName,
    }
    info.value = identified
    hasIsoDep.value = Boolean(isoDep)
    if (mifare) {
      mifareSize.value = mifareSizeOf(identified.capacity)
    }
    storageHint.value = mifare
      ? '这是 MIFARE Classic，下面是它的扇区（分区）地图；数据块需要扇区密钥才能读出。'
      : identified.isoDep
      ? '这是 ISO-DEP 卡片，点「读取文件清单」浏览它的文件系统。'
      : '这不是 ISO-DEP 卡片，可在「原始」页用射频帧与它交互。'
    fieldOn.value = epdSession.rfBridge.isFieldOn
    appStore.log('success', `识别到 ${identified.modelName}（${identified.protocolName}）UID=${identified.uid}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `读卡失败：${message}`)
    showToast('读卡失败')
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
    probeNote.value = ''
  }
}

/** 关场会使选卡与 ISO-DEP 状态失效，每次独立操作重新激活并核对 UID。 */
async function refreshActivation(): Promise<void> {
  const previous = activation
  if (!previous) {
    throw new Error('请先识别卡片')
  }
  await epdSession.rfBridge.cycleRfField()
  const active = await activateTag(epdSession.rfBridge, WAKE_FRAME_REQA, {
    strictAtqa: false,
    requireIsoDep: false,
  })
  if (toHex(active.uid) !== toHex(previous.uid)) {
    throw new Error('卡片已更换，请重新识别')
  }
  activation = active
  isoDep = active.sak & 0x20 ? new IsoDepSession(epdSession.rfBridge, active) : null
}

/** 读取 NTAG / Ultralight 的四页数据。 */
async function onReadTagPages(): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  tagPages.value = []
  fileEncrypted.value = ''
  try {
    const page = Number(tagPage.value)
    if (!tagPage.value.trim() || !Number.isInteger(page) || page < 0 || page > 252) {
      throw new Error('起始页必须是 0..252')
    }
    let data: Uint8Array
    if (type2UsePassword.value) {
      const session = createType2Session()
      await session.open()
      data = await session.readPage(page)
    } else {
      await refreshActivation()
      data = await readType2Pages(epdSession.rfBridge, page)
    }
    tagPages.value = [0, 1, 2, 3].map(offset => ({
      page: page + offset,
      hex: toHex(data.slice(offset * 4, offset * 4 + 4)),
    }))
    fileEncrypted.value = 'Type 2 原始页数据；密码保护状态未知，读取成功不代表未保护'
    fileStatus.value = `已读取页 ${page}～${page + 3}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fileStatus.value = `读取失败：${message}`
  } finally {
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
    fieldOn.value = epdSession.rfBridge.isFieldOn
  }
}

/**
 * 读取 Type 2 标签的能力容器与 NDEF。
 *
 * 走 Type 2 自己的指令集（GET_VERSION / READ），不走 ISO-DEP。
 */
async function onReadType2(): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  type2ReadError.value = ''
  type2Info.value = null
  type2Text.value = ''
  type2Uri.value = ''
  try {
    const session = createType2Session()
    const tag = await session.open({ quick: true })
    if (card.value.uid && toHex(tag.uid) !== card.value.uid) throw new Error('卡片已更换，请重新识别')
    const identified = identifyCard({ uid: tag.uid, atqa: tag.atqa, sak: tag.sak, protocol: 'iso14443a' })
    const model = ntagModel(tag.version)
    info.value = { ...identified, modelId: 'ultralight', modelName: model?.name ?? 'NFC Forum Type 2 标签（NTAG / Ultralight）', capacity: `${tag.userCapacity ?? tag.userMemory.length} 字节 NDEF 区` }
    card.value = { uid: toHex(tag.uid), atqa: toHex(tag.atqa), sak: tag.sak.toString(16).padStart(2,'0').toUpperCase(), ats: '非 ISO-DEP 卡片', kind: info.value.modelName }
    activation = { uid: tag.uid, atqa: tag.atqa, sak: tag.sak, ats: new Uint8Array(), fsc: 0, fwtMs: 0, cid: null }
    hasIsoDep.value = false; isoDep = null
    isMifare.value = false; sectors.value = []; classicRows.value = []
    type2Info.value = tag
    type2ConfirmUid.value = toHex(tag.uid)
    const ndef = tag.ndefTlv?.value
    if (ndef) {
      type2Text.value = decodeTextRecord(ndef) ?? ''
      type2Uri.value = decodeUriRecord(ndef) ?? ''
    }
    appStore.log(
      'success',
      `Type 2 标签 UID=${toHex(tag.uid)}，用户内存 ${tag.userCapacity ?? tag.userMemory.length} 字节，已读取 ${tag.userMemory.length} 字节（NDEF 与权限）`
    )
    showToast('已读取 Type 2 标签', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    type2ReadError.value = message
    appStore.log('error', `读取 Type 2 标签失败：${message}`)
    showToast('读取失败')
  } finally {
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/**
 * 写入 NDEF 文本。
 *
 * 写标签不可撤销，所以要用户敲一遍卡片的 UID 确认，再弹一次确认框。
 */
async function onWriteType2Ndef(): Promise<void> {
  if (busy.value) {
    return
  }
  if (writeBlocked.value) { showToast(writeBlocked.value); return }
  const kind = type2WriteKind.value
  const text = kind === 'uri' ? type2WriteText.value.trim() : type2WriteText.value
  if (!text) {
    showToast('请先填写要写入的文本')
    return
  }
  if (!type2Info.value) {
    showToast('请先读取 Type 2 标签')
    return
  }
  const confirmed = type2ConfirmUid.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const expected = toHex(type2Info.value.uid).replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (confirmed !== expected) {
    showToast('确认的 UID 与卡片不一致')
    return
  }
  const ok = await showModal({
    title: '确认写入 NDEF',
    content: `将向 UID ${expected} 写入${kind === 'uri' ? '网址' : '文本'}「${text}」。写标签不可撤销，确认继续？`,
    confirmText: '写入',
  })
  if (!ok) {
    return
  }
  busy.value = true
  try {
    const session = createType2Session()
    await session.open()
    if (kind === 'uri') await session.writeUri(text, expected)
    else await session.writeText(text, expected)
    type2Info.value = session.tag
    type2Text.value = kind === 'text' ? text : ''
    type2Uri.value = kind === 'uri' ? text : ''
    appStore.log('success', '已写入 NDEF 并通过回读校验')
    showToast('NDEF 已写入并校验通过', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `写入 NDEF 失败：${message}`)
    showToast('写入失败')
  } finally {
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/** 把输入的文本写进当前选中的 ISO-DEP 文件。 */
async function onWriteFile(): Promise<void> {
  if (busy.value) {
    return
  }
  if (!isoDep) {
    showToast('请先读取一张 ISO-DEP 卡片')
    return
  }
  if (!selectedFid.value) {
    showToast('请先选择一个文件')
    return
  }
  const data = new TextEncoder().encode(fileWriteText.value)
  if (!data.length) {
    showToast('请先填写要写入的内容')
    return
  }
  const ok = await showModal({
    title: '确认写入文件',
    content: `将向文件 ${selectedFid.value
      .toString(16)
      .toUpperCase()} 写入 ${data.length} 字节。覆盖后不可撤销，确认继续？`,
    confirmText: '写入',
  })
  if (!ok) {
    return
  }
  busy.value = true
  try {
    await refreshActivation()
    const session = isoDep
    if (!session) {
      throw new Error('请先读取一张 ISO-DEP 卡片')
    }
    const status = await writeIsoDepFile(session, selectedFid.value, data)
    fileStatus.value = status.ok ? `已写入 ${data.length} 字节` : status.text
    appStore.log(status.ok ? 'success' : 'error', `写入文件：${fileStatus.value}`)
    showToast(status.ok ? '写入完成' : '写入失败')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fileStatus.value = `写入失败：${message}`
    appStore.log('error', `写入文件失败：${message}`)
  } finally {
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/** 读取 ISO-DEP 卡片的文件清单。 */
async function onListFiles(): Promise<void> {
  if (busy.value) {
    return
  }
  if (!isoDep) {
    showToast('请先读取一张 ISO-DEP 卡片')
    return
  }
  busy.value = true
  try {
    await refreshActivation()
    const session = isoDep
    if (!session) {
      throw new Error('请先读取一张 ISO-DEP 卡片')
    }
    const listing = await listIsoDepFiles(session)
    files.value = listing.files
    fileStatus.value = listing.status.ok
      ? `共 ${listing.files.length} 个条目`
      : `SELECT MF 失败：${listing.status.text}`
    appStore.log('info', `文件清单：${listing.files.length} 个条目`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fileStatus.value = `读取失败：${message}`
    appStore.log('error', `读取文件清单失败：${message}`)
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/** 选中一个文件。 */
function onPickFile(fid: number): void {
  selectedFid.value = fid
  fileHex.value = ''
  fileAscii.value = ''
}

async function onReadBambu(): Promise<void> {
  if (busy.value || !connected.value) return
  busy.value = true; bambuReading.value = true; bambuResult.value = null
  bambuKeys.value = []; bambuKeyUid.value = card.value.uid
  bambuStatus.value = '正在读取料盘…'
  try {
    const device = await deviceSession.require()
    if (!supportsChipPrimitives(device) || !classic1k.value) throw new Error('请先识别 Classic 1K 卡片，并使用 raw RF 1.2 固件')
    bambuResult.value = await readBambuSpool(epdSession.rfBridge, parseHex(card.value.uid), {
      trace: message => appStore.log('info', `[拓竹] ${message}`),
      onProgress: (done, total) => { bambuStatus.value = `正在读取料盘 · ${done} / ${total} 块` },
      onSectorKey: key => { bambuKeys.value.push(key) },
    })
    bambuStatus.value = '8 个数据块读取完成'
    appStore.log('success', `[拓竹] ${bambuResult.value.materialDetail || bambuResult.value.material} · ${bambuResult.value.weightGrams} g · 读取完成`)
  } catch (error) {
    bambuStatus.value = error instanceof Error ? error.message : String(error)
    appStore.log('error', `[拓竹] ${bambuStatus.value}`)
  } finally { bambuReading.value = false; busy.value = false; if (transportManager.status !== 'connected') resetCardState() }
}

function onSelectClassicSector(sector: number): void {
  if (busy.value || !classic1k.value) return
  classicReadMode.value = 'sector'
  classicSector.value = sector
  classicBlock.value = sector * 4 + (sector === 0 ? 1 : 0)
}

async function onMifareBlock(write = false): Promise<void> {
  if (busy.value || !connected.value) return
  const cleaned = classicKey.value.replace(/\s/g, '')
  if (!/^[a-fA-F0-9]{12}$/.test(cleaned)) { showToast('密钥需要 12 位十六进制（6 字节）'); return }
  const key = parseHex(cleaned)
  const block = classicBlock.value, keyType = classicKeyType.value
  const sector = classicSector.value, readSector = !write && classicReadMode.value === 'sector'
  const includeTrailer = classicIncludeTrailer.value
  const uid = parseHex(card.value.uid)
  let session: MifareClassicSession | undefined
  busy.value = true; classicResult.value = ''; classicStatus.value = ''; classicRows.value = []
  try {
    const device = await deviceSession.require()
    if (!supportsChipPrimitives(device)) throw new Error('需要支持芯片原语的 raw RF 1.2 固件，请在连接页升级')
    if (!classic1k.value) throw new Error('当前只适配 MIFARE Classic 1K（SAK 08）')
    if (readSector) {
      if (!Number.isInteger(sector) || sector < 0 || sector > 15) throw new Error('扇区号必须为 0–15')
    } else if (!Number.isInteger(block) || block < 0 || block > 63) throw new Error('块号必须为 0–63')
    const data = write ? parseHex(classicWriteData.value) : null
    if (write) {
      if (block === 0 || block % 4 === 3) throw new Error('不能写入制造商块或扇区尾块')
      if (data?.length !== 16) throw new Error('写入数据必须恰好 16 字节')
      if (!await showModal({ title: '写入 Classic 数据块', content: `卡片 UID：${toHex(uid)}\n块 ${block} · Key ${keyType}\n新数据：${toHex(data)}\n写入后将回读校验。`, confirmText: '写入并校验' })) return
    }
    classicStatus.value = '正在重新选卡并认证…'
    session = new MifareClassicSession(epdSession.rfBridge, message => appStore.log('info', `[Classic] ${message}`))
    await session.open(uid)
    const result = readSector ? await session.readSector(sector, key, keyType, includeTrailer) : new Map([[block, data ? await session.writeBlock(block, data, key, keyType) : await session.readBlock(block, key, keyType)]])
    const kinds = { manufacturer: '厂商块', data: '数据块', value: '值块', trailer: '访问控制' }
    classicRows.value = Array.from(result, ([index, bytes]) => ({ block: index, kind: kinds[mifareBlockType('1K', index)], hex: toHex(bytes), ascii: toAscii(bytes) }))
    classicResult.value = classicRows.value.map(row => row.hex).join('\n')
    classicStatus.value = readSector ? `扇区 ${sector} · Key ${keyType} 认证通过 · ${result.size} 块读取完成` : `块 ${block} · Key ${keyType} 认证通过 · ${write ? '写入并校验完成' : '读取完成'}`
    showToast(write ? '写入并校验完成' : '认证并读取完成', 'success')
  } catch (error) {
    classicStatus.value = error instanceof Error ? error.message : String(error)
    appStore.log('error', `[Classic] ${classicStatus.value}`)
  } finally {
    key.fill(0)
    await session?.close().catch(() => undefined)
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

onBeforeRouteLeave(() => {
  if (busy.value) { showToast('请等待当前卡片操作完成'); return false }
})

/** 读出选中的文件内容。 */
async function onReadFile(): Promise<void> {
  if (busy.value) {
    return
  }
  if (!isoDep) {
    showToast('请先读取一张 ISO-DEP 卡片')
    return
  }
  if (!selectedFid.value) {
    showToast('请先选择一个文件')
    return
  }
  const file = files.value.find(item => item.fid === selectedFid.value)
  busy.value = true
  try {
    await refreshActivation()
    const session = isoDep
    if (!session) {
      throw new Error('请先读取一张 ISO-DEP 卡片')
    }
    const result = await readIsoDepFile(session, selectedFid.value, file?.size ?? 0)
    const hex = toHex(result.data)
    fileHex.value = hex
    fileAscii.value = result.data.length ? toAscii(result.data) : ''
    fileEncrypted.value = result.status.ok
      ? '已读出数据；应用层是否加密需按卡片协议判断'
      : '未知／可能需要认证'
    fileStatus.value = result.status.ok ? `读出 ${result.data.length} 字节` : result.status.text
    appStore.log(
      'info',
      `读出文件 ${selectedFid.value.toString(16).toUpperCase()}：${result.data.length} 字节`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fileStatus.value = `读取失败：${message}`
    appStore.log('error', `读取文件失败：${message}`)
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/** 对比两段 hex 内容。 */
function onCompare(): void {
  try {
    const left = parseHex(hexLeft.value)
    const right = parseHex(hexRight.value)
    const result = diffHex(left, right)
    diffSummary.value = formatDiffSummary(result, left.length, right.length)
    diffText.value = formatDiffLines(left, right, result)
    diffCount.value = result.diffCount + result.leftOnly + result.rightOnly
    appStore.log('info', `hex 对比：${result.diffCount} 处差异`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    diffSummary.value = `解析失败：${message}`
    diffText.value = ''
    diffCount.value = 0
  }
}

/** 手动关闭射频场。 */
async function onTurnOffField(): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    await epdSession.rfBridge.turnOffField()
    fieldOn.value = false
    appStore.log('success', '已手动关闭射频场')
    showToast('射频场已关闭')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `关闭射频场失败：${message}`)
    showToast('关闭失败')
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

function onToggleTxLastBits(): void {
  rawTxLastBits.value = rawTxLastBits.value ? 0 : 7
}

function onToggleCrcTx(): void {
  rawCrcTx.value = !rawCrcTx.value
}

function onToggleCrcRx(): void {
  rawCrcRx.value = !rawCrcRx.value
}

function onTimeoutInput(event: Event): void {
  const target = event.target as HTMLInputElement
  rawTimeout.value = Number(target.value) || 100
}

/** 起始页按文本保存，方便判断「没填」与「填了非法值」。 */
function onTagPageInput(event: Event): void {
  const target = event.target as HTMLInputElement
  tagPage.value = target.value
}

/** 发送一帧原始射频数据并显示响应。 */
async function onSendRaw(): Promise<void> {
  if (busy.value) {
    return
  }
  if (transportManager.status !== 'connected') {
    showToast('请先连接读卡器')
    return
  }
  busy.value = true
  try {
    const frame = parseHex(rawHex.value)
    if (frame.length === 0 || frame.length > 256) throw new Error('原始帧必须为 1–256 字节')
    if (!Number.isInteger(rawTimeout.value) || rawTimeout.value < 1 || rawTimeout.value > 300000) throw new Error('超时必须为 1–300000 毫秒的整数')
    if (!Number.isInteger(rawTxLastBits.value) || rawTxLastBits.value < 0 || rawTxLastBits.value > 7) throw new Error('末字节有效位数必须为 0–7')
    const reply = await epdSession.rfBridge.exchange(frame, {
      txLastBits: rawTxLastBits.value,
      crcTx: rawCrcTx.value,
      crcRx: rawCrcRx.value,
      timeoutMs: rawTimeout.value,
      rxMode: rawModeSupported.value ? rawRxMode.value : undefined,
      txMode: rawModeSupported.value && rawTxMode.value >= 0 ? rawTxMode.value : undefined,
    })
    rawResult.value =
      `${toHex(reply.data)}\n` +
      `RXBITS=${reply.rxLastBits} IRQ0=0x${reply.irq0Status.toString(16).padStart(2, '0').toUpperCase()} ` +
      `ERROR=0x${reply.errorStatus.toString(16).padStart(2, '0').toUpperCase()}`
    appStore.log('info', `原始帧响应：${toHex(reply.data)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    rawResult.value = `失败：${message}`
    appStore.log('error', `原始帧发送失败：${message}`)
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

/** 发送一条 ISO-DEP APDU。 */
async function onSendApdu(): Promise<void> {
  if (busy.value) {
    return
  }
  if (!isoDep) {
    showToast('请先读取 ISO-DEP 卡片')
    return
  }
  busy.value = true
  try {
    const apdu = parseHex(apduHex.value)
    if (apdu.length < 4) throw new Error('APDU 至少包含 4 字节指令头')
    await refreshActivation()
    const session = isoDep
    if (!session) {
      throw new Error('请先读取 ISO-DEP 卡片')
    }
    const response = await session.exchange(apdu)
    apduResult.value = `${toHex(response)}\nSW=${toHex(response.slice(response.length - 2))}`
    appStore.log('info', `APDU 响应：${toHex(response)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    apduResult.value = `失败：${message}`
    appStore.log('error', `APDU 失败：${message}`)
  } finally {
    await epdSession.rfBridge
      .turnOffField()
      .catch(error => appStore.log('warn', `关场失败：${String(error)}`))
    fieldOn.value = epdSession.rfBridge.isFieldOn
    busy.value = false; if (transportManager.status !== 'connected') resetCardState()
  }
}

function onClearLogs(): void {
  appStore.clearLogs()
}

// ---------------- 生命周期 ----------------

async function updateConnectionState(): Promise<void> {
  const revision = ++capabilityRevision
  connected.value = transportManager.status === 'connected'
  chipSupported.value = false
  rawModeSupported.value = false
  rawRxModes.value = []; rawTxModes.value = []
  if (!connected.value) {
    resetCardState()
    rawResult.value = ''; apduResult.value = ''
    return
  }
  try {
    const session = await deviceSession.require()
    if (revision !== capabilityRevision || transportManager.status !== 'connected') return
    chipSupported.value = supportsChipPrimitives(session)
    await loadRawModes()
  } catch (error) {
    if (revision === capabilityRevision) appStore.log('warn', `设备能力读取失败：${String(error)}`)
  }
}

onMounted(() => {
  logs.value = appStore.logs.slice(0, 40)
  unsubscribe = appStore.subscribe(() => { logs.value = appStore.logs.slice(0, 40) })
  unsubscribeStatus = transportManager.onStatus(() => { void updateConnectionState() })
  unsubscribeField = epdSession.rfBridge.onField(state => { fieldOn.value = state.on })
  void updateConnectionState()
})

// ---------------- 忙时挂住射频场 ----------------

/**
 * 通用 NFC 通信期间别让射频场被关掉。
 *
 * 有些硬件关场就掉电（B01），自动休眠的空闲脉冲也只该在闲时跑。
 * 一次读写往往要连着发好几帧，中间的间隙也得留着场，
 * 所以这里在 busy 期间挂住射频场，做完再放。
 */
let releaseField: (() => void) | null = null

function holdFieldForBusy(value: boolean): void {
  if (value && !releaseField) {
    releaseField = epdSession.rfBridge.retainField()
    return
  }
  if (!value && releaseField) {
    releaseField()
    releaseField = null
  }
}

watch(busy, value => holdFieldForBusy(value), { flush: 'sync' })

onBeforeUnmount(() => {
  ++capabilityRevision
  resetCardState()
  holdFieldForBusy(false)
  unsubscribe?.(); unsubscribe = null
  unsubscribeStatus?.(); unsubscribeStatus = null
  unsubscribeField?.(); unsubscribeField = null
  void epdSession.rfBridge.turnOffField().catch(() => undefined)
})

// ---------------- 本地工具 ----------------

/** 把字节转成可打印的 ASCII 预览。 */
function toAscii(data: Uint8Array): string {
  let text = ''
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i]
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
  }
  return text
}


/** 按容量描述猜出 MIFARE Classic 的容量。 */
function mifareSizeOf(capacity: string): MifareMemorySize {
  if (capacity.includes('4K')) {
    return '4K'
  }
  if (capacity.includes('2K')) {
    return '2K'
  }
  return '1K'
}

/**
 * 生成 MIFARE Classic 的扇区（分区）地图。
 *
 * 每个扇区给出块范围与块的类型构成：
 * 厂商块 / 数据块 / 访问控制块（trailer）/ 值块。
 */
function buildSectorMap(size: MifareMemorySize): SectorRow[] {
  const layout = mifareSectors(size)
  const rows: SectorRow[] = []
  const kindNames: Record<string, string> = {
    manufacturer: '厂商块',
    data: '数据块',
    value: '值块',
    trailer: '访问控制',
  }
  for (let block = 0; block < layout.blocks; block += 1) {
    const location = mifareSectorOfBlock(size, block)
    let row = rows[rows.length - 1]
    if (!row || row.index !== location.sector) {
      row = {
        index: location.sector,
        start: block,
        end: block,
        count: 0,
        kinds: '',
      }
      rows.push(row)
    }
    row.end = block
    row.count += 1
    const kind = kindNames[mifareBlockType(size, block)]
    if (!row.kinds.includes(kind)) {
      row.kinds = row.kinds ? `${row.kinds} + ${kind}` : kind
    }
  }
  return rows
}
</script>

<template>
  <div class="page nfc-page">
    <main class="shell">
      <NavBar title="通用 NFC 读写" subtitle="READ & WRITE">
        <template #right>
          <BlePill idle-label="读卡器未连接" @click="goConnect" />
        </template>
      </NavBar>

      <!-- 分区切换 -->
      <div class="segment">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="segment-item"
          :aria-pressed="activeTab === tab.key"
          :class="{ on: activeTab === tab.key }"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="workbench" :class="{ 'storage-workbench': activeTab === 'storage' }">
        <div class="workbench-main">
          <!-- 01 卡片识别 -->
          <section v-if="activeTab === 'card'" class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">01</span>
                <span class="section-title">卡片识别</span>
              </div>
              <span class="section-aside mono">CARD</span>
            </div>

            <div class="stack">
              <!-- 卡片图像 + 识别信息 -->
              <div class="card-grid">
                <div class="card card-pad card-hero">
                  <NfcCardFace :info="info" />
                  <button class="btn btn-primary btn-block" :disabled="busy" @click="onIdentify">
                    {{ busy ? '读取中…' : '读取并识别卡片' }}
                  </button>
                </div>

                <div class="card card-pad">
                  <div class="field-label mono">识别信息</div>
                  <div class="kv-grid">
                    <div class="kv-cell">
                      <span class="k">协议</span>
                      <span class="v">{{ info ? info.protocolName : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">型号</span>
                      <span class="v">{{ info ? info.modelName : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">厂商</span>
                      <span class="v">{{ info ? info.vendor : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">容量</span>
                      <span class="v">{{ info ? info.capacity : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">UID</span>
                      <span class="v mono">{{ card.uid || '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">UID 形态</span>
                      <span class="v">{{ info ? info.uidKindName : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">ATQA</span>
                      <span class="v mono">{{ card.atqa || '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">SAK</span>
                      <span class="v mono">{{ card.sak || '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">ATS</span>
                      <span class="v wrap">{{ card.ats || '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">帧尺寸</span>
                      <span class="v">{{ info && info.fsc ? info.fsc + ' 字节' : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">帧等待</span>
                      <span class="v">{{ info && info.fwtMs ? info.fwtMs + ' ms' : '--' }}</span>
                    </div>
                    <div class="kv-cell">
                      <span class="k">CID</span>
                      <span class="v">{{ info ? (info.cidSupported ? '支持' : '不支持') : '--' }}</span>
                    </div>
                  </div>
                  <div v-if="info && info.hint" class="hint tip card-status-note">{{ info.hint }}</div>
                  <div v-if="probeNote" class="hint probe-status-note">{{ probeNote }}</div>
                </div>
              </div>

              <!-- 识别依据 + 协议探测 -->
              <div class="card-grid">
                <div v-if="info && info.evidence.length" class="card card-pad">
                  <div class="field-label mono">识别依据</div>
                  <div v-for="(item, index) in info.evidence" :key="index" class="evidence">
                    <span class="evidence-dot" />
                    <span class="evidence-text">{{ item }}</span>
                  </div>
                </div>

                <div v-if="probeAttempts.length" class="card card-pad">
                  <div class="field-label mono">协议探测</div>
                  <div v-for="(item, index) in probeAttempts" :key="index" class="probe">
                    <div class="probe-row">
                      <span class="probe-name">{{ item.protocol }}</span>
                      <span class="probe-state" :class="item.ok ? 'ok' : 'miss'">
                        {{ item.ok ? '命中' : '未命中' }}
                      </span>
                    </div>
                    <div class="probe-frame">帧 {{ item.frame }} → {{ item.reply || '无应答' }}</div>
                    <div class="probe-mode">模式 {{ item.mode }}</div>
                    <div class="probe-note">{{ item.note }}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- 02 存储 -->
          <section v-if="activeTab === 'storage'" class="section">
            <div v-if="isMifare && sectors.length" class="card card-pad classic-map">
              <div class="classic-map-head"><div><span class="field-label mono">存储分区</span><h3>扇区地图</h3></div><span class="hint">{{ sectors.length }} 个扇区 · 点击选择读取范围</span></div>
              <div class="sector-grid" aria-label="扇区地图">
                <button v-for="row in sectors" :key="row.index" class="sector-tile" :class="{ selected: classicSelectedSector === row.index }" :aria-pressed="classicSelectedSector === row.index" :aria-label="`选择扇区 ${row.index}`" :disabled="busy || !classic1k" :title="row.kinds" @click="onSelectClassicSector(row.index)"><span>扇区 {{ row.index }}</span><small>块 {{ row.start }}–{{ row.end }}</small></button>
              </div>
              <p v-if="!classic1k" class="hint">此卡型目前仅展示存储地图；认证读取支持 Classic 1K。</p>
            </div>
            <div v-if="isUltralight || type2Info" class="card card-pad tag-overview">
              <div class="tag-overview-head"><div><span class="field-label">TYPE 2 / NDEF</span><h3>{{ tagWriteStatus?.model || '可读写标签' }}</h3></div><div class="tag-overview-actions"><button v-if="type2Info" class="link" :disabled="busy || !connected" @click="exportTagMemory">导出 .bin</button><button class="btn btn-primary btn-sm" :disabled="busy || !connected" @click="onReadType2">{{ busy ? '读取中…' : '读取标签与权限' }}</button></div></div>
              <p v-if="!type2Info" class="hint">读取后显示型号、NDEF 内容、容量及当前工具支持的可写区域。</p>
              <template v-else>
                <div class="tag-stats"><div><small>NDEF 区容量</small><strong>{{ type2Info.userCapacity ?? type2Info.userMemory.length }} B</strong></div><div><small>现有 NDEF</small><strong>{{ type2Info.ndefTlv?.value.length ?? 0 }} B</strong></div><div><small>写入状态</small><strong>{{ tagWriteStatus?.label }}</strong></div></div>
                <p class="hint">{{ tagWriteStatus?.reason }}</p>
                <div class="tag-content"><span class="field-label">{{ type2Uri ? '网址记录' : type2Text ? '文本记录' : 'NDEF 数据' }}</span><pre>{{ type2Uri || type2Text || (type2Info.ndefTlv ? toHex(type2Info.ndefTlv.value) : '空标签，尚无 NDEF 内容') }}</pre></div>
              </template>
              <p v-if="type2ReadError" class="text-danger hint">{{ type2ReadError }}</p>
            </div>

            <div class="storage-actions">
            <!-- 读取数据块 -->
            <div v-if="isMifare" class="card card-pad classic-access">
              <div class="field-label mono">MIFARE CLASSIC 1K · 认证读取</div>
              <p class="hint">使用所选扇区的 Key A 或 Key B。密钥明文显示，仅保存在本页。</p>
              <div class="segment classic-mode" aria-label="读取范围"><button class="segment-item" :class="{ on: classicReadMode === 'block' }" :aria-pressed="classicReadMode === 'block'" :disabled="busy" @click="classicReadMode = 'block'">单块读取</button><button class="segment-item" :class="{ on: classicReadMode === 'sector' }" :aria-pressed="classicReadMode === 'sector'" :disabled="busy" @click="classicReadMode = 'sector'; classicSector = Math.floor(classicBlock / 4)">扇区读取</button></div>
              <p v-if="!chipSupported" class="text-danger hint">需要 raw RF 1.2 固件；请在连接设备页升级后重连。</p>
              <p v-else-if="!classic1k" class="hint">当前仅适配 Classic 1K（SAK 08）；此卡型暂不支持。</p>
              <div class="classic-fields">
                <label class="field-label">密钥类型<select v-model="classicKeyType" class="input" aria-label="密钥类型" :disabled="busy"><option value="A">Key A</option><option value="B">Key B</option></select></label>
                <label v-if="classicReadMode === 'block'" class="field-label">块号（0–63）<input v-model.number="classicBlock" class="input" type="number" min="0" max="63" :disabled="busy" /></label>
                <label v-else class="field-label">扇区<select v-model.number="classicSector" class="input" aria-label="读取扇区" :disabled="busy" @change="onSelectClassicSector(classicSector)"><option v-for="row in sectors" :key="row.index" :value="row.index">扇区 {{ row.index }} · 块 {{ row.start }}–{{ row.end }}</option></select></label>
              </div>
              <label class="field-label">扇区密钥（12 位十六进制）<input v-model="classicKey" type="text" autocomplete="off" :spellcheck="false" class="input classic-key-input" placeholder="6 字节 Key A / B" :disabled="busy" /></label>
              <label v-if="classicReadMode === 'sector'" class="classic-trailer"><input v-model="classicIncludeTrailer" type="checkbox" :disabled="busy" />包含访问控制块（块 {{ classicSector * 4 + 3 }}）</label>
              <button class="btn btn-primary btn-block" :disabled="busy || !connected || !chipSupported || !classic1k" @click="onMifareBlock()">{{ classicReadMode === 'sector' ? `读取扇区 ${classicSector}` : '认证并读取块' }}</button>
              <p v-if="classicStatus" class="hint classic-status" role="status">{{ classicStatus }}</p>
              <p class="hint classic-read-note">{{ classicReadMode === 'sector' ? `读取块 ${classicSector * 4}–${classicSector * 4 + (classicIncludeTrailer ? 3 : 2)}，扇区内复用一次认证。` : '读取前重新选卡并核对 UID。' }}射频异常时最多重读一次。</p>
            </div>
            <div v-if="isMifare" class="card card-pad classic-write">
              <div class="field-label mono">写入数据块</div>
              <p class="hint">使用左侧密钥，仅写入单个数据块。目标块在下方单独确认。</p>
              <label class="field-label">写入块号（0–63）<input v-model.number="classicBlock" class="input" type="number" min="0" max="63" :disabled="busy" /></label>
              <label class="field-label">数据（16 字节）<textarea v-model="classicWriteData" class="write-area" rows="3" placeholder="00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF" :disabled="busy" /></label>
              <p v-if="!classicWritable" class="hint">请选择数据块；块 0 和每个扇区的最后一块不能写入。</p>
              <button class="btn btn-dark btn-block" :disabled="busy || !connected || !chipSupported || !classic1k || !classicWritable" @click="onMifareBlock(true)">写入块并校验</button>
              <p class="hint">写前重新选卡核对 UID，失败时不自动重发。</p>
            </div>

            <!-- NTAG / Ultralight 分页读取 -->
            <div v-if="isUltralight" class="card card-pad">
              <div class="field-label mono">NTAG / Ultralight 分页读取</div>
              <div class="hint">每页 4 字节，一次读取 4 页；启用密码时先认证再读。</div>
              <input
                class="hex-input"
                type="number"
                :value="tagPage"
                @input="onTagPageInput"
                placeholder="起始页（十进制）"
              />
              <button class="btn btn-dark btn-block" :disabled="busy || !connected" @click="onReadTagPages">
                读取四页
              </button>
              <div v-for="row in tagPages" :key="row.page" class="kv">
                <span class="k">页 {{ row.page }}</span><span class="v mono">{{ row.hex }}</span>
              </div>
            </div>

            <!-- Type 2 / NDEF -->
            <div v-if="isUltralight || !info || type2Info" class="card card-pad ndef-editor">
              <div class="field-label mono">写入 NDEF</div>
              <div class="hint">
                写前核对 UID，写后回读校验。当前支持页 4–15 内的短文本与网址。
              </div>
              <button v-if="!isUltralight && !type2Info" class="btn btn-dark btn-block" :disabled="busy || !connected" @click="onReadType2">
                读取 Type 2 标签
              </button>
              <p v-if="type2ReadError && !isUltralight" class="text-danger hint">{{ type2ReadError }}</p>
              <div class="segment"><button class="segment-item" :class="{on: type2WriteKind === 'text'}" :disabled="busy" @click="type2WriteKind = 'text'">文本</button><button class="segment-item" :class="{on: type2WriteKind === 'uri'}" :disabled="busy" @click="type2WriteKind = 'uri'">网址</button></div>
              <input
                class="hex-input"
                v-model="type2WriteText"
                :placeholder="type2WriteKind === 'uri' ? 'https://example.com' : '要写入的文本'"
                :disabled="busy"
              />
              <div class="field-label mono">确认卡片 UID</div>
              <input
                class="hex-input mono"
                v-model="type2ConfirmUid"
                placeholder="读取后自动填入，核对无误再写"
              />
              <button
                class="btn btn-dark btn-block"
                :disabled="busy || !connected || Boolean(writeBlocked)"
                @click="onWriteType2Ndef"
              >
                {{ type2WriteKind === 'uri' ? '写入网址并校验' : '写入文本并校验' }}
              </button>
              <p v-if="type2Info" class="hint">{{ writePayload.bytes }} / {{ tagWriteStatus?.maxTlvBytes }} B（含 TLV）</p>
              <p class="hint">{{ writeBlocked || '写入后自动回读确认。' }}</p>
            </div>

            <div v-if="isUltralight || !info || type2Info" class="card card-pad tag-auth">
              <div class="field-label mono">NTAG 密码认证</div>
              <p class="hint">输入已有的 4 字节 PWD，密码仅保存在本页内存中。</p>
              <label class="password-toggle"><input type="checkbox" v-model="type2UsePassword" :disabled="busy" />使用已有密码（PWD_AUTH）</label>
              <div class="credential-fields">
              <label class="field-label">PWD（8 位十六进制）<input class="input" type="password" autocomplete="off" v-model="type2Password" :disabled="busy || !type2UsePassword" placeholder="4 字节 PWD" /></label>
              <label class="field-label">预期 PACK（选填）<input class="input" type="password" autocomplete="off" v-model="type2Pack" :disabled="busy || !type2UsePassword" placeholder="2 字节 PACK" /></label>
              </div>
              <button class="btn btn-dark btn-block" :disabled="busy || !connected || !type2UsePassword" @click="onReadType2">认证并读取</button>
              <p class="hint">{{ type2Info?.authenticated ? '本次读取已通过 PWD_AUTH；每次重新选卡后会再次认证。' : '认证失败不会自动重试密码。' }}</p>
            </div>
            </div>
            <div v-if="classicRows.length" class="card card-pad classic-results">
              <div class="classic-result-head"><span class="field-label mono">读取结果</span><span class="hint">{{ classicRows.length }} 块 · {{ classicRows.length * 16 }} B</span></div>
              <div class="classic-table-wrap"><table aria-label="Classic 分块读取结果"><thead><tr><th>块 / 类型</th><th>HEX · 16 字节</th><th>ASCII</th></tr></thead><tbody><tr v-for="row in classicRows" :key="row.block"><th scope="row">{{ row.block }}<small>{{ row.kind }}</small></th><td class="classic-hex">{{ row.hex }}</td><td class="classic-ascii">{{ row.ascii }}</td></tr></tbody></table></div>
              <details class="classic-raw"><summary>连续 HEX</summary><pre class="result-box" aria-label="Classic 读取结果">{{ classicResult }}</pre></details>
            </div>
            <div v-if="!isMifare && !isUltralight && !type2Info" class="section-head">
              <div class="section-left">
                <span class="section-index">02</span>
                <span class="section-title">存储分区</span>
              </div>
              <span class="section-aside mono">STORAGE</span>
            </div>

            <div class="stack">
              <div class="split">
                <!-- 文件清单 -->
                <div v-if="hasIsoDep || !info" class="card card-pad">
                  <div class="field-label mono">文件清单</div>
                  <div class="hint">{{ storageHint }}</div>
                  <button class="btn btn-dark btn-block" :disabled="busy || !hasIsoDep" @click="onListFiles">
                    读取文件清单
                  </button>
                  <div v-if="fileStatus" class="kv">
                    <span class="k">状态</span><span class="v wrap">{{ fileStatus }}</span>
                  </div>
                  <button
                    v-for="item in files"
                    :key="item.fid"
                    class="file-row"
                    :class="{ on: selectedFid === item.fid }"
                    @click="onPickFile(item.fid)"
                  >
                    <div class="file-main">
                      <span class="file-fid">{{ item.fidHex }}</span>
                      <span class="file-name">{{ item.tagName }}</span>
                    </div>
                    <span class="file-size">{{ item.size >= 0 ? item.size + ' B' : '—' }}</span>
                  </button>
                  <button
                    v-if="files.length"
                    class="btn btn-primary btn-block"
                    :disabled="busy || !selectedFid"
                    @click="onReadFile"
                  >
                    读出文件内容
                  </button>
                  <template v-if="files.length">
                    <div class="field-label mono">写入文件内容</div>
                    <textarea
                      class="hex-input write-area"
                      v-model="fileWriteText"
                      rows="3"
                      placeholder="要写进这个文件的内容"
                    />
                    <button
                      class="btn btn-dark btn-block"
                      :disabled="busy || !selectedFid"
                      @click="onWriteFile"
                    >
                      写入文件
                    </button>
                  </template>
                </div>


              </div>

              <!-- 文件内容 -->
              <div v-if="showFileContent" class="card card-pad">
                <div class="field-label mono">文件内容</div>
                <div v-if="fileEncrypted" class="kv">
                  <span class="k">加密状态</span><span class="v wrap">{{ fileEncrypted }}</span>
                </div>
                <div v-if="fileHex" class="result-box">{{ fileHex }}</div>
                <div v-if="fileAscii" class="field-label mono">ASCII</div>
                <div v-if="fileAscii" class="result-box">{{ fileAscii }}</div>
              </div>
            </div>
          </section>

          <!-- 03 工具 -->
          <section v-if="activeTab === 'tools'" class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">03</span>
                <span class="section-title">工具箱</span>
              </div>
              <span class="section-aside mono">TOOLS</span>
            </div>

            <div class="card card-pad bambu-spool">
              <div class="bambu-head">
                <div><span class="field-label mono">BAMBU LAB</span><h3>拓竹料盘解析工具</h3></div>
                <button class="btn btn-primary btn-sm" :disabled="busy || !connected || !chipSupported || !classic1k" @click="onReadBambu">{{ bambuReading ? '验证中…' : '开始验证' }}</button>
              </div>
              <p v-if="!bambuResult" class="hint">先在「卡片」页识别料盘标签，再验证认证与读取通路。仅支持 4 字节 UID 的 Classic 1K 标签。</p>
              <template v-else>
                <div class="bambu-specs">
                  <div><small>耗材 / 材质编号</small><span>{{ bambuResult.materialDetail || bambuResult.material }} · {{ bambuResult.materialId }}</span></div>
                  <div><small>颜色 RGBA</small><span><i class="bambu-color" :style="{ backgroundColor: '#' + bambuResult.colorRgba.slice(0, 6) }" />#{{ bambuResult.colorRgba }}</span></div>
                  <div><small>净重 / 直径</small><span>{{ bambuResult.weightGrams }} g · {{ bambuResult.diameterMm.toFixed(2) }} mm</span></div>
                  <div><small>喷嘴温度</small><span>{{ bambuResult.nozzleMinTemperature }}–{{ bambuResult.nozzleMaxTemperature }} °C</span></div>
                  <div><small>烘干</small><span>{{ bambuResult.dryingTemperature }} °C · {{ bambuResult.dryingHours }} 小时</span></div>
                  <div><small>生产时间</small><span>{{ bambuResult.productionDate.replace(/^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/, '$1-$2-$3 $4:$5') }}</span></div>
                </div>
                <details class="bambu-details"><summary>数据详情</summary>
                  <div class="kv"><span class="k">变体编号</span><span class="v">{{ bambuResult.variantId }}</span></div>
                  <div class="kv"><span class="k">Tray UID</span><span class="v mono wrap">{{ bambuResult.trayUid }}</span></div>
                  <div class="kv"><span class="k">床温 / 长度字段</span><span class="v">{{ bambuResult.bedTemperature }} °C / {{ bambuResult.lengthMeters }} m</span></div>
                  <div v-for="[block, data] in bambuResult.blocks" :key="block" class="kv"><span class="k">块 {{ block }}</span><span class="v mono wrap">{{ toHex(data) }}</span></div>
                  <a class="link" href="https://github.com/Bambu-Research-Group/RFID-Tag-Guide" target="_blank" rel="noopener noreferrer">社区格式参考 ↗</a>
                </details>
              </template>
              <div v-if="bambuKeys.length" class="bambu-keys">
                <div class="field-label">本次使用的密钥 · UID <span class="mono">{{ bambuKeyUid }}</span></div>
                <p class="hint">各扇区使用按当前 UID 派生的 Key A；下表对应本次实际尝试认证的块。</p>
                <table aria-label="料盘验证使用的密钥">
                  <thead><tr><th>扇区</th><th>读取块</th><th>类型</th><th>密钥（12 位 HEX）</th></tr></thead>
                  <tbody><tr v-for="key in bambuKeys" :key="key.sector"><td>{{ key.sector }}</td><td>{{ key.blocks.join('、') }}</td><td>Key A</td><td class="mono">{{ key.keyA }}</td></tr></tbody>
                </table>
                <details class="bambu-details"><summary>密钥派生方式</summary>
                  <p class="hint">HKDF-SHA256 · 输入为当前 4 字节 UID · 输出 96 字节，按每扇区 6 字节拆分。</p>
                  <div class="kv"><span class="k">Salt</span><span class="v mono wrap">9A759CF2C4F7CAFF222CB9769B41BC96</span></div>
                  <div class="kv"><span class="k">Info</span><span class="v mono">RFID-A\0</span></div>
                </details>
              </div>
              <p v-if="bambuStatus" class="hint classic-status" role="status">{{ bambuStatus }}</p>
            </div>

            <div class="stack">
              <div class="split">
                <!-- HEX 内容对比 -->
                <div class="card card-pad">
                  <div class="field-label mono">HEX 内容对比</div>
                  <div class="hint">
                    粘贴两段 hex（刷图前后的内容、固件版本、不同批次的卡），逐字节比对差异。
                  </div>
                  <input class="hex-input" v-model="hexLeft" placeholder="左侧内容（hex）" />
                  <input class="hex-input" v-model="hexRight" placeholder="右侧内容（hex）" />
                  <button class="btn btn-dark btn-block" @click="onCompare">对比</button>
                  <div v-if="diffSummary" class="kv">
                    <span class="k">结果</span><span class="v wrap">{{ diffSummary }}</span>
                  </div>
                  <div v-if="diffText" class="result-box">{{ diffText }}</div>
                </div>

              </div>
            </div>

            <!-- MIFARE Classic 安全审计 -->
            <MifareAuditPanel
              :available="chipSupported"
              :connected="connected"
              :busy="busy"
              :uid="card.uid"
              :classic1k="classic1k"
              @busy="busy = $event"
              @log="(level, message) => appStore.log(level, message)"
            />
          </section>

          <!-- 04 原始射频帧 -->
          <section v-if="activeTab === 'raw'" class="section">
            <div class="split raw-split">
              <div>
                <div class="section-head">
                  <div class="section-left">
                    <span class="section-index">04</span>
                    <span class="section-title">原始射频帧</span>
                  </div>
                  <span class="section-aside mono">RAW FRAME</span>
                </div>
                <div class="card card-pad">
                  <div class="hint">直接向射频场发送一帧原始字节，可用于厂商私有命令。</div>
                  <input class="hex-input" v-model="rawHex" placeholder="十六进制帧内容" />
                  <div v-if="rawRxModes.length" class="grid">
                    <label class="field-label">接收预设
                      <select aria-label="接收预设" v-model.number="rawRxMode" class="input input-sm" :disabled="busy || !rawModeSupported"><option v-for="mode in rawRxModes" :key="mode.id" :value="mode.id">{{ mode.id }} · {{ mode.label }}</option></select>
                    </label>
                    <label class="field-label">发送预设
                      <select aria-label="发送预设" v-model.number="rawTxMode" class="input input-sm" :disabled="busy || !rawModeSupported"><option :value="-1">跟随接收预设</option><option v-for="mode in rawTxModes" :key="mode.id" :value="mode.id">{{ mode.id }} · {{ mode.label }}</option></select>
                    </label>
                  </div>
                  <div class="chip-row">
                    <button class="option-chip" :class="{ on: rawTxLastBits }" @click="onToggleTxLastBits">
                      7 位短帧
                    </button>
                    <button class="option-chip" :class="{ on: rawCrcTx }" @click="onToggleCrcTx">发送加 CRC</button>
                    <button class="option-chip" :class="{ on: rawCrcRx }" @click="onToggleCrcRx">接收去 CRC</button>
                  </div>
                  <div class="chip-row">
                    <span class="field-label">超时</span>
                    <input
                      class="input input-sm timeout-input"
                      type="number"
                      :value="rawTimeout"
                      @input="onTimeoutInput"
                    />
                    <span class="field-label">毫秒（1..320）</span>
                  </div>
                  <div class="chip-row">
                    <span class="field-label">射频场</span>
                    <span class="field-label">{{ fieldOn ? '已开启' : '已关闭' }}</span>
                    <button class="btn btn-dark btn-sm" :disabled="busy || !fieldOn" @click="onTurnOffField">
                      关闭射频场
                    </button>
                  </div>
                  <button class="btn btn-dark btn-block" :disabled="busy || !connected" @click="onSendRaw">发送帧</button>
                  <div v-if="rawResult" class="result-box">{{ rawResult }}</div>
                </div>
              </div>

              <div>
                <div class="section-head">
                  <div class="section-left">
                    <span class="section-index">05</span>
                    <span class="section-title">ISO-DEP 指令</span>
                  </div>
                  <span class="section-aside mono">APDU</span>
                </div>
                <div class="card card-pad">
                  <div v-if="!hasIsoDep" class="hint">请先读取一张 ISO-DEP 卡片后再发送指令。</div>
                  <div v-else class="hint">APDU 以十六进制填写，将按 ISO-DEP 分块发送并显示状态字。</div>
                  <input class="hex-input" v-model="apduHex" placeholder="00A40000023F00" />
                  <button class="btn btn-dark btn-block" :disabled="busy || !hasIsoDep" @click="onSendApdu">
                    发送指令
                  </button>
                  <div v-if="apduResult" class="result-box">{{ apduResult }}</div>
                </div>
              </div>
            </div>
            <ChipTools :available="chipSupported" :connected="connected" :busy="busy" :uid="card.uid" @busy="busy = $event" />
          </section>
        </div>

        <aside class="workbench-aside scroll">
          <!-- 06 运行日志 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">07</span>
                <span class="section-title">运行日志</span>
              </div>
              <div class="head-actions">
                <button class="link muted" @click="onClearLogs">清空</button>
              </div>
            </div>
            <div class="card card-pad log-card">
              <div v-if="!logs.length" class="empty-desc">暂无日志</div>
              <div v-for="(entry, index) in logs" :key="index" class="log-line">
                <span class="log-time">{{ entry.time }}</span>
                <span class="log-msg" :class="entry.level">{{ entry.message }}</span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  </div>
</template>

<style scoped>
.bambu-spool { margin-bottom: 20px; background: #f1f5f3; }
.bambu-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.bambu-head h3 { font-size: 20px; font-weight: 400; margin: 4px 0 0; }
.bambu-specs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px 24px; margin: 20px 0; }
.bambu-specs small { display: block; font-size: 11px; color: var(--ink-45); margin-bottom: 6px; }
.bambu-specs span { display: flex; align-items: center; gap: 8px; font-size: 13px; overflow-wrap: anywhere; }
.bambu-color { width: 16px; height: 16px; flex-shrink: 0; border: 1px solid #0002; border-radius: 6px; }
.bambu-details { font-size: 12px; }.bambu-details summary { cursor: pointer; color: var(--ink-60); padding: 4px 0; }
.bambu-details .kv { gap: 20px; }.bambu-details .link { display: inline-block; margin-top: 12px; }
.bambu-keys { margin-top: 20px; padding-top: 16px; border-top: 1px solid #0001; }
.bambu-keys table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12px; text-align: left; }
.bambu-keys th, .bambu-keys td { padding: 9px 12px 9px 0; border-bottom: 1px solid #0001; }
.bambu-keys th { font-size: 11px; font-weight: 400; color: var(--ink-45); }
.bambu-keys td.mono { color: var(--ink); font-size: 12px; user-select: all; }
@media (max-width: 1100px) { .bambu-specs { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.card-status-note { margin-top: 20px; padding: 14px 16px; border-radius: 14px; line-height: 1.7; }
.classic-map { margin-bottom: 20px; }
.classic-map-head, .classic-result-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
.classic-map-head h3 { font-size: 18px; font-weight: 400; margin: 6px 0 0; }
.classic-map-head .hint, .classic-result-head .hint { margin: 0; }
.sector-grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 8px; }
.sector-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; padding: 11px 10px; background: #f1f3f0; border: 1px solid transparent; border-radius: 10px; font: 12px var(--font); color: var(--ink); cursor: pointer; text-align: left; }
.sector-tile small { font-size: 10px; color: var(--ink-45); }
.sector-tile.selected { background: #e6eee8; border-color: #8ea997; }.sector-tile:hover:not(:disabled) { border-color: #8ea997; }.sector-tile:disabled { opacity: .5; cursor: default; }
.classic-access, .classic-write { display: grid; align-content: start; gap: 16px; }
.classic-access > *, .classic-write > * { margin: 0; }
.classic-access .input, .classic-write .input { margin: 8px 0 0; }
.classic-access .btn-block, .classic-write .btn-block, .classic-write .write-area { margin: 0; }
.classic-access .classic-mode { margin: 0; }
.classic-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.classic-fields label { min-width: 0; }
.classic-trailer { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ink-70); }
.classic-read-note { line-height: 1.7; }
.classic-results { margin-bottom: 24px; }
.classic-table-wrap { overflow-x: auto; }
.classic-results table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
.classic-results th, .classic-results td { padding: 12px 14px 12px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.classic-results thead th { font-size: 10px; font-weight: 400; color: var(--ink-45); white-space: nowrap; }
.classic-results tbody th { min-width: 64px; font-weight: 400; }.classic-results tbody th small { display: block; font-size: 10px; font-weight: 400; color: var(--ink-45); margin-top: 5px; }
.classic-hex, .classic-ascii { font-family: var(--mono, monospace); line-height: 1.8; }.classic-hex { min-width: 240px; overflow-wrap: anywhere; }.classic-ascii { white-space: pre; }
.classic-raw { margin-top: 16px; font-size: 11px; }.classic-raw summary { cursor: pointer; color: var(--ink-70); }.classic-raw pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.classic-key-input { font-family: var(--mono, monospace); letter-spacing: .06em; }
.storage-actions > .classic-access { grid-column: 1; grid-row: 1; }.storage-actions > .classic-write { grid-column: 2; grid-row: 1; }.classic-status { overflow-wrap: anywhere; }
.probe-status-note { margin-top: 14px; }
.storage-workbench { grid-template-columns: minmax(0,1fr) clamp(240px, 20vw, 280px); }
.storage-actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 20px; margin-bottom: 24px; }
.storage-actions > .card + .card { margin-top: 0; }
.ndef-editor { grid-column: 2; grid-row: 1 / span 2; }
.tag-auth { grid-column: 1; grid-row: 1; }
.storage-actions > .card:not(.ndef-editor):not(.tag-auth):not(.classic-access):not(.classic-write) { grid-column: 1; grid-row: 2; }
.password-toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 16px; }
.credential-fields { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin-bottom: 16px; }
.tag-auth .input { margin-top: 6px; }
@media (max-width:1100px) { .storage-workbench { grid-template-columns: minmax(0,1fr); }.storage-workbench { overflow: auto; }.storage-workbench .workbench-main { height: auto; overflow: visible; }.storage-workbench .workbench-aside { height: auto; max-height: 220px; } }
@media (min-width: 1101px) and (max-width: 1450px) { .storage-workbench { grid-template-columns: minmax(0,1fr) 240px; } }
@media (min-width: 1101px) and (max-width: 1279px) { .sector-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

.tag-overview { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; margin-bottom: 20px; }
.tag-overview-head { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tag-overview-actions { display: flex; align-items: center; gap: 16px; }
.tag-overview h3 { margin: 0; font-size: 22px; font-weight: 400; }
.tag-overview > .hint { grid-column: 1; }.tag-overview > .text-danger { grid-column: 1 / -1; }
.tag-stats { grid-column: 1; display: grid; grid-template-columns: 1fr 1fr 1.6fr; gap: 12px; margin: 16px 0 8px; }.tag-stats small { display: block; color: var(--ink-45); font-size: 10px; }.tag-stats strong { display: block; font-size: 14px; font-weight: 400; margin-top: 6px; }
.tag-content { grid-column: 2; grid-row: 2 / span 2; align-self: stretch; background: #edf2ed; padding: 12px; border-radius: 12px; margin: 16px 0 0; max-height: 120px; overflow: auto; }.tag-content pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 var(--font); margin: 8px 0 0; }

/* 纵向节奏：小程序页面 wxss 里的间距，网页端全局类没有，这里补回来。 */
.hex-input {
  margin-bottom: 14px;
}

.write-area {
  resize: vertical;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(20, 22, 26, .12);
  background: transparent;
  color: var(--ink);
  width: 100%;
  box-sizing: border-box;
}

.probe-mode {
  font-size: 10px;
  color: var(--ink-45);
  margin-top: 3px;
}

.hint {
  margin-bottom: 14px;
}

.chip-row {
  margin-bottom: 14px;
}

.result-box {
  margin-top: 16px;
}

.btn-block {
  margin: 4px 0 14px;
}

/* 同一段里的卡片之间留一点缝。 */
.card + .card {
  margin-top: 16px;
}

/* 两栏栅格和右栏自己管间距，卡片不再叠加相邻卡片的上边距。 */
.split .card + .card,
.card-grid .card + .card,
.workbench-aside .card + .card {
  margin-top: 0;
}

/* 一栏里只剩一张卡时铺满整列。 */
.split > .card:only-child {
  grid-column: 1 / -1;
}

/* ---------------- 桌面栅格 ---------------- */

/* 主区按行堆叠，行距统一由 gap 控制。 */
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--gutter);
}

.stack > .card + .card {
  margin-top: 0;
}

/* 卡片识别：左列固定宽度放卡片图像，右列放识别信息；同一行两张卡等高。 */
.card-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: var(--gutter);
  align-items: stretch;
}

.card-grid > .card:only-child {
  grid-column: 1 / -1;
}

/* 识别信息：两列键值网格，标签在上、值在下。 */
.kv-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 26px;
}

.kv-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}

.kv-cell .k {
  font-size: 12px;
  color: var(--ink-45);
}

/* 全局 .v 是「左标签右值」的等宽右对齐写法，竖排格里要改回左对齐正文。 */
.kv-cell .v {
  font-family: var(--font);
  font-size: 14px;
  color: var(--ink);
  text-align: left;
  word-break: normal;
  overflow-wrap: anywhere;
}

.kv-cell .v.mono {
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.4px;
}

/* 主视觉卡：环放大一点，卡片图像和主按钮作为一组垂直居中。 */
.card-hero {
  display: flex;
  flex-direction: column;
}

.card-hero .card-visual {
  height: 220px;
  margin-top: auto;
  margin-bottom: 18px;
}

.card-hero .card-ring {
  width: 160px;
  height: 160px;
}

.card-hero .card-chip {
  width: 96px;
  height: 96px;
}

.card-hero .btn-block {
  margin: 0 0 auto;
  max-width: 340px;
  align-self: center;
}

/* 原始帧分区：两个小节并排。 */
.raw-split {
  align-items: start;
}

/* 右栏第一个就是日志小节，不要额外的上边距。 */
.workbench-aside .section {
  margin-top: 0;
}

/* 识别依据 */
.evidence {
  display: flex;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.evidence-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--lime);
  margin: 11px 13px 0 0;
  flex: none;
}

.evidence-text {
  flex: 1;
  font-size: 18px;
  color: var(--ink-70);
  line-height: 1.6;
}

/* 协议探测 */
.probe {
  padding: 13px 0;
  border-bottom: 1px solid var(--line);
}

.probe-name {
  font-size: 14px;
  color: var(--ink);
  font-weight: 600;
}

.probe-note {
  margin-top: 4px;
  font-size: 17px;
  color: var(--ink-45);
  line-height: 1.5;
}

/* 文件行 */
.file-main {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 11px;
}

/* 并排按钮 */
.btn-row {
  display: flex;
  gap: 11px;
  margin-bottom: 14px;
}

.btn-row .btn {
  flex: 1;
}

/* 穷举候选 */
.hit-card {
  margin-top: 12px;
}

/* 超时输入 */
.timeout-input {
  width: 96px;
  flex: none;
}

</style>
