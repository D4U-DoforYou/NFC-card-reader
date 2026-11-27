/**
 * APDU 助手与 ISO-7816-4 TLV 解析。
 *
 * APDU 用短格式（Case 1~4）：INS|P1|P2|[Lc|数据|Le]。
 * 状态字、GET RESPONSE 续读、文件列表解析都在这里收口，
 * 页面上只管拼命令和展示结果。
 */

/** APDU 指令常量。 */
export const APDU = {
  SELECT: 0xa4,
  READ_BINARY: 0xb0,
  GET_DATA: 0xca,
  GET_RESPONSE: 0xc0,
  READ_RECORD: 0xb2,
  WRITE_BINARY: 0xd6,
  UPDATE_BINARY: 0xe6,
} as const

/** 状态字。 */
export interface StatusWord {
  sw1: number
  sw2: number
  /** 是否成功（0x9000）。 */
  ok: boolean
  /** 中文说明。 */
  text: string
  /** 0x61xx 时表示还有多少字节待取。 */
  pending: number
}

/** 常见状态字说明。 */
const SW_TEXT: Record<string, string> = {
  '9000': '成功',
  '6282': '文件已结束，还有数据待取（可再发 GET RESPONSE）',
  '6300': '认证失败或状态未改变',
  '6400': '执行错误，状态未改变',
  '6581': '内存失败',
  '6700': '长度错误',
  '6800': 'CLA 不支持',
  '6981': '命令不支持',
  '6982': '安全状态不满足（需要认证）',
  '6983': '认证方法已锁定',
  '6985': '使用条件不满足',
  '6986': '命令不允许（当前状态不允许）',
  '6A80': '数据字段错误',
  '6A81': '不支持的功能',
  '6A82': '文件或应用不存在',
  '6A83': '记录不存在',
  '6A84': '文件容量不足',
  '6A86': 'P1/P2 参数错误',
  '6D00': 'INS 不支持',
  '6E00': 'CLA 不支持',
  '6F00': '不支持的命令',
}

/**
 * 解析状态字。
 */
export function parseStatusWord(data: Uint8Array): StatusWord {
  if (data.length < 2) {
    return { sw1: 0, sw2: 0, ok: false, text: '响应缺少状态字', pending: 0 }
  }
  const sw1 = data[data.length - 2]
  const sw2 = data[data.length - 1]
  const key = `${sw1.toString(16).padStart(2, '0').toUpperCase()}${sw2
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()}`
  let text = SW_TEXT[key]
  let pending = 0
  if (!text) {
    if (sw1 === 0x61) {
      pending = sw2
      text = `还有 ${sw2} 字节待取（请发 GET RESPONSE）`
    } else if (sw1 === 0x6c) {
      pending = sw2
      text = `长度错误，正确的 Le 应为 ${sw2}`
    } else if (sw1 === 0x63 && (sw2 & 0xf0) === 0xc0) {
      text = `校验失败，剩余尝试次数 ${sw2 & 0x0f}`
    } else {
      text = '未知的状态字'
    }
  }
  return { sw1, sw2, ok: sw1 === 0x90 && sw2 === 0x00, text, pending }
}

/** TLV 条目。 */
export interface TlvEntry {
  /** 标签（1~2 字节）。 */
  tag: number
  /** 长度。 */
  length: number
  /** 值。 */
  value: Uint8Array
  /** 子条目（属性类标签会再解析一层）。 */
  children: TlvEntry[]
}

function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

/**
 * 解析 BER-TLV 序列。
 *
 * 标签：低 5 位全为 1 时是双字节标签。
 * 长度：首字节 < 0x80 是短形式；0x81/0x82 后面跟 1/2 字节长度。
 */
export function parseTlv(data: Uint8Array): TlvEntry[] {
  const entries: TlvEntry[] = []
  let offset = 0
  while (offset < data.length) {
    let tag = data[offset]
    offset += 1
    if ((tag & 0x1f) === 0x1f) {
      if (offset >= data.length) {
        break
      }
      tag = (tag << 8) | data[offset]
      offset += 1
    }
    if (offset >= data.length) {
      break
    }
    let length = data[offset]
    offset += 1
    if (length === 0x80) {
      // 无限长度：本工具不解析，直接收尾
      break
    }
    if (length & 0x80) {
      const count = length & 0x7f
      if (count > 3 || offset + count > data.length) {
        break
      }
      length = 0
      for (let i = 0; i < count; i += 1) {
        length = (length << 8) | data[offset]
        offset += 1
      }
    }
    if (offset + length > data.length) {
      length = data.length - offset
    }
    const value = data.slice(offset, offset + length)
    offset += length
    entries.push({ tag, length, value, children: [] })
  }
  return entries
}

/**
 * 文件属性标签：0xA0~0xCF 是属性类，值里还是一层 TLV。
 *
 * 注意 0x80~0x8F 是基本文件（EF）的名字标签，不能算成属性。
 */
function isPropertyTag(tag: number): boolean {
  return tag >= 0xa0 && tag <= 0xcf
}

/**
 * 解析属性类标签的子条目。
 */
export function parseTlvChildren(entry: TlvEntry): TlvEntry[] {
  if (!isPropertyTag(entry.tag) || entry.children.length) {
    return entry.children
  }
  entry.children = parseTlv(entry.value)
  return entry.children
}

/** 文件系统里的一项（DF 或 EF）。 */
export interface FileEntry {
  /** 文件标识（2 字节 FID），没有则为 0。 */
  fid: number
  /** 文件标识的十六进制。 */
  fidHex: string
  /** 标签。 */
  tag: number
  /** 标签的中文说明。 */
  tagName: string
  /** 文件大小（字节），未知为 -1。 */
  size: number
  /** 原始值。 */
  value: Uint8Array
}

/** 文件标签的中文说明。 */
export function describeFileTag(tag: number): string {
  if (tag >= 0x61 && tag <= 0x6f) {
    return '目录文件（DF）'
  }
  if (tag >= 0x80 && tag <= 0x8f) {
    return '基本文件（EF）'
  }
  if (tag >= 0x90 && tag <= 0x9f) {
    return '工作文件（EF）'
  }
  if (tag >= 0xa0 && tag <= 0xbf) {
    return '属性文件（DF 属性）'
  }
  if (tag >= 0xc0 && tag <= 0xcf) {
    return '辅助文件属性'
  }
  return '未知标签'
}

/**
 * 把 SELECT 返回的 TLV 列表整理成文件清单。
 *
 * DESFire 这类卡片 SELECT MF 后返回的就是一张表：
 * 6x/8x/9x 开头的条目是文件名（值是 2 字节 FID），
 * Ax/Bx/Cx 是对应的属性（值里还是一层 TLV，0x82 是文件大小）。
 * 属性条目与文件条目按出现顺序一一对应。
 */
export function parseFileList(data: Uint8Array): FileEntry[] {
  const entries = parseTlv(data)
  const files: FileEntry[] = []
  const propertyEntries: TlvEntry[] = []
  for (const entry of entries) {
    if (isPropertyTag(entry.tag)) {
      propertyEntries.push(entry)
      continue
    }
    const fid = entry.value.length >= 2 ? (entry.value[0] << 8) | entry.value[1] : 0
    files.push({
      fid,
      fidHex: fid ? fid.toString(16).padStart(4, '0').toUpperCase() : '—',
      tag: entry.tag,
      tagName: describeFileTag(entry.tag),
      size: -1,
      value: entry.value,
    })
  }
  // 属性按顺序回填文件大小：子条目 0x82 的两字节就是大小。
  for (let index = 0; index < files.length && index < propertyEntries.length; index += 1) {
    const children = parseTlvChildren(propertyEntries[index])
    for (const child of children) {
      if (child.tag === 0x82 && child.value.length >= 2) {
        files[index].size = (child.value[0] << 8) | child.value[1]
        break
      }
    }
  }
  return files
}

/**
 * 构造 SELECT（按文件标识）指令。
 */
export function selectById(fid: number): Uint8Array {
  return new Uint8Array([0x00, APDU.SELECT, 0x00, 0x00, 0x02, (fid >> 8) & 0xff, fid & 0xff])
}

/**
 * 构造 SELECT（按名称）指令。
 */
export function selectByName(name: Uint8Array): Uint8Array {
  const apdu = new Uint8Array(5 + name.length)
  apdu[0] = 0x00
  apdu[1] = APDU.SELECT
  apdu[2] = 0x04
  apdu[3] = 0x00
  apdu[4] = name.length
  apdu.set(name, 5)
  return apdu
}

/**
 * 构造 READ BINARY 指令。
 */
export function readBinary(offset: number, length: number): Uint8Array {
  const le = Math.max(1, Math.min(0xff, length))
  return new Uint8Array([0x00, APDU.READ_BINARY, (offset >> 8) & 0xff, offset & 0xff, le])
}

/**
 * 构造 WRITE BINARY 指令（写当前选中的文件）。
 */
export function writeBinary(offset: number, data: Uint8Array): Uint8Array {
  return shortApdu(APDU.WRITE_BINARY, (offset >> 8) & 0xff, offset & 0xff, data)
}

/**
 * 构造 UPDATE BINARY 指令（部分卡片只认这一种写）。
 */
export function updateBinary(offset: number, data: Uint8Array): Uint8Array {
  return shortApdu(APDU.UPDATE_BINARY, (offset >> 8) & 0xff, offset & 0xff, data)
}

/**
 * 构造 GET DATA 指令。
 */
export function getData(tag: number, length = 0xff): Uint8Array {
  return new Uint8Array([0x00, APDU.GET_DATA, (tag >> 8) & 0xff, tag & 0xff, length])
}

/**
 * 构造 GET RESPONSE 指令。
 */
export function getResponse(length = 0xff): Uint8Array {
  return new Uint8Array([0x00, APDU.GET_RESPONSE, 0x00, 0x00, length])
}

/**
 * 拼出带 Lc 的短 APDU。
 */
export function shortApdu(ins: number, p1: number, p2: number, data: Uint8Array): Uint8Array {
  const apdu = new Uint8Array(5 + data.length)
  apdu[0] = 0x00
  apdu[1] = ins
  apdu[2] = p1
  apdu[3] = p2
  apdu[4] = data.length
  apdu.set(data, 5)
  return apdu
}

/**
 * 把响应拆成「数据 + 状态字」。
 */
export function splitResponse(response: Uint8Array): { data: Uint8Array; status: StatusWord } {
  if (response.length < 2) {
    return { data: response, status: parseStatusWord(response) }
  }
  return {
    data: response.slice(0, response.length - 2),
    status: parseStatusWord(response),
  }
}

/**
 * 把字节数组格式化成十六进制文本。
 */
export function bytesToHex(data: Uint8Array): string {
  return toHex(data)
}
