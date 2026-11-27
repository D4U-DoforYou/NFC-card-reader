/** Type 2 READ：每次读取四页，每页四字节。 */
import { RfBridge } from '../rf/bridge'
import { validateReply } from '../rf/isoDep'

export async function readType2Pages(bridge: RfBridge, page: number): Promise<Uint8Array> {
  if (!Number.isInteger(page) || page < 0 || page > 252) throw new Error('起始页必须是 0..252')
  const reply = await bridge.exchange(new Uint8Array([0x30, page]), {
    crcTx: true, crcRx: false, timeoutMs: 150,
  })
  const data = validateReply(reply, 'Type 2 READ')
  if (data.length !== 16) throw new Error(`读取被拒绝或响应异常（${data.length} 字节），可能需要认证`)
  return data
}
