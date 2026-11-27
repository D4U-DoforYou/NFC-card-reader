import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {createServer} from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {exchangeImagePacket}=await server.ssrLoadModule('/src/core/epd/retry.ts')
const uid=Uint8Array.of(1,2,3,4),packet=Uint8Array.of(0xf0,0xd3,0,1,3,27,7,42),ok=Uint8Array.of(0x90,0)
test('timeout retransmits identical D3 block/subpacket after ISO-DEP resync',async()=>{
 const events=[],messages=[];let count=0
 const session={uid,async exchange(p,budget,target,deadline){events.push(['send',[...p]]);assert.equal(target,uid);assert.equal(deadline,20000);if(++count===1)throw new Error('ISO-DEP 交换超时，结果未确认');return ok},async resync(){events.push(['resync'])}}
 assert.equal(await exchangeImagePacket(session,packet,uid,'D3 220/394 block=27 subpacket=7',2,m=>messages.push(m),3,async()=>{}),ok)
 assert.deepEqual(events.map(e=>e[0]),['send','resync','send']);assert.deepEqual(events[0][1],events[2][1]);assert.match(messages[0],/第 2\/3 次/)
})
test('persistent error stops after three packet attempts',async()=>{
 let sends=0,syncs=0;const session={uid,async exchange(){sends++;throw new Error('射频错误 INTEGERR')},async resync(){syncs++}}
 await assert.rejects(exchangeImagePacket(session,packet,uid,'D3',2,()=>{},3,async()=>{}),/第 3\/3 次/)
 assert.equal(sends,3);assert.equal(syncs,2)
})
test('D4 and disconnected transport are not replayed; resync failure stops',async()=>{
 for(const [p,error] of [[Uint8Array.of(0xf0,0xd4),new Error('射频错误')],[packet,new Error('蓝牙断开')]]){
 let count=0,syncs=0;const session={uid,async exchange(){count++;throw error},async resync(){syncs++}}
 await assert.rejects(exchangeImagePacket(session,p,uid,'test',2,()=>{},3,async()=>{}));assert.equal(count,1);assert.equal(syncs,0)
 }
 let sends=0;const session={uid,async exchange(){sends++;throw new Error('射频错误')},async resync(){throw new Error('射频错误')}}
 await assert.rejects(exchangeImagePacket(session,packet,uid,'D3',2,()=>{},3,async()=>{}),/重新协商失败/);assert.equal(sends,1)
})
test('status-word rejection is returned to protocol validation without replay',async()=>{
 let count=0;const session={uid,async exchange(){count++;return Uint8Array.of(0x69,0x92)},async resync(){assert.fail('must not resync')}}
 assert.deepEqual([...await exchangeImagePacket(session,packet,uid,'D3',2,()=>{},3,async()=>{})],[0x69,0x92]);assert.equal(count,1)
})
