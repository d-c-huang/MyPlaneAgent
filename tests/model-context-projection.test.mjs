import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {projectModelHistory,toolResultContextBudget} from '../dist-electron/main/model-context-projection.js'
import {contextMessages,contextStatus,estimateTokens,pinnedContext} from '../dist-electron/main/local-ai-context.js'
import {contextHistoryHash} from '../dist-electron/main/context-checkpoint.js'
import {capabilityAlias} from '../dist-electron/main/agent/core/tool-surface.js'
import {RuntimeStore} from '../dist-electron/main/agent/core/runtime-store.js'
import {WorkerContextSession} from '../dist-electron/main/agent/core/worker-context.js'
import {historyPage} from '../dist-electron/main/agent/core/worker-history.js'

const originalOutput='HEAD=keep-exact\n'+'large source '.repeat(1800)+'MIDDLE-ORIGINAL-ONLY\n'+'more data '.repeat(1800)+'\nTAIL=failed-exit-1'
const reply=(output=originalOutput,capability='agent.read_file',extra={})=>({id:'source-message',role:'tool',tool_call_id:'call',content:JSON.stringify({activityId:'operation',status:'complete',capability,output,...extra})})
const calls=(name='cap_2_agent_read_file')=>({role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name,arguments:'{"path":"large.txt"}'}}]})

test('large model input is bounded while original messages, hashes, identities and head/tail values stay intact',()=>{
 const history=[{role:'user',content:'保留原文，不部署。'},calls(),reply()],before=structuredClone(history),hash=contextHistoryHash(history,history.length)
 const view=contextMessages(history,[],undefined,undefined,8192),projected=JSON.parse(view.at(-1).content)
 assert.ok(estimateTokens(view.at(-1).content)<=toolResultContextBudget(8192))
 assert.equal(projected.activityId,'operation');assert.equal(projected.status,'complete');assert.equal(projected.capability,'agent.read_file')
 assert.equal(projected.projection.originalCharacters,originalOutput.length);assert.equal(projected.projection.readWith,'runtime.read_evidence')
 assert.match(projected.output,/HEAD=keep-exact/);assert.match(projected.output,/TAIL=failed-exit-1/)
 assert.doesNotMatch(projected.output,/MIDDLE-ORIGINAL-ONLY/);assert.match(projected.output,/不能作为验收依据/)
 assert.equal(view[1].tool_calls[0].function.name,capabilityAlias('agent.read_file'));assert.equal(view.at(-1).tool_call_id,'call')
 assert.deepEqual(history,before);assert.equal(contextHistoryHash(history,history.length),hash)
 assert.equal('id' in view.at(-1),false)
})

test('wire budgets include JSON escaping, Unicode and status metadata at multiple capacities',()=>{
 for(const capacity of [2048,4096,8192,65536]){
  const message=reply()
  // The capability itself is plain host metadata; unusual content is only output data.
  message.content=JSON.stringify({activityId:'unicode',capability:'agent.read_file',status:'error',notApplied:true,output:'头部😀"\n'.repeat(3000)+'尾部😀'})
  const projected=projectModelHistory([message],capacity)[0],row=JSON.parse(projected.content)
  assert.ok(estimateTokens(projected.content)<=toolResultContextBudget(capacity))
  assert.equal(row.status,'error');assert.equal(row.notApplied,true)
  assert.doesNotMatch(projected.content,/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][cdefCDEF])/)
 }
})

test('readback pages, unstructured legacy output and short results are preserved losslessly',()=>{
 for(const message of [reply(originalOutput,'runtime.read_history'),reply(originalOutput,'runtime.read_evidence'),reply('short'),{role:'tool',tool_call_id:'legacy',content:originalOutput}]){
  assert.equal(projectModelHistory([message],8192)[0],message)
 }
})

test('projection is idempotent and cache invalidation follows source edits and capacity changes',()=>{
 const message=reply(),first=projectModelHistory([message],8192)[0]
 assert.deepEqual(projectModelHistory([first],8192),[first])
 const smaller=projectModelHistory([message],2048)[0]
 assert.ok(smaller.content.length<first.content.length)
 message.content=message.content.replace('HEAD=keep-exact','HEAD=changed')
 assert.match(JSON.parse(projectModelHistory([message],8192)[0].content).output,/HEAD=changed/)
})

test('reused call IDs bind to their own paired host capability; pending and legacy calls are not guessed',()=>{
 const messages=[calls(),reply('one'),calls('cap_5_agent_web_fetch'),reply('two','agent.web_fetch'),calls('cap_6_pending')]
 const projected=projectModelHistory(messages,8192)
 assert.equal(projected[0].tool_calls[0].function.name,capabilityAlias('agent.read_file'))
 assert.equal(projected[2].tool_calls[0].function.name,capabilityAlias('agent.web_fetch'))
 assert.equal(projected[4].tool_calls[0].function.name,'cap_6_pending')
 assert.equal(projectModelHistory([calls('read_file'),reply('legacy')],8192)[0].tool_calls[0].function.name,'read_file')
})

test('mandatory host state is present even when projection removes the need for a checkpoint',()=>{
 const history=[{role:'user',content:'保留 customer_id'},calls(),reply()],pinned=pinnedContext(history,{permissions:{approvalMode:'ask',webEnabled:false},acceptance:['实际检查通过'],unresolvedEffects:[{id:'unknown',status:'unknown'}]})
 const view=contextMessages(history,[],undefined,pinned,8192),text=view.map(row=>row.content).join('\n')
 assert.match(text,/customer_id/);assert.match(text,/"approvalMode":"ask"/);assert.match(text,/实际检查通过/);assert.match(text,/"status":"unknown"/)
 assert.equal(contextStatus(history,[],undefined,{contextLength:8192,maxTokens:1024,pinned}).inputTokens,estimateTokens(view)+32)
})

test('SQLite restart and history search retain the original middle that model projection omits',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-projection-restart-')),scope={taskId:'task',workerId:'worker',workspace:directory}
 let store=new RuntimeStore(path.join(directory,'runtime'))
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})})
 const history=[{role:'user',content:'按原文核验'},calls(),reply()],state=pinnedContext(history,{taskId:'task',workerId:'worker'})
 const session=new WorkerContextSession(store,scope,{goal:'verify'},history,state),hash=contextHistoryHash(history,history.length)
 projectModelHistory(session.history,8192);session.finish(session.history,undefined,false)
 store.close();store=new RuntimeStore(path.join(directory,'runtime'))
 const restored=store.loadWorker(scope)
 assert.equal(contextHistoryHash(restored.history,restored.history.length),hash)
 assert.equal(JSON.parse(restored.history.at(-1).content).output,originalOutput)
 let page=historyPage(restored.history,{query:'MIDDLE-ORIGINAL-ONLY',limit:24000}),full=page.text
 while(page.nextOffset!==undefined){page=historyPage(restored.history,{query:'MIDDLE-ORIGINAL-ONLY',limit:24000,offset:page.nextOffset,through:page.through,snapshot:page.snapshot});full+=page.text}
 assert.match(full,/MIDDLE-ORIGINAL-ONLY/)
 assert.doesNotMatch(projectModelHistory(restored.history,8192).at(-1).content,/MIDDLE-ORIGINAL-ONLY/)
})
