import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {toolLedgerSummary} from '../dist-electron/main/context-tool-ledger.js'
import {compactContext,contextMessages,contextStatus,contextOccupancy,pinnedContext,createContextCheckpoint} from '../dist-electron/main/local-ai-context.js'
import {validateCheckpoint,contextHistoryHash} from '../dist-electron/main/context-checkpoint.js'
import {RuntimeStore} from '../dist-electron/main/agent/core/runtime-store.js'
import {WorkerContextSession} from '../dist-electron/main/agent/core/worker-context.js'

const pair=(id='one',capability='agent.read_file',status='complete')=>[
 {role:'assistant',content:'这是读取计划，不能当作完成事实。',tool_calls:[{id,type:'function',function:{name:'cap_old_read',arguments:'{"path":"batch-01.txt"}'}}]},
 {role:'tool',tool_call_id:id,content:JSON.stringify({activityId:id,capability,status,output:'HEAD actual code B1-exact\n'+'raw material '.repeat(1200)+'\nTAIL actual code B1-exact'})},
]
test('a ledger counts actual returned calls without converting goals or assistant plans into completed operations',()=>{
 const history=[{role:'user',content:'读取全部8批，尚有7批未读'},...pair(),{role:'assistant',content:'下一步计划读取其余批次。'}],before=structuredClone(history)
 const summary=toolLedgerSummary(history,history.length),ledger=JSON.parse(summary)
 assert.equal(ledger.operations,1);assert.deepEqual(ledger.returnedStatuses,{complete:1,error:0,denied:0})
 assert.match(ledger.assistantNotes.text[0],/计划/);assert.doesNotMatch(summary,/8批已读|B[2-8]-/)
 assert.deepEqual(history,before)
 const denied=pair('two','agent.write_file','denied')
 assert.deepEqual(JSON.parse(toolLedgerSummary([...history,...denied],history.length+2)).returnedStatuses,{complete:1,error:0,denied:1})
})
test('unpaired, legacy, readback, multimodal and substantive narrative history retain the model summary path',()=>{
 const valid=pair()
 for(const history of [[valid[0]],[valid[1]],[...valid,{role:'assistant',content:'分析细节'.repeat(1000)}],pair('read','runtime.read_history'),pair('read','runtime.read_evidence'),[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aA=='}}]},...valid],
  [valid[0],{...valid[1],content:'legacy plain output'}]])assert.equal(toolLedgerSummary(history,history.length),undefined)
})
test('restored calls that never ran cannot turn an eight-call plan into eight completed operations',()=>{
 const calls=Array.from({length:8},(_,i)=>({id:'call-'+i,type:'function',function:{name:'cap_read',arguments:JSON.stringify({path:'batch-'+(i+1)})}}))
 const history=[{role:'user',content:'读取8批'}, {role:'assistant',content:'计划读取全部8批',tool_calls:calls},...calls.map((call,i)=>({role:'tool',tool_call_id:call.id,content:JSON.stringify(i<4?{activityId:'actual-'+i,status:'complete',capability:'agent.read_file',output:'source '+i}:{status:'error',outcome:'not-applied',output:'上次在执行前中断，未自动重放'})}))]
 const ledger=JSON.parse(toolLedgerSummary(history,history.length))
 assert.equal(ledger.operations,4);assert.equal(ledger.returnedStatuses.complete,4);assert.equal(ledger.notApplied,4)
})
test('automatic projected-tool compaction produces a durable source-backed checkpoint without asking a model',async t=>{
 const history=[{role:'user',content:'读取8批，逐字保留凭据，不部署。'},...pair()],pinned=pinnedContext(history,{taskId:'task',workerId:'worker'}),budget={contextLength:8192,maxTokens:1024,pinned}
 const system=[{role:'system',content:''}]
 while(contextOccupancy(contextStatus(history,system,undefined,budget))<5000)system[0].content+='固定说明 '.repeat(10)
 // The fixed content is deliberately large; keep enough genuinely removable tool-call narrative to fit the ledger.
 history.splice(1,0,...Array.from({length:5},(_,i)=>pair('source-'+i)).flat())
 assert.ok(contextOccupancy(contextStatus(history,system,undefined,budget))>budget.contextLength)
 const hash=contextHistoryHash(history,history.length)
 const previous=createContextCheckpoint(history,1,'batch-09 已读取，虚构凭据 B9-fabricated。',undefined,pinned)
 let calls=0
 const checkpoint=await compactContext({history,system,checkpoint:previous,budget,signal:new AbortController().signal,summarize:async()=>{calls++;return '不应请求模型'}})
 assert.equal(checkpoint.source,'ledger');assert.equal(calls,0);assert.equal(checkpoint.compaction.requests,0)
 assert.equal(checkpoint.compaction.outcome,'compressed');assert.equal(validateCheckpoint(history,checkpoint,pinned),checkpoint)
 assert.equal(contextHistoryHash(history,history.length),hash)
 assert.match(contextMessages(history,system,checkpoint,pinned,8192).map(row=>row.content).join('\n'),/B1-exact/)
 assert.doesNotMatch(checkpoint.summary,/B9-fabricated|batch-09/,'a source-backed ledger must not carry forward fabricated model claims')
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-ledger-')),scope={taskId:'task',workerId:'worker',workspace:directory}
 let store=new RuntimeStore(directory)
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})})
 const session=new WorkerContextSession(store,scope,{goal:'audit'},history,pinned);session.finish(history,checkpoint,false)
 store.close();store=new RuntimeStore(directory)
 assert.deepEqual(store.loadWorker(scope).checkpoint,checkpoint)
 assert.equal(store.loadWorker(scope).history.length,history.length)
})
test('unknown checkpoint sources still fail validation',()=>{
 const history=[{role:'user',content:'检查'}],checkpoint=createContextCheckpoint(history,1,'资料')
 assert.throws(()=>validateCheckpoint(history,{...checkpoint,source:'invented'}),/不匹配/)
})
