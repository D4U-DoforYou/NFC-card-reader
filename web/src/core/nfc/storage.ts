/**
 * 卡片存储浏览：ISO-DEP 文件系统清单与内容读取。
 *
 * 「查看分区」有两种含义，取决于卡片：
 *   - ISO-DEP（DESFire 这类）：是文件系统的目录/文件，按 FID 选、按偏移读。
 *   - MIFARE Classic：是扇区/块，见 utils/nfc/mifare.ts。
 * 这个模块负责前者。
 */

import { IsoDepSession } from '../rf/isoDep'
import {
  FileEntry,
  StatusWord,
  parseFileList,
  readBinary,
  selectById,
  splitResponse,
  updateBinary,
  writeBinary,
} from './apdu'

/** 一次写入的最大字节数，留出 APDU 头与状态字的空间。 */
const WRITE_CHUNK = 200

/** 主文件（MF）的标识。 */
export const MASTER_FILE_ID = 0x3f00

/** 文件清单。 */
export interface StorageListing {
  /** 文件条目。 */
  files: FileEntry[]
  /** SELECT MF 的原始应答。 */
  raw: Uint8Array
  /** SELECT MF 的状态字。 */
  status: StatusWord
}

/**
 * 读出 ISO-DEP 卡片的文件清单。
 *
 * 流程：SELECT MF → 得到目录表 → 解析 TLV。
 * 有些卡片（需要认证）会返回 6982，此时把状态字原样交给上层显示。
 */
export async function listIsoDepFiles(session: IsoDepSession): Promise<StorageListing> {
  const response = await session.exchange(selectById(MASTER_FILE_ID))
  const { data, status } = splitResponse(response)
  return { files: status.ok ? parseFileList(data) : [], raw: data, status }
}

/**
 * 读出一个文件的内容。
 *
 * 先 SELECT 到该文件，再 READ BINARY；文件大于一次读出的长度时循环读。
 */
export async function readIsoDepFile(
  session: IsoDepSession,
  fid: number,
  size: number
): Promise<{ data: Uint8Array; status: StatusWord }> {
  const select = await session.exchange(selectById(fid))
  const selected = splitResponse(select)
  if (!selected.status.ok) {
    return { data: new Uint8Array(0), status: selected.status }
  }
  const total = size > 0 ? Math.min(size, 4096) : 256
  const chunks: Uint8Array[] = []
  let offset = 0
  let status = selected.status
  while (offset < total) {
    const want = Math.min(0xf0, total - offset)
    const response = await session.exchange(readBinary(offset, want))
    const split = splitResponse(response)
    status = split.status
    if (!status.ok) {
      break
    }
    if (!split.data.length) {
      break
    }
    chunks.push(split.data)
    offset += split.data.length
    if (split.data.length < want) {
      break
    }
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const data = new Uint8Array(length)
  let cursor = 0
  for (const chunk of chunks) {
    data.set(chunk, cursor)
    cursor += chunk.length
  }
  return { data, status }
}

/**
 * 写出一个文件的内容。
 *
 * 流程：SELECT 到该文件 → 分块 WRITE BINARY；卡片只认 UPDATE BINARY 时退回它。
 * 写是不可撤销的，调用方应先让用户确认卡片 UID。
 */
export async function writeIsoDepFile(
  session: IsoDepSession,
  fid: number,
  data: Uint8Array
): Promise<StatusWord> {
  const select = await session.exchange(selectById(fid))
  const selected = splitResponse(select)
  if (!selected.status.ok) {
    return selected.status
  }

  let offset = 0
  let status = selected.status
  while (offset < data.length) {
    const chunk = data.slice(offset, Math.min(offset + WRITE_CHUNK, data.length))
    const response = await session.exchange(writeBinary(offset, chunk), undefined, session.uid)
    const split = splitResponse(response)
    if (!split.status.ok) {
      // 有的卡片只实现了 UPDATE BINARY，换一种再试一次。
      const fallback = await session.exchange(updateBinary(offset, chunk), undefined, session.uid)
      const fallbackSplit = splitResponse(fallback)
      if (!fallbackSplit.status.ok) {
        return fallbackSplit.status
      }
      status = fallbackSplit.status
    } else {
      status = split.status
    }
    offset += chunk.length
  }
  return status
}
