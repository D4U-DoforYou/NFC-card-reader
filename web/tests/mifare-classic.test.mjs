import assert from 'node:assert/strict'
import { after,test } from 'node:test'
import { createServer } from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {MifareClassicSession}=await server.ssrLoadModule('/src/core/nfc/mifareClassic.ts')
const {RfError}=await server.ssrLoadModule('/src/core/rf/bridge.ts')
const {crcA}=await server.ssrLoadModule('/src/core/rf/crc.ts')
const key=()=>Uint8Array.of(1,2,3,4,5,6),uid=Uint8Array.of(4,0x12,0x34,0x56)
const reply=(data,crc=false)=>{const d=Uint8Array.from(data);return{data:crc?Uint8Array.from([...d,...crcA(d)]):d,rxLastBits:0,errorStatus:0,irq0Status:0}}
class Bridge {
 uid=uid;sak=8;calls=[];loaded=null;crypto=false;memory=new Map();awaitData=false;failWrite=false;corruptRead=false;field=true
 async cycleRfField(){this.crypto=false;this.calls.push('select')}
 async turnOffField(){this.field=false}
 async writeChipRegister(address,value){assert.equal(address,11);assert.equal(value,0);this.crypto=false}
 async executeChipCommand(command,data){
  this.calls.push({command,data:data.slice()})
  if(command===2){this.loaded=data.slice();return{error:0,status:0,irq0:16,irq1:0,fifoOutput:new Uint8Array()}}
  assert.equal(command,3);this.crypto=Buffer.from(this.loaded).equals(Buffer.from(key()))
  return{error:0,status:this.crypto?32:0,irq0:16,irq1:0,fifoOutput:new Uint8Array()}
 }
 async exchange(frame,options){
  if(frame[0]===0x52)return reply([4,0])
  if([0x93,0x95].includes(frame[0]) && frame[1]===0x20){const part=this.uid.length===4?this.uid:frame[0]===0x93?Uint8Array.of(0x88,...this.uid.slice(0,3)):this.uid.slice(3);return reply([...part,part.reduce((a,b)=>a^b,0)])}
  if([0x93,0x95].includes(frame[0]) && frame[1]===0x70){
   // 真卡只会回应「卡号对得上」的 SELECT：卡号不对就一声不吭。
   const wanted=this.uid.length===4?this.uid:frame[0]===0x93?Uint8Array.of(0x88,...this.uid.slice(0,3)):this.uid.slice(3)
   const got=frame.slice(2,6)
   if(!wanted.every((b,i)=>b===got[i]))throw new RfError('SELECT 没有应答',{status:0,errorStatus:1,irq0Status:0})
   return reply([this.uid.length===7 && frame[0]===0x93?4:this.sak],true)
  }
  assert.equal(this.crypto,true,'all data operations require Crypto1')
  assert.deepEqual(options.confirmedTargetUid,this.uid)
  if(this.awaitData){this.awaitData=false;this.calls.push('write-data');this.memory.set(this.block,frame.slice());if(this.failWrite)throw new Error('link lost');return{...reply([10]),rxLastBits:4}}
  if(frame[0]===0xa0){this.calls.push('write-command');this.block=frame[1];this.awaitData=true;return{...reply([10]),rxLastBits:4}}
  assert.equal(frame[0],0x30);assert.equal(options.crcRx,true);this.calls.push('read')
  const data=this.memory.get(frame[1])?.slice()??new Uint8Array(16).fill(frame[1]);if(this.corruptRead)data[0]^=1
  return reply(data)
 }
}
test('Key A and Key B authenticate with LOADKEY/MFAUTHENT and return a plaintext block',async()=>{
 for(const keyType of ['A','B']){
  const bridge=new Bridge(),traces=[],session=new MifareClassicSession(bridge,line=>traces.push(line))
  await session.open(uid);assert.deepEqual(await session.readBlock(4,key(),keyType),new Uint8Array(16).fill(4))
  const auth=bridge.calls.find(c=>c.command===3)
  assert.deepEqual(auth.data,Uint8Array.of(keyType==='A'?0x60:0x61,4,...uid))
  assert.ok(!traces.join('').includes('010203040506'))
  await session.close();assert.ok(bridge.loaded.every(x=>x===0));assert.equal(bridge.field,false);assert.equal(bridge.crypto,false)
 }
})
test('wrong key fails without READ and is not retried',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 await assert.rejects(session.readBlock(4,new Uint8Array(6)),/认证未通过/)
 assert.equal(bridge.calls.filter(c=>c.command===3).length,1);assert.ok(!bridge.calls.includes('read'));await session.close()
})
test('manual Key A/B reads recover a transient authentication RF error using the same key and UID',async()=>{
 for(const keyType of ['A','B']){
  const bridge=new Bridge(),traces=[],session=new MifareClassicSession(bridge,line=>traces.push(line))
  const execute=bridge.executeChipCommand.bind(bridge);let authentications=0
  bridge.executeChipCommand=async(command,data)=>{
   if(command===3&&++authentications===1){bridge.calls.push({command,data:data.slice()});return{error:0x0a,irq0:0x32,irq1:0x40,status:0,fifoOutput:new Uint8Array()}}
   return execute(command,data)
  }
  await session.open(uid)
  assert.deepEqual(await session.readBlock(1,key(),keyType),new Uint8Array(16).fill(1))
  assert.equal(authentications,2)
  const attempts=bridge.calls.filter(call=>call.command===3)
  assert.deepEqual(attempts[0].data,attempts[1].data)
  for(const load of bridge.calls.filter(call=>call.command===2))assert.deepEqual(load.data,key())
  assert.equal(traces.filter(line=>line.includes('重读一次')).length,1)
  assert.ok(!bridge.calls.includes('write-command'));await session.close()
 }
})
test('a sector READ RF error discards partial results and reauthenticates once',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 const exchange=bridge.exchange.bind(bridge);let readsOfFive=0
 bridge.memory.set(4,new Uint8Array(16).fill(1))
 bridge.exchange=async(frame,options)=>{
  if(frame[0]===0x30&&frame[1]===5&&++readsOfFive===1){
   bridge.memory.set(4,new Uint8Array(16).fill(9))
   throw new RfError('READ RF error',{status:3,errorStatus:3,irq0Status:0x32})
  }
  return exchange(frame,options)
 }
 const result=await session.readBlocks([4,5],key())
 assert.deepEqual(result.get(4),new Uint8Array(16).fill(9))
 assert.deepEqual(result.get(5),new Uint8Array(16).fill(5))
 assert.equal(bridge.calls.filter(call=>call.command===3).length,2)
 assert.equal(readsOfFive,2);await session.close()
})
test('UID change during read recovery stops before loading another key',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 const execute=bridge.executeChipCommand.bind(bridge)
 bridge.executeChipCommand=async(command,data)=>{
  if(command===3){bridge.calls.push({command,data:data.slice()});bridge.uid=Uint8Array.of(1,2,3,4);return{error:0x0a,irq0:0x32,irq1:0x40,status:0,fifoOutput:new Uint8Array()}}
  return execute(command,data)
 }
 await assert.rejects(session.readBlock(1,key()),/UID/)
 assert.equal(bridge.calls.filter(call=>call.command===2).length,1)
 assert.equal(bridge.calls.filter(call=>call.command===3).length,1)
 assert.ok(!bridge.calls.includes('read'));await session.close()
})
test('Classic reception settings are restored after success and authentication failure',async()=>{
 for(const wrongKey of [false,true]){
  const bridge=new Bridge(),session=new MifareClassicSession(bridge);let configured=false,restored=0
  bridge.prepareClassicRf=async()=>{configured=true;return async()=>{configured=false;restored++}}
  await session.open(uid);assert.equal(configured,true)
  if(wrongKey)await assert.rejects(session.readBlock(1,new Uint8Array(6)))
  else await session.readBlock(1,key())
  await session.close();assert.equal(configured,false);assert.equal(restored,1);assert.equal(bridge.field,false)
 }
})
test('receiver cleanup still runs if clearing the controller key fails',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);let restored=false
 bridge.prepareClassicRf=async()=>async()=>{restored=true}
 await session.open(uid)
 bridge.writeChipRegister=async()=>{throw new Error('clear failed')}
 await assert.rejects(session.close(),/clear failed/)
 assert.equal(restored,true);assert.equal(bridge.field,false)
})
test('persistent read RF errors stop after two attempts; writes never repeat authentication',async()=>{
 for(const write of [false,true]){
  const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
  const execute=bridge.executeChipCommand.bind(bridge);let calls=0
  bridge.executeChipCommand=async(command,data)=>{
   if(command===3){calls++;return{error:0x0a,irq0:0x32,irq1:0x40,status:0,fifoOutput:new Uint8Array()}}
   return execute(command,data)
  }
  await assert.rejects(write?session.writeBlock(4,new Uint8Array(16),key()):session.readBlock(1,key()),/ERROR=0x0A/)
  assert.equal(calls,write?1:2);assert.ok(!bridge.calls.includes('write-command'));await session.close()
 }
})
test('real controller RF failures preserve diagnostics and never claim a wrong key',async()=>{
 for(const result of [
  {error:3,irq0:0x32,irq1:0x40,status:0},
  {error:0x12,irq0:0x32,irq1:0x40,status:0},
  {error:0,irq0:0x12,irq1:0,status:0},
  {error:4,irq0:0x32,irq1:0,status:0x20},
 ]){
  const bridge=new Bridge(),session=new MifareClassicSession(bridge)
  const command=bridge.executeChipCommand.bind(bridge)
  bridge.executeChipCommand=async(cmd,data)=>cmd===3?{...result,fifoOutput:new Uint8Array()}:command(cmd,data)
  await session.open(uid)
  await assert.rejects(session.readBlock(5,key()),error=>{
   assert.match(error.message,/扇区 1 · 块 5 · UID 04 12 34 56/)
   assert.match(error.message,/ERROR=0x[\dA-F]{2}.*IRQ0=0x[\dA-F]{2} IRQ1=0x[\dA-F]{2} STATUS=0x[\dA-F]{2}/)
   if(result.error===3)assert.match(error.message,/PROTERR \| INTEGERR/)
   if(result.error===0x12)assert.match(error.message,/MINFRAMEERR \| PROTERR/)
   // 无论哪种情况都不能说「密钥不对」：卡没应答与握手被拒在报错上长得一样。
   assert.ok(!/密钥不对|密钥错了/.test(error.message))
   // 分得出「卡拒了握手」还是「没定论」时，措辞要跟着变。
   const rejected=Boolean((result.error&0x10)&&!(result.error&0x08))
   if(rejected)assert.match(error.message,/卡回了应答但帧不完整/)
   else assert.match(error.message,/控制器报告射频错误，不能据此判定密钥错误/)
   assert.ok(!error.message.includes('010203040506'))
   return true
  })
  assert.ok(!bridge.calls.includes('read'));assert.ok(!bridge.calls.includes('write-command'));await session.close()
 }
})
test('LOADKEY errors stop before authentication and include controller status',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge)
 const command=bridge.executeChipCommand.bind(bridge)
 bridge.executeChipCommand=async(cmd,data)=>cmd===2&&data.some(x=>x)?{error:0x40,irq0:0x12,irq1:0,status:0,fifoOutput:new Uint8Array()}:command(cmd,data)
 await session.open(uid)
 await assert.rejects(session.readBlock(2,key()),/密钥加载失败.*FIFOWRERR/)
 assert.equal(bridge.calls.filter(c=>c.command===3).length,0);await session.close()
})
test('seven-byte UIDs use the final four UID bytes for controller authentication',async()=>{
 const bridge=new Bridge();bridge.uid=Uint8Array.of(4,1,2,3,4,5,6)
 const session=new MifareClassicSession(bridge);await session.open(bridge.uid)
 await session.readBlock(4,key())
 assert.deepEqual(bridge.calls.find(c=>c.command===3).data,Uint8Array.of(0x60,4,3,4,5,6))
 await session.close()
})
test('several blocks in one sector reuse exactly one authentication',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 const blocks=await session.readBlocks([4,5,6],key())
 assert.deepEqual([...blocks.keys()],[4,5,6])
 for(const [block,bytes] of blocks)assert.deepEqual(bytes,new Uint8Array(16).fill(block))
 assert.equal(bridge.calls.filter(call=>call.command===3).length,1)
 assert.equal(bridge.calls.filter(call=>call==='read').length,3)
 const authCount=bridge.calls.filter(call=>call.command===3).length
 await assert.rejects(session.readBlocks([4,8],key()),/同一扇区/)
 await assert.rejects(session.readBlocks([],key()),/至少/)
 await assert.rejects(session.readBlocks([4,64],key()),/块号/)
 assert.equal(bridge.calls.filter(call=>call.command===3).length,authCount)
 await session.close()
})
test('sector reads cover the selected range with one authentication and optional access-control block',async()=>{
 for(const sector of [0,1,15])for(const includeTrailer of [false,true]){
  const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
  const result=await session.readSector(sector,key(),'A',includeTrailer)
  const expected=Array.from({length:includeTrailer?4:3},(_,index)=>sector*4+index)
  assert.deepEqual([...result.keys()],expected)
  assert.equal(bridge.calls.filter(call=>call.command===3).length,1)
  for(const [block,data]of result)assert.deepEqual(data,new Uint8Array(16).fill(block))
  assert.ok(!bridge.calls.includes('write-command'));await session.close()
 }
})
test('invalid sector selections stop before any key is loaded',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 for(const sector of [-1,16,0.5,NaN])await assert.rejects(session.readSector(sector,key()),/扇区/)
 assert.equal(bridge.calls.filter(call=>call.command).length,0);await session.close()
})
test('reselection checks UID before sending a key and rejects unsupported SAK',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 bridge.uid=Uint8Array.of(4,3,2,1)
 await assert.rejects(session.readBlock(4,key()),/UID/);assert.equal(bridge.calls.filter(c=>c.command).length,0)
 const other=new Bridge();other.sak=0x18
 await assert.rejects(new MifareClassicSession(other).open(uid),/1K/)
})
test('data block write completes both ACKs and verifies plaintext readback',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 const data=Uint8Array.from({length:16},(_,i)=>i)
 assert.deepEqual(await session.writeBlock(4,data,key()),data)
 assert.equal(bridge.calls.filter(c=>c==='write-command').length,1);assert.equal(bridge.calls.filter(c=>c==='write-data').length,1)
 assert.ok(bridge.calls.includes('read'));await session.close()
})
test('manufacturer/trailer writes and invalid block or data fail before authentication',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
 for(const block of [0,3,7,63,-1,64,4.5])await assert.rejects(session.writeBlock(block,new Uint8Array(16),key()))
 await assert.rejects(session.writeBlock(4,new Uint8Array(15),key()))
 assert.equal(bridge.calls.filter(c=>c.command).length,0)
})
test('uncertain writes and readback mismatch are reported once without repeating a write',async()=>{
 for(const failure of ['link','readback']){
  const bridge=new Bridge(),session=new MifareClassicSession(bridge);await session.open(uid)
  bridge.failWrite=failure==='link';bridge.corruptRead=failure==='readback'
  await assert.rejects(session.writeBlock(4,new Uint8Array(16),key()),/未自动重发/)
  assert.equal(bridge.calls.filter(c=>c==='write-data').length,1)
  await session.close()
 }
})
test('a rejected handshake is classified from the error register and is not retried',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge)
 const execute=bridge.executeChipCommand.bind(bridge);let auths=0
 bridge.executeChipCommand=async(command,data)=>{
  if(command===3){auths++;throw new Error('作业失败')}
  return execute(command,data)
 }
 bridge.readChipRegister=async address=>address===0x0a?0x10:0
 await session.open(uid)
 assert.equal(await session.probeAuthenticate(4,key()),'rejected')
 assert.equal(auths,1)
 await session.close()
})
test('a missing answer is retried once and still reported as undecided',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge)
 const execute=bridge.executeChipCommand.bind(bridge);let auths=0
 bridge.executeChipCommand=async(command,data)=>{
  if(command===3){auths++;throw new Error('作业失败')}
  return execute(command,data)
 }
 bridge.readChipRegister=async address=>address===0x0a?0x08:0
 await session.open(uid)
 assert.equal(await session.probeAuthenticate(4,key()),'inconclusive')
 assert.equal(auths,2)
 await session.close()
})
test('an unreadable error register keeps the retry conservative',async()=>{
 const bridge=new Bridge(),session=new MifareClassicSession(bridge)
 const execute=bridge.executeChipCommand.bind(bridge);let auths=0
 bridge.executeChipCommand=async(command,data)=>{
  if(command===3){auths++;throw new Error('作业失败')}
  return execute(command,data)
 }
 bridge.readChipRegister=async()=>{throw new Error('读不到寄存器')}
 await session.open(uid)
 assert.equal(await session.probeAuthenticate(4,key()),'inconclusive')
 assert.equal(auths,2)
 await session.close()
})
test('the error bits decide whether a failed handshake may be retried',async()=>{
 const {classifyAuthError,classifyAuthTimeout}=await server.ssrLoadModule('/src/core/nfc/mifareClassic.ts')
 // 0x0A = NODATAERR|PROTERR：卡压根没应答，时序抖动，值得再试一次。
 assert.equal(classifyAuthError(0x0a),'inconclusive')
 // 0x12 = MINFRAMEERR|PROTERR：卡答了话但帧不完整，它拒了这次握手。
 assert.equal(classifyAuthError(0x12),'wrong-key')
 // 0x03 = PROTERR|INTEGERR：收到的是被噪声弄坏的帧，也得重试，
 // 不然真密钥会被误判成打不开。
 assert.equal(classifyAuthError(0x03),'inconclusive')
 // 卡回了 4 位 NAK：帧不完整，没有 NODATAERR —— 它拒了这次握手。
 assert.equal(classifyAuthTimeout(0x10),'rejected')
 assert.equal(classifyAuthTimeout(0x12),'rejected')
 // 卡压根没应答：时序抖动，值得再试一次。
 assert.equal(classifyAuthTimeout(0x08),'inconclusive')
 assert.equal(classifyAuthTimeout(0x18),'inconclusive')
 assert.equal(classifyAuthTimeout(0x00),'inconclusive')
 assert.equal(classifyAuthTimeout(null),'inconclusive')
})
