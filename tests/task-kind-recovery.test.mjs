import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createServer} from 'node:http'
import {parseTaskItems,runTaskPlan} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {recoverTaskKinds,taskKindConflict} from '../dist-electron/main/agent/core/task-kind-recovery.js'
import {chatCapabilityAllowed,chatApprovalRequired} from '../dist-electron/main/agent/core/chat-runner.js'
import {budgetCapabilities} from '../dist-electron/main/agent/core/capability-budget.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
import {isolatedGitWorkspace,workspaceCleanup} from './helpers/workspace.mjs'

const step={key:'init',title:'初始化项目结构与基础资源',acceptance:'项目目录创建完成，包含 index.html、style.css 和 assets 文件夹。',kind:'inspect',verification:[{kind:'file',path:'index.html',contains:'fixture animation'},{kind:'file',path:'style.css',contains:'body'},{kind:'file',path:'assets/.gitkeep'}]}
const makePlan=workspace=>({taskId:'fixture-task',workspace,graphVersion:1,scope:{goal:'制作一个鹈鹕骑车动画',kind:'general',required:['制作一个鹈鹕骑车动画'],optional:[]},items:parseTaskItems(JSON.stringify({steps:[step]})),updatedAt:''})
const options=workspace=>({workspace,filesEnabled:true,webEnabled:false,approvalMode:'ask',messages:[{role:'user',content:'制作一个鹈鹕骑车动画'}],model:'fixture',signal:new AbortController().signal,approve:async()=>true,onActivity(){},onContent(){},onRequest(){},onUsage(){}})
async function model(t,reply){
 const requests=[],server=createServer(async(req,res)=>{
  try{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);requests.push(input);const message=await reply(input);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}))}
  catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}))}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 return {requests,connection:{endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:16384}}
}
const isCorrection=input=>input.messages.some(m=>m.role==='system'&&m.content.includes('现在仅纠正计划中的任务类型'))
const correction=input=>({content:JSON.stringify({corrections:JSON.parse(input.messages.at(-1).content).steps.map(s=>({id:s.id,kind:'edit',reason:'用户要求制作动画，本项需要创建实际项目文件'}))})})

test('only actionable file creation conflicts trigger role repair; verification stays read-only',()=>{
 const item=makePlan('workspace').items[0]
 assert.equal(taskKindConflict(item),true)
 for(const [title,kind] of [['检查项目目录是否创建完成','inspect'],['创建项目的优化建议','answer'],['生成最终回答','answer'],['修复后运行测试','verify']])assert.equal(taskKindConflict({...item,title,kind,acceptance:'核对结果'}),false,title)
 assert.equal(taskKindConflict({...item,status:'complete'}),false)
 const legacy=parseTaskItems(JSON.stringify({steps:[{...step,kind:undefined}]}))[0]
 assert.equal(legacy.mode,'write','untyped legacy initialization is an implementation action')
})

for(const resumed of [false,true])test(`${resumed?'persisted blocked':'new'} mistyped initialization gets actual Python writes with approval`,async t=>{
 const root=isolatedGitWorkspace('myplane-kind-recovery-'),track=workspaceCleanup(t,root),workspace=path.join(root,'workspace'),skillsDir=path.join(root,'skills')
 fs.mkdirSync(workspace);fs.cpSync(path.resolve('skills/agent-tools'),path.join(skillsDir,'agent-tools'),{recursive:true})
 let currentPlan=resumed?makePlan(workspace):undefined
 if(currentPlan){const item=currentPlan.items[0];item.status='blocked';item.attempts=2;item.evidenceIds=['previous-read'];item.worker={id:'saved-worker',mode:'read',assignedAt:'before',toolCalls:5,maxToolCalls:20,toolLimitSource:'configured'};item.summary='本 Worker 没有文件写入工具'}
 const files=[['index.html','<!doctype html><title>fixture animation</title>'],['style.css','body {margin:0}'],['assets/.gitkeep','']]
 let writes=0,requests=0,outcome;const approvals=[],activities=[]
 const fixture=await model(t,input=>{
  if(input.messages.some(m=>m.role==='system'&&m.content.includes('现在仅规划当前用户任务')))return {content:JSON.stringify({steps:[step]})}
  if(isCorrection(input))return correction(input)
  if(input.messages.some(m=>m.role==='system'&&m.content.includes('你是任务完成检查器')))return {content:JSON.stringify({status:'complete',reason:'真实写入结果与文件验收相符',nextStep:''})}
  const target=files[writes]
  if(!target)return {content:'项目文件已创建，已有执行记录，不重复写入。'}
  const tool=input.tools?.find(tool=>tool.function.description.startsWith('agent.write_file:'))
  assert.ok(tool,'corrected worker receives write_file, even with networking disabled')
  assert.ok(!input.tools.some(tool=>tool.function.description.startsWith('agent.run_command:')),'no shell is needed to create the directories')
  writes++
  return {content:null,tool_calls:[{id:'write-'+writes,type:'function',function:{name:tool.function.name,arguments:JSON.stringify({path:target[0],content:target[1]})}}]}
 })
 const core=track(new AgentCoreService({dataDir:path.join(root,'data'),skillsDir,getConnection:()=>fixture.connection}));core.on('error',()=>{});await core.initialize()
 const run=()=>core.runConversation({...options(workspace),connection:fixture.connection,maxToolCalls:20,onRequest:()=>requests++,onActivity:a=>activities.push(a),onOutcome:v=>outcome=v,approve:async a=>{approvals.push(a);return true},planExecution:{taskId:'fixture-task',goal:'制作一个鹈鹕骑车动画',plan:currentPlan,save:p=>{currentPlan=p}}})
 await run()
 assert.equal(outcome,'complete',JSON.stringify({items:currentPlan.items,activities}));assert.equal(writes,3);assert.equal(approvals.length,3)
 for(const [file,content] of files)assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),content)
 const item=currentPlan.items[0]
 assert.equal(item.kind,'edit');assert.equal(item.mode,'write');assert.equal(item.worker.mode,'write');assert.equal(item.kindCorrection.from,'inspect')
 assert.ok(activities.some(a=>a.capability==='agent.write_file'&&a.status==='complete'))
 assert.ok(item.verificationRuns.at(-1).passed)
 if(resumed){assert.equal(item.worker.id,'saved-worker');assert.ok(item.evidenceIds.includes('previous-read'));assert.equal(item.worker.maxToolCalls,20);assert.ok(item.worker.toolCalls>=8)}
 assert.equal(fixture.requests.filter(isCorrection).length,1);assert.equal(requests,fixture.requests.length)
 const prior=requests;await run();assert.equal(requests,prior,'completed items never replay on continue')
})

test('invalid role correction is atomic and stops before any worker runs',async t=>{
 const plan=makePlan('workspace')
 plan.items.push({...structuredClone(plan.items[0]),id:'second',key:'second'})
 const before=structuredClone(plan)
 const fixture=await model(t,()=>({content:JSON.stringify({corrections:[{id:plan.items[0].id,kind:'edit',reason:'first'},{id:plan.items[0].id,kind:'edit',reason:'duplicate'}]})}))
 let ran=0
 await assert.rejects(runTaskPlan({...options('workspace'),connection:fixture.connection},{taskId:plan.taskId,plan,save(){}},async()=>{ran++}),/任务计划类型冲突/)
 assert.equal(ran,0);assert.deepEqual(plan.items.map(item=>[item.kind,item.mode]),before.items.map(item=>[item.kind,item.mode]))
})

test('read-only user goal never repairs a role into writing',async()=>{
 const plan=makePlan('workspace');plan.scope.goal='只读检查项目，不修改文件'
 await assert.rejects(recoverTaskKinds(plan,{...options('workspace'),onRequest:()=>assert.fail('must not request a writable role')}),/任务计划类型冲突/)
 assert.equal(plan.items[0].mode,'read')
 const cap={name:'agent.write_file',source:{type:'skill',skillId:'agent-tools'},tags:['requires-approval']}
 assert.equal(chatCapabilityAllowed(cap,{filesEnabled:true,webEnabled:false,workerMode:'read'}),false)
 assert.equal(chatApprovalRequired(cap,{path:'index.html'},{workspace:process.cwd(),approvalMode:'ask'}),true)
})

test('small contexts retain a file creation tool ahead of optional browser schemas',()=>{
 const names=['agent.web_search','agent.web_fetch','browser.open','browser.read_page','browser.screenshot','preview.start','preview.status','agent.list_files','agent.read_file','agent.write_file','agent.replace_text','agent.apply_patch']
 const caps=names.map(name=>({name,description:'schema '.repeat(150),parameters:{type:'object',properties:{path:{type:'string'}}},source:{type:'skill',skillId:'agent-tools'}}))
 const selected=budgetCapabilities(caps,'初始化网页项目，预览页面',4096,true)
 assert.ok(selected.some(cap=>cap.name==='agent.write_file'))
})
