<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ModalPanel from './ModalPanel.vue'
import tutorialPortrait from '@/assets/tutorial/lakeside-portrait-photo.png'
import readerPhoto from '@/assets/tutorial/black-reader-smooth.png'
import panelPhoto from '@/assets/tutorial/white-epaper-photo.png'
import { DEFAULT_OPTIONS, prepareHuaweiAsync } from '@/core/image/pipeline'
const displayPortrait = ref(tutorialPortrait)
const displayReader = ref(readerPhoto)
const displayPanel = ref(panelPhoto)
const processedPortrait = ref(tutorialPortrait)
let disposed = false
async function preparePhoto(): Promise<void> {
  const image = new Image()
  image.src = tutorialPortrait
  await image.decode()
  if (disposed) return
  const canvas = document.createElement('canvas')
  canvas.width = 138; canvas.height = 192
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#fff'; context.fillRect(0, 0, 138, 192)
  context.drawImage(image, 0, 0, 138, 192)
  displayPortrait.value = canvas.toDataURL('image/webp', .78)
  const rgba = context.getImageData(0, 0, 138, 192).data
  const rgb = new Uint8Array(138 * 192 * 3)
  for (let i = 0; i < 138 * 192; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3)
  const prepared = await prepareHuaweiAsync(rgb, 138, 192, DEFAULT_OPTIONS, { skipPacked: true })
  if (disposed || !prepared?.preview) return
  context.putImageData(new ImageData(new Uint8ClampedArray(prepared.preview), 138, 192), 0, 0)
  processedPortrait.value = canvas.toDataURL('image/png')
}
async function prepareHardwarePhotos(): Promise<void> {
  await Promise.all([
    { source: readerPhoto, target: displayReader, width: 120, height: 240 },
    { source: panelPhoto, target: displayPanel, width: 186, height: 258 },
  ].map(async ({ source, target, width, height }) => {
    const image = new Image()
    image.src = source
    await image.decode()
    if (disposed) return
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    target.value = canvas.toDataURL('image/webp', .8)
  }))
}
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; start: [] }>()
const steps = [
  { title: '连接读卡器', duration: 3000, note: '选择 D4U-NFC 蓝牙设备，或通过 USB HID 有线连接。' },
  { title: '选择图片', duration: 4000, note: '添加图片，勾选本次要刷入的画面。' },
  { title: '图像处理', duration: 4000, note: '调整亮度与对比度，确认四色预览。' },
  { title: '放置墨水屏', duration: 3000, note: '将墨水屏贴近读卡器的感应区域，放稳后保持不动。' },
  { title: '开始刷写', duration: 6000, note: '点击开始刷图。传输与显色期间保持贴近，完成后再移开。' },
]
const step = ref(0), elapsed = ref(0), reducedMotion = ref(false)
const paused = ref(false), pageHidden = ref(false)
const finished = computed(() => step.value === steps.length - 1 && elapsed.value >= current.value.duration)
const current = computed(() => steps[step.value])
const progress = computed(() => Math.min(1, elapsed.value / current.value.duration))
const totalDuration = steps.reduce((sum, item) => sum + item.duration, 0)
const overallProgress = computed(() => (steps.slice(0, step.value).reduce((sum, item) => sum + item.duration, 0) + Math.min(elapsed.value, current.value.duration)) / totalDuration)
const phase = computed(() => step.value === 4 ? progress.value < .18 ? 0 : progress.value < .58 ? 1 : progress.value < .83 ? 2 : 3 : progress.value < .35 ? 0 : progress.value < .72 ? 1 : 2)
const captions = [ ['选择蓝牙设备', '建立连接', '已连接'], ['添加图片', '图片进入队列', '已选中'], ['调节画面', '生成四色预览', '预览已就绪'], ['对准感应区域', '贴近读卡器', '保持位置不动'], ['开始刷图', '正在传输', '正在显色 · 请勿移开', '刷写完成，可以移开'] ]
const status = computed(() => captions[step.value][phase.value])
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (value: number) => 1 - Math.pow(1 - clamp(value), 3)
const placement = computed(() => step.value > 3 ? 1 : step.value === 3 ? ease((progress.value - .08) / .64) : 0)
const panelTransform = computed(() => `translate(${754 - 146 * placement.value} ${118 + 108 * placement.value}) rotate(${-8 * (1 - placement.value)} 51 71)`)
const selected = computed(() => step.value > 1 || step.value === 1 && progress.value >= .72)
const imported = computed(() => step.value > 1 ? 1 : step.value === 1 ? ease((progress.value - .15) / .4) : 0)
const processed = computed(() => step.value > 2 ? 1 : step.value === 2 ? clamp((progress.value - .24) / .48) : 0)
const transfer = computed(() => step.value === 4 ? clamp((progress.value - .18) / .4) : 0)
const revealed = computed(() => step.value === 4 ? clamp((progress.value - .58) / .25) : 0)
const dot = computed(() => {
  const p = progress.value
  if (step.value === 0) return { x: 416 - 44 * ease(p / .3), y: 307 - 17 * ease(p / .3), opacity: p < .65 ? 1 : 0 }
  if (step.value === 1) { const t = ease((p - .38) / .3); return { x: 391 - 159 * t, y: 286 - 102 * t, opacity: p < .86 ? 1 : 0 } }
  if (step.value === 2) { const t = ease((p - .06) / .3); const contrast = ease((p - .4) / .28); return { x: p < .4 ? 330 + 35 * t : 372 - 29 * contrast, y: p < .4 ? 204 : 245, opacity: p < .78 ? 1 : 0 } }
  return { x: 372, y: 290, opacity: step.value === 4 && p < .28 ? 1 : 0 }
})
let frame = 0, startedAt = 0, media: MediaQueryList | undefined
let photosStarted = false
function prepareAssets() {
  if (photosStarted) return
  photosStarted = true
  void Promise.all([preparePhoto(), prepareHardwarePhotos()]).catch(() => undefined)
}
function stop() { cancelAnimationFrame(frame); frame = 0 }
function resume() {
  stop()
  if (!props.open || reducedMotion.value || paused.value || pageHidden.value || finished.value) return
  startedAt = performance.now() - elapsed.value
  frame = requestAnimationFrame(tick)
}
function tick(now: number) {
  frame = 0
  if (!props.open || reducedMotion.value || paused.value || pageHidden.value) return
  const duration = Math.max(0, now - startedAt)
  if (duration >= current.value.duration) {
    if (step.value === steps.length - 1) {
      elapsed.value = current.value.duration
      paused.value = true
    } else select(step.value + 1)
    return
  }
  elapsed.value = duration
  frame = requestAnimationFrame(tick)
}
function select(index: number) {
  if (index < 0 || index >= steps.length) return
  stop(); step.value = index; elapsed.value = reducedMotion.value ? steps[index].duration : 0
  resume()
}
function replay() { paused.value = false; select(0) }
function togglePlayback() {
  if (finished.value) { replay(); return }
  paused.value = !paused.value
  if (paused.value) stop(); else resume()
}
function visibilityChanged() {
  pageHidden.value = document.hidden
  if (pageHidden.value) stop(); else resume()
}
function motionChanged(event: MediaQueryListEvent) { reducedMotion.value = event.matches }
watch(() => props.open, open => {
  if (open) { prepareAssets(); replay() } else stop()
})
watch(reducedMotion, reduced => {
  stop()
  if (reduced) elapsed.value = current.value.duration
  else { elapsed.value = 0; resume() }
})
onMounted(() => {
  media = matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = media.matches
  media.addEventListener('change', motionChanged)
  document.addEventListener('visibilitychange', visibilityChanged)
  pageHidden.value = document.hidden
  if (props.open) { prepareAssets(); replay() }
})
onBeforeUnmount(() => {
  disposed = true; stop()
  media?.removeEventListener('change', motionChanged)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <ModalPanel :open="open" title="刷图教程" :width="960" @close="emit('close')">
    <div class="tutorial">
      <div class="tutorial-scene" :data-step="step + 1" :data-phase="phase">
        <div class="scene-status" aria-live="polite"><i :class="{ ready: phase >= 2 }" />{{ status }}</div>
        <span class="scene-count">0{{ step + 1 }} / 05</span>
        <svg class="tutorial-art" viewBox="0 0 900 420" role="img" :aria-label="current.title + '操作动画'">
          <defs>
            <symbol id="lesson-photo" viewBox="0 0 112 156">
              <image :href="displayPortrait" width="112" height="156" preserveAspectRatio="xMidYMid meet" />
            </symbol>
            <symbol id="lesson-ink" viewBox="0 0 112 156">
              <image :href="processedPortrait" width="112" height="156" preserveAspectRatio="xMidYMid meet" />
            </symbol>
            <clipPath id="lesson-photo-reveal"><rect width="112" :height="156" :style="{ width: 112 * processed + 'px' }" /></clipPath>
            <symbol id="lesson-reader" viewBox="0 0 887 1774">
              <image :href="displayReader" width="887" height="1774" preserveAspectRatio="xMidYMid meet" />
            </symbol>
            <clipPath id="lesson-white-enclosure"><rect width="124" height="172" rx="12" /></clipPath>
            <symbol id="lesson-panel" viewBox="0 0 124 172">
              <g clip-path="url(#lesson-white-enclosure)"><image :href="displayPanel" x="-8" y="-10" width="141" height="190" preserveAspectRatio="none" /></g>
            </symbol>
            <clipPath id="lesson-computer-clip"><rect x="86" y="105" width="388" height="232" rx="7" /></clipPath>
            <clipPath id="lesson-panel-clip"><rect x="7" y="8" width="88" :height="122 * revealed" rx="6" /></clipPath>
          </defs>
          <ellipse cx="452" cy="374" rx="390" ry="12" fill="#dfe5dc" opacity=".55" />
          <path d="M42 376h816" stroke="#d7e0d3" />
          <!-- Persistent desk: only the contents and panel position change. -->
          <g class="lesson-computer">
            <rect x="73" y="91" width="414" height="256" rx="15" fill="#dbe2de" stroke="#aebcb1" stroke-width="1.5" />
            <rect x="86" y="105" width="388" height="232" rx="7" fill="#fffefa" />
            <circle cx="280" cy="98" r="2" fill="#9cac9e" />
            <path d="M73 347h414l25 18q-1 9-25 9H73q-24 0-25-9Z" fill="#ccd6ce" stroke="#aebcb1" />
            <path d="M249 348h62l-6 6h-50Z" fill="#a7b7aa" />
            <g clip-path="url(#lesson-computer-clip)">
              <path d="M86 139h388" stroke="#e7eae2" />
              <circle cx="100" cy="122" r="3" fill="#d8afa4" /><circle cx="112" cy="122" r="3" fill="#e6cd98" /><circle cx="124" cy="122" r="3" fill="#aac4ad" />
              <text x="145" y="126" class="art-text small">D4U · NFC-tools</text>
              <circle cx="407" cy="122" r="3" :fill="step > 0 || phase === 2 ? '#7f9e83' : '#c4cbbc'" />
              <text x="418" y="126" class="art-text tiny">{{ step > 0 || phase === 2 ? '已连接' : '待连接' }}</text>
              <g class="screen-pane" :opacity="step === 0 ? 1 : 0">
                <text x="112" y="170" class="art-text strong">连接读卡器</text>
                <rect x="110" y="188" width="338" height="62" rx="10" :fill="phase > 0 ? '#e7efe5' : '#f0f3ec'" />
                <path d="m130 208 13 14-7 7v-29l7 7-13 15" fill="none" stroke="#7591ac" stroke-width="1.6" />
                <text x="157" y="215" class="art-text">D4U-NFCA01-2136</text>
                <text x="157" y="235" class="art-text tiny">蓝牙读卡器</text>
                <rect x="325" y="276" width="94" height="29" rx="8" fill="#5d7f66" />
                <text x="372" y="295" class="button-text" text-anchor="middle">{{ phase === 2 ? '已连接 ✓' : '连接设备' }}</text>
              </g>
              <g class="screen-pane" :opacity="step > 0 ? 1 : 0">
                <text x="110" y="164" class="art-text strong">{{ step === 1 ? '图片队列' : step === 2 ? '图像处理' : '刷图引导' }}</text>
                <rect x="118" y="176" width="120" height="134" rx="9" fill="#edf1e8" stroke="#d9e2d3" stroke-dasharray="4 4" />
                <g :transform="`translate(${122 + 194 * (1 - imported)} ${180 - 23 * (1 - imported)})`" :opacity="imported > 0 ? 1 : 0">
                  <use href="#lesson-photo" width="112" height="125" />
                  <svg x="0" y="0" width="112" height="125" viewBox="0 0 112 156" preserveAspectRatio="xMidYMid meet"><g clip-path="url(#lesson-photo-reveal)"><use href="#lesson-ink" width="112" height="156" /></g></svg>
                </g>
                <rect v-if="selected" x="114" y="172" width="128" height="142" rx="12" fill="none" stroke="#7d9e81" stroke-width="1.7" />
                <g v-if="selected"><circle cx="232" cy="184" r="9" fill="#6c9277" /><path d="m228 184 3 3 5-6" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" /></g>
                <text x="178" y="327" class="art-text tiny" text-anchor="middle">{{ imported ? '山水人像.png' : '等待添加图片' }}</text>
                <g :opacity="step === 1 ? 1 : 0" class="screen-pane">
                  <text x="280" y="207" class="art-text">选一张喜欢的画面</text>
                  <text x="280" y="229" class="art-text tiny">添加后，勾选要刷入的图片</text>
                  <rect x="339" y="273" width="102" height="28" rx="8" fill="#e7eee3" /><text x="390" y="291" class="art-text small" text-anchor="middle">＋ 添加图片</text>
                </g>
                <g :opacity="step === 2 ? 1 : 0" class="screen-pane">
                  <text x="281" y="188" class="art-text tiny">亮度</text><path d="M285 204h150" stroke="#d3ddce" stroke-width="4" stroke-linecap="round" />
                  <circle :cx="330 + 35 * ease((progress - .06) / .3)" cy="204" r="6" fill="#88a18b" />
                  <text x="281" y="229" class="art-text tiny">对比度</text><path d="M285 245h150" stroke="#d3ddce" stroke-width="4" stroke-linecap="round" />
                  <circle :cx="372 - 29 * ease((progress - .4) / .28)" cy="245" r="6" fill="#88a18b" />
                  <text x="281" y="286" class="art-text tiny">四色预览</text><g stroke="#ccd4c7"><circle cx="352" cy="282" r="5" fill="#fffef5" /><circle cx="373" cy="282" r="5" fill="#2e3831" /><circle cx="394" cy="282" r="5" fill="#edcc57" /><circle cx="415" cy="282" r="5" fill="#b95e4c" /></g>
                </g>
                <g :opacity="step >= 3 ? 1 : 0" class="screen-pane">
                  <text x="279" y="204" class="art-text">{{ step === 3 ? '画面已准备好' : phase === 0 ? '贴近读卡器' : phase === 1 ? '正在传输图像' : phase === 2 ? '等待屏幕显色' : '刷写完成 ✓' }}</text>
                  <text x="279" y="228" class="art-text tiny">{{ step === 4 && phase > 0 ? Math.round(transfer * 100) + '% · 图像传输' : '将墨水屏放在感应区域' }}</text>
                  <rect x="281" y="245" width="155" height="4" rx="2" fill="#e4e9dc" /><rect x="281" y="245" :width="155 * transfer" height="4" rx="2" fill="#84a187" />
                  <rect x="325" y="276" width="94" height="29" rx="8" :fill="step === 4 && phase === 0 ? '#5d7f66' : '#e7eee3'" />
                  <text x="372" y="295" text-anchor="middle" :class="step === 4 && phase === 0 ? 'button-text' : 'art-text small'">{{ step === 3 || phase === 0 ? '开始刷图' : phase === 1 ? '正在传输' : phase === 2 ? '正在显色' : '已完成' }}</text>
                </g>
              </g>
            </g>
          </g>
          <g class="lesson-link" :opacity="step > 0 || phase > 0 ? 1 : .3">
            <path d="M512 285h70" stroke="#b6cbd4" stroke-dasharray="3 5" stroke-width="1.5" />
            <path d="m536 257 18 19-9 9v-38l9 9-18 20" fill="none" stroke="#809caf" stroke-width="2" stroke-linejoin="round" />
            <circle v-for="i in 2" :key="i" :cx="512 + ((elapsed / 900 + i / 2) % 1) * 70" cy="285" r="3" fill="#8fae9b" :opacity="step === 4 && phase === 1 ? .8 : 0" />
          </g>
          <g class="lesson-reader">
            <ellipse cx="659" cy="330" rx="91" ry="40" fill="#e0e9da" :opacity="step >= 3 ? .75 : .25" />
            <use href="#lesson-reader" x="609" y="180" width="100" height="160" />
          </g>
          <g class="lesson-panel" :transform="panelTransform">
            <use href="#lesson-panel" width="102" height="142" />
            <path d="M25 60h52m-26-15v30" stroke="#e4e1d5" stroke-width="2" stroke-linecap="round" :opacity="1 - revealed" />
            <g clip-path="url(#lesson-panel-clip)"><svg x="7" y="8" width="88" height="122" viewBox="0 0 112 156" preserveAspectRatio="xMidYMid meet"><use href="#lesson-ink" width="112" height="156" /></svg></g>
            <rect x="7" y="8" width="88" height="122" rx="6" fill="#354238" :opacity="step === 4 && phase === 2 ? .65 * Math.sin(revealed * Math.PI) : 0" />
          </g>
          <g class="placement-guide" :opacity="step === 3 && phase < 2 ? .8 : 0"><path d="m737 213-20 8m4-10-4 10 10 4" fill="none" stroke="#90a48e" stroke-width="2" stroke-linecap="round" /></g>
          <g class="completion-mark" :opacity="step === 4 && phase === 3 ? 1 : 0"><circle cx="742" cy="229" r="18" fill="#e1eddd" stroke="#b9ceaf" /><path d="m734 229 6 6 11-13" fill="none" stroke="#749679" stroke-width="2" stroke-linecap="round" /></g>
          <circle class="interaction-dot" :cx="dot.x" :cy="dot.y" r="10" :opacity="reducedMotion ? 0 : dot.opacity" fill="#6f97a4" fill-opacity=".2" stroke="#6c929c" stroke-opacity=".4" stroke-width="1.4" />
          <text x="280" y="402" class="device-label" text-anchor="middle">浏览器</text>
          <text x="659" y="402" class="device-label" text-anchor="middle">读卡器</text>
          <text x="806" y="287" class="device-label" text-anchor="middle" :opacity="step < 3 ? 1 : 0">墨水屏</text>
          <text x="659" y="160" class="device-label" text-anchor="middle" :opacity="step === 3 && phase === 2 || step === 4 && phase < 3 ? 1 : 0">保持贴近，请勿移开</text>
        </svg>
        <div class="tutorial-caption"><span class="tutorial-number">0{{ step + 1 }}</span><div><h3>{{ current.title }}</h3><p>{{ current.note }}</p></div></div>
      </div>
      <button v-if="finished" type="button" class="btn btn-primary btn-block" @click="emit('start')">开始准备我的图片</button>
      <div class="tutorial-controls" aria-label="教程播放控制">
        <span>操作演示 · 不会连接设备或写入屏幕</span>
        <div>
          <button type="button" :disabled="step === 0" @click="select(step - 1)">上一步</button>
          <button v-if="!reducedMotion" type="button" :aria-pressed="!paused" @click="togglePlayback">{{ finished ? '重新播放' : paused ? '继续播放' : '暂停播放' }}</button>
          <button v-else type="button" @click="replay">回到开始</button>
          <button type="button" :disabled="step === steps.length - 1" @click="select(step + 1)">下一步</button>
        </div>
      </div>
      <div class="tutorial-footer">
        <div class="tutorial-ring" role="progressbar" aria-label="教程整体进度" :aria-valuenow="Math.round(overallProgress * 100)" :aria-valuemin="0" :aria-valuemax="100">
          <svg viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-track" cx="24" cy="24" r="20" /><circle class="ring-fill" cx="24" cy="24" r="20" pathLength="100" stroke-dasharray="100" :stroke-dashoffset="100 * (1 - overallProgress)" /></svg>
          <span>{{ Math.round(overallProgress * 100) }}<small>%</small></span>
        </div>
        <nav class="tutorial-steps" aria-label="教程步骤">
          <button v-for="(item, index) in steps" :key="item.title" type="button" :aria-label="'第' + (index + 1) + '步：' + item.title" :aria-current="index === step ? 'step' : undefined" :class="{ active: index === step, done: index < step }" @click="select(index)"><span>{{ index < step ? '✓' : index + 1 }}</span>{{ item.title }}</button>
        </nav>
      </div>
    </div>
  </ModalPanel>
</template>

<style scoped>
.tutorial { padding-top: 6px; }
.tutorial-scene { position: relative; overflow: hidden; border: 1px solid #dfe6d9; border-radius: 20px; background: #f1f4ee; }
.scene-status { position: absolute; top: 18px; left: 22px; display: flex; align-items: center; gap: 8px; color: #71806c; font-size: 12px; }
.scene-status i { width: 5px; height: 5px; border-radius: 50%; background: #b6c3af; }.scene-status i.ready { background: #78977d; }
.scene-count { position: absolute; top: 18px; right: 22px; font: 10px var(--mono); letter-spacing: .1em; color: #96a18d; }
.tutorial-art { display: block; width: 100%; height: clamp(260px, 42vh, 420px); }
.art-text { font: 12px var(--font); fill: #566957; }.art-text.strong { font-weight: 500; }.art-text.small { font-size: 10px; }.art-text.tiny { font-size: 9px; }.button-text { font: 10px var(--font); fill: white; }.device-label { font: 11px var(--font); fill: #8b9882; }
.lesson-reader > use, .lesson-panel > use { filter: blur(.35px); }
use[href="#lesson-photo"], use[href="#lesson-ink"] { filter: blur(.65px); }
.lesson-panel > g { filter: blur(.3px); }
.screen-pane { transition: opacity .18s ease; }
.completion-mark, .placement-guide, .lesson-link { transition: opacity .18s ease; }
.tutorial-caption { display: flex; gap: 18px; align-items: flex-start; min-height: 89px; padding: 6px 24px 22px; }
.tutorial-number { color: #91a58c; font: 24px/1.4 var(--mono); }
.tutorial-caption h3 { margin: 0 0 7px; font-size: 19px; font-weight: 500; }.tutorial-caption p { margin: 0; font-size: 12px; line-height: 1.8; color: #7d8874; }
.tutorial-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 4px 0; }
.tutorial-controls > span { font-size: 11px; color: #7d8874; }
.tutorial-controls > div { display: flex; gap: 8px; }
.tutorial-controls button { border: 1px solid #dfe6d9; border-radius: 8px; padding: 7px 12px; background: #f1f4ee; color: #597451; font: 11px var(--font); cursor: pointer; }
.tutorial-controls button:disabled { opacity: .4; cursor: default; }
.tutorial-footer { display: flex; align-items: center; gap: 24px; padding: 15px 4px 0; }
.tutorial-ring { position: relative; flex: 0 0 48px; width: 48px; height: 48px; color: #6a8663; }
.tutorial-ring svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.tutorial-ring circle { fill: none; stroke-width: 2.5; }.ring-track { stroke: #e3e9dd; }.ring-fill { stroke: #91a989; stroke-linecap: round; }
.tutorial-ring > span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 1px; font: 12px var(--mono); }.tutorial-ring small { font-size: 8px; }
.tutorial-steps { flex: 1; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.tutorial-steps button { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 12px 4px; border: 0; border-radius: 10px; background: transparent; color: #929b8a; font: 11px var(--font); cursor: pointer; transition: background .12s, color .12s; }
.tutorial-steps button span { font: 10px var(--mono); }.tutorial-steps button:hover { background: #f0f3ec; }.tutorial-steps .active { color: #597451; background: #eaf0e4; }.tutorial-steps .done { color: #788d70; }
@media (max-height: 700px) { .tutorial-art { height: 240px; }.tutorial-caption { min-height: 77px; padding: 2px 20px 16px; }.tutorial-caption h3 { font-size: 17px; }.tutorial-footer { padding-top: 10px; gap: 16px; }.tutorial-ring { flex-basis: 40px; width: 40px; height: 40px; } }
@media (prefers-reduced-motion: reduce) { .screen-pane, .completion-mark, .placement-guide, .lesson-link { transition: none; } }
</style>
