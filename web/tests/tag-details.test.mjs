import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'
const server = await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {ntagModel,type2WriteStatus}=await server.ssrLoadModule('/src/core/nfc/tagDetails.ts')
const {encodeUriRecord,decodeUriRecord,Type2Session,scanType2Tlvs}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
const tag=()=>({uid:Uint8Array.of(4,1,2,3),version:Uint8Array.of(0,4,4,2,1,0,15,3),staticLocks:Uint8Array.of(0,0),auth0:255,capabilityContainer:Uint8Array.of(0xe1,0x10,18,0),userMemory:new Uint8Array(144),ndefTlv:null,appendOffset:0,hasControlTlv:false,hasTlvAfterNdef:false})
test('GET_VERSION distinguishes 213, 215 and 216 without trusting unrelated bytes',()=>{
 for(const [size,name]of[[15,'NTAG213'],[17,'NTAG215'],[19,'NTAG216']]){const t=tag();t.version[6]=size;assert.equal(ntagModel(t.version).name,name)}
 const t=tag();t.version[1]=1;assert.equal(ntagModel(t.version),null)
})
test('write status separates declared NDEF capacity from supported unlocked region',()=>{
 assert.equal(type2WriteStatus(tag()).maxTlvBytes,48)
 const t=tag();t.auth0=8;assert.equal(type2WriteStatus(t).maxTlvBytes,16)
 t.auth0=4;assert.equal(type2WriteStatus(t).allowed,false)
})
test('read-only, unknown protection, locked and special layouts cannot be called writable',()=>{
 for(const patch of [{capabilityContainer:Uint8Array.of(0xe1,0x10,18,15)},{auth0:undefined},{staticLocks:undefined},{staticLocks:Uint8Array.of(16,0)},{hasControlTlv:true}])assert.equal(type2WriteStatus({...tag(),...patch}).allowed,false)
})
test('verified password unlocks protected user pages but never overrides locks or read-only CC',()=>{
 const t={...tag(),auth0:4,authenticated:true}
 assert.equal(type2WriteStatus(t).allowed,true)
 assert.equal(type2WriteStatus(t).maxTlvBytes,48)
 for(const patch of [{capabilityContainer:Uint8Array.of(0xe1,0x10,18,15)},{staticLocks:Uint8Array.of(16,0)},{hasControlTlv:true}])assert.equal(type2WriteStatus({...t,...patch}).allowed,false)
})
test('URI records use standard prefix compression and reject unsafe input',()=>{
 for(const url of ['https://example.com','http://example.com','https://www.example.com','http://www.example.com'])assert.equal(decodeUriRecord(encodeUriRecord(url)),url)
 assert.equal(encodeUriRecord('https://example.com')[4],4)
 for(const url of ['javascript:alert(1)','https://user:password@example.com','not a URL'])assert.throws(()=>encodeUriRecord(url))
})
test('URI writing verifies data and updates session snapshot; password protected writes fail before writing',async()=>{
 const t=tag();const memory=t.userMemory;memory.set([3,0,254]);t.ndefTlv=scanType2Tlvs(memory).ndef
 const session=new Type2Session({});session.info=t;session.active=true
 let auth0=255,writes=0
 session.readPage=async page=>{const data=new Uint8Array(16);if(page===41)data[3]=auth0;return data}
 session.writePage=async(page,bytes)=>{writes++;memory.set(bytes,(page-4)*4)}
 session.readUserMemory=async()=>memory.slice()
 await session.writeUri('https://example.com','04010203')
 assert.equal(decodeUriRecord(session.tag.ndefTlv.value),'https://example.com');assert.ok(writes>0)
 const before=writes;auth0=4
 await assert.rejects(session.writeText('new text','04010203'),/密码/);assert.equal(writes,before)
})
