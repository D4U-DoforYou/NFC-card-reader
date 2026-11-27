<script setup lang="ts">
import { computed } from 'vue'
import { useConnection } from '@/composables/useConnection'
const { connected, kind, status } = useConnection()
const caption = computed(() => connected.value
  ? `${kind.value === 'usb' ? 'USB' : '蓝牙'}已连接`
  : status.value === 'connecting' || status.value === 'scanning' ? '正在连接读卡器…' : '读卡器未连接')
</script>

<template>
  <div class="connection-scene" :class="{ connected }" role="group" :aria-label="caption">
    <div class="scene-devices">
      <div class="reader-group">
        <div class="swipe-card"><span /><i /><i /></div>
        <div class="scan-rings" aria-hidden="true"><i /><i /></div>
        <div class="reader-device">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 17a10 10 0 0 1 14 0M12 12a17 17 0 0 1 24 0M21 22a4 4 0 0 1 6 0"/><circle cx="24" cy="29" r="2"/></svg>
          <span>D4U READER</span><i />
        </div>
        <span class="device-label">读卡器</span>
      </div>
      <div class="link-zone" :class="{ wireless: connected && kind === 'bluetooth', wired: connected && kind === 'usb' }">
        <span class="link-line" /><span v-if="connected" class="data-packet" aria-hidden="true" />
        <svg v-if="!connected" class="link-icon disconnected" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 7 10 10M17 7 7 17"/></svg>
        <svg v-else-if="kind === 'bluetooth'" class="link-icon bluetooth" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 7 10 10-5 4V3l5 4L7 17"/></svg>
        <span v-else class="usb-label">USB</span>
      </div>
      <div class="pc-group">
        <div class="macbook-lid"><i class="macbook-camera" /><div class="pc-screen"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path v-if="connected" d="m14 24 7 7 14-15"/><path v-else d="m18 18 12 12m0-12L18 30"/></svg></div></div>
        <div class="macbook-base"><i /></div>
        <span class="device-label">PC</span>
      </div>
    </div>
    <div class="scene-caption" aria-live="polite"><span class="scene-dot" />{{ caption }}</div>
    <RouterLink v-if="!connected" to="/connect" class="scene-action">连接设备 <span>↗</span></RouterLink>

  </div>
</template>

<style scoped>
.connection-scene { min-width: 0; padding: 26px 12px; }
.scene-devices { display: flex; align-items: center; justify-content: center; height: 230px; padding-top: 28px; }
.reader-group { position: relative; width: 112px; flex: none; text-align: center; perspective: 500px; }
.reader-device { position: relative; z-index: 1; height: 106px; border-radius: 18px; background: linear-gradient(145deg,#edf1ee,#dce6df); border: 1px solid #c5d2c9; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #64786b; }
.reader-device svg { width: 44px; height: 44px; animation: reader-response 3.4s ease-in-out infinite; }
.reader-device span { font-size: 7px; letter-spacing: 1.3px; }
.reader-device > i { width: 16px; height: 2px; background: #b4c3b9; margin-top: 10px; border-radius: 2px; }
.connected .reader-device > i { background: #598467; }
.swipe-card { position: absolute; z-index: 3; width: 78px; height: 49px; left: 18px; top: -36px; border-radius: 8px; border: 1px solid #b67f64; background: #d6aa8f; padding: 10px; animation: card-swipe 3.4s infinite; will-change: transform; }
.swipe-card span { display: block; width: 12px; height: 9px; background: #f3e6c9; border: 1px solid #c7c3b6; border-radius: 2px; }
.swipe-card i { display: block; width: 30px; height: 1px; margin-top: 5px; background: #92694f; }
.device-label { display: block; margin-top: 16px; font-size: 10px; color: #777; }
.link-zone { flex: 0 0 clamp(40px,5vw,72px); height: 60px; position: relative; display: flex; align-items: center; justify-content: center; margin: 0 8px 28px; }
.link-line { position: absolute; width: 100%; border-top: 1px dashed #ccc; transition: border-color .3s; }
.link-icon { z-index: 1; width: 28px; height: 28px; padding: 5px; background: var(--paper); color: #999; }
.wireless .link-line { border-color: #91a6be; }
.bluetooth { color: #6085ac; animation: bluetooth-pulse 1.6s ease-in-out infinite; }
.wired .link-line { border-top: 1px solid #809b8b; }
.usb-label { z-index: 1; font-size: 9px; color: #567561; background: var(--paper); padding: 3px 6px; }
.pc-group { width: 154px; flex: none; text-align: center; }
.macbook-lid { position: relative; width: 136px; margin: auto; padding: 5px 5px 7px; border: 1px solid #a9b0b6; background: #cdd2d7; border-radius: 9px 9px 3px 3px; }
.macbook-camera { position: absolute; z-index: 1; top: 4px; left: calc(50% - 8px); width: 16px; height: 5px; border-radius: 0 0 3px 3px; background: #bcc4cd; }
.macbook-camera::after { content: ''; position: absolute; top: 1px; left: 7px; width: 2px; height: 2px; border-radius: 50%; background: #74818d; }
.pc-screen { height: 80px; background: linear-gradient(145deg,#e6edf5,#d4e0ed); border-radius: 4px; display: grid; place-items: center; color: #a5b1be; }
.pc-screen svg { width: 28px; height: 28px; }
.connected .pc-screen { color: #638076; }
.macbook-base { position: relative; height: 6px; width: 154px; background: linear-gradient(#e1e4e7,#bcc3c9); border: 1px solid #aeb6bd; border-top: 0; border-radius: 1px 1px 12px 12px; }
.macbook-base > i { position: absolute; top: 0; left: calc(50% - 13px); width: 26px; height: 2px; background: #aeb7bf; border-radius: 0 0 4px 4px; }
.pc-group .device-label { margin-top: 16px; }
.scene-dot { width: 4px; height: 4px; background: #aaa; border-radius: 50%; }
.connected .scene-dot { background: #63846e; }
.scene-caption { display: flex; justify-content: center; align-items: center; gap: 7px; font-size: 11px; color: #666; margin-top: 4px; }
.scene-action { display: flex; gap: 24px; width: fit-content; margin: 10px auto 0; color: #333; font-size: 11px; text-decoration: underline; text-underline-offset: 4px; }
.scan-rings { position: absolute; z-index: 0; inset: -14px -12px 12px; pointer-events: none; }
.scan-rings i { position: absolute; inset: 0; border: 1px solid #9bb9a6; border-radius: 30px; animation: scan-wave 3.4s ease-out infinite; opacity: 0; }
.scan-rings i + i { animation-delay: .16s; }
.data-packet { position: absolute; left: 0; width: 5px; height: 5px; background: #739783; border-radius: 50%; animation: packet-travel 1.8s ease-in-out infinite; }
.wireless .data-packet { background: #799bbf; }
@keyframes card-swipe {
  0%,8% { transform: translate3d(-35px,-18px,35px) rotate(-22deg) rotateY(-14deg); animation-timing-function: cubic-bezier(.4,0,.25,1); }
  35% { transform: translate3d(10px,62px,0) rotate(4deg) rotateY(0); animation-timing-function: ease-out; }
  44% { transform: translate3d(7px,54px,5px) rotate(1deg); animation-timing-function: ease-in-out; }
  56% { transform: translate3d(9px,58px,2px) rotate(2deg); animation-timing-function: cubic-bezier(.45,0,.2,1); }
  84%,100% { transform: translate3d(-35px,-18px,35px) rotate(-22deg) rotateY(-14deg); }
}
@keyframes scan-wave { 0%,28% { opacity: 0; transform: scale(.75); } 38% { opacity: .7; } 68%,100% { opacity: 0; transform: scale(1.32); } }
@keyframes reader-response { 0%,25%,75%,100% { opacity: .4; } 35%,55% { opacity: 1; } }
@keyframes packet-travel { 0% { left: 0; opacity: 0; } 15%,85% { opacity: 1; } 100% { left: calc(100% - 5px); opacity: 0; } }
@keyframes bluetooth-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) {
  .swipe-card, .scan-rings i, .reader-device svg, .data-packet, .bluetooth { animation: none; }
  .swipe-card { transform: translate(-12px,10px) rotate(-10deg); }
}
</style>
