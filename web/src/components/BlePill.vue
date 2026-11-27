<script setup lang="ts">
import { computed } from 'vue'
import { useConnection } from '@/composables/useConnection'

/**
 * 蓝牙状态胶囊。
 *
 * 网页端拿不到 RSSI，所以信号柱一律按「未知」显示，不拿别的数字冒充。
 */
const props = withDefaults(
  defineProps<{
    /** 紧凑模式：墨水屏页右上角那一个，文案更短。 */
    compact?: boolean
    /** 未连接时的文案，各页沿用小程序里各自的叫法。 */
    idleLabel?: string
  }>(),
  { compact: false, idleLabel: '' },
)

const { status, kind } = useConnection()

const label = computed(() => {
  switch (status.value) {
    case 'connected':
      return `${kind.value === 'usb' ? 'USB' : '蓝牙'}已连接`
    case 'scanning':
      return props.compact ? '搜索中' : '搜索读卡器中'
    case 'connecting':
      return props.compact ? '连接中' : '连接中…'
    case 'error':
      return props.compact ? '连接异常' : '连接异常'
    default:
      if (props.idleLabel) {
        return props.idleLabel
      }
      return props.compact ? '未连接' : '未连接读卡器'
  }
})

const dotClass = computed(() => {
  if (status.value === 'connected') {
    return 'on'
  }
  if (status.value === 'scanning' || status.value === 'connecting') {
    return 'busy'
  }
  if (status.value === 'error') {
    return 'err'
  }
  return ''
})
</script>

<template>
  <button class="ble-pill" type="button">
    <span class="ble-dot" :class="dotClass" />
    <svg class="connection-icon" :class="{ usb: kind === 'usb' }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="kind === 'bluetooth'" d="m7 7 10 10-5 4V3l5 4L7 17" />
      <g v-else class="usb-mark">
        <path d="M8 8V4h3v4m2 0V4h3v4M12 15v5" />
        <rect x="6" y="8" width="12" height="7" rx="1.5" />
      </g>
    </svg>
    <span class="ble-label">{{ label }}</span>
    <span class="ble-chevron">›</span>
  </button>
</template>
