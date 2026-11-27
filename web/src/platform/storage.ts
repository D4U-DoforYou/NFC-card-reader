/**
 * 本地存储。
 *
 * 小程序用 `wx.getStorageSync` / `wx.setStorageSync` / `wx.removeStorageSync`，
 * 网页端换成 `localStorage`。这里保留同样的函数名与语义，
 * 核心模块（store、readerLogs、票面条目）就不用大改。
 */

const PREFIX = 'd4u_web_'

/**
 * 读取一个本地存储项。
 *
 * 返回值与微信 `wx.getStorageSync` 同义：不存在时返回空字符串，
 * 存在时返回**反序列化后的值**（对象 / 数组 / 数字）。
 */
export function getStorageSync(key: string): any {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (raw === null) {
      return ''
    }
    return JSON.parse(raw)
  } catch {
    return ''
  }
}

/** 写入一个本地存储项。 */
export function setStorageSync(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 配额满了或隐私模式禁用了存储：功能降级，但不打断流程。
  }
}

/** 删除一个本地存储项。 */
export function removeStorageSync(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key)
  } catch {
    // 忽略。
  }
}
