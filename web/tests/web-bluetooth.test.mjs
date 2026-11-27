import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {WebBluetoothTransport}=await server.ssrLoadModule('/src/platform/webBluetooth.ts')
const uuid=n=>`0000ff${n}-0000-1000-8000-00805f9b34fb`
function setup(properties,writeProperties={write:true,writeWithoutResponse:true},options={}){
 const calls=[],listeners=new Map()
 const tx={uuid:uuid('12'),properties,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),async startNotifications(){
   calls.push('subscribe')
   if(options.dropOnSubscribe){
    // 模拟浏览器：订阅过程中链路就断了。
    gatt.connected=false
    const fn=listeners.get('gattserverdisconnected');if(fn)fn()
   }
   return this
 },async stopNotifications(){calls.push('unsubscribe')}}
 const rx={uuid:uuid('11'),properties:writeProperties,async writeValueWithResponse(){
   assert.ok(calls.includes('subscribe'));calls.push('write')
   if(options.dropOnWrite){
    // 模拟浏览器：链路已断，写入抛原始异常，并触发 gattserverdisconnected。
    gatt.connected=false
    const fn=listeners.get('gattserverdisconnected');if(fn)fn()
    throw new Error("Failed to execute 'writeValueWithResponse' on 'BluetoothRemoteGATTCharacteristic': GATT Server is disconnected. Cannot perform GATT operations. (Re)connect first with `device.gatt.connect`.")
   }
 },async writeValueWithoutResponse(){assert.ok(calls.includes('subscribe'));calls.push('writeWithoutResponse')}}
 const service={uuid:uuid('10'),getCharacteristics:async()=>[rx,tx]}
 const gatt={connected:false,async connect(){this.connected=true;return this},getPrimaryServices:async()=>[service],disconnect(){this.connected=false;calls.push('disconnect')}}
 const device={id:'test-device',name:'D4U-NFCA01-2136',gatt,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
 const old=Object.getOwnPropertyDescriptor(globalThis,'navigator')
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{bluetooth:{requestDevice:async()=>device}}})
 return {calls,listeners,tx,rx,gatt,restore(){if(old)Object.defineProperty(globalThis,'navigator',old);else delete globalThis.navigator}}
}
test('new A01 indication-only FF12 connects, subscribes before writes, and receives bytes',async()=>{
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport(),received=[]
 try{
  transport.onData(bytes=>received.push([...bytes]));await transport.connect()
  assert.equal(transport.status,'connected');assert.equal(mock.calls[0],'subscribe')
  // 连接阶段不再盲写探测：第一次写入由上层发起，且一定发生在订阅之后。
  await transport.writeChunk(Uint8Array.of(4,5))
  assert.ok(mock.calls.includes('write'));assert.ok(!mock.calls.includes('writeWithoutResponse'))
  const buffer=Uint8Array.of(9,1,2,3,9);mock.tx.value=new DataView(buffer.buffer,1,3)
  mock.listeners.get('characteristicvaluechanged')({target:mock.tx});assert.deepEqual(received,[[1,2,3]])
  await transport.disconnect()
  assert.equal(transport.status,'idle');assert.equal(mock.listeners.size,0);assert.equal(mock.gatt.connected,false)
 }finally{mock.restore()}
})
test('legacy notify-only FF12 remains compatible',async()=>{
 const mock=setup({notify:true,indicate:false}),transport=new WebBluetoothTransport()
 try{
  await transport.connect();assert.equal(transport.status,'connected')
  // 写入一律等 ATT 确认：旧 Notify 链路也一样。
  await transport.writeChunk(Uint8Array.of(1));assert.ok(mock.calls.includes('write'))
  await transport.disconnect()
 }finally{mock.restore()}
})
test('FF12 with neither property fails with actionable error and disconnects cleanly',async()=>{
 const mock=setup({notify:false,indicate:false}),transport=new WebBluetoothTransport()
 try{await assert.rejects(transport.connect(),/FF12.*Notify \/ Indicate/);assert.equal(transport.status,'error');assert.equal(mock.gatt.connected,false);assert.ok(!mock.calls.includes('subscribe'))}finally{mock.restore()}
})
test('indication-only device without response writes still uses its supported write mode',async()=>{
 const mock=setup({indicate:true},{write:false,writeWithoutResponse:true}),transport=new WebBluetoothTransport()
 try{
  await transport.connect()
  // 这种设备根本不支持有响应写，即使上层要确认也只能退回无响应写。
  await transport.writeChunk(Uint8Array.of(1));assert.ok(mock.calls.includes('writeWithoutResponse'))
  await transport.disconnect()
 }finally{mock.restore()}
})

test('every slice waits for an ATT confirmation, like the python reference',async()=>{
 // 参考实现 rf_device_platform-python：每片 write_gatt_char(..., response=True)。
 // 无响应写没有流控，连发会把设备接收队列冲垮，固件整段丢弃（静默丢片）。
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 try{
  await transport.connect()
  await transport.writeChunk(Uint8Array.of(1,2))
  await transport.writeChunk(Uint8Array.of(3))
  assert.ok(mock.calls.includes('write'))
  assert.ok(!mock.calls.includes('writeWithoutResponse'),'不应该出现无响应写')
 }finally{mock.restore()}
})

test('a busy GATT error is retried with backoff instead of failing the transfer',async()=>{
  // Chrome 在上一个操作还在途时会报 "GATT operation already in progress."，
  // 这是排队而不是链路坏了：等一会儿重写就好。浏览器偶尔会连着报几次，
  // 所以给多档退避，而不是只试一次就放弃。
  const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
  let attempts=0
  const original=mock.rx.writeValueWithResponse
  mock.rx.writeValueWithResponse=async payload=>{
    attempts+=1
    if(attempts<=2) throw new Error('GATT operation already in progress.')
    return original.call(mock.rx,payload)
  }
  try{
    await transport.connect()
    await transport.writeChunk(Uint8Array.of(1,2))
    assert.equal(attempts,3,'前两次忙，第三次写成')
    assert.equal(transport.status,'connected')
  }finally{mock.restore()}
})

test('a busy GATT error that never clears becomes an actionable Chinese message',async()=>{
  const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
  mock.rx.writeValueWithResponse=async()=>{throw new Error('GATT operation already in progress.')}
  try{
    await transport.connect()
    await assert.rejects(transport.writeChunk(Uint8Array.of(1)),/读卡器忙/)
  }finally{mock.restore()}
})

test('a GATT write that never settles times out instead of wedging the whole queue',async()=>{
 // 浏览器的 GATT 写有可能既不成功也不失败——Promise 永远不落地。
 // 不设上限，这一次写入就会把整条串行队列堵死：射频场一直开着，
 // 后面所有操作都排在它后面，看起来就像「传输卡住了」。
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 mock.rx.writeValueWithResponse=()=>new Promise(()=>{})
 mock.rx.writeValueWithoutResponse=()=>new Promise(()=>{})
 try{
  await transport.connect()
  await assert.rejects(transport.writeChunk(Uint8Array.of(1,2)),/写入超时/)
 }finally{mock.restore()}
})

test('the connected log states the write mode instead of offering a switch',async()=>{
 // 只有一种写法：每片等 ATT 确认（和参考实现 rf_device_platform-python 一致）。
 // 界面不再提供「快速/稳妥」开关，日志要把实际写法讲清楚。
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 const traces=[]
 transport.onTrace(message=>traces.push(message))
 try{
   mock.gatt.maxWriteWithoutResponseSize=244
   await transport.connect()
   assert.equal(transport.chunkSize,244)
   await transport.writeChunk(Uint8Array.of(1,2))
   assert.ok(mock.calls.includes('write'))
   assert.ok(!mock.calls.includes('writeWithoutResponse'),'不应出现无响应写')
   assert.ok(traces.some(line=>/每片等确认/.test(line)),'日志要写明每片等确认')
 }finally{mock.restore()}
})
test('connecting never writes probe packets of its own',async()=>{
 // 超 MTU 的 ATT PDU 会被设备丢弃且不回响应，浏览器只能干等到超时，
 // 链路还会被判死。连接阶段绝不能自己发探测包。
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 try{await transport.connect();assert.ok(!mock.calls.includes('write'));assert.ok(!mock.calls.includes('writeWithoutResponse'))}finally{mock.restore()}
})
test('the write chunk size follows the fragment length the device uses',async()=>{
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 try{
  await transport.connect()
  assert.equal(transport.chunkSize,20)
  // 设备按 MTU-3 分片发帧：它发过来的分片有多长，写入上限就是多少。
  const big=new Uint8Array(244).fill(7);mock.tx.value=new DataView(big.buffer)
  mock.listeners.get('characteristicvaluechanged')({target:mock.tx})
  assert.equal(transport.chunkSize,244)
  // 短分片不会把上限拉低。
  const small=new Uint8Array(12);mock.tx.value=new DataView(small.buffer)
  mock.listeners.get('characteristicvaluechanged')({target:mock.tx})
  assert.equal(transport.chunkSize,244)
 }finally{mock.restore()}
})
test('a disconnect during connect fails the connection instead of reporting a dead link as connected',async()=>{
 const mock=setup({indicate:true,notify:false},{write:true,writeWithoutResponse:true},{dropOnSubscribe:true}),transport=new WebBluetoothTransport()
 const traces=[]
 transport.onTrace(message=>traces.push(message))
 try{
  await assert.rejects(transport.connect(),/已断开/)
  assert.notEqual(transport.status,'connected')
  assert.equal(transport.status,'error')
  // 断连要留下可操作的提示，不能只有浏览器的英文原文。
  assert.ok(traces.some(line=>/已断开/.test(line)))
  assert.ok(!traces.some(line=>/GATT Server is disconnected/.test(line)))
 }finally{mock.restore()}
})
test('a disconnect after connect reports the loss and stops claiming to be connected',async()=>{
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 const traces=[],statuses=[]
 transport.onTrace(message=>traces.push(message))
 transport.onStatus((status,message)=>statuses.push([status,message]))
 try{
  await transport.connect()
  assert.equal(transport.status,'connected')
  mock.gatt.connected=false
  mock.listeners.get('gattserverdisconnected')()
  assert.equal(transport.status,'error')
  assert.ok(traces.some(line=>/请重新连接/.test(line)))
  assert.ok(statuses.some(([status,message])=>status==='error'&&/请重新连接/.test(message)))
 }finally{mock.restore()}
})
test('writes after a disconnect fail with an actionable message',async()=>{
 const mock=setup({indicate:true,notify:false}),transport=new WebBluetoothTransport()
 try{
  await transport.connect()
  mock.gatt.connected=false
  mock.listeners.get('gattserverdisconnected')()
  await assert.rejects(transport.writeChunk(Uint8Array.of(1,2)),/请重新连接/)
 }finally{mock.restore()}
})

test('native GATT payload length overrides short notifications and follows link changes',async()=>{
 const mock=setup({indicate:true}),transport=new WebBluetoothTransport()
 try{
  mock.gatt.maxWriteWithoutResponseSize=244
  await transport.connect();assert.equal(transport.chunkSize,244)
  mock.tx.value=new DataView(new Uint8Array(12).buffer)
  mock.listeners.get('characteristicvaluechanged')({target:mock.tx})
  assert.equal(transport.chunkSize,244)
  mock.gatt.maxWriteWithoutResponseSize=182;assert.equal(transport.chunkSize,182)
  await transport.disconnect();assert.equal(transport.chunkSize,20)
 }finally{mock.restore()}
})
test('a device without response writes still writes through the supported mode',async()=>{
 // 设备根本不支持有响应写时，退回无响应写——总比写不进去强。
 const mock=setup({indicate:true},{write:false,writeWithoutResponse:true}),transport=new WebBluetoothTransport()
 try{await transport.connect();await transport.writeChunk(Uint8Array.of(1));assert.ok(mock.calls.includes('writeWithoutResponse'));await transport.disconnect()}finally{mock.restore()}
})
