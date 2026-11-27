import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {uploadHuawei,buildD3Packets}=await server.ssrLoadModule('/src/core/epd/huawei.ts')
const {uploadPanel,buildNormalD2Packets,buildC1D3Packets}=await server.ssrLoadModule('/src/core/epd/panel.ts')
const {buildUploadStats,describeUploadStats,formatBytes}=await server.ssrLoadModule('/src/core/epd/stats.ts')
const {buildAppPacket,D3_HEADER_BYTES,D2_HEADER_BYTES,APP_CHUNK_SIZE}=await server.ssrLoadModule('/src/core/epd/commands.ts')
const uid=Uint8Array.of(1,2,3,4),ok=Uint8Array.of(0x90,0)
const huawei={width:552,height:768,colorCount:4,compression:true,uid}
const panelD2={width:240,height:416,colorCount:4,compression:false,uid,firmware:10,screenType:'panel_x'}
const panelC1={width:240,height:416,colorCount:4,compression:true,uid,firmware:10,screenType:'c1_2'}
function mock(){return {uid,calls:[],async exchange(data){this.calls.push({data});return data[1]===0xde?Uint8Array.of(0,0x90,0):ok},async exchangeOnce(data){return this.exchange(data)}}}

test('Huawei reports packed, compressed and packet sizes before uploading',async()=>{
  const packed=new Uint8Array(552*768/4)
  const stats=[]
  const session=mock()
  await uploadHuawei(session,huawei,packed,{onStats:value=>stats.push(value)})
  assert.equal(stats.length,1)
  const s=stats[0]
  assert.equal(s.packetCount,session.calls.filter(c=>c.data[1]===0xd3).length)
  assert.equal(s.headerBytes,D3_HEADER_BYTES)
  assert.equal(s.packetLabel,'D3')
  assert.equal(s.packedBytes,packed.length)
  // 纯色点阵压得很小，屏幕收到的字节远小于点阵。
  assert.ok(s.payloadBytes<s.packedBytes)
  assert.equal(s.totalBytes,s.packetCount*D3_HEADER_BYTES+s.payloadBytes)
  assert.ok(s.minPayload>=1&&s.maxPayload<=250)
  const text=describeUploadStats(s)
  assert.match(text,/^传屏数据：/)
  assert.ok(text.includes(formatBytes(s.packedBytes)))
  assert.ok(text.includes(formatBytes(s.payloadBytes)))
  assert.ok(text.includes(`${s.packetCount} 个 D3 包`))
})

test('Uncompressed panel path reports the screen receives the full bitmap',async()=>{
  const packed=new Uint8Array(240*416/4)
  const stats=[]
  await uploadPanel(mock(),panelD2,packed,{onStats:value=>stats.push(value)})
  const s=stats[0]
  assert.equal(s.headerBytes,D2_HEADER_BYTES)
  assert.equal(s.packetLabel,'D2')
  // 子包固定 250 字节（标签协议要求），D2 包头 5 字节。
  assert.equal(s.chunkSize,250)
  assert.equal(s.packetCount,Math.ceil(packed.length/250))
  assert.equal(s.payloadBytes,packed.length)
  assert.equal(s.ratio,1)
  assert.match(describeUploadStats(s),/未压缩/)
})

test('C1 path reuses the D3 header and reports one packet per block',async()=>{
  const packed=new Uint8Array(240*416/4)
  const stats=[]
  await uploadPanel(mock(),panelC1,packed,{onStats:value=>stats.push(value)})
  assert.equal(stats[0].headerBytes,D3_HEADER_BYTES)
  assert.equal(stats[0].packetCount,13)
  assert.equal(stats[0].packetLabel,'D3')
})

test('Packet headers keep their protocol length and mismatches are rejected',()=>{
  const packet=buildAppPacket([0xf0,0xd3,0,1,4,0,0],Uint8Array.of(1,2),D3_HEADER_BYTES)
  assert.equal(packet.length,D3_HEADER_BYTES+2)
  assert.equal(packet[1],0xd3)
  assert.throws(()=>buildAppPacket([0xf0,0xd3],Uint8Array.of(1),D3_HEADER_BYTES),/包头长度应为 7 字节/)
  // 旧的面板 D2 包头是 5 字节，别和 D3 混用。
  assert.equal(buildNormalD2Packets(new Uint8Array(600),4)[0].length,D2_HEADER_BYTES+250)
  const c1=buildC1D3Packets(new Uint8Array(240*416/4))[0]
  assert.equal(c1.length-D3_HEADER_BYTES,c1[4]-2)
})

test('Statistics cover every packet and report the payload range',()=>{
  const packets=buildD3Packets(new Uint8Array(4000))
  const s=buildUploadStats({packets,headerBytes:D3_HEADER_BYTES,packedBytes:4000,packetLabel:'D3'})
  const payload=packets.reduce((sum,p)=>sum+p.length-D3_HEADER_BYTES,0)
  assert.equal(s.payloadBytes,payload)
  assert.equal(s.minPayload,Math.min(...packets.map(p=>p.length-D3_HEADER_BYTES)))
  assert.equal(s.maxPayload,Math.max(...packets.map(p=>p.length-D3_HEADER_BYTES)))
  assert.equal(s.totalBytes,packets.reduce((sum,p)=>sum+p.length,0))
  assert.equal(formatBytes(105984),'105,984')
})

function noise(size){
  let seed=12345
  return Uint8Array.from({length:size},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255})
}

test('Sub-packets stay at the fixed 250 byte boundary the tag expects',async()=>{
  // 标签按 250 字节的固定边界重组 D3 压缩流：子包改小，标签拼出来的
  // 就不是合法 LZO 流，会回 SW=6992（实测踩过）。所以这里钉死 250。
  // 用噪声数据：全零图压得只剩几十字节，看不出子包边界。
  const session=mock()
  session.maxInf=253
  const packed=noise(552*768/4)
  const stats=[]
  await uploadHuawei(session,huawei,packed,{onStats:value=>stats.push(value)})
  const d3=session.calls.filter(c=>c.data[1]===0xd3)
  assert.ok(d3.length>50)
  const payloads=d3.map(c=>c.data.length-D3_HEADER_BYTES)
  assert.equal(Math.max(...payloads),250)
  assert.ok(payloads.every(p=>p<=250&&p>=1))
  assert.equal(stats[0].chunkSize,250)
  // 一个 D3 包 257 字节，超过一帧的 INF 上限，由 ISO-DEP 按 FSC 拆分——
  // 这是协议本来的分层，不能靠改子包大小去绕。
  assert.equal(d3[0].data.length,D3_HEADER_BYTES+250)
})

test('The chunk size never follows the frame limit',()=>{
  assert.equal(APP_CHUNK_SIZE,250)
})

test('C1 refuses to flash when one frame cannot hold the whole packet',async()=>{
  const session=mock()
  session.maxInf=125
  await assert.rejects(uploadPanel(session,panelC1,new Uint8Array(240*416/4)),/不能跨帧/)
  // 拒刷必须发生在任何射频操作之前。
  assert.equal(session.calls.length,0)
})

test('D3 packets match the verified reference implementation byte for byte', async () => {
  // golden 向量由实机验证过的 Python 参考实现生成
  // （tmp/demo_old/python/epaper_ble_suite/huawei.py 的 lzokay + 250 字节子包）。
  // 压缩算法、子包边界、包头字段任何一处改动都会在这里露出来。
  const golden = JSON.parse(readFileSync(new URL('./fixtures/d3-golden.json', import.meta.url), 'utf8'))
  const packed = Uint8Array.from(Buffer.from(golden.packed, 'hex'))
  const packets = buildD3Packets(packed)
  assert.equal(packets.length, golden.packets.length)
  packets.forEach((packet, index) => {
    assert.equal(
      Buffer.from(packet).toString('hex'),
      golden.packets[index],
      `第 ${index + 1} 个 D3 包与参考实现不一致`,
    )
  })
  // 参考实现里满包是 250 字节载荷 + 7 字节包头。
  assert.equal(Math.max(...packets.map(p => p.length)), 257)
})
