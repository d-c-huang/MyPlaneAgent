import test from 'node:test'
import assert from 'node:assert/strict'
import {requestAgentModel} from '../dist-electron/main/agent/model.js'
import {modelRetryAfter,transientModelError,ModelRequestError} from '../dist-electron/main/agent/model-retry.js'

const connection={endpoint:'http://localhost:1234/v1',key:'',contextLength:8192,maxTokens:512}
const messages=[{role:'user',content:'只读取已创建文件并汇报结果'}]
const answer=()=>Response.json({choices:[{message:{content:'已完成'},finish_reason:'stop'}]})
const request=(options={},signal=new AbortController().signal,api=connection)=>requestAgentModel(api,'fixture-model',messages,signal,options)

test('temporary HTTP failure resumes the identical request without replaying any tool',async t=>{
 const bodies=[],notices=[]
 t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(init.body);return bodies.length===1?Response.json({error:{message:'busy'}},{status:503}):answer()})
 const result=await request({onRetry:n=>notices.push(n)})
 assert.equal(result.content,'已完成');assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(notices[0].attempt,2)
})
test('rate limiting has a finite three-attempt budget',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:429})})
 await assert.rejects(request(),error=>error instanceof ModelRequestError&&error.status===429)
 assert.equal(calls,3)
})
test('credentials, missing models, invalid input and long Retry-After do not retry',async t=>{
 for(const status of [400,401,403,404,429]){
  let calls=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{message:'unavailable'}},{status,headers:{'Retry-After':'120'}})})
  await assert.rejects(request());assert.equal(calls,1)
 }
})
test('a user cancellation interrupts retry backoff immediately',async t=>{
 const controller=new AbortController();let calls=0
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:503})})
 await assert.rejects(request({onRetry:()=>controller.abort(new Error('user cancelled'))},controller.signal),/user cancelled/)
 assert.equal(calls,1)
})
test('connection reset before generation may retry',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async()=>{if(++calls===1)throw new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})});return answer()})
 assert.equal((await request()).content,'已完成');assert.equal(calls,2)
})
test('network interruption after streamed text, reasoning or tool fragments never replays output',async t=>{
 for(const delta of [{content:'partial'},{reasoning_content:'thinking'},{tool_calls:[{index:0,id:'call',type:'function',function:{name:'write_file',arguments:'{"path":'}}]}]){
  let calls=0,read=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(new ReadableStream({pull(controller){if(read++===0)controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta,finish_reason:null}]})}\n\n`));else controller.error(Object.assign(new Error('reset'),{code:'ECONNRESET'}))}}),{headers:{'content-type':'text/event-stream'}})})
  await assert.rejects(request(),/reset/);assert.equal(calls,1)
 }
})
test('Anthropic requests use the same bounded transport recovery',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('overloaded',{status:529}):Response.json({content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}))
 assert.equal((await request({},new AbortController().signal,{...connection,apiFormat:'anthropic'})).content,'ok');assert.equal(calls,2)
})
test('Retry-After dates and transport cause chains are classified precisely',()=>{
 assert.equal(modelRetryAfter('2'),2000);assert.equal(modelRetryAfter('Tue, 03 Nov 2026 00:00:02 GMT',Date.parse('2026-11-03T00:00:00Z')),2000)
 assert.equal(modelRetryAfter('invalid'),undefined)
 assert.equal(transientModelError(new Error('auth failed')),false)
 assert.equal(transientModelError(new Error('timeout',{cause:{code:'UND_ERR_HEADERS_TIMEOUT'}})),true)
})
