<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import UiHost from '@/components/UiHost.vue'
import { bluetoothAvailable } from '@/platform/webBluetooth'
import { usbAvailable } from '@/platform/usbHid'
import { showModal } from '@/platform/ui'
import startupIcon from '@/assets/startup-icon.png'

const startupLoading = ref(true)

function hasReaderApi(): boolean {
  return bluetoothAvailable() || usbAvailable()
}

onMounted(async () => {
  const readerApiAvailable = hasReaderApi()
  await new Promise(resolve => window.setTimeout(resolve, 850))
  startupLoading.value = false

  if (!readerApiAvailable) {
    void showModal({
      title: '浏览器兼容性提示',
      content: '当前浏览器未检测到 Web Bluetooth 或 WebHID 支持。你仍可浏览页面；连接读卡器请使用支持这些功能的桌面浏览器，并通过 HTTPS 或 localhost 打开。',
      confirmText: '我就看看',
      showCancel: false,
    })
  }
})
</script>

<template>
  <UiHost />
  <AppShell />
  <Transition name="startup">
    <div v-if="startupLoading" class="startup-mask" role="status" aria-live="polite">
      <div class="startup-card">
        <div class="startup-mark" aria-hidden="true">
          <span class="startup-orbit" />
          <img class="startup-icon" :src="startupIcon" alt="" />
        </div>
        <strong>正在加载工作台</strong>
        <span class="startup-caption">检查浏览器连接能力</span>
        <div class="startup-progress" aria-hidden="true"><i /></div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.startup-mask {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  background: var(--paper);
}

.startup-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 260px;
  padding: 34px 40px 30px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 24px 60px rgba(20, 22, 26, 0.08);
}

.startup-mark {
  position: relative;
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  margin-bottom: 20px;
}

.startup-orbit {
  position: absolute;
  inset: 0;
  border: 2px solid var(--line);
  border-top-color: var(--olive);
  border-right-color: var(--olive);
  border-radius: 50%;
  animation: startup-spin 1.1s linear infinite;
}

.startup-icon { width: 56px; height: 56px; border-radius: 14px; object-fit: cover; box-shadow: 0 4px 14px rgba(20, 22, 26, 0.12); }

.startup-card strong { font-size: 15px; font-weight: 600; }
.startup-caption { margin-top: 6px; color: var(--ink-45); font-size: 11px; }
.startup-progress { width: 150px; height: 3px; margin-top: 20px; overflow: hidden; border-radius: 3px; background: var(--paper-deep); }
.startup-progress i { display: block; width: 42%; height: 100%; border-radius: inherit; background: var(--olive); animation: startup-progress 1.2s ease-in-out infinite; }

.startup-enter-active, .startup-leave-active { transition: opacity 0.2s ease; }
.startup-leave-to { opacity: 0; }

@keyframes startup-spin { to { transform: rotate(360deg); } }
@keyframes startup-progress { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }

@media (prefers-reduced-motion: reduce) {
  .startup-orbit, .startup-progress i { animation-duration: 3s; }
}
</style>
