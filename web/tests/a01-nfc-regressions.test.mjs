import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {IsoDepSession,activateTag,parseAts}=await server.ssrLoadModule('/src/core/rf/isoDep.ts')
const {crcA}=await server.ssrLoadModule('/src/core/rf/crc.ts')
const {identifyCard,decodeSak}=await server.ssrLoadModule('/src/core/nfc/cards.ts')
const {Type2Session}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
const {A01Session}=await server.ssrLoadModule('/src/core/protocol/a01/session.ts')
const {A01_PROFILE}=await server.ssrLoadModule('/src/core/protocol/a01/index.ts')
const {deviceSession}=await server.ssrLoadModule('/src/core/protocol/index.ts')
const {probeProtocol}=await server.ssrLoadModule('/src/core/rf/probe.ts')
function reply(body,crc=true){const bytes=Uint8Array.from(body);return {data:crc?new Uint8Array([...bytes,...crcA(bytes)]):bytes,rxLastBits:0,errorStatus:0,irq0Status:0,irq1Status:0,collisionStatus:0}}
const activation={uid:Uint8Array.of(1,2,3,4),sak:32,atqa:Uint8Array.of(4,0),ats:Uint8Array.of(2,8),fsc:256,fwtMs:4096/13560000*16*1000,cid:null}

test('fractional ATS frame wait becomes integer at A01 boundary',async()=>{
 const a01=new A01Session(A01_PROFILE,{onData:()=>()=>{},writeChunk:async()=>{},chunkSize:244})
 a01.startJob=async()=>({state:3,result:new Uint8Array()})
 let timeout
 const bridge={exchange:async(_,options)=>{timeout=options.timeoutMs;await a01.rawTransceive(Uint8Array.of(2),options);return reply([2,0x90,0])}}
 const result=await new IsoDepSession(bridge,activation).exchange(Uint8Array.of(0xd1))
 assert.equal(timeout,9);assert.deepEqual([...result],[0x90,0]);await a01.close()
})
test('WTX uses the multiplied timeout for the subsequent frame',async()=>{
 const timeouts=[];let n=0
 const bridge={exchange:async(_,options)=>{timeouts.push(options.timeoutMs);return ++n===1?reply([0xf2,10]):reply([2,0x90,0])}}
 await new IsoDepSession(bridge,activation).exchange(Uint8Array.of(0xd1))
 assert.deepEqual(timeouts,[9,53])
})
test('ISO-DEP response chaining collects more than two blocks',async()=>{
 const frames=[[0x12,1],[0x13,2],[0x02,3]]
 const bridge={exchange:async()=>reply(frames.shift())}
 assert.deepEqual([...await new IsoDepSession(bridge,activation).exchange(Uint8Array.of(0xd1))],[1,2,3])
})
test('Type A SAK=0 and wire-order ATQA 44 00 activate as Type 2 candidate',async()=>{
 const uid1=[0x88,4,0x12,0x34],uid2=[0x56,0x78,0x9a,0xbc]
 const bcc=u=>u.reduce((a,b)=>a^b,0)
 const frames=[reply([0x44,0],false),reply([...uid1,bcc(uid1)],false),reply([4]),reply([...uid2,bcc(uid2)],false),reply([0])]
 const active=await activateTag({exchange:async()=>frames.shift()},0x52,{strictAtqa:false,requireIsoDep:false})
 const card=identifyCard({...active,protocol:'iso14443a'})
 assert.equal(card.modelId,'ultralight');assert.equal(card.uidKindName,'双尺寸 UID（7 字节）');assert.equal(card.isoDep,false)
 assert.ok(!card.modelName.includes('无效'))
})
test('SAK 18 is Classic 4K; generic ISO-DEP is not guessed as DESFire',()=>{
 assert.equal(identifyCard({uid:Uint8Array.of(1,2,3,4),atqa:Uint8Array.of(2,0),sak:0x18}).capacity,'4KB')
 assert.equal(decodeSak(0x18).modelId,'mifare-classic')
 assert.equal(decodeSak(0x28).modelId,'iso-dep')
 assert.equal(identifyCard({uid:Uint8Array.of(1,2,3,4),atqa:Uint8Array.of(4,0),sak:0x40}).protocol,'iso14443a')
})
test('ATS missing interface bytes is rejected',()=>{assert.throws(()=>parseAts(Uint8Array.of(2,0x18)))})
test('Type V inventory uses valid A01 full-byte frames and extracts UID after DSFID',async()=>{
 deviceSession.session={profile:A01_PROFILE}
 const seen=[]
 const bridge={exchange:async(frame,options)=>{seen.push({frame:[...frame],options});if(seen.length===1)throw new Error('no Type A');return reply([0,0,1,2,3,4,5,6,7,0xe0],false)}}
 const found=await probeProtocol(bridge)
 assert.equal(found.protocol,'iso15693');assert.deepEqual([...found.uid15693],[0xe0,7,6,5,4,3,2,1])
 assert.deepEqual(seen[1].frame,[0x26,1,0]);assert.equal(seen[1].options.txLastBits,0);deviceSession.session=null
})

test('NDEF extended TLV retains length, full payload and terminator', async()=>{
 const {encodeNdefTlv,scanType2Tlvs}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
 const message=Uint8Array.from({length:300},(_,i)=>i%251)
 const tlv=encodeNdefTlv(message,true)
 assert.equal(tlv.length,305);assert.equal(tlv.at(-1),0xfe)
 assert.deepEqual(scanType2Tlvs(tlv).ndef.value,message)
})
test('NTAG213 short-text write commits and reads back while wrong UID is rejected',async()=>{
 const {scanType2Tlvs,encodeTextRecord}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
 const memory=new Uint8Array(144);memory.set([3,0,0xfe])
 const session=new Type2Session({})
 session.active=true
 session.info={uid:Uint8Array.of(4,1,2,3),version:Uint8Array.of(0,4,4,2,1,0,0x0f,3),capabilityContainer:Uint8Array.of(0xe1,0x10,18,0),userMemory:memory.slice(),ndefTlv:scanType2Tlvs(memory).ndef,hasControlTlv:false,hasTlvAfterNdef:false,appendOffset:0}
 session.readPage=async page=>{ const bytes=new Uint8Array(16); if(page===0x29) bytes[3]=0xff; return bytes }
 session.writePage=async(page,data,uid)=>{assert.deepEqual([...uid],[4,1,2,3]);assert.ok(page>=4&&page<=15);memory.set(data,(page-4)*4)}
 session.readUserMemory=async()=>memory.slice()
 await assert.rejects(session.writeText('你好','DEADBEEF'),/UID/)
 const result=await session.writeText('你好','04010203')
 assert.deepEqual(result,encodeTextRecord('你好'));assert.deepEqual(scanType2Tlvs(memory).ndef.value,result)
})
test('unknown hardware is rejected even if it advertises the A01 service',async()=>{
 const {WebBluetoothTransport}=await server.ssrLoadModule('/src/platform/webBluetooth.ts')
 const transport=new WebBluetoothTransport();transport.connectedName='D4U-NFCA02-1A2B'
 await assert.rejects(transport.resolveProfile({getPrimaryServices:async()=>[{uuid:A01_PROFILE.serviceUuid}]}),/A02/)
})
test('A01 rejects fractional RF timeouts and invalid full-byte encoding at the boundary',async()=>{
 const session=new A01Session(A01_PROFILE,{onData:()=>()=>{},writeChunk:async()=>{},chunkSize:244})
 await assert.rejects(session.rawTransceive(Uint8Array.of(0x26),{timeoutMs:8.8}),/1..300000/)
 await assert.rejects(session.rawTransceive(Uint8Array.of(0x26),{txLastBits:8}),/txLastBits/)
 await assert.rejects(session.rawTransceive(Uint8Array.of(0x26),{rxMode:19}),/rxMode/)
 await session.close()
})
test('RATS with CID zero keeps CID omitted even if ATS advertises support',()=>{
 assert.equal(parseAts(Uint8Array.of(3,0x48,2)).cid,null)
})
test('Type B polling validates full ATQB and sends a full-byte REQB',async()=>{
 deviceSession.session={profile:A01_PROFILE};let n=0
 const bridge={exchange:async(frame,opts)=>{if(++n<=2)throw new Error('no response');assert.deepEqual([...frame],[5,0,0]);assert.equal(opts.txLastBits,0);return reply([0x50,...new Array(11).fill(1)],false)}}
 assert.equal((await probeProtocol(bridge)).protocol,'iso14443b');deviceSession.session=null
})
test('FeliCa polling extracts IDm from response after length and command',async()=>{
 deviceSession.session={profile:A01_PROFILE};let n=0
 const bridge={exchange:async(frame,opts)=>{if(++n<=3)throw new Error('no response');assert.deepEqual([...frame],[6,0,255,255,1,0]);assert.equal(opts.txLastBits,0);return reply([20,1,1,2,3,4,5,6,7,8,...new Array(10).fill(0)],false)}}
 const found=await probeProtocol(bridge);assert.equal(found.protocol,'felica');assert.deepEqual([...found.idm],[1,2,3,4,5,6,7,8]);deviceSession.session=null
})
