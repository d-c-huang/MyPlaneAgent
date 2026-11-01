import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {parseTaskItems,runTaskPlan} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {workerAdmission,canRunTogether} from '../dist-electron/main/agent/core/task-concurrency.js'
import {chatCapabilityAllowed} from '../dist-electron/main/agent/core/chat-runner.js'
import {ExecutionRuntime} from '../dist-electron/main/agent/core/execution-runtime.js'
import {verifyTaskRules} from '../dist-electron/main/agent/core/task-verification.js'

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
async function until(predicate){for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}assert.fail('Expected scheduler progress did not occur')}
const read=(key,dependsOn=[])=>({key,title:'读取 '+key,acceptance:'取得 '+key,kind:'inspect',parallel:true,dependsOn})
const edit=(key,file)=>({key,title:'修改 '+key,acceptance:'文件内容符合 '+key,kind:'edit',parallel:true,dependsOn:[],fileScope:[file],verification:[{kind:'file',path:file,contains:key}]})
const cap=name=>({name,category:'agent',runtime:'python-native',source:{type:'skill',skillId:'agent-tools'},permissions:[],parameters:{type:'object'}})
function fixture(t,steps){
 const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'myplane-parallel-')))
 t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}))
 const items=parseTaskItems(JSON.stringify({steps})),plan={taskId:'parallel',workspace,graphVersion:1,items,updatedAt:''}
 const controller=new AbortController(),saved=[]
 const options={workspace,messages:[{role:'user',content:'修改项目并运行测试'}],filesEnabled:true,webEnabled:true,approvalMode:'full',connection:{endpoint:'http://localhost/unused',key:'',maxTokens:1000,contextLength:8000},model:'fixture',signal:controller.signal,approve:async()=>true,onRequest:()=>{},onUsage:()=>{},onReasoning:()=>{},onActivity:()=>{},onContent:()=>{},onOutcome:()=>{}}
 return {workspace,items,plan,options,controller,saved,execution:{taskId:plan.taskId,plan,save:value=>saved.push(value)}}
}

test('four workers span independent branches and refill a slot while another stays busy',async t=>{
 const f=fixture(t,['a','b','c','d','e','f'].map(key=>read(key))),gates=new Map(f.items.map(item=>[item.title,deferred()])),started=[]
 let active=0,peak=0
 const running=runTaskPlan(f.options,f.execution,async step=>{
  started.push(step.currentStep.title);active++;peak=Math.max(peak,active)
  await gates.get(step.currentStep.title).promise
  active--;step.onOutcome('complete')
 })
 try{
  await until(()=>started.length===4)
  assert.equal(active,4);assert.equal(f.plan.maxParallelWorkers,4)
  assert.equal(f.items[4].runtime.waitReason,'resource')
  gates.get('读取 b').resolve()
  await until(()=>started.includes('读取 e'))
  assert.equal(f.items[0].status,'running','slot refill must not wait for the slowest worker')
  assert.equal(f.items[5].attempts,0)
 }finally{for(const gate of gates.values())gate.resolve();await running}
 assert.equal(peak,4);assert.ok(f.items.every(item=>item.status==='complete'))
})

test('a newly satisfied dependency starts before unrelated work finishes',async t=>{
 const f=fixture(t,[read('slow'),read('source'),read('dependent',['source'])]),hold=deferred(),started=[]
 const running=runTaskPlan({...f.options,maxParallelWorkers:2},f.execution,async step=>{
  started.push(step.currentStep.title)
  if(step.currentStep.title==='读取 slow')await hold.promise
  step.onOutcome('complete')
 })
 try{await until(()=>started.includes('读取 dependent'));assert.equal(f.items[0].status,'running')}
 finally{hold.resolve();await running}
 assert.equal(f.items[2].status,'complete')
})

test('disjoint edits overlap, keep independent progress, and finish before project verification',async t=>{
 const f=fixture(t,[edit('a','a.txt'),edit('b','b.txt'),{key:'verify',title:'运行项目测试',acceptance:'全部测试通过',kind:'verify',dependsOn:['a','b'],verification:[{kind:'test',script:'test'}]}])
 fs.writeFileSync(path.join(f.workspace,'package.json'),JSON.stringify({scripts:{test:'node test.js'}}))
 const runtime=new ExecutionRuntime();t.after(()=>runtime.dispose())
 const gate=deferred(),contexts=[],finished=[]
 const registry={list:()=>[cap('agent.run_test')],executeFileCheck:(request,signal,check)=>runtime.execute({...cap('runtime.check_file'),source:{type:'builtin'}},request,signal,check),execute:(request,signal)=>runtime.execute(cap(request.capability),request,signal,async()=>{
  assert.deepEqual(finished.sort(),['a','b'],'project tests must wait for all writers')
  return {success:true,elapsedMs:0,output:{exitCode:0}}
 })}
 const running=runTaskPlan(f.options,f.execution,async step=>{
  const key=step.currentStep.title.slice(-1),args={path:key+'.txt',content:key}
  contexts.push(step)
  assert.equal(step.parallelWrites,true);assert.equal(step.executionContext.parallel,'scoped-write')
  assert.equal(await step.beforeMutation(cap('agent.write_file'),args),undefined)
  if(contexts.length===2)gate.resolve()
  await gate.promise
  assert.notEqual(contexts[0].editProgress,contexts[1].editProgress)
  step.editProgress.ineffective=key==='a'?3:7
  const result=await runtime.execute(cap('agent.write_file'),{capability:'agent.write_file',workspace:f.workspace,args,execution:{...step.executionContext,activityId:key}},step.signal,async()=>{
   fs.writeFileSync(path.join(f.workspace,args.path),args.content);return {success:true,elapsedMs:0,output:{status:'saved'}}
  })
  assert.equal(result.success,true,result.error)
  finished.push(key)
  step.onActivity({id:key,capability:'agent.write_file',args,status:'complete',output:JSON.stringify(result.output),fileChanges:[{path:args.path,after:key}]})
  step.onOutcome('complete')
 },(rules,item,options)=>verifyTaskRules(registry,options,rules))
 try{await until(()=>contexts.length===2)}finally{gate.resolve();await running}
 assert.ok(f.items.every(item=>item.status==='complete'))
 assert.deepEqual(f.items.slice(0,2).map(item=>item.editProgress.ineffective),[3,7])
 assert.deepEqual(f.items.slice(0,2).map(item=>item.modifiedFiles),[['a.txt'],['b.txt']])
 assert.ok(f.items.every(item=>item.verificationRuns.at(-1).passed))
})

test('overlapping file ranges serialize whole workers, including their local checks',async t=>{
 const f=fixture(t,[edit('a','shared.txt'),edit('b','shared.txt')])
 let active=0,peak=0
 await runTaskPlan(f.options,f.execution,async step=>{
  active++;peak=Math.max(peak,active)
  await new Promise(resolve=>setTimeout(resolve,5));step.onOutcome('complete')
 },async(rules,item)=>{
  await new Promise(resolve=>setTimeout(resolve,5));if(item.baseline)active--
  return rules.map(rule=>({rule,passed:true,summary:'文件检查通过',fingerprint:'passed'}))
 })
 assert.equal(peak,1);assert.ok(f.items.every(item=>item.status==='complete'))
})

test('scope admission respects ancestor intersections and symbolic aliases',t=>{
 const f=fixture(t,[{title:'模块汇总',acceptance:'汇总完成',fileScope:['src/a.txt'],children:[edit('a','src')]},edit('b','src/a.txt')])
 fs.mkdirSync(path.join(f.workspace,'src'))
 const first=workerAdmission(f.plan,f.items[0])
 assert.equal(first.mode,'exclusive','file verification outside the parent scope must not parallelize')
 f.items[0].verification=[{kind:'file',path:'src/a.txt'}]
 const narrowed=workerAdmission(f.plan,f.items[0]),second=workerAdmission(f.plan,f.items[2])
 const expected=path.join(f.workspace,'src/a.txt')
 assert.deepEqual(narrowed.paths,[process.platform==='win32'?expected.toLowerCase():expected]);assert.equal(canRunTogether(narrowed,second),false)
 fs.symlinkSync(path.join(f.workspace,'src'),path.join(f.workspace,'alias'),'dir')
 f.items[2].fileScope=['alias/a.txt'];f.items[2].verification=[{kind:'file',path:'alias/a.txt'}]
 assert.equal(canRunTogether(narrowed,workerAdmission(f.plan,f.items[2])),false)
})

test('parallel edit restrictions are enforced at execution, beyond the model tool list',async t=>{
 const f=fixture(t,[edit('a','a.txt')]),runtime=new ExecutionRuntime();t.after(()=>runtime.dispose())
 const execution={taskId:'task',mode:'write',parallel:'scoped-write',writeScopes:[['a.txt']],reservedWritePaths:[path.join(f.workspace,'a.txt')]}
 for(const [name,args] of [['agent.run_command',{command:'echo unsafe'}],['agent.run_test',{script:'test'}],['agent.write_file',{path:'b.txt',content:'wrong'}]]){
  const result=await runtime.execute(cap(name),{capability:name,args,workspace:f.workspace,execution},new AbortController().signal,async()=>assert.fail('parallel restrictions must precede tool execution'))
  assert.equal(result.failureCode,'permission')
 }
 assert.equal(chatCapabilityAllowed(cap('agent.write_file'),{filesEnabled:true,webEnabled:true,workerMode:'write',parallelWrites:true}),true)
 assert.equal(chatCapabilityAllowed(cap('agent.run_test'),{filesEnabled:true,webEnabled:true,workerMode:'write',parallelWrites:true}),false)
 assert.equal(chatCapabilityAllowed({...cap('agent.read_file'),source:{type:'mcp',serverId:'other'}},{filesEnabled:true,webEnabled:true,workerMode:'write',parallelWrites:true}),false)
})

test('a denial cancels active peers and leaves unstarted work untouched',async t=>{
 const f=fixture(t,[read('deny'),read('peer'),read('later')]),both=deferred();let started=0,peerCancelled=false
 await runTaskPlan({...f.options,maxParallelWorkers:2},f.execution,async step=>{
  if(++started===2)both.resolve()
  await both.promise
  if(step.currentStep.title==='读取 deny')step.onActivity({id:'denied',capability:'agent.read_file',args:{},status:'denied',output:'用户拒绝'})
  else{assert.equal(step.signal.aborted,true);peerCancelled=true;step.signal.throwIfAborted()}
  step.onOutcome('complete')
 })
 assert.equal(peerCancelled,true);assert.equal(f.items[2].attempts,0)
 assert.equal(f.items[1].runtime.status,'cancelled');assert.equal(f.items[2].runtime.waitReason,'approval')
})

test('user cancellation drains workers before returning and resume preserves completed work',async t=>{
 const f=fixture(t,[read('done'),read('cancelled'),read('pending')]),started=[]
 const running=runTaskPlan({...f.options,maxParallelWorkers:2},f.execution,async step=>{
  started.push(step.currentStep.title)
  if(step.currentStep.title==='读取 done'){step.onOutcome('complete');return}
  await new Promise((resolve,reject)=>step.signal.addEventListener('abort',()=>reject(step.signal.reason),{once:true}))
 })
 await until(()=>f.items[0].status==='complete'&&started.length===3)
 const rejected=assert.rejects(running,/user cancelled/)
 f.controller.abort(new Error('user cancelled'));await rejected
 assert.equal(f.items[0].status,'complete');assert.ok(f.items.slice(1).every(item=>item.runtime.status==='cancelled'))
 const resumed=[]
 await runTaskPlan({...f.options,signal:new AbortController().signal},f.execution,async step=>{resumed.push(step.currentStep.title);step.onOutcome('complete')})
 assert.deepEqual(resumed.sort(),['读取 cancelled','读取 pending'])
})

test('approval requests from already running peers are displayed one at a time',async t=>{
 const f=fixture(t,[read('a'),read('b')]),gate=deferred();let prompts=0,active=0,peak=0
 f.options.approve=async()=>{
  prompts++;active++;peak=Math.max(peak,active)
  if(prompts===1)await gate.promise
  active--;return true
 }
 const running=runTaskPlan(f.options,f.execution,async step=>{
  await step.approve({id:step.currentStep.title,capability:'agent.read_file',args:{},status:'waiting'})
  step.onOutcome('complete')
 })
 try{await until(()=>prompts===1);assert.equal(f.items.filter(item=>item.status==='running').length,2)}
 finally{gate.resolve();await running}
 assert.equal(prompts,2);assert.equal(peak,1)
})
