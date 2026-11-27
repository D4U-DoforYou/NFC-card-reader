import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())

const { FrameStreamDecoder, encodeFrame } = await server.ssrLoadModule('/src/core/protocol/a01/framing.ts')
const { proto } = await server.ssrLoadModule('/src/core/protocol/a01/messages.ts')
const { A01Session } = await server.ssrLoadModule('/src/core/protocol/a01/session.ts')

const SESSION_ID = 0x1122334455667788n

/**
 * 一个假设备：按 A01 的协议规则回话。
 *
 * 用来在没有硬件的情况下验证「握手 → 能力清单 → 作业」这条主链路。
 */
class FakeDevice {
  chunkSize = 244

  constructor() {
    this.decoder = new FrameStreamDecoder()
    this.dataListeners = []
    this.written = []
    /** 每次写入用的确认选项，测试用。 */
    this.writeOptions = []
    this.jobId = 0
    /** 收到的请求体，测试用。 */
    this.requests = []
    /** 最近一次写入拼出的完整帧。 */
    this.lastFrames = []
  }

  onData(listener) {
    this.dataListeners.push(listener)
    return () => {
      this.dataListeners = this.dataListeners.filter(item => item !== listener)
    }
  }

  writeChunk(bytes, options) {
    this.written.push(bytes)
    this.writeOptions.push(options)
    const frames = this.decoder.feed(bytes)
    // 供测试判断「这一片是不是帧的终止符」：拼出完整帧就不算空转的重同步。
    this.lastFrames = frames
    for (const frame of frames) {
      this.handle(proto.decode('Envelope', frame))
    }
    return Promise.resolve()
  }

  send(envelope) {
    const payload = proto.encode('Envelope', envelope)
    const bytes = encodeFrame(payload)
    for (const listener of this.dataListeners) {
      listener(bytes)
    }
  }

  handle(envelope) {
    this.requests.push(envelope)
    const bodyName = Object.keys(envelope).find(
      key => !['protocol_major', 'protocol_minor', 'session_id', 'request_id'].includes(key)
    )
    if (bodyName === 'hello_request') {
      this.send({
        protocol_major: 1,
        protocol_minor: 0,
        session_id: SESSION_ID,
        request_id: envelope.request_id,
        hello_response: {
          device_id: new Uint8Array([1, 2, 3, 4, 5, 6]),
          boot_id: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
          protocol_major: 1,
          protocol_minor: 0,
          max_control_message: 10541,
          max_data_chunk: 244,
          max_in_flight_jobs: 4,
          transport: ['ble_gatt'],
        },
      })
      return
    }
    if (bodyName === 'capability_query') {
      this.send({
        protocol_major: 1,
        protocol_minor: 0,
        session_id: SESSION_ID,
        request_id: envelope.request_id,
        capability_list: {
          capabilities: [
            {
              id: 'org.example.device.info',
              major_version: 1,
              minor_version: 0,
              operations: [{ id: 'get', mutating: false, cancellable: true }],
            },
            {
              id: 'org.example.rf.clrc663.config',
              major_version: 1,
              minor_version: 0,
              operations: [
                { id: 'get_tx_amplitude', mutating: false, cancellable: true },
                { id: 'set_tx_amplitude', mutating: true, cancellable: false },
              ],
            },
            {
              id: 'org.example.rf.raw',
              major_version: 1,
              minor_version: 1,
              operations: [
                { id: 'set_field', mutating: true, cancellable: false },
                { id: 'transceive', mutating: true, cancellable: false },
              ],
            },
          ],
        },
      })
      return
    }
    if (bodyName === 'start_job') {
      this.jobId += 1
      const jobId = this.jobId
      const request = envelope.start_job
      // 先回受理，再回终态——和固件一样。
      this.send({
        protocol_major: 1,
        protocol_minor: 0,
        session_id: SESSION_ID,
        request_id: envelope.request_id,
        job_event: { job_id: jobId, state: 1 },
      })
      this.send({
        protocol_major: 1,
        protocol_minor: 0,
        session_id: SESSION_ID,
        request_id: 0,
        job_event: {
          job_id: jobId,
          state: 3,
          result: this.resultFor(request),
        },
      })
    }
  }

  /** 按操作返回对应的结果负载。 */
  resultFor(request) {
    if (request.operation_id === 'get') {
      return proto.encode('DeviceInfoResult', { firmware_name: 'rf-device-platform', firmware_version: '1.2.3', radio_controller: 'CLRC663' })
    }
    if (request.operation_id === 'get_tx_amplitude') {
      return proto.encode('TxAmplitudeResult', { level: 2 })
    }
    if (request.operation_id === 'set_tx_amplitude') {
      const args = proto.decode('TxAmplitudeRequest', request.arguments)
      return proto.encode('TxAmplitudeResult', { level: args.level })
    }
    if (request.operation_id === 'transceive') {
      return proto.encode('RawRfTransceiveResult', {
        rx: new Uint8Array([0x04, 0x00]),
        rx_last_bits: 0,
        irq0: 0,
        irq1: 0,
        error: 0,
        collision: 0,
      })
    }
    return new Uint8Array(0)
  }
}

function makeSession() {
  const device = new FakeDevice()
  const profile = {
    scheme: 'A01',
    label: 'test',
    namePrefix: 'D4U-NFC',
    serviceUuid: 'x',
    rxUuid: 'y',
    txUuid: 'z',
    createSession: channel => new A01Session(profile, channel),
  }
  const session = new A01Session(profile, device)
  return { device, session }
}

test('handshake returns the device identity and the session id', async () => {
  const { session } = makeSession()
  const hello = await session.connect()
  assert.equal(hello.sessionId ?? hello.protocolMajor, 1)
  assert.equal(hello.protocolMajor, 1)
  assert.deepEqual(Array.from(hello.deviceId), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(hello.transports, ['ble_gatt'])
})

test('the capability list is parsed with versions and operations', async () => {
  const { session } = makeSession()
  await session.connect()
  const raw = session.capabilities.find(item => item.id === 'org.example.rf.raw')
  assert.equal(raw.minorVersion, 1)
  assert.deepEqual(raw.operations.map(item => item.id), ['set_field', 'transceive'])
  assert.equal(raw.operations[1].mutating, true)
})

test('reading and writing the transmit amplitude round-trips', async () => {
  const { session } = makeSession()
  await session.connect()
  assert.equal(await session.getTxAmplitude(), 2)
  assert.equal(await session.setTxAmplitude(3), 3)
})

test('a raw transceive returns the frame the device sent', async () => {
  const { session } = makeSession()
  await session.connect()
  const frame = await session.rawTransceive(new Uint8Array([0x26]), {
    timeoutMs: 100,
    txLastBits: 7,
    crcFlags: 0,
  })
  assert.deepEqual(Array.from(frame.rx), [0x04, 0x00])
  assert.equal(frame.rxLastBits, 0)
})

test('a confirmed target uid reaches the device with the job', async () => {
  const { device, session } = makeSession()
  await session.connect()
  await session.rawTransceive(new Uint8Array([0xa2, 0x04]), {
    confirmedTargetUid: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  })
  const start = device.requests.find(item => item.start_job)
  assert.ok(start)
  assert.deepEqual(Array.from(start.start_job.confirmed_target_uid), [0xde, 0xad, 0xbe, 0xef])
  assert.equal(start.start_job.user_confirmed, true)
})

test('every request carries a unique id and the negotiated session id', async () => {
  const { device, session } = makeSession()
  await session.connect()
  await session.getTxAmplitude()
  const ids = device.requests.map(item => item.request_id)
  assert.equal(new Set(ids).size, ids.length)
  for (const request of device.requests) {
    if (request.hello_request) {
      assert.equal(request.session_id ?? 0n, 0n)
    } else {
      assert.equal(request.session_id, SESSION_ID)
    }
  }
})

test('concurrent metadata, power and field requests cannot interleave fragmented frames', {timeout:3000}, async () => {
  const { device, session } = makeSession()
  device.chunkSize = 5
  session.chunkSize = 5
  const write = device.writeChunk.bind(device)
  device.writeChunk = async bytes => { await new Promise(resolve=>setTimeout(resolve,1)); return write(bytes) }
  try {
    await session.connect()
    const [info, power] = await Promise.all([session.getDeviceInfo(), session.getTxAmplitude(), session.setRfField(false)])
    assert.equal(info.firmwareVersion,'1.2.3');assert.equal(power,2)
    assert.equal(device.requests.length,5)
  } finally { await session.close() }
})

test('duplicate device information reads share one in-flight job', async () => {
  const { device, session } = makeSession()
  await session.connect()
  const [first, second] = await Promise.all([session.getDeviceInfo(), session.getDeviceInfo()])
  assert.deepEqual(first,second)
  assert.equal(device.requests.filter(r=>r.start_job?.operation_id==='get').length,1)
  await session.getDeviceInfo()
  assert.equal(device.requests.filter(r=>r.start_job?.operation_id==='get').length,2)
  await session.close()
})

test('an early notification does not release the request slot before the GATT write settles', async () => {
  const { device, session } = makeSession()
  await session.connect()
  const write = device.writeChunk.bind(device)
  let writes = 0, maxWrites = 0
  device.writeChunk = async bytes => {
    maxWrites = Math.max(maxWrites, ++writes)
    await write(bytes)
    await new Promise(resolve=>setTimeout(resolve,10))
    writes--
  }
  await Promise.all([session.getDeviceInfo(),session.getTxAmplitude(),session.setRfField(false)])
  assert.equal(maxWrites,1)
  await session.close()
})

test('queued requests start their response timeout only after earlier responses arrive', async () => {
  const { device, session } = makeSession()
  await session.connect()
  const handle=device.handle.bind(device)
  let delayed=false
  device.handle=envelope=>{
    if(envelope.capability_query && !delayed){delayed=true;setTimeout(()=>handle(envelope),40)}
    else handle(envelope)
  }
  try {
    await Promise.all([
      session.request('capability_query',{},'capability_list',200),
      session.request('capability_query',{},'capability_list',15),
    ])
  } finally { await session.close() }
})

test('closing a session rejects pending and queued requests without sending queued bytes', async () => {
  const { device, session } = makeSession()
  await session.connect()
  device.handle=()=>{}
  const waiting=Promise.allSettled([
    session.request('capability_query',{},'capability_list'),
    session.request('capability_query',{},'capability_list'),
  ])
  await new Promise(resolve=>setTimeout(resolve,0))
  const sent=device.written.length
  await session.close()
  const results=await waiting
  assert.ok(results.every(result=>result.status==='rejected' && /关闭/.test(result.reason.message)))
  assert.equal(device.written.length,sent)
})

test('four-frame indication queue does not overflow during simultaneous metadata, power and RF jobs',async()=>{
 class IndicationDevice extends FakeDevice {
  queue=[];draining=false;peak=0;overflow=false
  send(envelope){
   if(this.queue.length>=4){this.overflow=true;throw new Error('queue_overflow queued=4')}
   this.queue.push(envelope);this.peak=Math.max(this.peak,this.queue.length)
   if(!this.draining){this.draining=true;void this.drain()}
  }
  async drain(){
   while(this.queue.length){
    await new Promise(r=>setTimeout(r,3))
    const message=this.queue[0];super.send(message)
    // Keep the frame queued until its simulated ATT confirmation.
    await new Promise(r=>setTimeout(r,2));this.queue.shift()
   }
   this.draining=false
  }
  handle(e){
   if(!e.start_job)return super.handle(e)
   this.requests.push(e);const id=++this.jobId
   const base={protocol_major:1,protocol_minor:0,session_id:SESSION_ID}
   this.send({...base,request_id:e.request_id,job_event:{job_id:id,state:1}})
   this.send({...base,request_id:0,job_event:{job_id:id,state:2}})
   this.send({...base,request_id:0,job_event:{job_id:id,state:3,result:this.resultFor(e.start_job)}})
  }
 }
 const device=new IndicationDevice(),session=new A01Session({scheme:'A01',label:'A01'},device)
 try{
  await session.connect()
  await Promise.all([session.getDeviceInfo(),session.getTxAmplitude(),session.setRfField(false)])
  assert.equal(device.overflow,false);assert.ok(device.peak<=4)
  assert.equal(device.requests.filter(e=>e.start_job).length,3)
 }finally{await session.close();while(device.draining)await new Promise(r=>setTimeout(r,5))}
})

test('queued jobs resume after failure and close rejects queued work before transmission',async()=>{
 const device=new FakeDevice(),session=new A01Session({scheme:'A01',label:'A01'},device)
 await session.connect()
 const original=session.performJob.bind(session);let entered=0
 session.performJob=async(...args)=>{if(++entered===1)throw new Error('first job failed');return original(...args)}
 const failed=session.getTxAmplitude(),second=session.setRfField(false)
 await assert.rejects(failed,/first job failed/);await second;assert.equal(entered,2)
 let release;session.performJob=()=>new Promise(resolve=>{release=resolve})
 const running=session.setRfField(false);await new Promise(r=>setTimeout(r,0))
 const queued=session.getTxAmplitude();const reject=assert.rejects(queued,/设备会话已关闭/)
 await session.close();release({state:3,result:new Uint8Array()});await running;await reject
})

test('information-only firmware rejects power and RF locally while device details remain readable',async()=>{
 class InfoOnlyDevice extends FakeDevice {
  handle(e){
   if(e.capability_query)return this.send({protocol_major:1,session_id:SESSION_ID,request_id:e.request_id,capability_list:{capabilities:[{id:'org.example.device.info',major_version:1,operations:[{id:'get'}]}]}})
   return super.handle(e)
  }
 }
 const device=new InfoOnlyDevice(),session=new A01Session({scheme:'A01',label:'A01'},device)
 try{
  await session.connect()
  for(const run of [()=>session.getTxAmplitude(),()=>session.setTxAmplitude(1),()=>session.setRfField(true)])await assert.rejects(run(),/当前设备未提供能力.*设备当前仅提供信息查询/)
  assert.equal(device.requests.filter(e=>e.start_job).length,0,'unsupported jobs never reach BLE')
  assert.ok((await session.getDeviceInfo()).firmwareName)
 }finally{await session.close()}
})
test('advertised capability rejected at runtime is diagnosed as a contract mismatch with operation ID',async()=>{
 class InconsistentDevice extends FakeDevice {
  handle(e){
   if(e.start_job)return this.send({protocol_major:1,session_id:SESSION_ID,request_id:e.request_id,job_event:{job_id:++this.jobId,state:4,error_code:1,detail:'unsupported capability'}})
   return super.handle(e)
  }
 }
 const device=new InconsistentDevice(),session=new A01Session({scheme:'A01',label:'A01'},device)
 try{
  await session.connect()
  await assert.rejects(session.setTxAmplitude(1),/已公布能力 org.example.rf.clrc663.config.*set_tx_amplitude.*不一致/)
  await assert.rejects(session.setRfField(true),/已公布能力 org.example.rf.raw.*set_field.*不一致/)
 }finally{await session.close()}
})

test('a frame is split into serial slices that each wait for the link',async()=>{
  // 每一片都等 ATT 确认（可靠写），和参考实现 rf_device_platform-python
  // 一致：`write_gatt_char(..., response=True)`。
  // 无响应写没有流控，连发会把设备接收队列冲垮，固件整段丢弃（静默丢片）。
  // BLE 分片本身仍必须串行（Chrome 不允许并发 GATT 操作）。
  const device=new FakeDevice()
  device.chunkSize=20
  const session=new A01Session({scheme:'A01',label:'A01'},device)
  await session.connect()
  device.writeOptions.length=0
  device.written.length=0
  await session.getDeviceInfo()
  const options=device.writeOptions
  assert.ok(options.length>1,'一帧应该被切成多片')
  // 协议层不再区分写法：每一次写入都是可靠写，由传输层保证等确认。
  assert.ok(options.every(item=>item===undefined),'协议层不再指定写法')
  assert.ok(device.written.every(part=>part.length<=20),'每片不超过分片上限')
})

test('B01 timing separates queued request submission from accepted and terminal replies',async()=>{
 class DelayedDevice extends FakeDevice {
  send(envelope){
   if(envelope.job_event){
    const ms=envelope.job_event.state===1?20:60
    setTimeout(()=>super.send(envelope),ms)
   }else super.send(envelope)
  }
 }
 const device=new DelayedDevice(),session=new A01Session({scheme:'B01',label:'B01'},device)
 try{
  await session.connect()
  const before=session.transferStats
  await session.rawTransceive(Uint8Array.of(0x26),{txLastBits:7})
  const after=session.transferStats
  assert.equal(after.requests-before.requests,1)
  assert.ok(after.firstReceiveWaitMs-before.firstReceiveWaitMs>=10,'first reply waits independently of fast submission')
  assert.ok(after.terminalWaitMs-before.terminalWaitMs>=20,'terminal reply has a distinct wait')
  assert.ok(after.receivedChunks>before.receivedChunks)
  assert.ok(after.receivedBytes>before.receivedBytes)
  // Snapshots must not mutate previously captured upload baselines.
  assert.equal(before.requests,2)
 }finally{await session.close()}
})

test('replies received before writes settle do not double-count receive waiting',async()=>{
 const {device,session}=makeSession()
 try{
  await session.connect()
  const original=device.writeChunk.bind(device)
  device.writeChunk=async(bytes,options)=>{await original(bytes,options);await new Promise(resolve=>setTimeout(resolve,15))}
  const before=session.transferStats
  await session.getDeviceInfo()
  const after=session.transferStats
  assert.ok(after.submitMs-before.submitMs>=10)
  assert.equal(after.firstReceiveWaitMs-before.firstReceiveWaitMs,0)
  assert.equal(after.responseReceiveMs-before.responseReceiveMs,0)
 }finally{await session.close()}
})

test('a frame the device never received is replayed instead of waiting out the whole timeout',async()=>{
 // 模拟无响应写丢片：这一片字节压根没到设备，设备连半帧都没收到。
 class LossyDevice extends FakeDevice {
  constructor(){super();this.loseNext=false;this.lostChunks=0}
  writeChunk(bytes,options){
   if(this.loseNext){
    this.loseNext=false
    this.lostChunks+=1
    this.written.push(bytes)
    this.writeOptions.push(options)
    return Promise.resolve()
   }
   return super.writeChunk(bytes,options)
  }
 }
 const device=new LossyDevice(),session=new A01Session({scheme:'B01',label:'B01'},device)
 try{
  await session.connect()
  const before=session.transferStats.frameReplays
  device.loseNext=true
  // 这一帧会先丢掉一次；会话层发现设备一个字节都没回就整帧重发。
  await session.rawTransceive(Uint8Array.of(0x26),{txLastBits:7})
  assert.equal(device.lostChunks,1,'第一片确实丢了')
  assert.equal(session.transferStats.frameReplays-before,1,'丢帧后整帧重发过一次')
 }finally{await session.close()}
})

test('a frame that is lost for good fails with an actionable message instead of hanging',async()=>{
 class DeadDevice extends FakeDevice {
  constructor(){super();this.dead=false;this.dropped=0}
  writeChunk(bytes,options){
   if(!this.dead)return super.writeChunk(bytes,options)
   this.written.push(bytes)
   this.writeOptions.push(options)
   this.dropped+=1
   // 全部丢掉：设备永远不回话。
   return Promise.resolve()
  }
 }
 const device=new DeadDevice(),session=new A01Session({scheme:'B01',label:'B01'},device)
 try{
  await session.connect()
  device.dead=true
  await assert.rejects(
   session.rawTransceive(Uint8Array.of(0x26),{txLastBits:7}),
   /帧未送达设备/,
  )
 }finally{await session.close()}
})
