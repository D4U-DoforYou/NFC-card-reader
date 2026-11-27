/**
 * 刷图数据的字节统计。
 *
 * 刷图出问题时，第一件事就是想知道「到底往屏幕里塞了多少字节」：
 * 图像处理后多大、压缩后多大、拆成多少包、每包多大。
 * 这里把数字一次算清，交给界面写进日志，方便对着日志核对传屏数据。
 */

/** 一次分包之后的统计。 */
export interface UploadStats {
  /** 图像处理后的点阵字节数（上传给屏幕的原始数据）。 */
  packedBytes: number
  /** 屏幕真正收到的图像数据字节数：D3 是压缩后的大小，D2 与点阵等长。 */
  payloadBytes: number
  /** 应用层包数量。 */
  packetCount: number
  /** 单个包头长度（字节）。 */
  headerBytes: number
  /** 含包头的协议总字节数，也就是实际发出去的应用层数据量。 */
  totalBytes: number
  /** 单包载荷最小字节数。 */
  minPayload: number
  /** 单包载荷最大字节数。 */
  maxPayload: number
  /** 载荷字节数占点阵的比例：小于 1 说明压缩省下了数据。 */
  ratio: number
  /** 包的命令名，例如 D3 / D2。 */
  packetLabel: string
  /** 应用层子包大小（字节）。标签按这个固定边界重组压缩流，不能改。 */
  chunkSize: number
}

/** 统计分包结果所需的参数。 */
export interface UploadStatsInput {
  /** 分好包的应用层数据包。 */
  packets: Uint8Array[]
  /** 单个包头长度（字节）。 */
  headerBytes: number
  /** 图像处理后的点阵字节数。 */
  packedBytes: number
  /** 包的命令名，例如 D3 / D2。 */
  packetLabel: string
  /** 应用层子包大小（字节）。 */
  chunkSize: number
}

/**
 * 统计分包之后的字节数。
 *
 * 载荷 = 包长 - 包头：去掉协议自己的包头，剩下的才是屏幕真正收到的图像数据，
 * 所以「屏幕实收多少字节」和「总共发了多少字节」是两个数，缺一不可。
 */
export function buildUploadStats(input: UploadStatsInput): UploadStats {
  const { packets, headerBytes, packedBytes, packetLabel, chunkSize } = input
  let payloadBytes = 0
  let totalBytes = 0
  let minPayload = Number.POSITIVE_INFINITY
  let maxPayload = 0
  for (const packet of packets) {
    if (packet.length < headerBytes) {
      throw new Error(`数据包长度 ${packet.length} 小于包头长度 ${headerBytes}`)
    }
    const payload = packet.length - headerBytes
    payloadBytes += payload
    totalBytes += packet.length
    if (payload < minPayload) {
      minPayload = payload
    }
    if (payload > maxPayload) {
      maxPayload = payload
    }
  }
  if (!packets.length) {
    minPayload = 0
  }
  return {
    packedBytes,
    payloadBytes,
    packetCount: packets.length,
    headerBytes,
    totalBytes,
    minPayload,
    maxPayload,
    ratio: packedBytes > 0 ? payloadBytes / packedBytes : 0,
    packetLabel,
    chunkSize,
  }
}

/** 千分位，便于一眼看出字节数量级。 */
export function formatBytes(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 把统计结果写成一句人话，直接进日志。
 *
 * 压缩过的路径会说明压缩比，未压缩的路径直说与点阵等长，
 * 不含糊其辞——不然看到字节数变小还以为是丢数据。
 */
export function describeUploadStats(stats: UploadStats): string {
  const parts: string[] = []
  parts.push(`点阵 ${formatBytes(stats.packedBytes)} 字节`)
  if (stats.ratio < 0.999) {
    parts.push(`压缩后 ${formatBytes(stats.payloadBytes)} 字节（占点阵 ${(stats.ratio * 100).toFixed(1)}%）`)
  } else {
    parts.push(`未压缩，屏幕实收 ${formatBytes(stats.payloadBytes)} 字节`)
  }
  const payloadRange = stats.minPayload === stats.maxPayload
    ? `${stats.minPayload} 字节`
    : `${stats.minPayload}~${stats.maxPayload} 字节`
  parts.push(
    `拆成 ${formatBytes(stats.packetCount)} 个 ${stats.packetLabel} 包（子包固定 ${stats.chunkSize} 字节），` +
      `单包载荷 ${payloadRange}，含 ${stats.headerBytes} 字节包头共 ${formatBytes(stats.totalBytes)} 字节`,
  )
  return `传屏数据：${parts.join('；')}`
}
