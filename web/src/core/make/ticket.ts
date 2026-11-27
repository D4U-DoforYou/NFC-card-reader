/**
 * 火车票票面：字段模型与画布渲染。
 *
 * 参考现实中的纸质火车票排版，把票号、检票口、车站、车次、日期时间、
 * 车厢席位、票价、席别、乘车人、二维码、底部编码等信息都做成可编辑字段。
 *
 * 票面按**横版** 768×552 出图，跟真实纸质票一致：左上票号、右上检票口，
 * 中间一行「出发站 → 车次 → 到达站」，右下角二维码，底部黄条放编码与发售站。
 */

/** 票面字段。 */
export interface TicketFields {
  /** 票号，左上角红色。 */
  ticketNo: string
  /** 检票口，右上角。 */
  gate: string
  /** 出发站。 */
  fromStation: string
  /** 出发站拼音。 */
  fromPinyin: string
  /** 到达站。 */
  toStation: string
  /** 到达站拼音。 */
  toPinyin: string
  /** 车次。 */
  trainNo: string
  /** 出发日期，形如 2015年07月10日。 */
  date: string
  /** 出发时间，形如 12:21。 */
  time: string
  /** 开车时刻的汉字说明。 */
  departLabel: string
  /** 车厢，形如 11车。 */
  carriage: string
  /** 座位，形如 13A号。 */
  seat: string
  /** 票价数字。 */
  price: string
  /** 购票渠道。 */
  channel: string
  /** 席别。 */
  seatClass: string
  /** 检票状态标记。 */
  checked: string
  /** 乘车人证件号。 */
  idNumber: string
  /** 乘车人姓名。 */
  passenger: string
  /** 虚线框里的第一行提示。 */
  slogan: string
  /** 虚线框里的第二行祝福。 */
  wish: string
  /** 二维码内容。 */
  qrContent: string
  /** 底部条码区的编码。 */
  bottomCode: string
  /** 底部条码区的发售站。 */
  bottomOffice: string
}

/** 新建一张票时的默认值。 */
export function defaultTicketFields(): TicketFields {
  return {
    ticketNo: 'QWE9527',
    gate: '检票口A10',
    fromStation: '南京南站',
    fromPinyin: 'Nanjingnan',
    toStation: '北京南站',
    toPinyin: 'Beijingnan',
    trainNo: 'G124',
    date: '2015年07月10日',
    time: '12:21',
    departLabel: '开',
    carriage: '11车',
    seat: '13A号',
    price: '443.5',
    channel: '网',
    seatClass: '二等座',
    checked: '已检',
    idNumber: '11000000****0001',
    passenger: '狗腿',
    slogan: '买票请到12306  发货请到95306',
    wish: '中国铁路祝您旅途愉快',
    // 默认内容短一点：二维码版本越小，同样的面积里每格越大，越容易被扫到。
    qrContent: 'https://www.12306.cn',
    bottomCode: '1122334455667788',
    bottomOffice: '北京南售',
  }
}

/** 票面配色：按四色墨水屏的调色板选，量化后不会串色。 */
export const TICKET_COLORS = {
  /** 票面底色。 */
  paper: '#ffffff',
  /** 正文黑。 */
  ink: '#14161a',
  /** 票号红。 */
  red: '#c00000',
  /** 底部条与强调黄。 */
  yellow: '#f5cd00',
  /** 虚线与分隔线。 */
  line: '#8b9099',
}

/**
 * 画布尺寸。
 *
 * 票面按**横版**出图，跟真实纸质火车票一致。
 * 宽度取 768：正好是墨水屏 552×768 转 90° 后的宽高，
 * 想铺满整屏时在图像处理页把角度转 90° 即可无缝铺满。
 */
export const TICKET_WIDTH = 768
export const TICKET_HEIGHT = 552

/** 画布上下文（getContext 返回 any，这里只收窄用到的方法）。 */
export interface TicketContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  font: string
  textAlign: 'left' | 'center' | 'right'
  textBaseline: 'top' | 'middle' | 'bottom' | 'alphabetic' | 'hanging' | 'ideographic'
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  fill(): void
  setLineDash(segments: number[]): void
  stroke(): void
  save(): void
  restore(): void
  clearRect(x: number, y: number, w: number, h: number): void
  translate(x: number, y: number): void
  rotate(angle: number): void
}

/** 设置字体。 */
function useFont(ctx: TicketContext, size: number, weight = 'normal', family = 'sans-serif'): void {
  ctx.font = `${weight} ${size}px ${family}`
}

/**
 * 画一条虚线。
 */
function drawDashedLine(ctx: TicketContext, x1: number, y1: number, x2: number, y2: number, dash = 6): void {
  ctx.save()
  ctx.strokeStyle = TICKET_COLORS.line
  ctx.lineWidth = 1.5
  ctx.setLineDash([dash, dash])
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

/**
 * 画二维码。
 *
 * 二维码自带 4 模块静区，扫描器需要它来定位图形。
 *
 * 模块边界一律取整：模块尺寸是小数时，相邻模块之间会留下发丝级的缝，
 * 扫读器容易在缝上判定失败。取整后模块严丝合缝、既不重叠也不留缝。
 */
export function drawQrMatrix(
  ctx: TicketContext,
  modules: number[][],
  x: number,
  y: number,
  size: number
): void {
  const count = modules.length
  const quiet = 4
  const total = count + quiet * 2
  const unit = size / total
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, size, size)
  ctx.fillStyle = TICKET_COLORS.ink
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!modules[row][col]) {
        continue
      }
      const left = Math.round(x + (col + quiet) * unit)
      const right = Math.round(x + (col + quiet + 1) * unit)
      const top = Math.round(y + (row + quiet) * unit)
      const bottom = Math.round(y + (row + quiet + 1) * unit)
      ctx.fillRect(left, top, right - left, bottom - top)
    }
  }
  ctx.restore()
}

/**
 * 渲染票面。
 *
 * `qrModules` 为二维码矩阵；为空时只画票面，二维码位置留白。
 *
 * 布局按横版排：左上票号、右上检票口，中间一行是「出发站 → 车次 → 到达站」，
 * 右下角二维码，底部一条黄底色带放编码与发售站。
 *
 * `rotation` 为 90 时整幅转 90° 再画，用来把横版票面填进竖屏的画布——
 * 刷到竖着的墨水屏上时，把标签横过来拿就是正的票。
 */
export function renderTicket(
  ctx: TicketContext,
  fields: TicketFields,
  qrModules: number[][] | null,
  rotation: 0 | 90 = 0
): void {
  const margin = 24
  const right = TICKET_WIDTH - margin
  const center = TICKET_WIDTH / 2

  ctx.save()
  if (rotation === 90) {
    // 顺时针转 90°：票面左上角落到目标画布的右上角
    ctx.translate(TICKET_HEIGHT, 0)
    ctx.rotate(Math.PI / 2)
  }

  ctx.clearRect(0, 0, TICKET_WIDTH, TICKET_HEIGHT)
  ctx.fillStyle = TICKET_COLORS.paper
  ctx.fillRect(0, 0, TICKET_WIDTH, TICKET_HEIGHT)

  // 顶部：票号（左，红）与检票口（右）
  ctx.fillStyle = TICKET_COLORS.red
  useFont(ctx, 36, 'bold')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(fields.ticketNo, margin, 18)

  ctx.fillStyle = TICKET_COLORS.ink
  useFont(ctx, 26)
  ctx.textAlign = 'right'
  ctx.fillText(fields.gate, right, 26)

  drawDashedLine(ctx, margin, 72, right, 72)

  // 站名行：出发站（左）、车次（中）、到达站（右）
  //
  // 横版才排得开一行三段，所以车次放回两站中间，跟真实票面一致。
  const stationY = 88
  ctx.fillStyle = TICKET_COLORS.ink
  useFont(ctx, 48, 'bold', 'serif')
  ctx.textAlign = 'left'
  ctx.fillText(fields.fromStation, margin, stationY)
  ctx.textAlign = 'right'
  ctx.fillText(fields.toStation, right, stationY)

  // 拼音
  useFont(ctx, 22, 'normal', 'serif')
  ctx.textAlign = 'left'
  ctx.fillText(fields.fromPinyin, margin, stationY + 58)
  ctx.textAlign = 'right'
  ctx.fillText(fields.toPinyin, right, stationY + 58)

  // 车次与箭头
  ctx.textAlign = 'center'
  useFont(ctx, 38, 'bold', 'serif')
  ctx.fillStyle = TICKET_COLORS.ink
  ctx.fillText(fields.trainNo, center, stationY + 8)

  const arrowY = stationY + 74
  ctx.strokeStyle = TICKET_COLORS.ink
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(center - 88, arrowY)
  ctx.lineTo(center + 80, arrowY)
  ctx.stroke()
  ctx.fillStyle = TICKET_COLORS.ink
  ctx.beginPath()
  ctx.moveTo(center + 80, arrowY - 7)
  ctx.lineTo(center + 96, arrowY)
  ctx.lineTo(center + 80, arrowY + 7)
  ctx.closePath()
  ctx.fill()

  // 日期时间与车厢席位
  const infoY = 198
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = TICKET_COLORS.ink
  useFont(ctx, 24)
  ctx.fillText(`${fields.date} ${fields.time}${fields.departLabel}`, margin, infoY)
  ctx.textAlign = 'right'
  ctx.fillText(`${fields.carriage}${fields.seat}`, right, infoY)

  // 票价 / 渠道 / 席别
  const priceY = infoY + 38
  ctx.textAlign = 'left'
  useFont(ctx, 28, 'bold')
  ctx.fillText(`￥${fields.price}元`, margin, priceY)
  ctx.textAlign = 'center'
  useFont(ctx, 24)
  ctx.fillText(fields.channel, center, priceY + 2)
  ctx.textAlign = 'right'
  ctx.fillText(fields.seatClass, right, priceY)

  drawDashedLine(ctx, margin, priceY + 44, right, priceY + 44)

  // 下半区：二维码在右下角，左边放检票状态、证件号与提示语
  const qrSize = 148
  const qrX = right - qrSize
  const qrY = 292
  if (qrModules) {
    drawQrMatrix(ctx, qrModules, qrX, qrY, qrSize)
  } else {
    ctx.strokeStyle = TICKET_COLORS.line
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 6])
    ctx.strokeRect(qrX, qrY, qrSize, qrSize)
    ctx.setLineDash([])
  }

  // 检票状态、证件号与姓名
  ctx.textAlign = 'left'
  ctx.fillStyle = TICKET_COLORS.ink
  useFont(ctx, 24)
  ctx.fillText(fields.checked, margin, qrY)
  useFont(ctx, 26, 'bold')
  ctx.fillText(fields.idNumber, margin, qrY + 38)
  useFont(ctx, 22)
  ctx.fillText(fields.passenger, margin, qrY + 72)

  // 虚线框里的提示语
  const boxX = margin
  const boxY = qrY + 104
  const boxW = qrX - 16 - boxX
  const boxH = 52
  ctx.strokeStyle = TICKET_COLORS.line
  ctx.lineWidth = 1.5
  ctx.setLineDash([7, 6])
  ctx.strokeRect(boxX, boxY, boxW, boxH)
  ctx.setLineDash([])
  ctx.textAlign = 'center'
  useFont(ctx, 17)
  ctx.fillStyle = TICKET_COLORS.ink
  ctx.fillText(fields.slogan, boxX + boxW / 2, boxY + 5)
  useFont(ctx, 19, 'bold')
  ctx.fillText(fields.wish, boxX + boxW / 2, boxY + 26)

  // 底部色条
  const bandY = TICKET_HEIGHT - 96
  ctx.fillStyle = TICKET_COLORS.yellow
  ctx.fillRect(0, bandY, TICKET_WIDTH, 96)
  ctx.fillStyle = TICKET_COLORS.ink
  useFont(ctx, 24, 'bold')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(fields.bottomCode, margin, bandY + 48)
  ctx.textAlign = 'right'
  useFont(ctx, 24)
  ctx.fillText(fields.bottomOffice, right, bandY + 48)

  ctx.restore()
}
