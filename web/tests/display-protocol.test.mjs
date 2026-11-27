import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {uploadHuawei}=await server.ssrLoadModule('/src/core/epd/huawei.ts')
const {uploadPanel,buildC1D3Packets}=await server.ssrLoadModule('/src/core/epd/panel.ts')
const {IsoDepSession}=await server.ssrLoadModule('/src/core/rf/isoDep.ts')
const {crcA}=await server.ssrLoadModule('/src/core/rf/crc.ts')
const uid=Uint8Array.of(1,2,3,4),ok=Uint8Array.of(0x90,0)
const huawei={width:552,height:768,colorCount:4,compression:true,uid}
const c1={width:240,height:416,colorCount:4,compression:true,uid,firmware:10,screenType:'c1_2'}
const packed=new Uint8Array(552*768/4)
function mock(fail){const calls=[];return {uid,calls,async exchange(data,retries,target,deadline){calls.push({data,retries,target,deadline});if(data[1]===fail)throw new Error('radio timeout');return data[1]===0xde?Uint8Array.of(0,0x90,0):ok},async exchangeOnce(data,target,deadline){return this.exchange(data,0,target,deadline)}}}
test('Huawei uploads once per D3, binds UID and allows 120 second refresh',async()=>{
 const session=mock();await uploadHuawei(session,huawei,packed)
 assert.equal(session.calls.filter(c=>c.data[1]===0x20).length,2)
 const d3=session.calls.filter(c=>c.data[1]===0xd3);assert.ok(d3.length>50)
 assert.ok(d3.every(c=>c.deadline===20000 && c.target===uid))
 const refresh=session.calls.find(c=>c.data[1]===0xd4);assert.equal(refresh.deadline,120000);assert.equal(refresh.retries,0)
 assert.equal(session.calls.at(-1).data[1],0xde)
})
test('D3 without link resync and uncertain D4 stop without replay or refresh polling',async()=>{
 for(const command of [0xd3,0xd4]){const session=mock(command);await assert.rejects(uploadHuawei(session,huawei,packed),/传输未确认|结果不确定.*未重发/);assert.equal(session.calls.filter(c=>c.data[1]===command).length,1);assert.equal(session.calls.filter(c=>c.data[1]===0xde).length,0)}
})
test('wrong UID, incomplete image and invalid PIN fail before any RF operation',async()=>{
 for(const [profile,data,options] of [[{...huawei,uid:Uint8Array.of(5,6,7,8)},packed,{}],[huawei,packed.slice(1),{}],[huawei,packed,{pin:Uint8Array.of(1)}]]){const session=mock();await assert.rejects(uploadHuawei(session,profile,data,options));assert.equal(session.calls.length,0)}
})
test('C1 uses single-packet compressed D3 even when PIN is disabled and waits 190 seconds',async()=>{
 const session=mock();await uploadPanel(session,c1,new Uint8Array(24960))
 const uploads=session.calls.filter(c=>[0xd2,0xd3].includes(c.data[1]));assert.equal(uploads.length,13)
 assert.ok(uploads.every(c=>c.data[1]===0xd3 && c.data[3]===1 && c.data[6]===0 && c.data.length<=253))
 assert.equal(session.calls.find(c=>c.data[1]===0xd4).deadline,190000)
})
test('complex C1 block is rejected before D8 or PIN and landscape C1 cannot upload',async()=>{
 let seed=123;const noise=Uint8Array.from({length:24960},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255})
 assert.throws(()=>buildC1D3Packets(noise),/246/)
 const session=mock();await assert.rejects(uploadPanel(session,c1,noise),/246/);assert.equal(session.calls.length,0)
 await assert.rejects(uploadPanel(session,{...c1,width:416,height:240},new Uint8Array(24960)),/240×416/)
})
const activation={uid,sak:32,atqa:Uint8Array.of(4,0),ats:Uint8Array.of(2,8),fsc:256,fwtMs:5,cid:null}
function reply(body){return {data:new Uint8Array([...body,...crcA(Uint8Array.from(body))]),rxLastBits:0,errorStatus:0,irq0Status:0,irq1Status:0,collisionStatus:0}}
test('ISO-DEP enforces total deadline across WTX and preserves WTX response on recovery',async()=>{
 const sent=[];let i=0;const session=new IsoDepSession({async exchange(frame){sent.push(frame[0]);if(++i===1)return reply([0xf2,2]);if(i===2)throw new Error('RF');return reply([2,0x90,0])}},activation)
 await session.exchange(Uint8Array.of(0,0xd1,0,0,0));assert.deepEqual(sent,[2,0xf2,0xf2])
 const slow=new IsoDepSession({async exchange(){await new Promise(r=>setTimeout(r,15));return reply([0xf2,2])}},activation)
 await assert.rejects(slow.exchange(Uint8Array.of(0,0xd1,0,0,0),2,uid,5),/交换超时/)
})
test('ISO-DEP rejects invalid I-block and explicitly NAKed I-block can retry',async()=>{
 const invalid=new IsoDepSession({exchange:async()=>reply([0x03,0x90,0])},activation)
 await assert.rejects(invalid.exchange(Uint8Array.of(0,0xd1,0,0,0)),/I-block/)
 let n=0;const nak=new IsoDepSession({exchange:async()=>reply(++n===1?[0xb2]:[2,0x90,0])},activation)
 assert.deepEqual([...await nak.exchange(Uint8Array.of(0,0xd1,0,0,0))],[0x90,0]);assert.equal(n,2)
})

test('C1 D1 supports the new reference fields without a B1 extension',async()=>{
 const {parsePanelProfile}=await server.ssrLoadModule('/src/core/epd/profile.ts')
 const tlv=(tag,data)=>[tag,data.length,...data]
 const profile=parsePanelProfile(Uint8Array.from([
  ...tlv(0xa0,[0,0,0x40,1,0xa0,0,0xf0]),...tlv(0xa1,[0,0,0,0,0,0,0]),
  ...tlv(0xc0,[0,0,0,1]),...tlv(0xc1,uid),...tlv(0xd1,[0,0x10,0,0,0,0,0]),0x90,0
 ]))
 assert.equal(profile.width,240);assert.equal(profile.height,416);assert.equal(profile.firmware,10)
 assert.equal(profile.scanVertical,false);assert.equal(profile.colorCodes['02'],3)
})
