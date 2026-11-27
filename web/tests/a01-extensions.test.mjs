import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {A01Session}=await server.ssrLoadModule('/src/core/protocol/a01/session.ts')
const {proto}=await server.ssrLoadModule('/src/core/protocol/a01/messages.ts')
const {FrameStreamDecoder,encodeFrame,crc32}=await server.ssrLoadModule('/src/core/protocol/a01/framing.ts')
const {supportsChipPrimitives}=await server.ssrLoadModule('/src/core/protocol/features.ts')
const {inspectFirmwareImage}=await server.ssrLoadModule('/src/core/protocol/a01/firmware.ts')

function image(size=1300){
 const data=new Uint8Array(size),view=new DataView(data.buffer)
 data[0]=0xe9;data[1]=1;view.setUint16(12,5,true);view.setUint32(28,256,true);view.setUint32(32,0xabcd5432,true)
 data.set(new TextEncoder().encode('0.2.0'),48);data.set(new TextEncoder().encode('rf_device_platform'),80)
 return data
}
class Device {
 chunkSize=20;listeners=[];decoder=new FrameStreamDecoder();requests=[];jobs=[];minor=2;jobId=0;offset=0;sequence=0;parts=[];wrongId=false;wrongOffset=false;rejectBegin=0;earlyWriteFailure=false;hold=false;registers=new Map()
 onData(listener){this.listeners.push(listener);return()=>this.listeners=this.listeners.filter(x=>x!==listener)}
 send(id,name,body,sid=123n){const bytes=encodeFrame(proto.encode('Envelope',{protocol_major:1,session_id:sid,request_id:id,[name]:body}));this.listeners.forEach(fn=>fn(bytes))}
 async writeChunk(bytes){
  for(const data of this.decoder.feed(bytes)){
   const envelope=proto.decode('Envelope',data);this.requests.push(envelope)
   this.handle(envelope)
   if(this.earlyWriteFailure && envelope.start_job)throw new Error('write uncertain')
  }
 }
 handle(e){
  const id=e.request_id
  if(e.hello_request)return this.send(id,'hello_response',{device_id:Uint8Array.of(1),protocol_major:1,max_control_message:10541,max_data_chunk:244,transport:['ble_gatt']})
  if(e.capability_query)return this.send(id,'capability_list',{capabilities:[{id:'org.example.rf.raw',major_version:1,minor_version:this.minor,operations:['transceive','set_field','execute_command','read_register','write_register'].map(id=>({id}))}]})
  if(e.start_job){
   const job=e.start_job;this.jobs.push(job)
   const jobId=++this.jobId;this.send(id,'job_event',{job_id:jobId,state:1})
   if(this.hold)return
   let result=new Uint8Array()
   if(job.operation_id==='execute_command')result=proto.encode('Clrc663CommandResult',{status:32,irq0:16})
   if(job.operation_id==='read_register'){const r=proto.decode('Clrc663RegisterRequest',job.arguments);result=proto.encode('Clrc663RegisterResult',{value:this.registers.get(r.address)??32})}
   if(job.operation_id==='write_register'){const r=proto.decode('Clrc663RegisterRequest',job.arguments);this.registers.set(r.address,r.value??0)}
   this.send(0,'job_event',{job_id:jobId,state:3,result});return
  }
  const name=['transfer_begin','transfer_chunk','transfer_finish'].find(name=>e[name]);if(!name)return
  const body=e[name];const transfer_id=this.wrongId?body.transfer_id+1:body.transfer_id
  if(name==='transfer_begin'){
   this.begin=body;return this.send(id,'transfer_ack',{transfer_id,receive_window:1,error_code:this.rejectBegin})
  }
  if(name==='transfer_chunk'){
   assert.equal(Number(body.offset??0),this.offset);assert.equal(body.sequence??0,this.sequence++)
   assert.equal(body.crc32>>>0,crc32(body.data));assert.ok(body.data.length<=512)
   this.parts.push(body.data);this.offset+=body.data.length
   return this.send(id,'transfer_ack',{transfer_id,next_offset:this.wrongOffset?this.offset+1:this.offset,receive_window:1})
  }
  return this.send(id,'transfer_ack',{transfer_id})
 }
}
async function setup(minor=2){
 const device=new Device();device.minor=minor
 const profile={scheme:'A01',label:'A01',firmwareTarget:{chipId:5,label:'ESP32-C3'}}
 const session=new A01Session(profile,device);await session.connect();return{device,session}
}
test('new command protobuf matches the reference wire contract',()=>{
 assert.equal(Buffer.from(proto.encode('Clrc663CommandRequest',{command:2,fifo_input:new Uint8Array(6).fill(255),timeout_ms:100})).toString('hex'),'08021206ffffffffffff1864')
 assert.equal(Buffer.from(proto.encode('Clrc663RegisterRequest',{address:11,value:0})).toString('hex'),'080b')
 assert.equal(Number(proto.decode('Clrc663CommandResult',Uint8Array.of(0x28,0x20)).status),32)
})
test('chip primitives enforce capabilities and bind the key command to the target UID',async()=>{
 const {device,session}=await setup();assert.ok(supportsChipPrimitives(session))
 const uid=Uint8Array.of(4,1,2,3)
 const outcome=await session.executeChipCommand(2,new Uint8Array(6).fill(255),{confirmedTargetUid:uid})
 assert.equal(outcome.status,32);assert.equal(device.jobs[0].operation_id,'execute_command');assert.equal(device.jobs[0].user_confirmed,true)
 assert.deepEqual(device.jobs[0].confirmed_target_uid,uid)
 assert.equal(await session.readChipRegister(11),32);await session.writeChipRegister(11,0)
 await session.close()
 const old=await setup(1);assert.equal(supportsChipPrimitives(old.session),false)
 await assert.rejects(old.session.executeChipCommand(2,new Uint8Array(6),{confirmedTargetUid:uid}),/1.2/)
 assert.equal(old.device.jobs.length,0);await old.session.close()
})
test('unsafe commands, register writes, FIFO reads and invalid targets fail before transmission',async()=>{
 const {device,session}=await setup();const opts={confirmedTargetUid:Uint8Array.of(1,2,3,4)}
 for(const [command,data]of[[1,[]],[2,[1]],[3,[0,4,1,2,3,4]],[13,[19,0]]])await assert.rejects(session.executeChipCommand(command,Uint8Array.from(data),opts))
 await assert.rejects(session.executeChipCommand(2,new Uint8Array(6),{confirmedTargetUid:new Uint8Array()}))
 for(const [a,v]of[[0x28,1],[0x2e,1],[0x0b,32],[0x14,256],[-1,0]])await assert.rejects(session.writeChipRegister(a,v))
 await assert.rejects(session.readChipRegister(5));assert.equal(device.jobs.length,0);await session.close()
})
test('A01 Classic keeps the chip receive gain untouched so the controller can see the card answer',async()=>{
 for(const original of [0x08,0x09,0x0a,0x0b,0x06,0x03]){
  const {device,session}=await setup();device.registers.set(0x39,original)
  const restore=await session.prepareClassicRf()
  // 增益不能降：降了芯片就收不到卡拒绝握手时回的 4 位 NAK，
  // 错误寄存器变空，「卡拒了握手」与「卡没应答」就分不出来了。
  assert.equal(device.registers.get(0x39),original)
  await restore();assert.equal(device.registers.get(0x39),original)
  assert.equal(device.jobs.filter(job=>job.operation_id==='write_register').length,0)
  await session.close()
 }
})
test('the Classic receiver preparation writes nothing, so it cannot fail',async()=>{
 const {device,session}=await setup();device.registers.set(0x39,0x0a)
 await assert.doesNotReject(session.prepareClassicRf())
 assert.equal(device.registers.get(0x39),0x0a);await session.close()
})
test('firmware inspection reads metadata and rejects wrong chip, bootloader and merged images',()=>{
 assert.deepEqual(inspectFirmwareImage(image(),5),{chipId:5,version:'0.2.0',project:'rf_device_platform'})
 const wrong=image();wrong[12]=9;assert.throws(()=>inspectFirmwareImage(wrong,5),/芯片/)
 const boot=image();boot.fill(0,32,36);assert.throws(()=>inspectFirmwareImage(boot,5),/应用描述/)
 assert.throws(()=>inspectFirmwareImage(new Uint8Array(2000)))
})
test('OTA sends ordered CRC checked chunks and SHA-256, then commits only after all acknowledgements',async()=>{
 const {device,session}=await setup();const data=image(),progress=[]
 await session.uploadFirmware(data,{onProgress:e=>progress.push(e)})
 assert.equal(device.begin.purpose,'firmware');assert.equal(device.offset,data.length)
 assert.deepEqual(device.begin.sha256,new Uint8Array(await crypto.subtle.digest('SHA-256',data)))
 assert.deepEqual(Buffer.concat(device.parts),Buffer.from(data))
 assert.equal(device.requests.filter(e=>e.transfer_finish).length,1)
 assert.deepEqual(progress.map(e=>e.stage),['preparing','uploading','uploading','uploading','finalizing','rebooting'])
 assert.equal(session.firmwareRequiresReconnect,true);assert.equal(session.firmwareUpdating,false)
 await assert.rejects(session.setRfField(true),/重新连接/);await session.close()
})
test('OTA abort, unsupported firmware and invalid ACK never reach finish or retry chunks',async()=>{
 for(const mode of ['abort','unsupported','offset','id']){
  const {device,session}=await setup();const controller=new AbortController()
  device.rejectBegin=mode==='unsupported'?1:0;device.wrongOffset=mode==='offset';device.wrongId=mode==='id'
  await assert.rejects(session.uploadFirmware(image(),{signal:controller.signal,onProgress:e=>{if(mode==='abort'&&e.stage==='uploading')controller.abort()}}))
  assert.equal(device.requests.filter(e=>e.transfer_finish).length,0)
  assert.ok(device.requests.filter(e=>e.transfer_chunk).length<=1)
  assert.equal(session.firmwareRequiresReconnect,true);await session.close()
 }
})
test('invalid or pre-aborted images do not begin a transfer',async()=>{
 const {device,session}=await setup();const controller=new AbortController();controller.abort()
 await assert.rejects(session.uploadFirmware(image(),{signal:controller.signal}))
 await assert.rejects(session.uploadFirmware(new Uint8Array(1)))
 assert.equal(device.requests.filter(e=>e.transfer_begin).length,0);assert.equal(session.firmwareRequiresReconnect,false)
 await session.close()
})
test('an invalid finish acknowledgement is uncertain and is never automatically repeated',async()=>{
 const {device,session}=await setup();const handle=device.handle.bind(device)
 device.handle=e=>e.transfer_finish?device.send(e.request_id,'transfer_ack',{transfer_id:e.transfer_finish.transfer_id^1}):handle(e)
 await assert.rejects(session.uploadFirmware(image()),/切换结果未确认.*未自动重发/)
 assert.equal(device.requests.filter(e=>e.transfer_finish).length,1)
 assert.equal(session.firmwareRequiresReconnect,true);await session.close()
})
test('OTA excludes RF jobs, and an in-flight job prevents OTA from starting',async()=>{
 const first=await setup();first.device.hold=true
 const pending=first.session.readChipRegister(11);const handled=pending.catch(e=>e)
 await new Promise(r=>setTimeout(r,0))
 await assert.rejects(first.session.uploadFirmware(image()),/其他操作/)
 await first.session.close();assert.match((await handled).message,/关闭/)
 const {device,session}=await setup();let blocked
 await session.uploadFirmware(image(),{onProgress:()=>{if(!blocked){assert.equal(session.firmwareUpdating,true);blocked=session.setRfField(true).catch(error=>error)}}})
 assert.match((await blocked).message,/固件升级期间/)
 assert.equal(device.jobs.length,0);await session.close()
})
test('mutating jobs are not replayed when a GATT write completes but returns an error',async()=>{
 const {device,session}=await setup();device.earlyWriteFailure=true
 await assert.rejects(session.setRfField(true),/未自动重发/)
 assert.equal(device.jobs.length,1);await session.close()
})
test('stale session events cannot complete current jobs and completed channels are released',async()=>{
 const {device,session}=await setup();device.hold=true
 let complete=false
 const pending=session.readChipRegister(11).then(value=>{complete=true;return value})
 await new Promise(r=>setTimeout(r,0))
 const body={job_id:device.jobId,state:3,result:proto.encode('Clrc663RegisterResult',{value:32})}
 device.send(0,'job_event',body,999n)
 await new Promise(r=>setTimeout(r,0));assert.equal(complete,false)
 device.send(0,'job_event',body)
 assert.equal(await pending,32);assert.equal(session.jobChannels.size,0);await session.close()
})
