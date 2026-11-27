/**
 * 屏幕常亮：刷图时防止电脑自动息屏。
 *
 * 小程序里靠 `wx.setKeepScreenOn`。网页端用 **Screen Wake Lock API**
 * （`navigator.wakeLock.request('screen')`）——桌面版 Chrome / Edge 支持。
 *
 * 息屏不只是「看不见显色动画」：浏览器会把后台标签页的定时器降频，
 * 分包超时与失败重传逻辑一起变慢，刷图会卡住。所以常亮是刷图链路的
 * 可靠性前提，不只是体验问题。
 *
 * 浏览器端的硬限制：
 * - 页面切到后台或窗口失焦时，系统会**自动释放**唤醒锁，
 *   回到前台要重新申请；
 * - 文档不可见时申请会被拒绝；
 * - 不支持该 API 的浏览器安全降级，不影响刷图。
 */

import { appStore } from '../store/index'

interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

/** 当前持有的唤醒锁。 */
let sentinel: WakeLockSentinelLike | null = null
/** 是否处于「想要常亮」的状态。 */
let wanted = false

function api(): WakeLockLike | null {
  const host = navigator as unknown as { wakeLock?: WakeLockLike }
  if (!host.wakeLock || typeof host.wakeLock.request !== 'function') {
    return null
  }
  return host.wakeLock
}

/**
 * 设置屏幕常亮。
 *
 * 幂等：状态没变就不重复申请。返回是否成功发出请求。
 */
export function setKeepScreenOn(enabled: boolean): boolean {
  if (wanted === enabled) {
    return true
  }
  wanted = enabled
  if (!enabled) {
    void sentinel?.release().catch(() => undefined)
    sentinel = null
    return true
  }
  const lock = api()
  if (!lock) {
    wanted = false
    return false
  }
  // 文档不可见时申请会被拒绝，刷图途中切走再切回来时就会遇到。
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    wanted = false
    return false
  }
  lock
    .request('screen')
    .then(next => {
      sentinel = next
      next.addEventListener('release', () => {
        sentinel = null
      })
    })
    .catch((error: unknown) => {
      wanted = false
      appStore.log('warn', `设置屏幕常亮失败：${error instanceof Error ? error.message : String(error)}`)
    })
  return true
}

/** 当前是否处于常亮状态。 */
export function isKeepScreenOn(): boolean {
  return wanted
}

/**
 * 页面重新可见时补一次申请。
 *
 * 系统会在切后台时自动释放唤醒锁，回来要重新申请，
 * 否则刷图中途息屏会让链路卡住。
 */
export function resumeKeepScreenOn(): void {
  if (wanted && !sentinel) {
    setKeepScreenOn(false)
    setKeepScreenOn(true)
  }
}
