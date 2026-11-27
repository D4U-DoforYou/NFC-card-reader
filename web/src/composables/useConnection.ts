import { computed, onScopeDispose, shallowRef } from 'vue'
import { appStore } from '@/core/store'
import { transportManager } from '@/platform/transport'

/** Transport objects are plain classes: mirror their events into Vue refs. */
export function useConnection() {
  const read = () => ({
    status: transportManager.status,
    kind: transportManager.kind,
    name: transportManager.connectedName,
    deviceId: transportManager.connectedDeviceId,
    connectedAt: transportManager.connectedAt,
    chunkSize: transportManager.chunkSize,
    rssi: transportManager.lastRssi,
    message: appStore.bleMessage,
  })
  const connection = shallowRef(read())
  const unsubscribe = appStore.subscribe(() => { connection.value = read() })
  onScopeDispose(unsubscribe)
  return {
    connection,
    status: computed(() => connection.value.status),
    kind: computed(() => connection.value.kind),
    connected: computed(() => connection.value.status === 'connected'),
  }
}
