/**
 * 极简 protobuf 编解码（proto3 语义）。
 *
 * 只覆盖 A01 协议用到的字段类型，没有引入任何外部依赖：
 * varint / fixed32 / fixed64 / bool / enum / string / bytes / 嵌套消息。
 *
 * proto3 的「默认值不写出」规则很关键——固件用的是 nanopb + proto3，
 * 主机若多写了默认值字段不会出错，但少写会直接影响可选字段的
 * presence 判定（比如 TxAmplitudeRequest.level 是 optional，
 * 固件靠 has_level 判断参数是否给了）。
 */

/** 字段类型。 */
export type ProtoFieldType =
  | 'uint32'
  | 'uint64'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'fixed32'
  | 'fixed64'
  | 'enum'
  | 'message'

/** 字段定义。 */
export interface ProtoField {
  /** 字段号。 */
  id: number
  /** 字段类型。 */
  type: ProtoFieldType
  /** 嵌套消息的类型名（type 为 message 时必填）。 */
  message?: string
  /** 是否为 repeated 字段。 */
  repeated?: boolean
  /** 是否显式存在（proto3 optional）：等于默认值也要写出去。 */
  optional?: boolean
}

/** 消息结构：字段名 → 字段定义。 */
export type ProtoSchema = Record<string, ProtoField>

/** 消息对象。 */
export type ProtoObject = Record<string, unknown>

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

/** protobuf 编解码错误。 */
export class ProtoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtoError'
  }
}

/** 可增长的字节写入器。 */
class Writer {
  private buffer = new Uint8Array(256)
  private length = 0

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) {
      return
    }
    let size = this.buffer.length * 2
    while (size < this.length + extra) {
      size *= 2
    }
    const next = new Uint8Array(size)
    next.set(this.buffer.subarray(0, this.length), 0)
    this.buffer = next
  }

  byte(value: number): void {
    this.ensure(1)
    this.buffer[this.length++] = value & 0xff
  }

  bytes(values: Uint8Array): void {
    this.ensure(values.length)
    this.buffer.set(values, this.length)
    this.length += values.length
  }

  varint(value: number): void {
    let remaining = value >>> 0
    while (remaining >= 0x80) {
      this.byte((remaining & 0x7f) | 0x80)
      remaining >>>= 7
    }
    this.byte(remaining)
  }

  /** 64 位 varint，用 BigInt 承载以免丢精度。 */
  varint64(value: bigint): void {
    let remaining = value & 0xffffffffffffffffn
    while (remaining >= 0x80n) {
      this.byte(Number(remaining & 0x7fn) | 0x80)
      remaining >>= 7n
    }
    this.byte(Number(remaining))
  }

  tag(id: number, wireType: number): void {
    this.varint((id << 3) | wireType)
  }

  fixed32(value: number): void {
    this.ensure(4)
    const view = new DataView(this.buffer.buffer)
    view.setUint32(this.length, value >>> 0, true)
    this.length += 4
  }

  fixed64(value: bigint): void {
    this.ensure(8)
    const view = new DataView(this.buffer.buffer)
    view.setBigUint64(this.length, value & 0xffffffffffffffffn, true)
    this.length += 8
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }
}

/** 字节读取器。 */
class Reader {
  offset = 0

  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.data.length
  }

  varint(): number {
    let result = 0
    let shift = 1
    for (let index = 0; index < 5; index += 1) {
      if (this.offset >= this.data.length) {
        throw new ProtoError('varint 被截断')
      }
      const byte = this.data[this.offset++]
      result += (byte & 0x7f) * shift
      if ((byte & 0x80) === 0) {
        return result >>> 0
      }
      shift *= 128
    }
    throw new ProtoError('varint 过长')
  }

  /** 64 位 varint。 */
  varint64(): bigint {
    let result = 0n
    let shift = 0n
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.data.length) {
        throw new ProtoError('varint 被截断')
      }
      const byte = this.data[this.offset++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) {
        return result
      }
      shift += 7n
    }
    throw new ProtoError('varint 过长')
  }

  fixed32(): number {
    if (this.offset + 4 > this.data.length) {
      throw new ProtoError('fixed32 被截断')
    }
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength)
    const value = view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  fixed64(): bigint {
    if (this.offset + 8 > this.data.length) {
      throw new ProtoError('fixed64 被截断')
    }
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength)
    const value = view.getBigUint64(this.offset, true)
    this.offset += 8
    return value
  }

  lengthDelimited(): Uint8Array {
    const size = this.varint()
    if (this.offset + size > this.data.length) {
      throw new ProtoError('长度定界字段被截断')
    }
    const value = this.data.subarray(this.offset, this.offset + size)
    this.offset += size
    return value
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint()
        return
      case WIRE_FIXED64:
        this.fixed64()
        return
      case WIRE_LENGTH:
        this.lengthDelimited()
        return
      case WIRE_FIXED32:
        this.fixed32()
        return
      default:
        throw new ProtoError(`未知的 wire type ${wireType}`)
    }
  }
}

/** 字符串编码。 */
function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** 字符串解码。 */
function decodeText(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

/**
 * 消息注册表：按类型名查找结构，负责编码与解码。
 */
export class ProtoRegistry {
  constructor(private readonly schemas: Record<string, ProtoSchema>) {}

  private schema(typeName: string): ProtoSchema {
    const schema = this.schemas[typeName]
    if (!schema) {
      throw new ProtoError(`未注册的消息类型 ${typeName}`)
    }
    return schema
  }

  /** 编码一条消息。 */
  encode(typeName: string, value: ProtoObject): Uint8Array {
    const schema = this.schema(typeName)
    const writer = new Writer()
    for (const [name, field] of Object.entries(schema)) {
      const raw = value[name]
      if (raw === undefined || raw === null) {
        continue
      }
      if (field.repeated) {
        const items = raw as unknown[]
        for (const item of items) {
          if (item === undefined || item === null) {
            continue
          }
          this.writeField(writer, field, item)
        }
        continue
      }
      if (!field.optional && this.isDefault(field, raw)) {
        continue
      }
      this.writeField(writer, field, raw)
    }
    return writer.result()
  }

  /** 是否为 proto3 默认值（默认不写出）。 */
  private isDefault(field: ProtoField, value: unknown): boolean {
    switch (field.type) {
      case 'uint32':
      case 'enum':
        return Number(value) === 0
      case 'uint64':
        return BigInt(value as bigint) === 0n
      case 'fixed64':
        return BigInt(value as bigint) === 0n
      case 'bool':
        return value === false
      case 'string':
        return value === ''
      case 'bytes':
        return (value as Uint8Array).length === 0
      default:
        return false
    }
  }

  private writeField(writer: Writer, field: ProtoField, value: unknown): void {
    switch (field.type) {
      case 'uint32':
      case 'enum':
        writer.tag(field.id, WIRE_VARINT)
        writer.varint(Number(value))
        return
      case 'uint64':
        writer.tag(field.id, WIRE_VARINT)
        writer.varint64(BigInt(value as bigint))
        return
      case 'bool':
        writer.tag(field.id, WIRE_VARINT)
        writer.varint(value ? 1 : 0)
        return
      case 'fixed32':
        writer.tag(field.id, WIRE_FIXED32)
        writer.fixed32(Number(value))
        return
      case 'fixed64':
        writer.tag(field.id, WIRE_FIXED64)
        writer.fixed64(BigInt(value as bigint))
        return
      case 'string': {
        const payload = encodeText(String(value))
        writer.tag(field.id, WIRE_LENGTH)
        writer.varint(payload.length)
        writer.bytes(payload)
        return
      }
      case 'bytes': {
        const payload = value as Uint8Array
        writer.tag(field.id, WIRE_LENGTH)
        writer.varint(payload.length)
        writer.bytes(payload)
        return
      }
      case 'message': {
        const nested = this.encode(field.message as string, value as ProtoObject)
        writer.tag(field.id, WIRE_LENGTH)
        writer.varint(nested.length)
        writer.bytes(nested)
        return
      }
      default:
        throw new ProtoError(`未知的字段类型 ${field.type}`)
    }
  }

  /** 解码一条消息。 */
  decode(typeName: string, bytes: Uint8Array): ProtoObject {
    const schema = this.schema(typeName)
    const byId = new Map<number, { name: string; field: ProtoField }>()
    for (const [name, field] of Object.entries(schema)) {
      byId.set(field.id, { name, field })
    }
    const reader = new Reader(bytes)
    const result: ProtoObject = {}
    while (!reader.done) {
      const key = reader.varint()
      const id = key >>> 3
      const wireType = key & 7
      const entry = byId.get(id)
      if (!entry) {
        reader.skip(wireType)
        continue
      }
      const { name, field } = entry
      const value = this.readValue(reader, field, wireType)
      if (field.repeated) {
        const list = (result[name] as unknown[]) ?? []
        list.push(value)
        result[name] = list
      } else {
        result[name] = value
      }
    }
    return result
  }

  private readValue(reader: Reader, field: ProtoField, wireType: number): unknown {
    switch (field.type) {
      case 'uint32':
      case 'enum':
        return reader.varint()
      case 'uint64':
        return reader.varint64()
      case 'bool':
        return reader.varint() !== 0
      case 'fixed32':
        return reader.fixed32()
      case 'fixed64':
        return reader.fixed64()
      case 'string':
        return decodeText(reader.lengthDelimited())
      case 'bytes':
        return reader.lengthDelimited().slice()
      case 'message': {
        const nested = reader.lengthDelimited()
        return this.decode(field.message as string, nested)
      }
      default:
        reader.skip(wireType)
        return undefined
    }
  }
}
