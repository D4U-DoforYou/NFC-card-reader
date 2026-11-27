import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {Type2Session}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
const {RfBridge,RfError}=await server.ssrLoadModule('/src/core/rf/bridge.ts')
const {deviceSession}=await server.ssrLoadModule('/src/core/protocol/index.ts')
const {crcA}=await server.ssrLoadModule('/src/core/rf/crc.ts')
const uid=Uint8Array.of(4,1,2,3)
const rf=()=>new RfError('射频错误 ERROR=0x04 IRQ0=0x3E（COLLDET）',{status:4,errorStatus:4,irq0Status:0x3e})
const response=body=>{const data=Uint8Array.from(body);return {data:Uint8Array.from([...data,...crcA(data)]),rxLastBits:0}}

test('READ collision recovers original UID then retries only once',async()=>{
 let reads=0,selects=0
 const session=new Type2Session({exchange:async()=>{if(++reads===1)throw rf();return response(new Array(16).fill(42))}})
 session.selectedUid=uid
 session.requireTarget=async expected=>{assert.deepEqual(expected,uid);selects++}
 assert.equal((await session.readPage(43))[0],42);assert.equal(reads,2);assert.equal(selects,1)
})
test('persistent collision reports the exact READ page instead of hiding it',async()=>{
 let reads=0
 const session=new Type2Session({exchange:async()=>{reads++;throw rf()}})
 session.selectedUid=uid;session.requireTarget=async()=>{}
 await assert.rejects(session.readPage(43),/READ 第 43 页失败.*COLLDET/);assert.equal(reads,2)
})
test('UID change during recovery stops before another READ',async()=>{
 let reads=0
 const session=new Type2Session({exchange:async()=>{reads++;throw rf()}})
 session.selectedUid=uid;session.requireTarget=async()=>{throw new Error('UID 发生变化')}
 await assert.rejects(session.readPage(3),/UID 发生变化/);assert.equal(reads,1)
})
test('GET_VERSION collision is not silently treated as an unsupported command',async()=>{
 let reads=0
 const session=new Type2Session({exchange:async()=>{reads++;throw rf()}})
 session.selectedUid=uid;session.requireTarget=async()=>{}
 await assert.rejects(session.readVersion(),/GET_VERSION 失败.*COLLDET/);assert.equal(reads,2)
})
test('Type 2 uses shared RF reset and checks UID on reselection',async()=>{
 let cycles=0,step=0
 const block=[1,2,3,4];const bcc=block.reduce((a,b)=>a^b,0)
 const bridge={cycleRfField:async()=>{cycles++},exchange:async()=>[ {data:Uint8Array.of(4,0),rxLastBits:0,errorStatus:0,irq0Status:0}, {data:Uint8Array.from([...block,bcc]),rxLastBits:0,errorStatus:0,irq0Status:0}, {...response([0]),errorStatus:0,irq0Status:0} ][step++]}
 const session=new Type2Session(bridge)
 await assert.rejects(session.requireTarget(uid),/UID 发生变化/);assert.equal(cycles,1)
})
test('WRITE collision is never replayed and includes page and uncertainty',async()=>{
 let writes=0
 const session=new Type2Session({exchange:async()=>{writes++;throw rf()}})
 session.requireTarget=async()=>{}
 await assert.rejects(session.writePage(6,Uint8Array.of(1,2,3,4),uid),/WRITE 第 6 页失败.*未重发.*COLLDET/)
 assert.equal(writes,1)
})
async function exchangeResult(frame,options,result){
 const previous=deviceSession.require
 deviceSession.require=async()=>({rawTransceive:async()=>result})
 try {return await new RfBridge({onStatus(){}}).doExchange(Uint8Array.from(frame),options)}finally{deviceSession.require=previous}
}
const good={rx:Uint8Array.of(0x0a),rxLastBits:4,irq0:0x3e,irq1:0,error:0x10,collision:4}
test('valid 4-bit WRITE ACK tolerates only MINFRAMEERR',async()=>{
 const result=await exchangeResult([0xa2,4,1,2,3,4],{allowType2Ack:true,crcTx:true},good)
 assert.equal(result.data[0],10)
 for(const error of [4,0x14,1,2])await assert.rejects(exchangeResult([0xa2,4,1,2,3,4],{allowType2Ack:true,crcTx:true},{...good,error}),/射频错误/)
 await assert.rejects(exchangeResult([0x30,4],{allowType2Ack:true},good),/射频错误/)
})
test('RxColl position bits alone are not a collision flag, Error.CollDet always fails',async()=>{
 await exchangeResult([0x30,4],{}, {...good,rx:Uint8Array.of(1,2),rxLastBits:0,error:0,irq0:0x3c,collision:0x84})
 await assert.rejects(exchangeResult([0x30,4],{}, {...good,error:4,collision:0}),/COLLDET/)
})
test('Classic WRITE accepts a valid short ACK only with authenticated-operation context',async()=>{
 const options={allowMifareAck:true,crcTx:true,crcRx:false,confirmedTargetUid:uid}
 for(const frame of [[0xa0,4],new Array(16).fill(1)]){
  const accepted=await exchangeResult(frame,options,good)
  assert.equal(accepted.errorStatus,0);assert.equal(accepted.irq0Status&2,0)
  for(const patch of [{error:4},{error:0x14},{rx:Uint8Array.of(0)},{rxLastBits:0}])await assert.rejects(exchangeResult(frame,options,{...good,...patch}),/射频错误/)
 }
 await assert.rejects(exchangeResult([0xa0,4],{...options,confirmedTargetUid:undefined},good),/射频错误/)
 await assert.rejects(exchangeResult([0x30,4],options,good),/射频错误/)
})
test('invalid GET_VERSION CRC and link failures are not silently downgraded',async()=>{
 const corrupt=new Type2Session({exchange:async()=>({data:new Uint8Array(10),rxLastBits:0})})
 await assert.rejects(corrupt.readVersion(),/CRC_A/)
 const broken=new Type2Session({exchange:async()=>{throw new Error('蓝牙断开')}})
 await assert.rejects(broken.readVersion(),/蓝牙断开/)
})

test('MINFRAMEERR only permits complete ATQA or CRC-valid SAK during activation',async()=>{
 const atqa={...good,rx:Uint8Array.of(0x44,0),rxLastBits:0}
 await exchangeResult([0x52],{txLastBits:7,shortResponse:'atqa'},atqa)
 for(const patch of [{rx:Uint8Array.of(0x44)},{rxLastBits:1},{error:0x14}])await assert.rejects(exchangeResult([0x52],{txLastBits:7,shortResponse:'atqa'},{...atqa,...patch}),/射频错误/)
 await assert.rejects(exchangeResult([0x52],{txLastBits:8,shortResponse:'atqa'},atqa),/射频错误/)
 const sak={...atqa,rx:response([0]).data}
 const select=[0x93,0x70,4,1,2,3,4,0,0]
 await exchangeResult(select,{shortResponse:'sak',crcRx:false},sak)
 await assert.rejects(exchangeResult(select,{shortResponse:'sak',crcRx:false},{...sak,rx:Uint8Array.of(0,0,0)}),/射频错误/)
 await assert.rejects(exchangeResult([0x93,0x20],{shortResponse:'sak'},sak),/射频错误/)
 await assert.rejects(exchangeResult(select,{},sak),/射频错误/)
})

test('Type 2 reselection traverses both UID cascade levels with valid short MINFRAME responses',async()=>{
 const a=[0x88,4,0x12,0x34],b=[0x56,0x78,0x9a,0xbc],bcc=x=>x.reduce((a,b)=>a^b,0)
 const replies=[{...good,rx:Uint8Array.of(0x44,0),rxLastBits:0},...[[...a,bcc(a)],[4],[...b,bcc(b)],[0]].map((data,i)=>({...good,rx:i%2?response(data).data:Uint8Array.from(data),rxLastBits:0,error:i%2?0x10:0,irq0:i%2?0x3e:0x3c}))]
 const frames=[]
 const session=new Type2Session({cycleRfField:async()=>{},exchange:async(frame,options)=>{
  frames.push(frame)
  return exchangeResult(frame,options,replies.shift())
 }})
 const target=Uint8Array.of(4,0x12,0x34,0x56,0x78,0x9a,0xbc)
 await session.requireTarget(target)
 assert.deepEqual(session.selectedUid,target);assert.equal(replies.length,0)
 assert.deepEqual(frames.map(f=>f[0]),[0x52,0x93,0x93,0x95,0x95])
})

const credentials=()=>({password:Uint8Array.of(0x12,0x34,0x56,0x78),expectedPack:Uint8Array.of(0xab,0xcd),uid})
test('PWD_AUTH sends a CRC-protected password bound to the selected UID and validates PACK',async()=>{
 const calls=[],traces=[]
 const session=new Type2Session({exchange:async(frame,options)=>{calls.push({frame,options});return response([0xab,0xcd])}},line=>traces.push(line),credentials())
 session.selectedUid=uid
 await session.authenticateTarget()
 assert.equal(session.authenticated,true)
 assert.deepEqual(calls[0].frame,response([0x1b,0x12,0x34,0x56,0x78]).data)
 assert.deepEqual(calls[0].options.confirmedTargetUid,uid)
 assert.equal(calls.length,1)
 assert.ok(!traces.join(' ').includes('12345678'))
 session.selectedUid=Uint8Array.of(4,1,2,4)
 await assert.rejects(session.authenticateTarget(),/未发送密码/)
 assert.equal(calls.length,1);assert.equal(session.authenticated,false)
})
test('wrong password, PACK, and corrupt authentication response are never retried or accepted',async()=>{
 for(const answer of [response([0,0]),{data:Uint8Array.of(0xab,0xcd,0,0)},null]){
  let calls=0
  const session=new Type2Session({exchange:async()=>{calls++;if(!answer)throw rf();return answer}},()=>{},credentials())
  session.selectedUid=uid;session.authenticated=true
  await assert.rejects(session.authenticateTarget(),/PWD_AUTH|PACK/)
  assert.equal(session.authenticated,false);assert.equal(calls,1)
 }
})
test('page WRITE reauthenticates after both reselections before write and readback',async()=>{
 const events=[]
 const session=new Type2Session({exchange:async frame=>{
  if(frame[0]===0x1b){events.push('auth');return response([0xab,0xcd])}
  if(frame[0]===0xa2){events.push('write');return {data:Uint8Array.of(10),rxLastBits:4}}
  if(frame[0]===0x30){events.push('read');return response([1,2,3,4,...new Array(12).fill(0)])}
  throw new Error('unexpected frame')
 }},()=>{},credentials())
 session.selectTarget=async()=>{session.authenticated=false;events.push('select');return {uid}}
 await session.writePage(4,Uint8Array.of(1,2,3,4),uid)
 assert.deepEqual(events,['select','auth','write','select','auth','read'])
})

test('ISO-DEP MINFRAME tolerance requires explicit context, complete CRC and no collision',async()=>{
 const valid={...good,rx:response([2,0x90,0]).data,rxLastBits:0,collision:0}
 const options={isoDepResponse:true}
 assert.equal((await exchangeResult([2,0,0xd1,0,0,0],options,valid)).errorStatus,0)
 await assert.rejects(exchangeResult([2,0,0xd1,0,0,0],{},valid),/射频错误/)
 for(const patch of [{rx:Uint8Array.of(2,0x90,0,0,0)},{rxLastBits:1},{error:0x14},{collision:0x80}]) {
   await assert.rejects(exchangeResult([2,0,0xd1,0,0,0],options,{...valid,...patch}),/射频错误/)
 }
})
