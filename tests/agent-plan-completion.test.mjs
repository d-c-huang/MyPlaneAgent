import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'node:http'
import {parseTaskItems,runTaskPlan} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {verifyTaskRules} from '../dist-electron/main/agent/core/task-verification.js'
import {completeVerificationRules} from '../dist-electron/main/agent/core/verification-rule-recovery.js'

async function fixture(t,answer,work){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-plan-completion-')),requests=[],outcomes=[]
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk
  requests.push(JSON.parse(body))
  const value=answer(requests.length)
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const options={workspace:root,connection:{endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:8192},model:'test',messages:[{role:'user',content:'创建一个显示 ready 的网页，并核对结果'}],filesEnabled:true,webEnabled:true,approvalMode:'ask',signal:new AbortController().signal,onContent(){},onOutcome:value=>outcomes.push(value),onActivity(){},onRequest(){},onUsage(){},approve:async()=>true}
 const item=parseTaskItems(JSON.stringify({steps:[{kind:'edit',title:'创建页面',acceptance:'index.html 显示 ready',fileScope:['index.html']}]}))[0]
 const plan={taskId:'task',workspace:root,items:[item],updatedAt:''},execution={taskId:'task',plan,save(){}}
 const verify=rules=>verifyTaskRules({list:()=>[]},options,rules)
 try{await work({root,requests,options,outcomes,item,plan,execution,verify})}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}

async function writeReviewedPage(step,root,content='<!doctype html><h1>ready</h1>'){
 const args={path:'index.html',content}
 assert.equal(await step.beforeMutation({name:'agent.write_file'},args),undefined)
 const file=path.join(root,args.path),before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):undefined
 fs.writeFileSync(file,content)
 step.onActivity({id:'write-'+content,capability:'agent.write_file',args,status:'complete',fileChanges:[{path:args.path,before,after:content}]})
 step.onCompletionReview({status:'complete',reason:'已按原要求核对实际页面内容',nextStep:'',implementation:{status:'present',evidenceIds:['write-'+content]}})
 step.onOutcome('complete')
}

const contentRule={kind:'file',path:'index.html',contains:'<h1>ready</h1>'}

test('a reviewed generated artifact gains independent content acceptance without replaying completed steps',async t=>{
 await fixture(t,()=>({verification:[contentRule]}),async f=>{
  f.plan.items.unshift({id:'existing',kind:'inspect',title:'检查工作区',acceptance:'已有记录',status:'complete',attempts:1,summary:'已检查',evidenceIds:['existing-read']})
  let workers=0
  await runTaskPlan(f.options,f.execution,async step=>{workers++;await writeReviewedPage(step,f.root)},f.verify)
  assert.equal(workers,1);assert.equal(f.requests.length,1)
  assert.equal(f.item.status,'complete');assert.equal(f.item.verificationRuns.at(-1).passed,true)
  assert.deepEqual(f.item.verification,[contentRule]);assert.equal(f.plan.items[0].attempts,1)
  assert.deepEqual(f.plan.items[0].evidenceIds,['existing-read'])
 })
})

test('missing acceptance recovery rejects existence-only and unmodified-file substitutions',async t=>{
 await fixture(t,n=>({verification:[n===1?{kind:'file',path:'index.html'}:contentRule]}),async f=>{
  await runTaskPlan(f.options,f.execution,step=>writeReviewedPage(step,f.root),f.verify)
  assert.equal(f.requests.length,2);assert.equal(f.item.status,'complete')
  assert.match(f.item.verificationRepairs[0].error,/不能降级/)
 })
 await fixture(t,()=>({verification:[{kind:'file',path:'unrelated.html',contains:'ready'}]}),async f=>{
  fs.writeFileSync(path.join(f.root,'unrelated.html'),'ready')
  await runTaskPlan(f.options,f.execution,step=>writeReviewedPage(step,f.root),()=>assert.fail('invalid checks must not execute'))
  assert.equal(f.requests.length,2);assert.equal(f.item.status,'blocked');assert.equal(f.outcomes.at(-1),'needs_input')
 })
})

test('semantic review and existing acceptance remain required',async t=>{
 await fixture(t,()=>assert.fail('unreviewed work must not request replacement acceptance'),async f=>{
  f.item.modifiedFiles=['index.html'];fs.writeFileSync(path.join(f.root,'index.html'),'ready')
  assert.equal(await completeVerificationRules(f.item,f.options,()=>{}),false)
  f.item.verification=[contentRule]
  assert.equal(await completeVerificationRules(f.item,f.options,()=>{}),true)
  assert.deepEqual(f.item.verification,[contentRule]);assert.equal(f.requests.length,0)
  f.item.verification=[];f.item.completionReview={status:'complete',reason:'reviewed',nextStep:''}
  assert.equal(await completeVerificationRules(f.item,{...f.options,connection:undefined},()=>{}),false)
 })
})

test('unrepresentable runtime acceptance stays blocked with bounded recovery until explicit continue',async t=>{
 await fixture(t,()=>({verification:[],reason:'需要浏览器交互记录，静态文件不能证明交互正确'}),async f=>{
  f.item.acceptance='浏览器点击按钮后显示 ready'
  await runTaskPlan(f.options,f.execution,step=>writeReviewedPage(step,f.root),()=>assert.fail('empty rules cannot certify work'))
  assert.equal(f.requests.length,2);assert.equal(f.outcomes.at(-1),'needs_input')
  assert.equal(await completeVerificationRules(f.item,f.options,()=>{}),false)
  assert.equal(f.requests.length,2,'automatic re-entry retains the exhausted recovery budget')
  assert.equal(await completeVerificationRules(f.item,f.options,()=>{},true),false)
  assert.equal(f.requests.length,4,'explicit continue grants at most two new proposals')
 })
})

test('explicit continue permits one new repair round while keeping cumulative attempts and completed evidence',async t=>{
 await fixture(t,()=>assert.fail('configured rules require no model repair'),async f=>{
  const rule={kind:'file',path:'index.html',contains:'ready'}
  fs.writeFileSync(path.join(f.root,'index.html'),'wrong')
  Object.assign(f.item,{status:'blocked',attempts:3,repairAttempts:2,mutationStarted:true,modifiedFiles:['index.html'],verification:[rule]})
  f.item.verificationRuns=[{createdAt:'old',passed:false,results:await f.verify([rule])}]
  f.plan.items.unshift({id:'earlier',kind:'inspect',title:'读取旧页面',acceptance:'已记录',status:'complete',attempts:1,summary:'已读',evidenceIds:['read-old']})
  await runTaskPlan(f.options,f.execution,()=>assert.fail('automatic re-entry cannot renew repairs'),f.verify)
  assert.equal(f.item.status,'blocked');assert.equal(f.item.repairAttempts,2)
  let workers=0
  await runTaskPlan(f.options,{...f.execution,resume:true},async step=>{workers++;await writeReviewedPage(step,f.root)},f.verify)
  assert.equal(workers,1);assert.equal(f.item.status,'complete');assert.equal(f.item.repairAttempts,3)
  assert.equal(f.plan.items[0].attempts,1);assert.deepEqual(f.plan.items[0].evidenceIds,['read-old'])
 })
})

test('explicit continue renews exhausted schema recovery without replaying completed items',async t=>{
 await fixture(t,()=>({verification:[contentRule]}),async f=>{
  fs.writeFileSync(path.join(f.root,'index.html'),'<h1>ready</h1>')
  Object.assign(f.item,{kind:'verify',mode:'verify',title:'核对页面内容',status:'blocked',verificationProblem:{attempts:2,input:[{kind:'file_contains',path:'index.html',contains:'<h1>ready</h1>'}],message:'previous model correction failed'}})
  await runTaskPlan(f.options,f.execution,()=>assert.fail('exhausted recovery cannot start worker'),f.verify)
  assert.equal(f.requests.length,0);assert.equal(f.item.status,'blocked')
  await runTaskPlan(f.options,{...f.execution,resume:true},async step=>step.onOutcome('complete'),f.verify)
  assert.equal(f.requests.length,1);assert.equal(f.item.status,'complete')
 })
})

test('verify node syntax checks can read beyond write scopes without creating mutation requirements',async t=>{
 await fixture(t,()=>assert.fail('read-only checks need no replacement acceptance'),async f=>{
  Object.assign(f.item,{kind:'verify',mode:'verify',title:'核对页面源码',acceptance:'node 语法检查通过',fileScope:['index.html']})
  await runTaskPlan(f.options,f.execution,async step=>{
   for(const command of ['node --check game.js','node --version']){
    const args={command}
    assert.equal(await step.beforeMutation({name:'agent.run_command'},args),undefined)
    step.onActivity({id:command,capability:'agent.run_command',args,status:'complete',output:'{"exitCode":0}'})
   }
   assert.match(await step.beforeMutation({name:'agent.run_command'},{command:'node -e "require(\'fs\').writeFileSync(\'game.js\',\'x\')"'}),/文件范围/)
   assert.match(await step.beforeMutation({name:'agent.write_file'},{path:'game.js',content:'x'}),/文件范围/)
   step.onOutcome('complete')
  },()=>assert.fail('read-only syntax checks must not imply edits'))
  assert.equal(f.item.status,'complete');assert.equal(f.item.requiresVerification,undefined);assert.equal(f.item.mutationStarted,undefined)
 })
})

test('preview startup with an empty file scope is allowed while shell chains and writes remain blocked',async t=>{
 await fixture(t,()=>assert.fail('preview startup needs no file check'),async f=>{
  fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify({scripts:{dev:'vite'}}))
  Object.assign(f.item,{kind:'preview',mode:'verify',title:'启动页面预览',acceptance:'确认预览地址可打开',fileScope:[]})
  await runTaskPlan(f.options,f.execution,async step=>{
   for(const command of ['node --version','npm run dev']){
    const args={command}
    assert.equal(await step.beforeMutation({name:'agent.run_command'},args),undefined)
    step.onActivity({id:command,capability:'agent.run_command',args,status:'complete',output:'{"exitCode":0}'})
   }
   assert.match(await step.beforeMutation({name:'agent.run_command'},{command:'npm run dev && echo changed > index.html'}),/文件范围/)
   assert.match(await step.beforeMutation({name:'agent.write_file'},{path:'index.html',content:'x'}),/文件范围/)
   step.onOutcome('complete')
  },()=>assert.fail('starting a preview does not require file modification acceptance'))
  assert.equal(f.item.status,'complete');assert.equal(f.item.requiresVerification,undefined);assert.equal(f.item.mutationStarted,undefined)
 })
})
