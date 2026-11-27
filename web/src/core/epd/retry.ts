import type { DeviceProfile } from './profile'
import type { IsoDepSession } from '../rf/isoDep'

/** Only an interrupted image upload can restart; refresh commands are never replayed. */
export class ImageUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'ImageUploadError' }
}

/**
 * 链路层写失败也归入「可重试」。
 *
 * 写失败意味着这一帧没写完整：会话层已经先补了一个 0x00 帧结束符，
 * 设备会把半帧丢掉，所以它没见过这次操作——重传当前包是安全的。
 * 不重试的话，一次偶发的链路抖动就会让整趟刷图前功尽弃。
 */
const RETRYABLE_CAUSE =
  /射频错误|CRC_A|ISO-DEP.*超时|设备响应超时|WTX|R-NAK|RF|radio timeout|发送结果未确认|写入超时|帧未送达设备|读卡器忙/i

export function interruptedUpload(label: string, cause: unknown): ImageUploadError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new ImageUploadError(`${label} 传输未确认：${message}`, RETRYABLE_CAUSE.test(message))
}

/** Restart from block zero after a fresh activation, never resume an uncertain D3 packet. */
export async function uploadWithRetry(
  initial: { profile: DeviceProfile; iso: IsoDepSession },
  reconnect: () => Promise<{ profile: DeviceProfile; iso: IsoDepSession }>,
  upload: (iso: IsoDepSession, profile: DeviceProfile) => Promise<void>,
  onRetry: (message: string) => void,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  const target = { ...initial.profile, uid: initial.profile.uid.slice() }
  let current = initial
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await upload(current.iso, current.profile); return }
    catch (error) {
      if (!(error instanceof ImageUploadError) || !error.retryable || attempt === 3) throw error
      onRetry(`图像传输中断，1 秒后重新选卡并从头上传（第 ${attempt + 1}/3 次）：${error.message}`)
      await wait(1000)
      current = await reconnect()
      const next = current.profile
      if (next.uid.length !== target.uid.length || next.uid.some((v, i) => v !== target.uid[i]) ||
          next.family !== target.family || next.width !== target.width || next.height !== target.height ||
          next.colorCount !== target.colorCount || next.firmware !== target.firmware ||
          next.scanVertical !== target.scanVertical || next.flipHorizontal !== target.flipHorizontal ||
          next.flipVertical !== target.flipVertical || JSON.stringify(next.colorCodes) !== JSON.stringify(target.colorCodes)) {
        throw new Error('重试时屏幕 UID 或面板参数发生变化，已停止上传')
      }
    }
  }
}

/** Explicitly enabled D3 replay; keep packet coordinates and re-negotiate link sequencing. */
export async function exchangeImagePacket(
  session: IsoDepSession, packet: Uint8Array, uid: Uint8Array, label: string,
  recoveryBudget: number, onRetry: (message: string) => void,
  attempts = 3,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Uint8Array> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('图像包尝试次数必须为 1..5')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await session.exchange(packet, recoveryBudget, uid, 20_000) }
    catch (cause) {
      const error = interruptedUpload(`${label}（当前包第 ${attempt}/${attempts} 次）`, cause)
      if (packet[1] !== 0xd3 || !error.retryable || attempt === attempts || typeof session.resync !== 'function') throw error
      onRetry(`${label} 传输中断，重新协商后重传当前包（第 ${attempt + 1}/${attempts} 次）`)
      await wait(150)
      try { await session.resync() }
      catch (resyncError) { throw interruptedUpload(`${label} 重新协商失败`, resyncError) }
      if (session.uid.length !== uid.length || session.uid.some((value, index) => value !== uid[index])) throw new Error('重传前 UID 发生变化，已停止上传')
    }
  }
  throw new Error('图像包传输未完成')
}
