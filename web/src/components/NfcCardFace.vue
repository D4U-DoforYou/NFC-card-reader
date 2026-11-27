<script setup lang="ts">
import { computed } from 'vue'
import type { CardIdentification } from '@/core/nfc/cards'
import { cardAppearance } from '@/core/nfc/appearance'
const props = defineProps<{ info: CardIdentification | null }>()
const face = computed(() => cardAppearance(props.info))
const uid = computed(() => props.info?.uid && !['未取到', '—'].includes(props.info.uid) ? props.info.uid : '')
</script>

<template>
  <div class="nfc-face-stage">
    <div class="nfc-face" :data-card-type="face.key" :data-pattern="face.pattern"
      :style="{ '--face-paper': face.background, '--face-ink': face.ink, '--face-accent': face.accent }"
      role="img" :aria-label="info ? `${info.protocolName}，${info.modelName}` : '未读取卡片'">
      <div class="face-art" aria-hidden="true"><i /><i /><i /><i /></div>
      <div class="face-top"><span>{{ face.title }}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M8 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14m3-17a14 14 0 0 1 0 20"/></svg></div>
      <span class="face-mark" aria-hidden="true">{{ face.mark }}</span>
      <div class="face-bottom"><span>{{ info ? 'UID' : 'D4U' }}</span><span class="face-uid">{{ uid || (info ? '未获取' : '等待卡片') }}</span></div>
    </div>
    <div class="face-caption">{{ info?.modelName || '未读取' }}</div>
    <div v-if="info" class="face-protocol">{{ info.protocolName }}</div>
  </div>
</template>

<style scoped>
.nfc-face-stage { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px 0; flex: 1; min-width: 0; width: 100%; }
.nfc-face { position: relative; isolation: isolate; overflow: hidden; width: 100%; max-width: 238px; aspect-ratio: 1.586; border-radius: 14px; background: var(--face-paper); color: var(--face-ink); border: 1px solid color-mix(in srgb,var(--face-accent) 65%,transparent); padding: 14px; display: flex; flex-direction: column; justify-content: space-between; }
.face-top, .face-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; position: relative; z-index: 1; }
.face-top { font-size: 10px; font-weight: 500; letter-spacing: .2px; }.face-top svg { width: 18px; height: 18px; flex: none; }
.face-mark { font-size: clamp(24px,3vw,42px); font-weight: 500; line-height: 1; letter-spacing: -2px; position: relative; z-index: 1; }
.face-bottom { align-items: flex-end; font-size: 7px; letter-spacing: .6px; }.face-uid { font-family: var(--mono); font-size: 8px; letter-spacing: .2px; overflow-wrap: anywhere; text-align: right; }
.face-caption { font-size: 12px; text-align: center; line-height: 1.5; overflow-wrap: anywhere; }.face-protocol { font-size: 10px; color: var(--ink-45); text-align: center; margin-top: -5px; }
.face-art { position: absolute; z-index: 0; inset: 0; pointer-events: none; color: var(--face-accent); opacity: .65; }
[data-pattern='waves'] .face-art i { position: absolute; right: -28px; top: 22%; width: 110px; height: 110px; border: 1px solid; border-radius: 32px; transform: rotate(30deg); }
[data-pattern='waves'] .face-art i:nth-child(2) { right: -12px; }[data-pattern='waves'] .face-art i:nth-child(3) { right: 4px; }[data-pattern='waves'] .face-art i:nth-child(4) { right: 20px; }
[data-pattern='grid'] .face-art { left: 45%; top: 32%; background-image: linear-gradient(currentColor 1px,transparent 1px),linear-gradient(90deg,currentColor 1px,transparent 1px); background-size: 18px 18px; transform: rotate(-12deg) scale(1.2); border-radius: 9px; }
[data-pattern='stripes'] .face-art { left: 38%; background: repeating-linear-gradient(125deg,transparent 0 15px,currentColor 15px 16px,transparent 16px 22px); }
[data-pattern='rings'] .face-art i { position: absolute; border: 1px solid; width: 120px; height: 120px; right: -18px; top: 20px; border-radius: 50%; }
[data-pattern='rings'] .face-art i:nth-child(2) { transform: scale(.75); }[data-pattern='rings'] .face-art i:nth-child(3) { transform: scale(.5); }[data-pattern='rings'] .face-art i:nth-child(4) { transform: scale(.25); }
[data-pattern='dots'] .face-art { left: 42%; top: 25%; background: radial-gradient(circle,currentColor 1.5px,transparent 2px); background-size: 12px 12px; transform: rotate(-12deg); }
[data-pattern='circuit'] .face-art i { position: absolute; right: -8px; top: 30%; width: 90px; height: 45px; border: 1px solid; border-radius: 9px; }
[data-pattern='circuit'] .face-art i:nth-child(2) { top: 42%; right: 12px; }[data-pattern='circuit'] .face-art i:nth-child(3) { top: 54%; right: 32px; }[data-pattern='circuit'] .face-art i:nth-child(4) { top: 66%; right: 52px; }
[data-pattern='screen'] .face-art { inset: 27% 12% 22% 48%; background: #ffffff88; border: 4px solid currentColor; border-radius: 5px; }
[data-card-type='idle'] .face-mark { font-size: 26px; font-weight: 400; letter-spacing: 1px; }
</style>
