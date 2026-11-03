import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {NodeMonitor,validateMonitorPolicy,monitorText} from '../dist-electron/main/node-monitor.js'

const diagnosis={cause:'transient',summary:'暂时服务故障',action:'retry_node',nextStep:'沿原计划继续'}
const session=(id='session',overrides={})=>({id,title:'测试任务',messages:[],abilityTask:{id:'task',status:'blocked'},taskPlan:{taskId:'task',items:[{id:'step',title:'读取生成结果',status:'blocked',summary:'模型请求失败（HTTP 503）',attempts:1,evidenceIds:[],evidence:[{activityId:'error-1',status:'error',capability:'agent.read_file',args:{},output:'HTTP 503'}],...overrides}]}})
async function until(check){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('monitor condition timed out');await new Promise(resolve=>setTimeout(resolve,15))}}
function fixture(t,overrides={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-monitor-')),calls={analysis:0,repair:0}
 const deps={analyze:async()=>{calls.analysis++;return diagnosis},repair:async()=>{calls.repair++;return {phase:'resolved',message:'节点真实验收完成'}},moduleSnapshots:()=>[],...overrides}
 const monitor=new NodeMonitor(root,deps)
 t.after(async()=>{await monitor.dispose();fs.rmSync(root,{recursive:true,force:true})})
 return {monitor,calls,root,deps}
}
test('observations are asynchronous and repeated evidence is deduplicated',async t=>{
 const f=fixture(t),data=session()
 for(let i=0;i<20;i++)f.monitor.observeSession(data,false)
 assert.equal(f.calls.analysis,0);assert.equal(f.monitor.snapshot().issues.length,1);assert.equal(f.monitor.snapshot().issues[0].occurrences,1)
 await until(()=>f.monitor.snapshot().issues[0].phase==='resolved')
 assert.equal(f.calls.repair,1);assert.equal(f.calls.analysis,1)
 f.monitor.observeSession(data,false);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(f.calls.repair,1)
 assert.equal(data.taskPlan.items[0].status,'blocked','monitor never fabricates task completion')
})
test('foreground activity defers repair until the session settles',async t=>{
 const f=fixture(t),data=session()
 f.monitor.observeSession(data,true)
 await until(()=>f.monitor.snapshot().issues[0].phase==='waiting')
 assert.equal(f.calls.repair,0)
 f.monitor.observeSession(data,false)
 await until(()=>f.monitor.snapshot().issues[0].phase==='resolved');assert.equal(f.calls.repair,1)
})
test('node completion closes an observed failure without retrying old work',async t=>{
 const f=fixture(t),data=session()
 f.monitor.observeSession(data,true);data.taskPlan.items[0].status='complete';f.monitor.observeSession(data,false)
 await new Promise(resolve=>setTimeout(resolve,160))
 assert.equal(f.monitor.snapshot().issues[0].phase,'resolved');assert.equal(f.calls.repair,0)
})
test('changing tasks expires the old issue without claiming a successful repair',async t=>{
 const f=fixture(t),data=session()
 f.monitor.observeSession(data,true)
 data.taskPlan={taskId:'new-task',items:[]};data.abilityTask.id='new-task'
 f.monitor.observeSession(data,false)
 await new Promise(resolve=>setTimeout(resolve,160))
 const issue=f.monitor.snapshot().issues[0]
 assert.equal(issue.phase,'superseded');assert.equal(f.calls.repair,0)
 assert.throws(()=>f.monitor.command({action:'retry',id:issue.id}),/原任务已经切换/)
})
test('permission, visual waits and unknown side effects cannot be turned into retries by the model',async t=>{
 const f=fixture(t)
 for(const [id,summary,outcome] of [['permission','权限拒绝，HTTP 503','blocked'],['unknown','执行结果未知，存在未知副作用','blocked'],['visual','请用户确认视觉结果','needs_input']])f.monitor.observeSession(session(id,{summary,outcome}),false)
 await until(()=>f.monitor.snapshot().issues.every(issue=>issue.phase==='waiting'))
 assert.equal(f.calls.repair,0)
})
test('paused sessions never trigger monitor recovery',async t=>{
 const f=fixture(t),data=session();data.abilityTask.status='paused';f.monitor.observeSession(data,false)
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(f.monitor.snapshot().issues.length,0)
})
test('analysis-only policy permits a deliberate manual repair without broadening autoApply',async t=>{
 let policy
 const f=fixture(t,{repair:async(_issue,value)=>{policy=value;return {phase:'resolved',message:'已验证'}}})
 f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,autoRepair:false,autoApply:false}})
 f.monitor.observeSession(session(),false)
 await until(()=>f.monitor.snapshot().issues[0].phase==='waiting')
 assert.equal(policy,undefined)
 f.monitor.command({action:'retry',id:f.monitor.snapshot().issues[0].id})
 await until(()=>f.monitor.snapshot().issues[0].phase==='resolved');assert.equal(policy.autoApply,false)
})
test('repair failures retain finite issue and daily budgets across reloads',async t=>{
 const f=fixture(t,{repair:async()=>({phase:'failed',message:'再次失败'})})
 f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,maxAttemptsPerIssue:1}})
 f.monitor.observeSession(session(),false)
 await until(()=>f.monitor.snapshot().issues[0].phase==='failed')
 const first=f.monitor.snapshot().issues[0]
 assert.throws(()=>f.monitor.command({action:'retry',id:first.id}),/次数上限/)
 await f.monitor.dispose()
 const restored=new NodeMonitor(f.root,f.deps);t.after(()=>restored.dispose())
 assert.equal(restored.snapshot().repairsToday,1);assert.equal(restored.snapshot().issues[0].attempts,1)
 assert.throws(()=>restored.command({action:'retry',id:first.id}),/次数上限/)
})
test('enabling automatic repair resumes issues deferred only by that policy',async t=>{
 const f=fixture(t)
 f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,autoRepair:false}})
 f.monitor.observeSession(session(),false)
 await until(()=>f.monitor.snapshot().issues[0].phase==='waiting')
 assert.equal(f.calls.repair,0)
 f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,autoRepair:true}})
 await until(()=>f.monitor.snapshot().issues[0].phase==='resolved')
 assert.equal(f.calls.repair,1)
})
test('a global daily limit bounds independent changing errors',async t=>{
 const f=fixture(t);f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,maxRepairsPerDay:1}})
 f.monitor.observeSession(session('a'),false);f.monitor.observeSession(session('b'),false)
 await until(()=>f.monitor.snapshot().issues.every(issue=>['resolved','waiting'].includes(issue.phase)))
 assert.equal(f.calls.repair,1);assert.equal(f.monitor.snapshot().repairsToday,1)
})
test('monitor has only one repair in flight and cancellation never resolves a node',async t=>{
 let running=0,peak=0
 const f=fixture(t,{repair:async(_issue,_policy,signal)=>{peak=Math.max(peak,++running);try{return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}finally{running--}}})
 f.monitor.observeSession(session('a'),false);f.monitor.observeSession(session('b'),false)
 await until(()=>running===1)
 f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,enabled:false}})
 await until(()=>!f.monitor.snapshot().runningId)
 assert.equal(peak,1);assert.ok(f.monitor.snapshot().issues.every(issue=>issue.phase!=='resolved'))
})
test('a user dismissal survives a late aborted analysis result',async t=>{
 const f=fixture(t,{analyze:async(_issue,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
 f.monitor.observeSession(session(),false);await until(()=>!!f.monitor.snapshot().runningId)
 const id=f.monitor.snapshot().issues[0].id;f.monitor.command({action:'dismiss',id})
 await until(()=>!f.monitor.snapshot().runningId);assert.equal(f.monitor.snapshot().issues[0].phase,'dismissed')
})
test('module hot update requires an actual passed report and recorded switch',async t=>{
 const module={moduleId:'error-recovery',name:'恢复策略',activeId:'v1',problems:[{id:'problem',versionId:'v1',description:'验证失败'}],jobs:[],versions:[],switches:[]}
 const f=fixture(t,{moduleSnapshots:()=>[module],analyze:async()=>({cause:'module',action:'needs_user',summary:'等候',nextStep:'等待评测'})})
 f.monitor.scanModules();await until(()=>f.monitor.snapshot().issues[0].phase==='waiting')
 module.activeId='v2';module.jobs=[{id:'job',parentId:'v1',candidateId:'v2',resolution:'improved'}]
 f.monitor.scanModules();assert.equal(f.monitor.snapshot().issues[0].phase,'waiting')
 module.versions=[{id:'v2',hash:'candidate-hash',report:{passed:true,sourceHash:'other-hash'}}];module.switches=[{from:'v1',to:'v2',reason:'自动优化 job'}]
 f.monitor.scanModules();assert.equal(f.monitor.snapshot().issues[0].phase,'waiting','a stale report cannot prove activation')
 module.versions[0].report.sourceHash='candidate-hash'
 f.monitor.scanModules();assert.equal(f.monitor.snapshot().issues[0].phase,'applied');assert.equal(f.monitor.snapshot().issues[0].toVersion,'v2')
})
test('secret-like values and observation payloads are not persisted in diagnostics',async t=>{
 const f=fixture(t);f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,enabled:false}})
 const data=session('safe',{evidence:[],summary:'HTTP 503 API_KEY=super-secret-value Bearer private-token sk-privatekey'})
 f.monitor.observeSession(data,false)
 const saved=fs.readFileSync(path.join(f.root,'node-monitor.json'),'utf8')
 assert.doesNotMatch(saved,/super-secret-value|private-token|sk-privatekey/)
 assert.match(monitorText('password: private'),/已隐藏/)
 assert.doesNotMatch(monitorText('Basic abc123 refresh_token=private-value https://name:private-pass@example.test'),/abc123|private-value|private-pass/)
})
test('a module repair completed between scans remains visible without replaying it',async t=>{
 const module={moduleId:'error-recovery',name:'恢复策略',activeId:'v2',problems:[{id:'problem',versionId:'v1',description:'验证失败'}],jobs:[{id:'job',parentId:'v1',candidateId:'v2',resolution:'improved'}],versions:[{id:'v2',hash:'candidate',report:{passed:true,sourceHash:'candidate'}}],switches:[{from:'v1',to:'v2',reason:'自动优化 job'}]}
 const f=fixture(t,{moduleSnapshots:()=>[module]})
 f.monitor.scanModules()
 await new Promise(resolve=>setTimeout(resolve,160))
 assert.equal(f.monitor.snapshot().issues[0].phase,'applied');assert.equal(f.calls.repair,0);assert.equal(f.calls.analysis,0)
})
test('duplicate historical module problems cannot retrigger failed diagnosis on every scan',async t=>{
 let analyses=0
 const module={moduleId:'error-recovery',name:'恢复策略',activeId:'v1',problems:[{id:'old',versionId:'v1',description:'重复模块失败'},{id:'new',versionId:'v1',description:'重复模块失败'}],jobs:[],versions:[],switches:[]}
 const f=fixture(t,{moduleSnapshots:()=>[module],analyze:async()=>{analyses++;throw Error('诊断模型不可用')}})
 f.monitor.scanModules();await until(()=>f.monitor.snapshot().issues[0]?.phase==='failed')
 for(let i=0;i<5;i++)f.monitor.scanModules()
 await new Promise(resolve=>setTimeout(resolve,160))
 assert.equal(analyses,1);assert.equal(f.monitor.snapshot().issues[0].occurrences,1)
 module.problems.push({id:'actual-new-error',versionId:'v1',description:'重复模块失败'})
 f.monitor.scanModules();await until(()=>analyses===2)
 assert.equal(f.monitor.snapshot().issues[0].occurrences,2)
})
test('interrupted repair is restored as waiting rather than replayed on app startup',async t=>{
 const f=fixture(t);f.monitor.command({action:'policy',policy:{...f.monitor.snapshot().policy,enabled:false}});f.monitor.observeSession(session(),false)
 const file=path.join(f.root,'node-monitor.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'))
 saved.issues[0].phase='repairing';saved.policy.enabled=true;fs.writeFileSync(file,JSON.stringify(saved));await f.monitor.dispose()
 const restored=new NodeMonitor(f.root,f.deps);t.after(()=>restored.dispose())
 await new Promise(resolve=>setTimeout(resolve,160));assert.equal(restored.snapshot().issues[0].phase,'waiting');assert.equal(f.calls.repair,0)
})
test('policy validation rejects unsupported edits and unbounded budgets',()=>{
 const policy={enabled:true,autoRepair:true,autoApply:true,maxAttemptsPerIssue:2,maxRepairsPerDay:6,analysisTimeoutSeconds:90}
 assert.deepEqual(validateMonitorPolicy(policy),policy)
 for(const changed of [{enabled:'yes'},{maxAttemptsPerIssue:0},{maxRepairsPerDay:999},{analysisTimeoutSeconds:1},{allowNetwork:true}])assert.throws(()=>validateMonitorPolicy({...policy,...changed}))
})
