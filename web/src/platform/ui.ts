/**
 * 轻提示与确认框。
 *
 * 小程序用 `wx.showToast` / `wx.showModal`，网页端自己实现一套：
 * 提示是一个浮层，确认框是一个模态，两者都由 `UiHost.vue` 渲染。
 */

import { ref } from 'vue'

export interface ToastState {
  visible: boolean
  message: string
  /** 'none' 是普通提示，'success' 是成功勾。 */
  icon: 'none' | 'success'
  duration: number
}

export interface ModalState {
  visible: boolean
  title: string
  content: string
  confirmText: string
  cancelText: string
  showCancel: boolean
  resolve: ((confirmed: boolean) => void) | null
}

export interface LoadingState {
  visible: boolean
  message: string
}

export const toastState = ref<ToastState>({
  visible: false,
  message: '',
  icon: 'none',
  duration: 1800,
})

export const loadingState = ref<LoadingState>({
  visible: false,
  message: '',
})

export const modalState = ref<ModalState>({
  visible: false,
  title: '',
  content: '',
  confirmText: '确定',
  cancelText: '取消',
  showCancel: true,
  resolve: null,
})

let toastTimer = 0

/** 显示一条轻提示。 */
export function showToast(title: string, icon: 'none' | 'success' = 'none', duration = 1800): void {
  toastState.value = { visible: true, message: title, icon, duration }
  if (toastTimer) {
    window.clearTimeout(toastTimer)
  }
  toastTimer = window.setTimeout(() => {
    toastState.value = { ...toastState.value, visible: false }
  }, duration)
}

/** 关闭轻提示。 */
export function hideToast(): void {
  if (toastTimer) {
    window.clearTimeout(toastTimer)
    toastTimer = 0
  }
  toastState.value = { ...toastState.value, visible: false }
}

/**
 * 显示全屏遮罩加载态。
 *
 * 对应小程序的 `wx.showLoading({ title, mask })`。
 */
export function showLoading(message = '处理中…'): void {
  loadingState.value = { visible: true, message }
}

/** 关闭全屏遮罩加载态。 */
export function hideLoading(): void {
  loadingState.value = { ...loadingState.value, visible: false }
}

export interface ModalOptions {
  title?: string
  content?: string
  confirmText?: string
  cancelText?: string
  showCancel?: boolean
}

/**
 * 弹一个确认框，返回用户是否点了确定。
 *
 * 用法与 `wx.showModal` 一致：`const ok = await showModal({ ... })`。
 */
export function showModal(options: ModalOptions = {}): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    modalState.value.resolve?.(false)
    modalState.value = {
      visible: true,
      title: options.title ?? '提示',
      content: options.content ?? '',
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      showCancel: options.showCancel ?? true,
      resolve,
    }
  })
}

/** 关闭确认框，回传结果。 */
export function closeModal(confirmed: boolean): void {
  const resolve = modalState.value.resolve
  modalState.value = { ...modalState.value, visible: false, resolve: null }
  resolve?.(confirmed)
}
