import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {createServer} from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {Type2Session,hasTlvTerminator}=await server.ssrLoadModule('/src/core/nfc/type2Session.ts')
function tag(memory){const pages=[],session=new Type2Session({});session.readPage=async page=>{pages.push(page);return memory.slice((page-4)*4,(page-4)*4+16)};return{session,pages}}
test('12-byte NDEF on 872-byte tag reads only first 48 bytes in quick mode',async()=>{
 const memory=new Uint8Array(872);memory.set([3,12,...new Array(12).fill(0x36),0xfe])
 const {session,pages}=tag(memory);const prefix=await session.readUserMemory(872,true)
 assert.equal(prefix.length,48);assert.deepEqual(pages,[4,8,12]);assert.deepEqual(prefix,memory.slice(0,48))
})
test('full export still reads all 872 bytes',async()=>{
 const memory=new Uint8Array(872);memory.set([3,0,0xfe]);memory[871]=123
 const {session,pages}=tag(memory);assert.deepEqual(await session.readUserMemory(872),memory);assert.equal(pages.length,55)
})
test('terminator in payload never ends reading and extended TLV can cross READ boundaries',async()=>{
 const memory=new Uint8Array(872);memory.set([3,0xff,0,80]);memory.fill(0xfe,4,84);memory[84]=0xfe
 assert.equal(hasTlvTerminator(memory.slice(0,48)),false)
 const {session,pages}=tag(memory);const prefix=await session.readUserMemory(872,true)
 assert.equal(prefix.length,96);assert.equal(pages.length,6);assert.equal(hasTlvTerminator(prefix),true)
})
test('no terminator falls back to full memory and incomplete TLV is not mistaken for completion',async()=>{
 const memory=new Uint8Array(872),{session,pages}=tag(memory)
 assert.equal((await session.readUserMemory(872,true)).length,872);assert.equal(pages.length,55)
 for(const bytes of [[3],[3,255],[3,255,0],[3,4,0xfe],[1,1,0xfe]]) assert.equal(hasTlvTerminator(Uint8Array.from(bytes)),false)
})
