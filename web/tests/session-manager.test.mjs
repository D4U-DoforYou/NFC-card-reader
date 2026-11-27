import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {createServer} from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {DeviceSessionManager}=await server.ssrLoadModule('/src/core/protocol/index.ts')
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function setup(){
 const sessions=[],listeners=[]
 const transport={status:'connected',onStatus:fn=>listeners.push(fn),hardwareProfile:{createSession(){const handshake=defer();const session={handshake,closed:false,connect(){return handshake.promise},async close(){this.closed=true}};sessions.push(session);return session}}}
 return{sessions,transport,manager:new DeviceSessionManager(transport)}
}
test('simultaneous metadata and power requests share one handshake',async()=>{
 const {manager,sessions}=setup();const one=manager.require(),two=manager.require();await Promise.resolve();assert.equal(sessions.length,1)
 sessions[0].handshake.resolve();assert.equal(await one,await two);await manager.close()
})
test('slow old close cannot create duplicate replacement sessions',async()=>{
 const {manager,sessions}=setup();const first=manager.open();await Promise.resolve();sessions[0].handshake.resolve();await first
 // Simulate a previous failed handshake leaving a session needing cleanup.
 manager.ready=null
 const closing=defer();sessions[0].close=()=>closing.promise
 const a=manager.require(),b=manager.require();await Promise.resolve();assert.equal(sessions.length,1)
 closing.resolve();await new Promise(r=>setTimeout(r,0));assert.equal(sessions.length,2)
 sessions[1].handshake.resolve();assert.equal(await a,await b);assert.equal(sessions[1].closed,false);await manager.close()
})
test('stale handshake failure cannot replace the new session or set its error',async()=>{
 const {manager,sessions}=setup();const old=manager.open();const rejection=assert.rejects(old,/old failed/);await Promise.resolve();await manager.close()
 const fresh=manager.open();await Promise.resolve();sessions[1].handshake.resolve();const current=await fresh
 sessions[0].handshake.reject(new Error('old failed'));await rejection
 assert.equal(await manager.require(),current);assert.equal(manager.error,null);assert.equal(current.closed,false);await manager.close()
})
test('close before scheduled handshake prevents creating a session',async()=>{
 const {manager,sessions}=setup();const pending=manager.open();const rejected=assert.rejects(pending,/连接已变化/);await manager.close();await rejected;assert.equal(sessions.length,0)
})
