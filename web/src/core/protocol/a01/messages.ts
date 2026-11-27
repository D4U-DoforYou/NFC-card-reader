/**
 * A01 方案的协议消息定义（rfplatform.v1）。
 *
 * 与 tmp/rf_device_platform/protocol/device.proto 逐字段对应，
 * 字段号必须一致——固件按字段号解析。
 */

import { ProtoRegistry, ProtoSchema } from './protobuf'

/** 作业状态。 */
export const JOB_STATE = {
  UNSPECIFIED: 0,
  ACCEPTED: 1,
  RUNNING: 2,
  COMPLETED: 3,
  FAILED: 4,
  CANCELLED: 5,
  RESULT_UNCERTAIN: 6,
} as const

/** 错误码。 */
export const ERROR_CODE = {
  UNSPECIFIED: 0,
  UNSUPPORTED: 1,
  INVALID_ARGUMENT: 2,
  BUSY: 3,
  PERMISSION_DENIED: 4,
  TIMEOUT: 5,
  TRANSPORT: 6,
  RF: 7,
  PROTOCOL: 8,
  CANCELLED: 9,
  RESULT_UNCERTAIN: 10,
} as const

/** 作业状态的中文说法。 */
export const JOB_STATE_TEXT: Record<number, string> = {
  [JOB_STATE.ACCEPTED]: '已接受',
  [JOB_STATE.RUNNING]: '执行中',
  [JOB_STATE.COMPLETED]: '已完成',
  [JOB_STATE.FAILED]: '失败',
  [JOB_STATE.CANCELLED]: '已取消',
  [JOB_STATE.RESULT_UNCERTAIN]: '结果不确定',
}

/** 错误码的中文说法。 */
export const ERROR_CODE_TEXT: Record<number, string> = {
  [ERROR_CODE.UNSUPPORTED]: '设备不支持该操作',
  [ERROR_CODE.INVALID_ARGUMENT]: '参数非法',
  [ERROR_CODE.BUSY]: '设备忙',
  [ERROR_CODE.PERMISSION_DENIED]: '缺少目标确认',
  [ERROR_CODE.TIMEOUT]: '超时',
  [ERROR_CODE.TRANSPORT]: '传输错误',
  [ERROR_CODE.RF]: '射频错误',
  [ERROR_CODE.PROTOCOL]: '协议错误',
  [ERROR_CODE.CANCELLED]: '已取消',
  [ERROR_CODE.RESULT_UNCERTAIN]: '结果不确定',
}

const SCHEMAS: Record<string, ProtoSchema> = {
  Envelope: {
    protocol_major: { id: 1, type: 'uint32' },
    protocol_minor: { id: 2, type: 'uint32' },
    session_id: { id: 3, type: 'fixed64' },
    request_id: { id: 4, type: 'fixed32' },
    hello_request: { id: 10, type: 'message', message: 'HelloRequest' },
    hello_response: { id: 11, type: 'message', message: 'HelloResponse' },
    capability_query: { id: 12, type: 'message', message: 'CapabilityQuery' },
    capability_list: { id: 13, type: 'message', message: 'CapabilityList' },
    start_job: { id: 14, type: 'message', message: 'StartJob' },
    cancel_job: { id: 15, type: 'message', message: 'CancelJob' },
    query_job: { id: 16, type: 'message', message: 'QueryJob' },
    job_event: { id: 17, type: 'message', message: 'JobEvent' },
    transfer_begin: { id: 18, type: 'message', message: 'TransferBegin' },
    transfer_chunk: { id: 19, type: 'message', message: 'TransferChunk' },
    transfer_ack: { id: 20, type: 'message', message: 'TransferAck' },
    transfer_finish: { id: 21, type: 'message', message: 'TransferFinish' },
  },
  HelloRequest: {
    min_protocol_major: { id: 1, type: 'uint32' },
    max_protocol_major: { id: 2, type: 'uint32' },
    max_protocol_minor: { id: 3, type: 'uint32' },
    host_nonce: { id: 4, type: 'bytes' },
  },
  HelloResponse: {
    device_id: { id: 1, type: 'bytes' },
    boot_id: { id: 2, type: 'bytes' },
    protocol_major: { id: 3, type: 'uint32' },
    protocol_minor: { id: 4, type: 'uint32' },
    max_control_message: { id: 5, type: 'uint32' },
    max_data_chunk: { id: 6, type: 'uint32' },
    max_in_flight_jobs: { id: 7, type: 'uint32' },
    transport: { id: 8, type: 'string', repeated: true },
  },
  CapabilityQuery: {},
  CapabilityList: {
    capabilities: { id: 1, type: 'message', message: 'CapabilityDescriptor', repeated: true },
  },
  CapabilityDescriptor: {
    id: { id: 1, type: 'string' },
    major_version: { id: 2, type: 'uint32' },
    minor_version: { id: 3, type: 'uint32' },
    operations: { id: 4, type: 'message', message: 'OperationDescriptor', repeated: true },
    requirements: { id: 5, type: 'message', message: 'CapabilityRequirement', repeated: true },
  },
  OperationDescriptor: {
    id: { id: 1, type: 'string' },
    mutating: { id: 2, type: 'bool' },
    cancellable: { id: 3, type: 'bool' },
    max_payload_size: { id: 4, type: 'uint32' },
    requires_target_confirmation: { id: 5, type: 'bool' },
  },
  CapabilityRequirement: {
    id: { id: 1, type: 'string' },
    minimum_major: { id: 2, type: 'uint32' },
  },
  StartJob: {
    capability_id: { id: 1, type: 'string' },
    capability_major: { id: 2, type: 'uint32' },
    operation_id: { id: 3, type: 'string' },
    arguments: { id: 4, type: 'bytes' },
    deadline_ms: { id: 5, type: 'uint32' },
    idempotency_key: { id: 6, type: 'bytes' },
    user_confirmed: { id: 7, type: 'bool' },
    confirmed_target_uid: { id: 8, type: 'bytes' },
  },
  CancelJob: {
    job_id: { id: 1, type: 'fixed32' },
  },
  QueryJob: {
    job_id: { id: 1, type: 'fixed32' },
  },
  JobEvent: {
    job_id: { id: 1, type: 'fixed32' },
    state: { id: 2, type: 'enum' },
    stage: { id: 3, type: 'string' },
    progress_current: { id: 4, type: 'uint32' },
    progress_total: { id: 5, type: 'uint32' },
    error_code: { id: 6, type: 'enum' },
    detail: { id: 7, type: 'string' },
    result: { id: 8, type: 'bytes' },
  },
  DeviceInfoResult: {
    device_id: { id: 1, type: 'bytes' },
    boot_id: { id: 2, type: 'bytes' },
    firmware_name: { id: 3, type: 'string' },
    firmware_version: { id: 4, type: 'string' },
    radio_controller: { id: 5, type: 'string' },
    bluetooth_mac: { id: 6, type: 'bytes' },
  },
  TxAmplitudeRequest: {
    level: { id: 1, type: 'uint32', optional: true },
  },
  TxAmplitudeResult: {
    level: { id: 1, type: 'uint32' },
  },
  RfFieldRequest: {
    enabled: { id: 1, type: 'bool' },
  },
  RawRfTransceiveRequest: {
    tx: { id: 1, type: 'bytes' },
    timeout_ms: { id: 2, type: 'uint32' },
    tx_last_bits: { id: 3, type: 'uint32' },
    rx_align: { id: 4, type: 'uint32' },
    crc_flags: { id: 5, type: 'uint32' },
    rx_mode: { id: 6, type: 'enum' },
    tx_mode: { id: 7, type: 'enum', optional: true },
  },
  RawRfTransceiveResult: {
    rx: { id: 1, type: 'bytes' },
    rx_last_bits: { id: 2, type: 'uint32' },
    irq0: { id: 3, type: 'uint32' },
    irq1: { id: 4, type: 'uint32' },
    error: { id: 5, type: 'uint32' },
    collision: { id: 6, type: 'uint32' },
  },
  Clrc663CommandRequest: {
    command: { id: 1, type: 'uint32' },
    fifo_input: { id: 2, type: 'bytes' },
    timeout_ms: { id: 3, type: 'uint32' },
  },
  Clrc663CommandResult: {
    fifo_output: { id: 1, type: 'bytes' },
    irq0: { id: 2, type: 'uint32' },
    irq1: { id: 3, type: 'uint32' },
    error: { id: 4, type: 'uint32' },
    status: { id: 5, type: 'uint32' },
  },
  Clrc663RegisterRequest: {
    address: { id: 1, type: 'uint32' },
    value: { id: 2, type: 'uint32' },
  },
  Clrc663RegisterResult: { value: { id: 1, type: 'uint32' } },
  TransferBegin: {
    transfer_id: { id: 1, type: 'fixed32' },
    total_size: { id: 2, type: 'uint64' },
    sha256: { id: 3, type: 'bytes' },
    purpose: { id: 4, type: 'string' },
  },
  TransferChunk: {
    transfer_id: { id: 1, type: 'fixed32' },
    offset: { id: 2, type: 'uint64' },
    sequence: { id: 3, type: 'fixed32' },
    crc32: { id: 4, type: 'fixed32' },
    data: { id: 5, type: 'bytes' },
  },
  TransferAck: {
    transfer_id: { id: 1, type: 'fixed32' },
    next_offset: { id: 2, type: 'uint64' },
    receive_window: { id: 3, type: 'uint32' },
    error_code: { id: 4, type: 'enum' },
  },
  TransferFinish: {
    transfer_id: { id: 1, type: 'fixed32' },
  },
}

/** 协议编解码器。 */
export const proto = new ProtoRegistry(SCHEMAS)

/** A01 的能力 ID。 */
export const CAPABILITY = {
  DEVICE_INFO: 'org.example.device.info',
  CLRC663_CONFIG: 'org.example.rf.clrc663.config',
  RF_RAW: 'org.example.rf.raw',
} as const
