<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import ModalPanel from '@/components/ModalPanel.vue'
import FirmwareUpdate from '@/components/FirmwareUpdate.vue'
import { transportManager, switchTransport, hasTransportPreference, bluetoothAvailable, usbAvailable } from '@/platform'
import { readerConnection, signalInfo } from '@/core/ble/connection'
import { deviceSession, type DeviceInfo, type DeviceSession, type SessionHello, type CapabilityDescriptor } from '@/core/protocol'
import { toHex } from '@/core/hex'
import { capabilityOperationIssue } from '@/core/protocol/features'
import { readerLogs } from '@/core/ble/readerLogs'
import { epdSession } from '@/core/rf/session'
import { MANUAL_FIELD_MS } from '@/core/rf/bridge'
import { isAutoSleepEnabled, type AutoSleepState } from '@/core/rf/autoSleep'
import { appStore } from '@/core/store/index'
import { showToast } from '@/platform/ui'
import { useConnection } from '@/composables/useConnection'

const router = useRouter()
const route = useRoute()

const status = ref(transportManager.status)
const modePickerOpen = ref(transportManager.status !== 'connected' && !hasTransportPreference())
const busy = ref(false)
const actionBusy = ref(false)
const otaBusy = ref(false)
const readySession = shallowRef<DeviceSession | null>(null)
const logs = ref<ReturnType<typeof readerLogs.recent>>([])
const now = ref(Date.now())

const fieldOn = ref(false)
const fieldManual = ref(false)
const fieldRemaining = ref(0)

const deviceInfo = ref<DeviceInfo | null>(null)
const helloInfo = ref<SessionHello | null>(null)
const deviceCapabilities = ref<CapabilityDescriptor[]>([])
const powerUnavailable = computed(() => readySession.value
  ? capabilityOperationIssue(readySession.value.capabilities, 'org.example.rf.clrc663.config', 'set_tx_amplitude')
  : '等待设备握手并确认功率控制能力')
const hardwareLabel = ref('')
const infoLoading = ref(false)
const infoError = ref('')
let infoRevision = 0
async function loadDeviceInfo() {
  if (infoLoading.value || otaBusy.value) return
  const revision = ++infoRevision
  deviceInfo.value = null
  infoError.value = ''
  if (status.value !== 'connected') { infoLoading.value = false; return }
  infoLoading.value = true
  try {
    const session = await deviceSession.require()
    if (revision !== infoRevision) return
    readySession.value = session
    helloInfo.value = session.hello
    hardwareLabel.value = session.profile.label
    deviceCapabilities.value = [...session.capabilities]
    appStore.log('info', `设备公布能力：${session.capabilities.map(cap => `${cap.id} v${cap.majorVersion}.${cap.minorVersion}`).join('、') || '无'}`)
    const details = await session.getDeviceInfo()
    if (revision === infoRevision && status.value === 'connected') {
      deviceInfo.value = details
      appStore.log('info', `固件 ${details.firmwareName} ${details.firmwareVersion}；控制器 ${details.radioController || '未知'}`)
    }
  } catch (error) {
    if (revision === infoRevision) infoError.value = error instanceof Error ? error.message : String(error)
  } finally { if (revision === infoRevision) infoLoading.value = false }
}
/** 发射功率档位；null 表示还没读到。 */
const txAmplitude = ref<number | null>(null)
const txAmplitudeBusy = ref(false)

/** 发射功率档位与说明。 */
const TX_LEVELS = [
  { level: 0, hint: 'TxAmp 档位 0' },
  { level: 1, hint: '默认' },
  { level: 2, hint: 'TxAmp 档位 2' },
  { level: 3, hint: 'TxAmp 档位 3' },
]

let ticker = 0
let unsubStatus: (() => void) | null = null
let unsubLogs: (() => void) | null = null
let unsubField: (() => void) | null = null
let unsubAutoSleep: (() => void) | null = null
let unsubConnection: (() => void) | null = null

const { connection } = useConnection()
const isBluetooth = computed(() => connection.value.kind === 'bluetooth')
const isUsb = computed(() => connection.value.kind === 'usb')
const autoReturn = computed(() => route.query.return === '1')

const statusText = computed(() => {
  if (status.value === 'connected') {
    return '读卡器已连接'
  }
  if (status.value === 'connecting') {
    return '正在连接读卡器…'
  }
  if (status.value === 'scanning') {
    return '正在搜索读卡器…'
  }
  if (status.value === 'error') {
    return '读卡器未连接'
  }
  return '暂未连接读卡器'
})

const statusHint = computed(() => {
  if (status.value === 'connected') {
    return autoReturn.value ? '连接成功，即将返回上一页' : '连接正常，可管理读卡器'
  }
  if (appStore.bleMessage) {
    return appStore.bleMessage
  }
  if (isUsb.value) return '请连接 RF Device USB HID 设备，并在浏览器弹窗中授权'
  return '请确保读卡器已上电并靠近电脑'
})

/**
 * 信号强度。
 *
 * 浏览器蓝牙 API 不提供 RSSI，所以这里永远是「信号未知」——
 * 不拿别的数字冒充信号。
 */
const signal = computed(() => signalInfo(connection.value.rssi))
const signalCells = computed(() => [1, 2, 3, 4].map(value => value <= signal.value.bars))

const deviceName = computed(() => connection.value.name || '等待读卡器')
const deviceId = computed(() => connection.value.deviceId)
const bluetoothMac = computed(() => deviceInfo.value?.bluetoothMac?.length === 6
  ? toHex(deviceInfo.value.bluetoothMac, ':') : '当前固件未提供')
async function copyDeviceDetails(): Promise<void> {
  const info = deviceInfo.value
  const hello = helloInfo.value
  const text = [
    `设备名称：${deviceName.value}`, `硬件方案：${hardwareLabel.value || '—'}`,
    `固件：${info?.firmwareName || '—'} ${info?.firmwareVersion || ''}`,
    `射频芯片：${info?.radioController || '—'}`, `蓝牙 MAC：${bluetoothMac.value}`,
    `浏览器设备 ID：${deviceId.value || '—'}`,
    `设备 ID：${info ? toHex(info.deviceId) : hello ? toHex(hello.deviceId) : '—'}`,
    `启动 ID：${info ? toHex(info.bootId) : hello ? toHex(hello.bootId) : '—'}`,
    `协议版本：${hello ? `${hello.protocolMajor}.${hello.protocolMinor}` : '—'}`,
    ...deviceCapabilities.value.map(cap => `${cap.id} ${cap.majorVersion}.${cap.minorVersion}：${cap.operations.map(op => op.id).join(' / ')}`),
  ].join('\n')
  try { await navigator.clipboard.writeText(text); showToast('设备详情已复制', 'success') }
  catch { showToast('复制失败，请允许浏览器访问剪贴板') }
}

const connectedDuration = computed(() => {
  if (!connection.value.connectedAt) {
    return '—'
  }
  const seconds = Math.max(0, Math.floor((now.value - connection.value.connectedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}分 ${String(rest).padStart(2, '0')}秒`
})

const packetSize = computed(() => {
  if (status.value !== 'connected') {
    return '—'
  }
  return `${connection.value.chunkSize} B`
})

const fieldText = computed(() => {
  if (!fieldOn.value) {
    return '已关闭'
  }
  if (fieldManual.value) {
    return `${Math.max(0, Math.ceil(fieldRemaining.value / 1000))} 秒后自动关闭`
  }
  return '开启中'
})

// ---------------- 自动休眠 ----------------

/** 空闲时用短脉冲保活，避免设备因关场掉电。 */
const autoSleepEnabled = ref(isAutoSleepEnabled())
/** 当前连接的方案支不支持自动休眠。 */
const autoSleepSupported = ref(false)
/** 自动休眠的运行时状态。 */
const autoSleepState = ref<AutoSleepState | null>(null)

const autoSleepText = computed(() => {
  if (status.value !== 'connected') {
    return '连接后生效'
  }
  if (!autoSleepSupported.value) {
    return '当前方案不支持'
  }
  const state = autoSleepState.value
  if (!state) {
    return ''
  }
  if (state.busy) {
    return '通信中，射频场保持开启'
  }
  if (state.pulsing) {
    return '正在唤醒设备…'
  }
  if (state.asleep) {
    return '已休眠，等下次操作唤醒'
  }
  const seconds = Math.max(0, Math.ceil(state.nextPulseInMs / 1000))
  if (!state.enabled) {
    return `持续保活 · ${seconds} 秒后唤醒`
  }
  const minutes = Math.max(0, Math.ceil(state.windowRemainingMs / 60000))
  return `${seconds} 秒后唤醒 · ${minutes} 分钟后深睡`
})

function toggleAutoSleep(): void {
  const next = !autoSleepEnabled.value
  autoSleepEnabled.value = next
  epdSession.rfBridge.setAutoSleepEnabled(next)
  appStore.log(
    'info',
    next
      ? '已打开自动休眠：闲时每 10 秒唤醒 1 秒，10 分钟无操作后进入深睡'
      : '已关闭自动休眠：闲时每 10 秒唤醒 1 秒，持续保活不休眠',
  )
}

async function connect(): Promise<void> {
  if (status.value === 'connected') {
    return
  }
  busy.value = true
  try {
    await readerConnection.connect(1)
    showToast('连接成功', 'success')
    if (autoReturn.value) {
      window.setTimeout(() => {
        if (window.history.length > 1) {
          router.back()
        } else {
          router.replace('/')
        }
      }, 900)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== '已取消选择设备') {
      showToast(`连接失败：${message}`, 'none', 2600)
    }
  } finally {
    busy.value = false
  }
}

async function reconnect(): Promise<void> {
  actionBusy.value = true
  try {
    await readerConnection.cancel()
    await epdSession.rfBridge.turnOffField().catch(() => undefined)
    await transportManager.disconnect().catch(() => undefined)
    appStore.log('info', '手动重新连接')
    await connect()
  } finally {
    actionBusy.value = false
  }
}

async function disconnect(): Promise<void> {
  actionBusy.value = true
  try {
    appStore.log('info', '手动断开连接')
    await transportManager.disconnect().catch(() => undefined)
  } finally {
    actionBusy.value = false
  }
}

async function turnOnField(): Promise<void> {
  if (otaBusy.value) return
  if (status.value !== 'connected') {
    showToast('请先连接读卡器')
    return
  }
  actionBusy.value = true
  try {
    await epdSession.rfBridge.turnOnFieldManually(MANUAL_FIELD_MS)
    appStore.log('info', '已手动打开射频场，1 分钟后自动关闭')
    showToast('射频场已打开', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `开场失败：${message}`)
    showToast('开场失败，请重试')
  } finally {
    actionBusy.value = false
  }
}

async function turnOffField(): Promise<void> {
  if (otaBusy.value) return
  actionBusy.value = true
  try {
    await epdSession.rfBridge.turnOffField()
    appStore.log('info', '射频场已关闭')
    showToast('射频场已关闭', 'success')
  } catch (error) {
    showToast('关场失败，请重试')
  } finally {
    actionBusy.value = false
  }
}

/**
 * 读取当前发射功率档位。
 *
 * 档位是设备侧的设置（CLRC663 的 TxAmp），换一台设备就是另一个值，
 * 所以连上以后要现读一次，不能拿本地存的数当真。
 */
let powerRevision = 0
async function loadTxAmplitude(): Promise<void> {
  if (otaBusy.value) return
  if (status.value !== 'connected') {
    return
  }
  const revision = ++powerRevision
  try {
    const session = await deviceSession.require()
    const applied = await session.getTxAmplitude()
    if (revision === powerRevision && status.value === 'connected' && deviceSession.current === session) txAmplitude.value = applied
  } catch (error) {
    if (revision !== powerRevision || status.value !== 'connected') return
    appStore.log('warn', `读取发射功率失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function setTxAmplitude(level: number): Promise<void> {
  if (txAmplitudeBusy.value || otaBusy.value || status.value !== 'connected' || powerUnavailable.value) {
    return
  }
  txAmplitudeBusy.value = true
  try {
    const session = await deviceSession.require()
    const applied = await session.setTxAmplitude(level)
    txAmplitude.value = applied
    appStore.log('info', `发射功率已设为 ${applied}`)
    showToast(`发射功率：${applied}`, 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appStore.log('error', `设置发射功率失败：${message}`)
    showToast('设置失败，请重试')
  } finally {
    txAmplitudeBusy.value = false
  }
}

function onSwitchTransport(kind: 'bluetooth' | 'usb'): void {
  if (kind === 'usb' && !usbAvailable()) return
  if (kind === 'bluetooth' && !bluetoothAvailable()) return
  const previous = transportManager.kind
  switchTransport(kind)
  if (kind === previous) {
    return
  }
  appStore.log('info', `已切换到${kind === 'bluetooth' ? '蓝牙' : 'USB HID'}传输`)
}

function chooseMode(kind: 'bluetooth' | 'usb'): void {
  if (busy.value || actionBusy.value) return
  if ((kind === 'usb' && !usbAvailable()) || (kind === 'bluetooth' && !bluetoothAvailable())) return
  onSwitchTransport(kind)
  modePickerOpen.value = false
  void connect()
}

function connectWithPreference(): void {
  if (!hasTransportPreference()) modePickerOpen.value = true
  else void connect()
}

onMounted(() => {
  unsubStatus = transportManager.onStatus((next, message) => {
    status.value = next
    if (next === 'connected') {
      appStore.bleMessage = message
      autoSleepSupported.value = epdSession.rfBridge.autoSleepSupported
      autoSleepState.value = epdSession.rfBridge.autoSleepState
      void loadTxAmplitude()
      void loadDeviceInfo()
    } else {
      ++powerRevision
      txAmplitude.value = null
      readySession.value = null
      ++infoRevision
      deviceInfo.value = null; helloInfo.value = null; deviceCapabilities.value = []; hardwareLabel.value = ''; infoError.value = ''; infoLoading.value = false
      autoSleepSupported.value = false
      autoSleepState.value = null
    }
  })
  unsubLogs = readerLogs.subscribe(() => {
    logs.value = readerLogs.recent(200)
  })
  unsubField = epdSession.rfBridge.onField(state => {
    fieldOn.value = state.on
    fieldManual.value = state.manual
    fieldRemaining.value = state.remainingMs
  })
  unsubAutoSleep = epdSession.rfBridge.onAutoSleep(state => {
    autoSleepState.value = state
  })
  unsubConnection = readerConnection.subscribe(() => {
    busy.value = readerConnection.state.running
  })
  logs.value = readerLogs.recent(200)
  ticker = window.setInterval(() => {
    now.value = Date.now()
    const state = epdSession.rfBridge.fieldState
    fieldOn.value = state.on
    fieldManual.value = state.manual
    fieldRemaining.value = state.remainingMs
    autoSleepSupported.value = epdSession.rfBridge.autoSleepSupported
    autoSleepState.value = epdSession.rfBridge.autoSleepState
  }, 1000)
  if (status.value === 'connected') { void loadTxAmplitude(); void loadDeviceInfo() }
  // 浏览器设备授权需要用户手势，由连接按钮发起。
})

onBeforeUnmount(() => {
  ++powerRevision
  ++infoRevision
  if (ticker) {
    window.clearInterval(ticker)
    ticker = 0
  }
  unsubStatus?.()
  unsubLogs?.()
  unsubField?.()
  unsubAutoSleep?.()
  unsubConnection?.()
})
</script>

<template>
  <div class="page" :class="{ 'device-connected': status === 'connected' }">
    <main class="shell">
      <NavBar title="连接设备" subtitle="BLUETOOTH / USB">
        <template #right>
          <div class="transport-switch">
            <button
              class="ts-btn"
              :class="{ on: isBluetooth }"
              :disabled="!bluetoothAvailable() || otaBusy"
              title="浏览器蓝牙"
              @click="onSwitchTransport('bluetooth')"
            >
              蓝牙
            </button>
            <button
              class="ts-btn"
              :class="{ on: isUsb }"
              :disabled="!usbAvailable() || otaBusy"
              title="USB HID"
              @click="onSwitchTransport('usb')"
            >
              USB
            </button>
          </div>
        </template>
      </NavBar>

      <div class="workbench">
        <div class="workbench-main">
          <!-- 雷达 -->
          <section class="radar-wrap">
            <div class="radar">
              <i class="ring r1" />
              <i class="ring r2" />
              <i class="ring r3" />
              <div class="radar-core">
                <div class="radar-chip"><i /><i /><i /></div>
              </div>
            </div>
            <div class="status-text">{{ statusText }}</div>
            <div class="status-hint-plain">{{ statusHint }}</div>
            <div v-if="busy" class="attempt">正在选择设备…</div>
          </section>

          <!-- 读卡器状态 -->
          <section class="card card-pad reader-card">
            <div class="reader-eyebrow">READER STATUS</div>
            <div class="reader-row">
              <div class="reader-name">{{ deviceName }}</div>
              <div class="signal">
                <i v-for="(cell, index) in signalCells" :key="index" class="signal-bar" :class="{ on: cell }" />
              </div>
            </div>
            <div v-if="isBluetooth" class="reader-sub">
              <span>{{ signal.label }}</span>
              <span class="mono">{{ signal.label === '信号未知' ? '-- dBm' : `${transportManager.lastRssi} dBm` }}</span>
              <span class="mono">浏览器蓝牙不提供 RSSI</span>
            </div>

            <div class="reader-details">
              <div class="detail-cell">
                <div class="detail-label">连接时长</div>
                <div class="detail-value">{{ connectedDuration }}</div>
              </div>
              <div class="detail-cell">
                <div class="detail-label">当前分片</div>
                <div class="detail-value" title="当前模式的分片长度。刷图验证通过后可使用更大长度，以连接日志为准；该值不等于实际 MTU。">{{ packetSize }}</div>
              </div>
            </div>
            <div v-if="deviceId && status === 'connected'" class="device-id mono">{{ deviceId }}</div>
          </section>

          <!-- 操作 -->
          <section v-if="status === 'connected'" class="actions">
            <!-- 射频场的开关只在 02 区块里做，这里不再放第二个同名按钮：
                 两处入口会让用户以为关掉了场，实际另一处还开着。 -->
            <button class="btn btn-ghost btn-block" :disabled="actionBusy || otaBusy" @click="reconnect">重新连接</button>
            <button class="btn action-disconnect" :disabled="actionBusy || otaBusy" @click="disconnect">断开连接</button>
          </section>
          <section v-else-if="!busy" class="actions">
            <button class="btn btn-primary btn-block" :disabled="busy || otaBusy || (isBluetooth ? !bluetoothAvailable() : !usbAvailable())" @click="connectWithPreference">{{ busy ? '正在连接…' : '连接读卡器' }}</button>
            <div class="guide-hint auto-return">
              {{ isBluetooth ? '点击后选择名字以 D4U-NFC 开头的读卡器。连接方式会保留，可在右上角手动切换。' : '点击后选择 RF Device USB HID 设备。需要 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开。' }}
            </div>
          </section>
          <section v-if="status === 'connected'" class="card card-pad device-info-card">
            <div class="device-info-head"><span>设备详情</span><button class="link" :disabled="infoLoading || !helloInfo" @click="copyDeviceDetails">复制详情</button><button class="link" :disabled="infoLoading || otaBusy" @click="loadDeviceInfo">{{ infoLoading ? '读取中…' : '刷新' }}</button></div>
            <p v-if="infoError" class="device-info-error">{{ infoError }}</p>
            <dl class="device-info-grid">
              <div><dt>硬件方案</dt><dd>{{ hardwareLabel || '等待握手' }}</dd></div>
              <div><dt>射频芯片</dt><dd>{{ deviceInfo?.radioController || '—' }}</dd></div>
              <div><dt>固件名称</dt><dd>{{ deviceInfo?.firmwareName || '—' }}</dd></div>
              <div><dt>固件版本</dt><dd>{{ deviceInfo?.firmwareVersion || '—' }}</dd></div>
              <div><dt>设备 ID（固件）</dt><dd class="device-hex">{{ deviceInfo ? toHex(deviceInfo.deviceId) : helloInfo ? toHex(helloInfo.deviceId) : '—' }}</dd></div>
              <div><dt>蓝牙 MAC</dt><dd class="device-hex">{{ bluetoothMac }}</dd></div>
              <div><dt>启动 ID</dt><dd class="device-hex">{{ deviceInfo ? toHex(deviceInfo.bootId) : helloInfo ? toHex(helloInfo.bootId) : '—' }}</dd></div>
              <div><dt>协议版本</dt><dd>{{ helloInfo ? `${helloInfo.protocolMajor}.${helloInfo.protocolMinor}` : '—' }}</dd></div>
              <div><dt>控制消息上限</dt><dd>{{ helloInfo ? `${helloInfo.maxControlMessage} B` : '—' }}</dd></div>
              <div><dt>协商数据块上限</dt><dd>{{ helloInfo ? `${helloInfo.maxDataChunk} B` : '—' }}</dd></div>
              <div><dt>并发作业上限</dt><dd>{{ helloInfo?.maxInFlightJobs ?? '—' }}</dd></div>
              <div><dt>设备声明传输</dt><dd>{{ helloInfo?.transports.join(' / ') || '—' }}</dd></div>
              <div><dt>当前连接</dt><dd>{{ isBluetooth ? 'Bluetooth' : 'USB HID' }}</dd></div>
            </dl>
            <details v-if="deviceCapabilities.length" class="device-capabilities"><summary>支持能力 · {{ deviceCapabilities.length }}</summary><div v-for="cap in deviceCapabilities" :key="cap.id"><strong>{{ cap.id }} · {{ cap.majorVersion }}.{{ cap.minorVersion }}</strong><span>{{ cap.operations.map(op => op.id).join(' / ') }}</span></div></details>
          </section>


          <FirmwareUpdate :session="readySession" :connected="status === 'connected'" :running-version="deviceInfo?.firmwareVersion" :disabled="actionBusy || infoLoading || txAmplitudeBusy" @busy="otaBusy = $event" @reconnect="connectWithPreference" @verify="loadDeviceInfo" />
        </div>

        <aside class="workbench-aside scroll">
          <!-- 射频场 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">02</span>
                <span class="section-title">射频场</span>
              </div>
              <span class="section-aside">{{ fieldText }}</span>
            </div>
            <div class="card card-pad field-card">
              <div class="field-status">
                <span class="field-dot" :class="{ on: fieldOn }" />
                <span>{{ fieldOn ? '射频场已打开' : '射频场已关闭' }}</span>
              </div>
              <button v-if="!fieldOn" class="btn btn-ghost btn-sm" :disabled="status !== 'connected' || actionBusy || otaBusy" @click="turnOnField">
                打开射频场
              </button>
              <button v-else class="btn btn-ghost btn-sm" :disabled="actionBusy || otaBusy" @click="turnOffField">关闭射频场</button>

              <!-- 自动休眠：B01 这类硬件关场就掉电，闲时改用短脉冲保活。 -->
              <div class="auto-sleep-row">
                <div class="auto-sleep-text">
                  <span class="auto-sleep-title">自动休眠</span>
                  <span class="auto-sleep-state">{{ autoSleepText }}</span>
                </div>
                <button
                  class="switch"
                  :class="{ on: autoSleepEnabled }"
                  role="switch"
                  :aria-checked="autoSleepEnabled"
                  :disabled="status === 'connected' && !autoSleepSupported"
                  :title="autoSleepSupported === false && status === 'connected' ? '当前硬件方案不支持自动休眠' : '闲时每 10 秒唤醒 1 秒；打开后 10 分钟无操作进入深睡'"
                  @click="toggleAutoSleep"
                />
              </div>

              <div class="field-note">为避免读卡器过热，请勿长时间打开射频场。手动打开后 1 分钟会自动关闭。</div>
              <div class="auto-sleep-note">自动休眠：闲时每 10 秒把射频场打开 1 秒再关掉，让设备别因关场掉电；10 分钟没人操作就停掉脉冲进入深睡，下一次操作再唤醒。刷图和通用 NFC 通信期间不关场。</div>
            </div>
          </section>

          <!-- 发射功率 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">03</span>
                <span class="section-title">发射幅度</span>
              </div>
              <span class="section-aside">{{ txAmplitude === null ? '未知' : `档位 ${txAmplitude}` }}</span>
            </div>
            <div class="card card-pad power-card">
              <div class="power-grid">
                <button
                  v-for="item in TX_LEVELS"
                  :key="item.level"
                  class="power-btn"
                  :class="{ on: txAmplitude === item.level }"
                  :disabled="status !== 'connected' || txAmplitudeBusy || otaBusy || !!powerUnavailable"
                  :title="item.hint"
                  @click="setTxAmplitude(item.level)"
                >
                  {{ item.level }}
                </button>
              </div>
              <p v-if="status === 'connected' && readySession && powerUnavailable" class="hint text-danger">{{ powerUnavailable }}</p>
              <div class="field-note">
                TxAmp 档位 0–3，默认 1。修改立即生效，设备掉电后恢复默认；档位不是毫瓦值，实际场强与线圈、匹配和标签位置有关。
              </div>
            </div>
          </section>

          <!-- 运行日志 -->
          <section class="section">
            <div class="section-head">
              <div class="section-left">
                <span class="section-index">04</span>
                <span class="section-title">运行日志</span>
                <span class="count">{{ logs.length }}</span>
              </div>
              <div class="head-actions">
                <button class="link muted" @click="readerLogs.clear()">清空</button>
              </div>
            </div>
            <div class="card card-pad log-card">
              <div v-if="!logs.length" class="empty-desc">暂无日志</div>
              <div v-for="(entry, index) in logs" :key="index" class="log-line">
                <span class="log-time">{{ entry.time }}</span>
                <span class="log-src" :class="entry.source">{{ entry.source === 'app' ? '运行' : '连接' }}</span>
                <span class="log-msg" :class="entry.level">{{ entry.message }}</span>
              </div>
            </div>
          </section>
        </aside>
      </div>
      <ModalPanel :open="modePickerOpen" title="选择连接方式" :width="480" @close="modePickerOpen = false">
        <div class="mode-choices">
          <button class="mode-choice mode-usb" type="button" :disabled="!usbAvailable() || busy" @click="chooseMode('usb')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 21V3m0 0-3 3m3-3 3 3M12 16l-5-4V8m5 5 5-4V6M5 8h4M15 4h4v3h-4z" /></svg>
            <strong>USB</strong><span>{{ usbAvailable() ? '通过 USB HID 有线连接' : '当前浏览器不支持 WebHID' }}</span>
          </button>
          <button class="mode-choice mode-bluetooth" type="button" :disabled="!bluetoothAvailable() || busy" @click="chooseMode('bluetooth')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 7 10 10-5 4V3l5 4L7 17" /></svg>
            <strong>蓝牙</strong><span>{{ bluetoothAvailable() ? '通过蓝牙无线连接' : '当前浏览器不支持' }}</span>
          </button>
        </div>
      </ModalPanel>
    </main>
  </div>
</template>

<style scoped>
.device-info-card { margin-top: 18px; }.device-info-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.device-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; margin: 18px 0 0; }
.device-info-grid dt { font-size: 10px; color: var(--ink-45); }.device-info-grid dd { font-size: 12px; margin: 4px 0 0; overflow-wrap: anywhere; }.device-hex { font-family: var(--mono); }
.device-info-error { font-size: 11px; color: var(--danger); }.device-capabilities { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 12px; font-size: 11px; }.device-capabilities summary { cursor: pointer; }.device-capabilities div { padding-top: 12px; overflow-wrap: anywhere; }.device-capabilities strong { font-weight: 500; }.device-capabilities span { display: block; margin-top: 4px; color: var(--ink-70); }

.mode-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 8px; }
.mode-choice { display: flex; align-items: flex-start; flex-direction: column; gap: 12px; padding: 22px 18px; border: 1px solid transparent; border-radius: 16px; cursor: pointer; color: #49634f; background: #e9f0e7; text-align: left; }
.mode-bluetooth { background: #e8eef6; color: #526e8b; }
.mode-choice:hover:not(:disabled) { border-color: currentColor; }
.mode-choice:disabled { opacity: .45; cursor: not-allowed; }
.mode-choice svg { width: 28px; height: 28px; }
.mode-choice strong { font-size: 17px; font-weight: 500; }
.mode-choice span { font-size: 11px; }

.transport-switch {
  display: flex;
  background: var(--paper);
  border-radius: 0;
  padding: 0;
  gap: 2px;
}

.ts-btn {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  padding: 6px 12px;
  border-radius: 0;
  cursor: pointer;
  color: var(--ink-70);
}

.ts-btn.on {
  background: transparent;
  border-bottom: 1px solid #333;
  font-weight: 400;
  color: var(--ink);
  box-shadow: none;
}

.ts-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.power-card { display: grid; gap: 12px; }
.power-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.power-btn {
  border: 1px solid var(--line, rgba(20, 22, 26, .12));
  background: transparent;
  border-radius: 10px;
  padding: 12px 0;
  font-family: inherit;
  font-size: 15px;
  cursor: pointer;
  color: var(--ink-70);
  transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.power-btn:hover:not(:disabled) { color: var(--ink); border-color: rgba(20, 22, 26, .28); }
.power-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.power-btn:disabled { opacity: .4; cursor: not-allowed; }

/* 雷达 */
.radar-wrap {
  text-align: center;
  padding: 32px 0 8px;
}

.radar {
  position: relative;
  width: 240px;
  height: 240px;
  margin: 0 auto 22px;
}

.radar .ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(20, 22, 26, 0.12);
}

.radar .r1 {
  inset: 37%;
}
.radar .r2 {
  inset: 21%;
  border-color: rgba(20, 22, 26, 0.07);
}
.radar .r3 {
  inset: 4%;
  border-color: rgba(20, 22, 26, 0.04);
}

.radar-core {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: var(--ink);
  box-shadow: none;
  display: flex;
  align-items: center;
  justify-content: center;

}

.radar-chip {
  width: 46px;
  height: 34px;
  border-radius: 6px;
  border: 4px solid var(--lime);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0 6px;
}

.radar-chip i {
  height: 2px;
  background: var(--lime);
  width: 100%;
}

.radar-chip i:nth-child(2) {
  width: 70%;
}
.radar-chip i:nth-child(3) {
  width: 45%;
}

.radar-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px;
  border-radius: 50%;
  background: var(--lime-deep);
  transform-origin: 0 0;
  animation: d4u-spin 6s linear infinite;
}

.status-text {
  font-size: 22px;
  font-weight: 400;
}

.status-hint-plain {
  font-size: 18px;
  color: var(--ink-45);
  line-height: 1.7;
  margin-top: 7px;
}

.attempt {
  display: inline-block;
  margin-top: 13px;
  padding: 5px 15px;
  border-radius: 14px;
  background: var(--paper-deep);
  font-size: 16px;
  color: var(--ink-70);
}

/* 状态卡 */
.reader-card {
  margin-top: 22px;
}

.reader-eyebrow {
  font-size: 14px;
  letter-spacing: 2.4px;
  color: var(--ink-45);
  font-family: var(--mono);
}

.reader-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 9px;
  gap: 14px;
}

.reader-name {
  font-size: 24px;
  font-weight: 600;
}

.signal {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 34px;
}

.signal-bar {
  width: 8px;
  border-radius: 3px;
  background: var(--paper-deep);
}

.signal-bar:nth-child(1) {
  height: 14px;
}
.signal-bar:nth-child(2) {
  height: 21px;
}
.signal-bar:nth-child(3) {
  height: 27px;
}
.signal-bar:nth-child(4) {
  height: 34px;
}

.signal-bar.on {
  background: var(--olive);
}

.reader-sub {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin-top: 7px;
  font-size: 17px;
  color: var(--ink-45);
  flex-wrap: wrap;
}

.reader-details {
  display: flex;
  border-top: 1px solid var(--line);
  margin-top: 17px;
  padding-top: 15px;
  gap: 12px;
}

.detail-cell {
  flex: 1;
}

.detail-label {
  font-size: 17px;
  color: var(--ink-45);
}

.detail-value {
  font-size: 20px;
  margin-top: 3px;
}

.device-id {
  margin-top: 13px;
  font-size: 14px;
  word-break: break-all;
  text-transform: none;
}

/* 操作 */
.actions {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.action-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.action-disconnect {
  background: #fff;
  border: 1px solid #edd4d0;
  color: var(--danger);
  width: 100%;
}

.auto-return {
  text-align: center;
}

/* 射频场 */
.field-card {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.field-status {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 19px;
  flex: 1;
  min-width: 130px;
}

.field-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--ink-25);
  flex: none;
}

.field-dot.on {
  background: var(--olive);
  box-shadow: 0 0 0 5px rgba(111, 125, 34, 0.16);
}

/* 自动休眠开关 */
.auto-sleep-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex: 1;
  min-width: 220px;
  padding-top: 2px;
}

.auto-sleep-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.auto-sleep-title {
  font-size: 14px;
}

.auto-sleep-state {
  font-size: 12px;
  color: var(--ink-45);
}

/* 全局 .switch 的开启底色是近白的浅灰，跟关闭态几乎看不出差别。
   这一颗开关的状态是要一眼看出来的，所以单独用主题强调色。 */
.auto-sleep-row .switch.on {
  background: var(--olive);
}

.auto-sleep-row .switch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.auto-sleep-note {
  width: 100%;
  font-size: 13px;
  color: var(--ink-70);
  line-height: 1.6;
}

.field-note {
  width: 100%;
  font-size: 16px;
  color: var(--warn);
  line-height: 1.6;
}
@keyframes reader-pulse {
  0%, 100% { box-shadow: 0 0 0 0 #9b9b922a; }
  50% { box-shadow: 0 0 0 16px #9b9b9200; }
}
@media (prefers-reduced-motion: reduce) {
  .radar-core, .radar-dot { animation: none; }
}
</style>
