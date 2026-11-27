<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'

/**
 * 通用模态框。
 *
 * 只做一件事：把一块内容浮在当前页之上。页面自己决定放什么进去。
 * 打开时锁住背景滚动，ESC 或点遮罩关闭。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    /** 面板最大宽度（px）。 */
    width?: number
  }>(),
  { title: '', width: 720 },
)

const emit = defineEmits<{ (event: 'close'): void }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) {
    emit('close')
  }
}

function unlockScroll(): void {
  document.body.style.overflow = ''
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlockScroll()
})

watch(
  () => props.open,
  open => {
    document.body.style.overflow = open ? 'hidden' : ''
  },
)
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="modal-panel" :style="{ maxWidth: `${width}px` }" role="dialog" :aria-label="title">
        <div v-if="title" class="modal-head">
          <div class="modal-title">{{ title }}</div>
          <button class="modal-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(20, 22, 26, 0.44);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal-panel {
  width: 100%;
  max-height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border-radius: 26px;
  box-shadow: 0 30px 70px rgba(20, 22, 26, 0.3);
  overflow: hidden;
}

.modal-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 26px 14px;
}

.modal-title {
  font-size: 24px;
  font-weight: 600;
}

.modal-close {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink-70);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  flex: none;
}

.modal-close:hover {
  border-color: var(--ink-25);
  color: var(--ink);
}

.modal-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 26px 26px;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}

.modal-enter-active .modal-panel,
.modal-leave-active .modal-panel {
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-panel,
.modal-leave-to .modal-panel {
  transform: translateY(16px) scale(0.98);
}
</style>
