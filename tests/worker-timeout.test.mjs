import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {runTaskPlan,parseTaskItems} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {failureCode} from '../dist-electron/main/agent/core/execution-result.js'
import {waitReasonLabels} from '../dist-electron/shared/task-contract.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'

function fixture(t){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-worker-timeout-'))
 t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}))
 const controller=new AbortController(),plan={taskId:'task',workspace,graphVersion:1,items:parseTaskItems(JSON.stringify({steps:[{title:'读取文件',acceptance:'报告原始内容',kind:'inspect'}]})),updatedAt:''}
 const execution={taskId:'task',goal:'读取文件',plan,save:()=>{}}
 const options={workspace,messages:[{role:'user',content:'读取文件'}],filesEnabled:true,webEnabled:true,approvalMode:'full',connection:{},model:'fixture',signal:controller.signal,approve:async()=>true,onRequest(){},onUsage(){},onReasoning(){},onContent(){},onActivity(){}}
 return {options,execution,plan,controller}
}

test('productive reads have no implicit four-minute Worker deadline',async t=>{
 const f=fixture(t)
 t.mock.method(AbortSignal,'timeout',()=>assert.fail('a default Worker must not acquire an absolute deadline'))
 await runTaskPlan(f.options,f.execution,async step=>{assert.equal(step.signal.aborted,false);step.onOutcome('complete');step.onContent('读取完成')})
 assert.equal(f.plan.items[0].status,'complete')
})

test('an explicit Worker deadline persists and timeout never becomes a budget label',async t=>{
 const f=fixture(t),deadline=new AbortController(),durations=[]
 t.mock.method(AbortSignal,'timeout',ms=>{durations.push(ms);return deadline.signal})
 f.options.workerTimeoutMs=123
 await runTaskPlan(f.options,f.execution,async step=>{deadline.abort(new DOMException('The operation was aborted due to timeout','TimeoutError'));step.signal.throwIfAborted()})
 assert.deepEqual(durations,[123]);assert.equal(f.plan.workerTimeoutMs,123)
 assert.equal(f.plan.items[0].runtime.waitReason,'timeout')
 assert.match(f.plan.items[0].summary,/超时.*恢复点/)
 assert.equal(waitReasonLabels.timeout,'等待超时，可恢复')
 assert.equal(failureCode('The operation was aborted due to timeout'),'timeout')
 assert.equal(f.controller.signal.aborted,false)
})

test('explicit zero disables a saved deadline and user cancellation still stops the Worker',async t=>{
 const f=fixture(t);f.plan.workerTimeoutMs=123;f.options.workerTimeoutMs=0
 t.mock.method(AbortSignal,'timeout',()=>assert.fail('deadline disabled'))
 await assert.rejects(runTaskPlan(f.options,f.execution,async step=>{f.controller.abort(new Error('user stopped'));step.signal.throwIfAborted()}),/user stopped/)
 assert.equal(f.plan.workerTimeoutMs,0);assert.equal(f.plan.items[0].runtime.status,'cancelled')
})

test('re-delivering a committed activity does not spend the saved tool budget twice',async t=>{
 const f=fixture(t),item=f.plan.items[0]
 item.worker={id:'worker',mode:'read',assignedAt:'before',toolCalls:1};item.evidenceIds=['saved'];item.evidence=[{activityId:'saved',capability:'agent.read_file',status:'complete',args:{path:'a'},output:'value',truncated:false}]
 await runTaskPlan(f.options,f.execution,async step=>{step.onActivity({id:'saved',capability:'agent.read_file',args:{path:'a'},status:'complete',output:'value'});step.onOutcome('complete')})
 assert.equal(item.worker.toolCalls,1);assert.equal(item.evidence.filter(row=>row.activityId==='saved').length,1)
})

test('workflow compatibility entry does not turn an absent round budget into a fixed twenty-round cap',async t=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-worker-compat-')),service=new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})})
 t.after(async()=>{await service.dispose();fs.rmSync(workspace,{recursive:true,force:true})})
 const limits=[]
 service.runConversation=async options=>{limits.push(options.maxRounds);options.onOutcome('complete')}
 const task={id:'compat',description:'读取文件',context:{workspace,userIntent:'读取文件'},createdAt:Date.now()}
 await service.runPlannedTask(task)
 await service.runPlannedTask(task,{maxSteps:5})
 assert.deepEqual(limits,[undefined,5])
})
