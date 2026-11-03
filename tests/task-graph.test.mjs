import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {parseTaskItems,runTaskPlan} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {validateTaskGraph,readyTaskItems,readWorkerBatch} from '../dist-electron/main/agent/core/task-graph.js'
import {recordTaskEvidence,taskResultContext} from '../dist-electron/main/agent/core/task-worker-context.js'
import {chatCapabilityAllowed} from '../dist-electron/main/agent/core/chat-runner.js'

function fixture(items){
 const plan={taskId:'graph',workspace:'/tmp/myplane-task-graph',graphVersion:1,items,updatedAt:''}
 const events=[]
 const options={workspace:plan.workspace,messages:[{role:'user',content:'分析并修改项目'}],filesEnabled:true,webEnabled:true,approvalMode:'full',connection:{endpoint:'http://localhost/unused',key:'',maxTokens:1000,contextLength:8000},model:'fixture',signal:new AbortController().signal,approve:async()=>true,onRequest:()=>{},onUsage:()=>{},onReasoning:()=>{},onActivity:()=>{},onContent:text=>events.push(text),onOutcome:value=>events.push(value)}
 return {plan,options,events,execution:{taskId:plan.taskId,goal:'分析并修改项目',plan,save:()=>{}}}
}

test('task graph validates references, cycles and parallel write requests',()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{key:'a',title:'读取接口',acceptance:'列出接口',mode:'read'},{key:'b',title:'修改接口',acceptance:'源码更新',mode:'write',dependsOn:['a']}]}))
 assert.deepEqual(items[1].dependsOn,[items[0].id])
 assert.deepEqual(readyTaskItems({graphVersion:1,items}),[items[0]])
 items[0].status='complete'
 assert.deepEqual(readyTaskItems({graphVersion:1,items}),[items[1]])
 assert.throws(()=>parseTaskItems(JSON.stringify({steps:[{key:'a',title:'步骤 A',acceptance:'完成 A',dependsOn:['b']},{key:'b',title:'步骤 B',acceptance:'完成 B',dependsOn:['a']}]})),/循环/)
 assert.throws(()=>parseTaskItems(JSON.stringify({steps:[{key:'a',title:'步骤 A',acceptance:'完成 A',dependsOn:['missing']}]})),/未知 key/)
 assert.throws(()=>parseTaskItems(JSON.stringify({steps:[{title:'父项',acceptance:'完成',children:[{title:'写代码',acceptance:'完成',mode:'write',parallel:true}]}]})),/文件范围/)
})

test('empty children preserve the leaf worker mode and inherited prerequisites cannot deadlock',()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'修改模块',acceptance:'模块已更新',mode:'write',children:[]}]}))
 assert.equal(items[0].mode,'write')
 assert.throws(()=>parseTaskItems(JSON.stringify({steps:[
  {key:'parent',title:'汇总资料',acceptance:'汇总完成',dependsOn:['other'],children:[{key:'child',title:'读取资料',acceptance:'读取完成'}]},
  {key:'other',title:'另一分支',acceptance:'完成',dependsOn:['child']}
 ]})),/循环/)
 assert.throws(()=>validateTaskGraph([{...items[0],parentId:'missing'}]),/父子/)
 for(const file of ['../secret','src/../../secret','C:\\secret','src\\..\\secret'])assert.throws(()=>parseTaskItems(JSON.stringify({steps:[{title:'修改模块',acceptance:'完成',fileScope:[file]}]})),/相对路径/)
})

test('a failed branch leaves dependents pending while independent branches finish and survive resume',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[
  {key:'a',title:'读取 A',acceptance:'取得 A'},
  {key:'b',title:'读取 B',acceptance:'取得 B',dependsOn:[]},
  {title:'整合 A',acceptance:'结果完整',dependsOn:['a']}
 ]}))
 const f=fixture(items),ran=[]
 await runTaskPlan(f.options,f.execution,async step=>{
  ran.push(step.currentStep.title)
  step.onOutcome(step.currentStep.title==='读取 A'?'blocked':'complete')
  step.onContent(step.currentStep.title==='读取 A'?'来源暂不可用':'B 已读取')
 })
 assert.deepEqual(ran,['读取 A','读取 B'])
 assert.deepEqual(items.map(item=>item.status),['blocked','complete','pending'])
 await runTaskPlan(f.options,f.execution,async step=>{ran.push(step.currentStep.title);step.onOutcome('complete')})
 assert.deepEqual(ran,['读取 A','读取 B','读取 A','整合 A'])
 assert.equal(items.every(item=>item.status==='complete'),true)
})

test('explicit denial stops even independent branches',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'读取 A',acceptance:'取得 A'},{title:'读取 B',acceptance:'取得 B',dependsOn:[]}]}))
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async step=>{step.onActivity({id:'denied',capability:'agent.read_file',args:{},status:'denied'});step.onOutcome('complete')})
 assert.equal(items[0].status,'blocked')
 assert.equal(items[1].attempts,0)
})

test('prerequisite evidence reaches dependent workers without unrelated branch claims',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[
  {key:'a',title:'读取接口',acceptance:'取得接口'},
  {key:'b',title:'读取其他资料',acceptance:'取得资料',dependsOn:[]},
  {title:'汇总接口',acceptance:'接口结论完整',dependsOn:['a']}
 ]}))
 items[0].status='complete';items[0].summary='接口有两个参数';items[0].evidenceIds=['read-api']
 recordTaskEvidence(items[0],{id:'read-api',capability:'agent.read_file',args:{path:'src/api.ts'},status:'complete',output:'export function query(city, date) {}'})
 items[1].status='complete';items[1].summary='无关分支的推断';items[1].modifiedFiles=['src/unrelated.ts']
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.match(step.stateContext,/read-api/)
  assert.match(step.stateContext,/query\(city, date\)/)
  assert.doesNotMatch(step.stateContext,/无关分支|unrelated/)
  assert.equal(step.currentStep.implementationChanged,false)
  step.onActivity({id:'verify-api',capability:'agent.read_file',args:{path:'src/api.ts'},status:'complete',output:'current API'})
  step.onOutcome('complete')
 })
 assert.equal(items[2].evidence[0].activityId,'verify-api')
 assert.equal(JSON.parse(JSON.stringify(f.plan)).items[2].evidence[0].output,'current API')
})

test('worker handoff bounds output and explicitly marks omitted evidence',()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'读取',acceptance:'取得资料'}]})),item=items[0]
 for(let n=0;n<30;n++){item.evidenceIds.push('read-'+n);recordTaskEvidence(item,{id:'read-'+n,capability:'agent.read_file',args:{path:'large.txt',content:'not a handoff argument'},status:'complete',output:'x'.repeat(10000)})}
 assert.equal(item.evidence.length,24)
 assert.equal(item.evidence[0].truncated,true)
 assert.equal(item.evidence[0].args.content,undefined)
 const handoff=taskResultContext(items)
 assert.equal(handoff.results[0].omittedEvidence,26)
 assert.ok(JSON.stringify(handoff).length<17000)
})

test('independent read subagents run concurrently, then the parent verifies',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{key:'parent',title:'汇总项目资料',acceptance:'两个来源均已读取',children:[
  {key:'one',title:'读取模块 A',acceptance:'取得模块 A 内容',mode:'read',parallel:true},
  {key:'two',title:'读取模块 B',acceptance:'取得模块 B 内容',mode:'read',parallel:true}
 ]}]}))
 const f=fixture(items),started=[],finished=[]
 f.options.messages.push({role:'assistant',content:'旧模型猜测，不能当作子任务证据'})
 let release
 const barrier=new Promise(resolve=>{release=resolve})
 await runTaskPlan(f.options,f.execution,async step=>{
  const title=step.currentStep.title
  assert.equal(step.messages.some(message=>message.role==='assistant'),false)
  if(title.startsWith('读取')){
   assert.equal(step.workerMode,'read')
   assert.equal(step.parallelReadOnly,true)
   started.push(title)
   if(started.length===2)release()
   await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(new Error('read workers did not overlap')),1000))])
  }else assert.deepEqual(finished.sort(),['读取模块 A','读取模块 B'])
  finished.push(title);step.onOutcome('complete')
 })
 assert.deepEqual(started.sort(),['读取模块 A','读取模块 B'])
 assert.equal(items.at(-1).status,'complete')
 assert.equal(items.filter(item=>item.parentId).every(item=>item.worker?.mode==='read'),true)
 assert.equal(readWorkerBatch(readyTaskItems(f.plan)).length,0)
})

test('approval mode serializes read workers so prompts cannot overlap',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'汇总',acceptance:'完成',children:[{title:'读取 A',acceptance:'完成 A',mode:'read',parallel:true},{title:'读取 B',acceptance:'完成 B',mode:'read',parallel:true}]}]}))
 const f=fixture(items);f.options.approvalMode='ask'
 let active=0,maxActive=0
 await runTaskPlan(f.options,f.execution,async step=>{
  active++;maxActive=Math.max(maxActive,active)
  await new Promise(resolve=>setTimeout(resolve,5))
  active--;step.onOutcome('complete')
 })
 assert.equal(maxActive,1)
})

test('read worker cannot receive editing or command capabilities',()=>{
 const capability=name=>({name,source:{type:'skill',skillId:'agent-tools'},tags:[]})
 const options={filesEnabled:true,webEnabled:true,workerMode:'read'}
 assert.equal(chatCapabilityAllowed(capability('agent.read_file'),options),true)
 assert.equal(chatCapabilityAllowed(capability('agent.write_file'),options),false)
 assert.equal(chatCapabilityAllowed(capability('agent.run_command'),options),false)
 assert.equal(chatCapabilityAllowed(capability('agent.web_search'),{...options,parallelReadOnly:true}),false)
 assert.equal(chatCapabilityAllowed(capability('agent.read_file'),{...options,parallelReadOnly:true}),true)
})

test('a write subagent cannot change files outside its assigned scope',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{key:'edit',title:'修改模块 A',acceptance:'模块 A 更新',mode:'write',fileScope:['src/a.js']}]}))
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.equal(step.workerMode,'write')
  assert.match(await step.beforeMutation({name:'agent.write_file'},{path:'src/b.js'}),/超出已分配文件范围/)
  step.onOutcome('blocked')
 })
 assert.equal(items[0].status,'blocked')
 assert.equal(items[0].worker.id,'worker-'+items[0].id)
})

test('a write subagent cannot leave its scope through a symbolic link',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-task-scope-'))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 fs.mkdirSync(path.join(root,'src'))
 fs.mkdirSync(path.join(root,'outside'))
 fs.symlinkSync(path.join(root,'outside'),path.join(root,'src','alias'),process.platform==='win32'?'junction':'dir')
 const items=parseTaskItems(JSON.stringify({steps:[{title:'修改源码',acceptance:'源码已更新',mode:'write',fileScope:['src']}]}))
 const f=fixture(items);f.options.workspace=root;f.plan.workspace=root
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.match(await step.beforeMutation({name:'agent.write_file'},{path:'src/alias/new.js'}),/超出已分配文件范围/)
  step.onOutcome('blocked')
 })
 assert.equal(fs.existsSync(path.join(root,'outside','new.js')),false)
})

test('child write scope cannot widen its parent assignment',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-parent-scope-'))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 fs.mkdirSync(path.join(root,'src'))
 const items=parseTaskItems(JSON.stringify({steps:[{title:'完成模块 A',acceptance:'子项完成',fileScope:['src/a.js'],children:[{title:'修改源码',acceptance:'源码更新',mode:'write',fileScope:['src']}]}]}))
 const f=fixture(items);f.options.workspace=root;f.plan.workspace=root
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.match(await step.beforeMutation({name:'agent.write_file'},{path:'src/b.js'}),/超出已分配文件范围/)
  assert.equal(await step.beforeMutation({name:'agent.write_file'},{path:'src/a.js'}),undefined)
  step.onOutcome('blocked')
 })
 assert.equal(items[1].status,'pending')
})

test('saved graph resumes after a completed child without replaying it',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'汇总',acceptance:'全部完成',children:[{title:'读取 A',acceptance:'完成 A',mode:'read',parallel:true},{title:'读取 B',acceptance:'完成 B',mode:'read',parallel:true}]}]}))
 items[0].status='complete';items[0].summary='已读取 A'
 const f=fixture(items),ran=[]
 await runTaskPlan(f.options,f.execution,async step=>{ran.push(step.currentStep.title);step.onOutcome('complete')})
 assert.deepEqual(ran,['读取 B','汇总'])
})

test('advice-only fallback removes stale child links from a saved graph',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'梳理项目可优化项',acceptance:'列出优化建议',children:[{title:'读取源码',acceptance:'取得源码资料',mode:'read'}]}]}))
 const f=fixture(items)
 f.plan.scope={goal:'项目还可以怎么优化',kind:'general',required:['项目还可以怎么优化'],optional:[]}
 let saved
 f.execution.save=plan=>{saved=plan}
 await runTaskPlan(f.options,f.execution,async step=>step.onOutcome('complete'))
 assert.equal(saved.items.length,1)
 assert.equal(saved.items[0].childIds,undefined)
 assert.equal(saved.items[0].worker,undefined)
 assert.equal(saved.items[0].status,'complete')
})

test('parent verification inherits completed child edits and evidence',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'实现并核验功能',acceptance:'子项结果已整合',children:[{title:'修改源码',acceptance:'功能已写入',mode:'write'}]}]}))
 items[0].status='complete';items[0].modifiedFiles=['src/feature.js'];items[0].evidenceIds=['child-edit']
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.equal(step.currentStep.implementationChanged,true)
  assert.deepEqual(step.currentStep.implementationPaths,['src/feature.js'])
  step.onOutcome('complete')
 })
 assert.equal(items[1].status,'complete')
 assert.ok(items[1].evidenceIds.includes('child-edit'))
})

test('parent verification does not claim edits from an unrelated completed branch',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[
  {title:'修改独立模块',acceptance:'独立模块已更新',mode:'write'},
  {title:'核对资料',acceptance:'读取结果完整',children:[{title:'读取说明',acceptance:'说明已读取',mode:'read'}]}
 ]}))
 items[0].status='complete';items[0].modifiedFiles=['src/unrelated.js']
 items[1].status='complete'
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async step=>{
  assert.equal(step.currentStep.implementationChanged,false)
  assert.deepEqual(step.currentStep.implementationPaths,[])
  step.onOutcome('complete')
 })
})

test('a resumed subagent keeps its tool budget and stops before replay',async()=>{
 const items=parseTaskItems(JSON.stringify({steps:[{title:'读取源码',acceptance:'内容已确认',mode:'read'}]}))
 items[0].worker={id:'worker-'+items[0].id,mode:'read',assignedAt:'2026-10-15',maxRounds:8,maxToolCalls:2,toolCalls:2}
 items[0].status='blocked'
 const f=fixture(items)
 await runTaskPlan(f.options,f.execution,async()=>assert.fail('exhausted worker must not call model'))
 assert.equal(items[0].status,'blocked')
 assert.match(items[0].summary,/工具调用已达到/)
})

test('graph workers inherit automatic continuation and honor the full configured round limit',async()=>{
 for(const mode of ['read','write','verify'])for(const limit of [undefined,2,23]){
  const items=parseTaskItems(JSON.stringify({steps:[{title:'处理当前项',acceptance:'当前项完成',mode}]})),f=fixture(items)
  f.options.maxRounds=limit
  await runTaskPlan(f.options,f.execution,async step=>{assert.equal(step.maxRounds,limit);step.onOutcome('complete')})
  assert.equal(items[0].worker.maxRounds,limit)
  assert.equal(items[0].worker.roundLimitSource,limit===undefined?'automatic':'configured')
 }
})

test('resumed workers migrate legacy defaults while preserving configured limits and tool usage',async()=>{
 for(const [saved,source,current,expected] of [[8,undefined,undefined,undefined],[20,undefined,undefined,undefined],[3,undefined,undefined,3],[8,'configured',undefined,8],[20,'configured',undefined,20],[8,undefined,23,23],[23,'configured',2,2]]){
  const items=parseTaskItems(JSON.stringify({steps:[{title:'读取资料',acceptance:'取得完整资料',mode:'read'}]})),f=fixture(items)
  items[0].worker={id:'saved-worker',mode:'read',assignedAt:'before',maxRounds:saved,roundLimitSource:source,maxToolCalls:32,toolCalls:14}
  items[0].status='blocked';items[0].attempts=1;items[0].evidenceIds=['existing-evidence']
  f.options.maxRounds=current
  await runTaskPlan(f.options,f.execution,async step=>{assert.equal(step.maxRounds,expected);step.onOutcome('complete')})
  assert.equal(items[0].worker.maxRounds,expected)
  assert.equal(items[0].worker.toolCalls,14)
  assert.deepEqual(items[0].evidenceIds,['existing-evidence'])
 }
})

test('new workers have no implicit tool cap and inherit explicitly configured budgets',async()=>{
 for(const mode of ['read','write','verify'])for(const limit of [undefined,2,96]){
  const items=parseTaskItems(JSON.stringify({steps:[{title:'处理当前项',acceptance:'当前项完成',mode}]})),f=fixture(items),seen=[]
  f.options.maxToolCalls=limit
  await runTaskPlan(f.options,f.execution,async step=>{
   seen.push({limit:step.maxToolCalls,budget:{...step.executionContext.budget}})
   step.onOutcome('complete')
  })
  assert.deepEqual(seen,[{limit,budget:{used:0,limit}}])
  assert.equal(items[0].worker.maxToolCalls,limit)
  assert.equal(items[0].worker.toolLimitSource,limit===undefined?'automatic':'configured')
 }
})

test('exhausted legacy tool caps migrate on resume without losing usage or evidence',async()=>{
 for(const limit of [32,40,80]){
  const items=parseTaskItems(JSON.stringify({steps:[{title:'读取资料',acceptance:'取得完整资料',kind:'inspect'}]})),f=fixture(items),seen=[]
  items[0].worker={id:'saved-worker',mode:'read',assignedAt:'before',maxToolCalls:limit,toolCalls:limit}
  items[0].status='blocked';items[0].attempts=1;items[0].evidenceIds=['existing-evidence']
  await runTaskPlan(f.options,f.execution,async step=>{
   seen.push({limit:step.maxToolCalls,budget:{...step.executionContext.budget}})
   step.onActivity({id:'new-read',capability:'agent.read_file',args:{path:'README.md'},status:'complete',output:'新的资料'})
   step.onOutcome('complete')
  })
  assert.deepEqual(seen,[{limit:undefined,budget:{used:limit,limit:undefined}}])
  assert.equal(items[0].status,'complete')
  assert.equal(items[0].worker.maxToolCalls,undefined)
  assert.equal(items[0].worker.toolLimitSource,'automatic')
  assert.equal(items[0].worker.toolCalls,limit+1)
  assert.deepEqual(items[0].evidenceIds,['existing-evidence','new-read'])
 }
})

test('explicit tool caps survive resume and can be raised without resetting usage',async()=>{
 for(const limit of [32,40,80]){
  const items=parseTaskItems(JSON.stringify({steps:[{title:'读取资料',acceptance:'取得完整资料',kind:'inspect'}]})),f=fixture(items),seen=[]
  items[0].worker={id:'saved-worker',mode:'read',assignedAt:'before',maxToolCalls:limit,toolLimitSource:'configured',toolCalls:limit}
  items[0].status='blocked';items[0].evidenceIds=['existing-evidence']
  let calls=0
  await runTaskPlan(f.options,f.execution,async()=>{calls++})
  assert.equal(calls,0);assert.equal(items[0].status,'blocked')
  assert.equal(items[0].runtime.waitReason,'budget')
  assert.match(items[0].summary,new RegExp(`${limit}/${limit}`))
  f.options.maxToolCalls=limit+2
  await runTaskPlan(f.options,f.execution,async step=>{
   seen.push({limit:step.maxToolCalls,budget:{...step.executionContext.budget}})
   step.onActivity({id:'continued-read',capability:'agent.read_file',args:{path:'README.md'},status:'complete',output:'已核对资料'})
   step.onOutcome('complete')
  })
  assert.deepEqual(seen,[{limit:2,budget:{used:limit,limit:limit+2}}])
  assert.equal(items[0].status,'complete');assert.equal(items[0].worker.toolCalls,limit+1)
  assert.equal(items[0].worker.maxToolCalls,limit+2);assert.equal(items[0].worker.toolLimitSource,'configured')
  assert.deepEqual(items[0].evidenceIds,['existing-evidence','continued-read'])
 }
})
