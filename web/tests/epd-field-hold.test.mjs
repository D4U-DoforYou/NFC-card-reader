import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {createServer} from 'vite'
const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
after(()=>server.close())
const {RfBridge}=await server.ssrLoadModule('/src/core/rf/bridge.ts')
test('image preparation and refresh retain RF activation until the last holder releases',()=>{
 const transport={status:'idle',onStatus:()=>()=>{}}
 const bridge=new RfBridge(transport)
 bridge.scheduleIdleOff();assert.ok(bridge.idleTimer)
 const release=bridge.retainField();assert.equal(bridge.idleTimer,0)
 bridge.scheduleIdleOff();assert.equal(bridge.idleTimer,0)
 const second=bridge.retainField();release();release();bridge.scheduleIdleOff();assert.equal(bridge.idleTimer,0)
 second();assert.ok(bridge.idleTimer);clearTimeout(bridge.idleTimer)
})
test('manual-field expiry cannot power down an ongoing display refresh',async()=>{
 const transport={status:'idle',onStatus:()=>()=>{}}
 const bridge=new RfBridge(transport);const events=[]
 bridge.setRfField=async on=>events.push(on)
 const release=bridge.retainField()
 await bridge.turnOnFieldManually(5)
 await new Promise(resolve=>setTimeout(resolve,20))
 assert.deepEqual(events,[true]);release();assert.ok(bridge.idleTimer);clearTimeout(bridge.idleTimer)
})
