import type { DeviceSession } from './types'

export function supportsChipPrimitives(session: DeviceSession | null): boolean {
  const capability = session?.capabilities.find(item => item.id === 'org.example.rf.raw')
  return Boolean(capability && capability.majorVersion === 1 && capability.minorVersion >= 2 &&
    ['execute_command', 'read_register', 'write_register'].every(id => capability.operations.some(op => op.id === id)) &&
    session?.executeChipCommand && session.readChipRegister && session.writeChipRegister)
}

/** Check the negotiated contract before sending an operation to the device. */
export function capabilityOperationIssue(
  capabilities: DeviceSession['capabilities'], capabilityId: string, operationId: string, majorVersion = 1,
): string {
  const capability = capabilities.find(item => item.id === capabilityId)
  if (!capability) {
    const offered = capabilities.map(item => item.id).join('、') || '无'
    const infoOnly = capabilities.length === 1 && capabilities[0].id === 'org.example.device.info'
    return `当前设备未提供能力 ${capabilityId}，无法执行 ${operationId}。已公布能力：${offered}。` +
      (infoOnly ? '设备当前仅提供信息查询，请检查本次启动的 nfc=disabled 或能力注册失败日志。' : '请核对当前固件的能力注册日志。')
  }
  if (capability.majorVersion !== majorVersion) return `能力 ${capabilityId} 版本不兼容：需要 ${majorVersion}，设备为 ${capability.majorVersion}`
  if (!capability.operations.some(item => item.id === operationId)) return `设备能力 ${capabilityId} 未提供操作 ${operationId}`
  return ''
}
