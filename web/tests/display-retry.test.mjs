import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {uploadWithRetry,interruptedUpload}=await server.ssrLoadModule('/src/core/epd/retry.ts')
const {uploadHuawei}=await server.ssrLoadModule('/src/core/epd/huawei.ts')
const profile={width:552,height:768,colorCount:4,compression:true,uid:Uint8Array.of(1,2,3,4)}
const ok=Uint8Array.of(0x90,0),packed=new Uint8Array(105984)
function device(fail){let n=0;return {uid:profile.uid,blocks:[],async exchange(packet){if(packet[1]===0xd3){this.blocks.push(packet[5]);if(++n===2&&fail)throw new Error('射频错误 ERROR=0x01 IRQ0=0x3E（INTEGERR）')}return packet[1]===0xde?Uint8Array.of(0,0x90,0):ok},async exchangeOnce(){return ok}}}
test('interrupted D3 restarts at block zero in a fresh session and completes',async()=>{
 const first=device(true),next=device(false),logs=[];let reconnects=0
 await uploadWithRetry({profile,iso:first},async()=>{reconnects++;return {profile,iso:next}},(iso,p)=>uploadHuawei(iso,p,packed),m=>logs.push(m),async ms=>assert.equal(ms,1000))
 assert.equal(reconnects,1);assert.equal(first.blocks.length,2);assert.equal(next.blocks[0],0);assert.ok(next.blocks.length>50);assert.match(logs[0],/第 2\/3 次/)
})
test('persistent RF failure is limited to three attempts',async()=>{
 let runs=0,reconnects=0
 await assert.rejects(uploadWithRetry({profile,iso:{}},async()=>{reconnects++;return{profile,iso:{}}},async()=>{runs++;throw interruptedUpload('D3',new Error('射频错误 INTEGERR'))},()=>{},async()=>{}),/INTEGERR/)
 assert.equal(runs,3);assert.equal(reconnects,2)
})
test('UID change stops before another upload',async()=>{
 let runs=0
 await assert.rejects(uploadWithRetry({profile,iso:{}},async()=>({profile:{...profile,uid:Uint8Array.of(5,6,7,8)},iso:{}}),async()=>{runs++;throw interruptedUpload('D3',new Error('射频错误'))},()=>{},async()=>{}),/UID/)
 assert.equal(runs,1)
})
test('refresh uncertainty, rejected status words and disconnected transport never auto retry',async()=>{
 for(const error of [new Error('D4 刷新结果不确定'),new Error('D3失败 SW=6992'),interruptedUpload('D3',new Error('蓝牙断开'))]){
  let reconnects=0
  await assert.rejects(uploadWithRetry({profile,iso:{}},async()=>{reconnects++;return{profile,iso:{}}},async()=>{throw error},()=>{},async()=>{}))
  assert.equal(reconnects,0)
 }
})
test('link level write failures are retryable because the half frame was flushed',async()=>{
 // 写失败时会话层已经先补了 0x00 帧结束符，设备把半帧丢掉了，
 // 所以它没见过这次操作——重传当前包是安全的。
 // 不这样的话，一次偶发的链路抖动就会让整趟刷图前功尽弃。
 for(const message of [
  '发送结果未确认，未自动重发：写入超时（5000 ms），蓝牙链路可能已经卡住',
  '帧未送达设备（1500 ms 内没有任何响应，已整帧重发 2 次）',
  '读卡器忙',
 ]){
  const error=interruptedUpload('D3 9/79',new Error(message))
  assert.equal(error.retryable,true,`${message} 应当可重试`)
  assert.match(error.message,/传输未确认/)
 }
})
