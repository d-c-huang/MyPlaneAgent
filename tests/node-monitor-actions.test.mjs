import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {analyzeMonitorIssue,hostMonitorDiagnosis,repairMonitorModule} from '../dist-electron/main/node-monitor-actions.js'
import {AbilityModuleManager} from '../dist-electron/main/ability-modules/manager.js'
import {baselineCode} from '../dist-electron/main/ability-modules/baseline.js'

const connection={endpoint:'http://127.0.0.1:1234/v1',key:'fixture-key',contextLength:8192,maxTokens:2048}
const signal=()=>new AbortController().signal
const issue=values=>({id:'issue',fingerprint:'fp',source:'node',sessionId:'session',taskId:'task',nodeId:'step',title:'核对输出',error:'本次内容校验失败',phase:'queued',retryable:true,occurrences:1,attempts:0,createdAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z',message:'',events:[],...values})
const diagnosis={cause:'verification',summary:'需要核对当前文件内容',action:'retry_node',nextStep:'读取文件并验证原始验收条件'}
const answer=data=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]})
test('host permissions, cancellation, configuration and budgets never request a model or authorize retry',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('host restriction must not reach a model'))
 for(const error of ['用户取消当前节点','PermissionError: 拒绝访问','需要用户确认','插件未启用','HTTP 401','已达到工具调用上限','子任务写入超出已分配文件范围']){
  const result=await analyzeMonitorIssue(issue({error}),connection,'fixture',signal())
  assert.equal(result.action,'needs_user',error)
 }
})
test('known transient failures require a host-authorized exact node before retry',()=>{
 assert.equal(hostMonitorDiagnosis(issue({error:'HTTP 503: busy'})).action,'retry_node')
 for(const extra of [{retryable:false},{source:'session'},{nodeId:undefined},{taskId:undefined},{sessionId:undefined}])assert.equal(hostMonitorDiagnosis(issue({error:'ECONNRESET',...extra})).action,'needs_user')
})
test('model diagnosis uses only redacted minimal evidence and cannot enable a forbidden action',async t=>{
 const bodies=[]
 t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(JSON.parse(init.body));return answer(diagnosis)})
 const result=await analyzeMonitorIssue(issue({retryable:false,error:'源码校验错误，Authorization: Bearer hidden-token api_key=hidden-secret'}),connection,'fixture',signal())
 assert.equal(result.action,'needs_user')
 assert.equal(bodies[0].tools,undefined)
 assert.equal(bodies[0].max_tokens,1200)
 assert.doesNotMatch(JSON.stringify(bodies[0].messages),/hidden-token|hidden-secret/)
 assert.match(bodies[0].messages[0].content,/不可信资料/)
})
test('model output is schema checked and cannot invent a managed module',async t=>{
 t.mock.method(globalThis,'fetch',async()=>answer({cause:'module',summary:'模块报错',action:'optimize_module',nextStep:'修复对应模块'}))
 assert.equal((await analyzeMonitorIssue(issue({moduleId:'completion-review'}),connection,'fixture',signal())).action,'needs_user')
 assert.equal((await analyzeMonitorIssue(issue({source:'module',moduleId:'made-up'}),connection,'fixture',signal())).action,'needs_user')
 assert.equal((await analyzeMonitorIssue(issue({source:'module',moduleId:'completion-review'}),connection,'fixture',signal())).action,'optimize_module')
 t.mock.method(globalThis,'fetch',async()=>answer({...diagnosis,code:'execute anything'}))
 await assert.rejects(analyzeMonitorIssue(issue({}),connection,'fixture',signal()),/格式无效/)
})
const fixedCode=baselineCode.replace('function process(input)','function original(input)')+`
function process(input) {
 const result = original(input);
 if (/^接着完成(?:剩余|未完)部分[。！!]?$/u.test(input.messages.at(-1)?.text || '')) result.intent = 'continue';
 return result;
}`
function fixture(t,generate=async()=>JSON.stringify({cause:'module',diagnosis:'连续任务表述应保持原目标',code:fixedCode})){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-monitor-module-'))
 const manager=new AbilityModuleManager(root,generate)
 manager.setPolicy({...manager.snapshot().policy,autoOptimize:true,autoPromote:true,failureThreshold:10})
 t.after(()=>{manager.dispose();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})})
 const problem=()=>manager.reportProblem('继续表达漏识别',['创建小游戏','接着完成剩余部分'],'continue')
 const moduleIssue=()=>issue({source:'module',moduleId:'conversation-state',versionId:manager.activeVersionId(),error:'本次意图输出未满足独立期望'})
 return {manager,problem,moduleIssue}
}
test('monitor can publish only a genuinely improved tested candidate with switch evidence',async t=>{
 const f=fixture(t),phases=[];f.problem()
 const result=await repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:true,signal:signal(),onPhase:(phase,message)=>phases.push([phase,message])})
 assert.equal(result.phase,'applied',JSON.stringify(result))
 assert.equal(f.manager.activeVersionId(),result.toVersion)
 assert.notEqual(result.fromVersion,result.toVersion)
 assert.ok(f.manager.reports(result.toVersion).at(-1).passed)
 assert.ok(f.manager.snapshot().switches.some(row=>row.reason.includes(result.jobId)))
 assert.ok(phases.some(([phase])=>phase==='verifying'))
})
test('autoApply false produces a tested candidate without changing saved publication policy or active code',async t=>{
 const f=fixture(t);f.problem();const before=f.manager.activeVersionId()
 const result=await repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:false,signal:signal()})
 assert.equal(result.phase,'waiting',JSON.stringify(result));assert.equal(f.manager.activeVersionId(),before)
 assert.equal(f.manager.snapshot().policy.autoPromote,true)
 assert.ok(result.toVersion);assert.ok(f.manager.reports(result.toVersion).at(-1).passed)
 assert.equal(f.manager.snapshot().switches.length,0)
})
test('module policy, stale versions and missing reproducible cases cannot be bypassed',async t=>{
 const f=fixture(t)
 assert.equal((await repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:true,signal:signal()})).phase,'waiting')
 f.problem();f.manager.setPolicy({...f.manager.snapshot().policy,autoOptimize:false})
 assert.equal((await repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:true,signal:signal()})).phase,'waiting')
 f.manager.setPolicy({...f.manager.snapshot().policy,autoOptimize:true})
 assert.equal((await repairMonitorModule({...f.moduleIssue(),versionId:'old-version'},f.manager,{autoApply:true,signal:signal()})).phase,'waiting')
 assert.equal(f.manager.snapshot().jobs.length,0)
})
test('aborting a monitor-owned optimization stops generation without publishing or leaving a pending adapter',async t=>{
 let started
 const begun=new Promise(resolve=>started=resolve)
 const f=fixture(t,async(_prompt,_policy,abortSignal)=>{started();return new Promise((_resolve,reject)=>abortSignal.addEventListener('abort',()=>reject(abortSignal.reason),{once:true}))})
 f.problem();const controller=new AbortController()
 const pending=repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:true,signal:controller.signal})
 await begun;controller.abort(new Error('monitor paused'))
 await assert.rejects(pending,/monitor paused/)
 for(let i=0;i<100&&f.manager.snapshot().jobs.some(j=>['queued','analyzing','testing'].includes(j.phase));i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(f.manager.snapshot().jobs[0].phase,'cancelled');assert.equal(f.manager.snapshot().switches.length,0)
})
test('an independent in-flight optimization is not duplicated or cancelled by a monitor observer',async t=>{
 let release
 const f=fixture(t,async()=>new Promise(resolve=>release=()=>resolve(JSON.stringify({cause:'information',diagnosis:'缺少独立期望'}))))
 f.problem();const existing=f.manager.optimize(true)
 const blocked=await repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:false,signal:signal()})
 assert.equal(blocked.phase,'waiting');assert.equal(blocked.jobId,existing.id)
 const controller=new AbortController(),pending=repairMonitorModule(f.moduleIssue(),f.manager,{autoApply:true,signal:controller.signal})
 controller.abort(new Error('observer stopped'));await assert.rejects(pending,/observer stopped/)
 assert.equal(f.manager.snapshot().jobs.length,1);assert.equal(f.manager.snapshot().jobs[0].phase,'analyzing')
 release()
 for(let i=0;i<100&&f.manager.snapshot().jobs[0].phase!=='complete';i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(f.manager.snapshot().jobs[0].phase,'complete')
})
