<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import type { DeviceSession, FirmwareProgress, FirmwareImageInfo } from '@/core/protocol'
import { epdSession } from '@/core/rf/session'
import { transportManager } from '@/platform'
import { showModal, showToast } from '@/platform/ui'
import { appStore } from '@/core/store'

const props = defineProps<{ session: DeviceSession | null; connected: boolean; disabled?: boolean; runningVersion?: string }>()
const emit = defineEmits<{ busy: [value: boolean]; reconnect: []; verify: [] }>()
const image = shallowRef<Uint8Array | null>(null)
const imageInfo = ref<FirmwareImageInfo | null>(null)
const filename = ref('')
const sha256 = ref('')
const message = ref('')
const failed = ref(false)
const busy = ref(false)
const progress = ref<FirmwareProgress | null>(null)
const messageNode = ref<HTMLElement | null>(null)
const verificationNode = ref<HTMLElement | null>(null)
const target = ref<{ id: string; version: string; scheme: string } | null>(null)
let revision = 0
let controller: AbortController | undefined
const percent = computed(() => progress.value ? Math.floor(progress.value.sent * 100 / progress.value.total) : 0)
const stage = computed(() => progress.value?.stage)
const identity = (session: DeviceSession | null) => Array.from(session?.hello?.deviceId ?? []).join(':')
const verification = computed(() => {
  if (!['rebooting', 'finalizing'].includes(stage.value || '') || busy.value || !props.connected || !target.value) return null
  if (!props.session) return { ok: false, text: '正在确认设备信息…' }
  if (!target.value.id || identity(props.session) !== target.value.id) return { ok: false, text: '尚未确认是原设备，请连接刚才升级的读卡器。' }
  if (!props.runningVersion) return { ok: false, text: '正在读取设备运行版本…' }
  const ok = Boolean(target.value.version) && props.runningVersion === target.value.version
  return { ok, text: ok ? `已重新连接原设备，运行版本 ${props.runningVersion}，升级版本已确认。` : `当前运行版本 ${props.runningVersion}，与目标 ${target.value.version || '未知'} 不一致；升级未确认，请检查设备状态。` }
})
watch(() => verification.value?.text, async text => {
  if (!text) return
  await nextTick()
  verificationNode.value?.scrollIntoView({ block: 'nearest' })
})
const canStop = computed(() => busy.value && progress.value && ['preparing', 'uploading'].includes(progress.value.stage))

async function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  const currentRevision = ++revision
  image.value = null; imageInfo.value = null; sha256.value = ''; message.value = ''; progress.value = null; target.value = null; failed.value = false; filename.value = file.name
  try {
    if (!file.name.toLowerCase().endsWith('.bin') || file.size > 4 * 1024 * 1024) throw new Error('请选择不超过 4 MB 的应用固件 .bin')
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!props.session?.inspectFirmware) throw new Error('当前硬件方案不支持固件镜像检查')
    const info = props.session.inspectFirmware(bytes)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    if (revision !== currentRevision) return
    image.value = bytes; imageInfo.value = info; sha256.value = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
  } catch (error) { if (revision === currentRevision) { message.value = error instanceof Error ? error.message : String(error); failed.value = true } }
}

async function start() {
  const session = props.session, bytes = image.value
  if (busy.value || props.disabled || !props.connected || !session?.uploadFirmware || !bytes) return
  busy.value = true; emit('busy', true); failed.value = false; message.value = ''; progress.value = null
  try {
    const accepted = await showModal({ title: '升级读卡器固件', content: `${transportManager.connectedName || session.profile.label}\n应用：${imageInfo.value?.project || '—'}\n目标版本：${imageInfo.value?.version || '—'}\n文件：${filename.value}\n上传完成后设备会重启。请保持供电与蓝牙连接。`, confirmText: '开始升级' })
    if (!accepted) return
    if (!props.connected || props.session !== session) throw new Error('设备连接已变化，请重新连接并确认固件')
    target.value = { id: identity(session), version: imageInfo.value?.version || '', scheme: session.profile.scheme }
    controller = new AbortController()
    await epdSession.rfBridge.turnOffField()
    await session.uploadFirmware(bytes, { signal: controller.signal, onProgress: value => {
      progress.value = value
      message.value = ({ preparing: '检查镜像并准备传输…', uploading: '正在上传固件…', finalizing: '设备正在校验并切换固件，请勿断电…', rebooting: '上传与切换请求已确认。设备重启后，请重新连接检查固件版本。' })[value.stage]
    } })
    appStore.log('success', `OTA 上传已确认 · ${imageInfo.value?.version || filename.value}；重连后检查版本`)
  } catch (error) {
    failed.value = true
    message.value = controller?.signal.aborted && stage.value !== 'finalizing' ? '上传已停止，未请求切换固件。请重新连接后再试。' : error instanceof Error ? error.message : String(error)
    appStore.log('error', `OTA：${message.value}`)
  } finally {
    if (session.firmwareRequiresReconnect || controller?.signal.aborted) await transportManager.disconnect().catch(() => undefined)
    controller = undefined; busy.value = false; emit('busy', false)
    await nextTick()
    messageNode.value?.scrollIntoView({ block: 'nearest' })
  }
}

function stop() {
  if (!canStop.value) return
  controller?.abort()
  message.value = '正在停止上传…'
  void transportManager.disconnect().catch(() => undefined)
}
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(() => { if (busy.value) { showToast('请先完成或停止固件上传'); return false } })
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { ++revision; controller?.abort(); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <section v-if="connected || message" class="card card-pad firmware-card">
    <div class="firmware-heading"><span>固件升级</span><span class="firmware-tag">OTA · {{ session?.profile.scheme || target?.scheme || '—' }}</span></div>
    <p class="firmware-note">选择当前硬件方案的应用固件 .bin。旧固件如不支持 OTA，需先通过有线烧录支持 OTA 的版本。</p>
    <div class="firmware-file"><label class="btn btn-ghost btn-sm">选择固件 .bin<input type="file" accept=".bin" aria-label="选择应用固件" :disabled="busy || disabled || !connected" @change="choose" /></label><span>{{ filename || '尚未选择文件' }}</span></div>
    <dl v-if="imageInfo" class="firmware-info"><div><dt>应用</dt><dd>{{ imageInfo.project || '—' }}</dd></div><div><dt>目标版本</dt><dd>{{ imageInfo.version || '—' }}</dd></div><div><dt>大小</dt><dd>{{ ((image?.length || 0) / 1024).toFixed(1) }} KB</dd></div></dl>
    <p v-if="sha256" class="firmware-hash" :title="sha256">SHA-256 {{ sha256 }}</p>
    <div v-if="progress" class="firmware-progress"><progress :value="progress.sent" :max="progress.total" aria-label="固件上传进度" /><span>{{ percent }}% · {{ progress.sent }} / {{ progress.total }} B</span></div>
    <p v-if="message" ref="messageNode" class="firmware-message" :class="{ failed }" role="status">{{ message }}</p>
    <p v-if="verification" ref="verificationNode" class="firmware-message" :class="{ verified: verification.ok }" role="status">{{ verification.text }}</p>
    <div class="firmware-buttons"><button class="btn btn-primary btn-sm" :disabled="busy || disabled || !connected || !image || !session?.uploadFirmware" @click="start">{{ busy ? '升级中…' : '上传并升级' }}</button><button v-if="canStop" class="btn btn-ghost btn-sm" @click="stop">停止上传</button><button v-if="!connected && message && !busy" class="btn btn-ghost btn-sm" @click="emit('reconnect')">重新连接</button><button v-if="verification" class="btn btn-ghost btn-sm" :disabled="disabled || busy" @click="emit('verify')">检查运行版本</button></div>
  </section>
</template>

<style scoped>
.firmware-card { margin-top: 18px; }.firmware-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; font-size: 13px; }.firmware-tag { color: #788d7b; background: #e9efe7; border-radius: 7px; padding: 4px 8px; font-size: 10px; }
.firmware-note, .firmware-message { font-size: 12px; line-height: 1.8; color: var(--ink-70); margin: 14px 0; }.firmware-file { display: flex; align-items: center; gap: 14px; font-size: 12px; min-width: 0; }.firmware-file > span { overflow-wrap: anywhere; }.firmware-file label { position: relative; display: inline-flex; align-items: center; flex: none; cursor: pointer; }.firmware-file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }.firmware-file label:focus-within { outline: 2px solid #91a88e; outline-offset: 2px; }
.firmware-info { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; margin: 18px 0 12px; }.firmware-info dt { font-size: 10px; color: var(--ink-45); }.firmware-info dd { margin: 5px 0 0; font-size: 12px; overflow-wrap: anywhere; }.firmware-hash { font: 10px/1.8 var(--mono); color: var(--ink-45); overflow-wrap: anywhere; margin-bottom: 16px; }.firmware-buttons { display: flex; gap: 12px; }.firmware-message.failed { color: var(--danger); }.firmware-progress progress { display: block; width: 100%; height: 7px; border: 0; border-radius: 6px; overflow: hidden; accent-color: #789782; background: #e5eae2; }.firmware-progress progress::-webkit-progress-bar { background: #e5eae2; }.firmware-progress progress::-webkit-progress-value { background: #789782; border-radius: 6px; }.firmware-progress span { display: block; margin-top: 7px; font: 10px var(--mono); color: var(--ink-70); }
.firmware-message.verified { color: #58785f; }.firmware-buttons { flex-wrap: wrap; }
.firmware-card { display: grid; gap: 16px; }
.firmware-card > * { margin: 0; }
.firmware-file { flex-wrap: wrap; row-gap: 10px; }
.firmware-file > span { flex: 1 1 160px; min-width: 0; }
.firmware-buttons { padding-top: 4px; }
</style>
