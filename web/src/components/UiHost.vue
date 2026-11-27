<script setup lang="ts">
import { modalState, closeModal, toastState, loadingState } from '@/platform/ui'
</script>

<template>
  <!-- 全屏遮罩加载态 -->
  <transition name="toast">
    <div v-if="loadingState.visible" class="loading-mask">
      <div class="loading-box">
        <span class="loading-spinner" />
        <span>{{ loadingState.message }}</span>
      </div>
    </div>
  </transition>

  <!-- 轻提示 -->
  <transition name="toast">
    <div v-if="toastState.visible" class="toast-layer">
      <div class="toast-box" :class="toastState.icon">
        <span v-if="toastState.icon === 'success'" class="toast-check">✓</span>
        <span>{{ toastState.message }}</span>
      </div>
    </div>
  </transition>

  <!-- 确认框 -->
  <transition name="toast">
    <div v-if="modalState.visible" class="modal-mask" @click.self="closeModal(false)">
      <div class="modal-box">
        <div class="modal-title">{{ modalState.title }}</div>
        <div class="modal-content">{{ modalState.content }}</div>
        <div class="modal-actions">
          <button v-if="modalState.showCancel" class="btn btn-ghost btn-sm" @click="closeModal(false)">
            {{ modalState.cancelText }}
          </button>
          <button class="btn btn-primary btn-sm" @click="closeModal(true)">{{ modalState.confirmText }}</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.toast-layer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 64px;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 900;
}

.toast-box {
  background: rgba(20, 22, 26, 0.92);
  color: #fff;
  padding: 13px 22px;
  border-radius: 14px;
  font-size: 19px;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 460px;
  box-shadow: 0 12px 30px rgba(20, 22, 26, 0.24);
}

.toast-box.success {
  background: var(--olive);
}

.toast-check {
  font-weight: 700;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 22, 26, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}

.loading-mask {
  position: fixed;
  inset: 0;
  background: rgba(242, 243, 238, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.loading-box {
  display: flex;
  align-items: center;
  gap: 13px;
  background: rgba(20, 22, 26, 0.92);
  color: #fff;
  padding: 17px 24px;
  border-radius: 16px;
  font-size: 19px;
  box-shadow: 0 14px 34px rgba(20, 22, 26, 0.24);
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 3px solid rgba(150, 150, 140, 0.3);
  border-top-color: var(--lime);
  animation: loading-spin 0.8s linear infinite;
}

@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}

.modal-box {
  background: #fff;
  border-radius: 20px;
  padding: 26px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 24px 60px rgba(20, 22, 26, 0.28);
}

.modal-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 10px;
}

.modal-content {
  font-size: 19px;
  color: var(--ink-70);
  line-height: 1.7;
  margin-bottom: 22px;
  white-space: pre-wrap;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 11px;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
