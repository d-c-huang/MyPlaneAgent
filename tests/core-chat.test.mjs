import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCoreChat, chatApprovalRequired, chatCapabilityAllowed } from '../dist-electron/main/agent/core/chat-runner.js'
import { estimateTokens } from '../dist-electron/main/local-ai-context.js'
import { AgentCoreService } from '../dist-electron/main/agent/agent-core-service.js'
import {execFileSync} from 'node:child_process'
import {beginOperation,operationKey,journalRequired} from '../dist-electron/main/agent/core/operation-journal.js'
import {StaticPreview} from '../dist-electron/main/agent/static-preview.js'
import {CapabilityRegistry} from '../dist-electron/main/agent/core/capability-registry.js'
import {enqueueReviewActions} from '../dist-electron/main/agent/core/review-dispatch.js'
import {runTaskPlan,parseTaskItems} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {weatherDate} from '../dist-electron/main/agent/core/weather-workflow.js'
import {createTaskScope} from '../dist-electron/shared/task-scope.js'
import {ExecutionInspector} from '../dist-electron/main/agent/core/execution-inspector.js'
import {isolatedGitWorkspace,workspaceCleanup} from './helpers/workspace.mjs'

test('inspection edits reach approval, execution and subsequent model history',async()=>{
 const controller=new AbortController(),inspector=new ExecutionInspector(controller.signal,true),executions=[],approvals=[]
 await withModel(input=>executions.length?{content:'查询完成'}:toolCall(input,'agent.web_search',{query:'original'}),async(connection,requests)=>{
  const run=runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{executions.push(request.args);return {success:true,output:'verified result'}}},options(connection,{signal:controller.signal,inspectTool:(cap,args,id)=>inspector.before('tool',cap.name,'plugin',args,cap.parameters,id),approve:async activity=>{approvals.push(activity.args);return true}}))
  for(let i=0;i<200&&!inspector.snapshot().checkpointId;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.ok(inspector.snapshot().checkpointId);assert.equal(executions.length,0);assert.equal(approvals.length,0)
  inspector.command({action:'continue',checkpointId:inspector.snapshot().checkpointId,args:{query:'edited by user'}})
  await run
  assert.deepEqual(executions,[{query:'edited by user'}]);assert.deepEqual(approvals,executions)
  assert.ok(requests.some(request=>request.messages.some(message=>message.tool_calls?.some(call=>JSON.parse(call.function.arguments).query==='edited by user'))))
 })
})

test('read-only weather task does not expose unrelated project diagnostics',()=>{
 const diagnostic=capability('agent.get_diagnostics','read')
 assert.equal(chatCapabilityAllowed(diagnostic,{filesEnabled:true,webEnabled:true,taskScope:createTaskScope('成都市明天下雨吗')}),false)
 assert.equal(chatCapabilityAllowed(diagnostic,{filesEnabled:true,webEnabled:true,taskScope:createTaskScope('修复天气代码并检查类型')}),true)
})

test('successful general weather lookup learns source method instead of tool sequence',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'weather-learning-')),track=workspaceCleanup(t,workspace)
 const service=track(new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.weather.run=async()=>false
 let reads=0,outcome
 service.capabilityRegistry.registerBuiltin({...capability('agent.web_fetch','read'),runtime:'builtin',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}},async args=>{reads++;return {url:args.url,text:`上海 ${weatherDate('明天','Asia/Shanghai',new Date())} 天气预报 20℃`}})
 await withModel(input=>reads?{content:'已取得上海明天的天气预报。'}:toolCall(input,'agent.web_fetch',{url:'https://weather.example/shanghai?private=123'}),async connection=>{
  await service.runConversation(options(connection,{workspace,approvalMode:'full',messages:[{role:'user',content:'上海明天天气'}],onOutcome:value=>outcome=value}))
 })
 assert.equal(outcome,'complete');assert.equal(reads,1)
 const entries=service.experienceState().entries
 assert.equal(entries.length,1);assert.equal(entries[0].recipe.kind,'weather-web');assert.equal(entries[0].recipe.sourceHost,'weather.example');assert.equal(entries[0].enabled,false)
 assert.doesNotMatch(JSON.stringify(entries),/private|shanghai|20℃/)
})

test('weather conversation uses learned source with fresh city and date before builtin provider',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'weather-method-')),track=workspaceCleanup(t,workspace)
 const service=track(new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.experiences.record('上海明天天气',workspace,['browser.open','browser.read_page','agent.web_fetch','agent.web_fetch'],true,undefined,'validation','weather.example')
 const entry=service.experienceState().entries[0],calls=[]
 service.experiences.verify(entry.id,1,true,[],'通过');service.enableExperience(entry.id,1,true)
 service.weather.run=async()=>{throw new Error('learned source must take precedence')}
 service.capabilityRegistry.registerBuiltin({...capability('agent.web_search','read'),runtime:'builtin',parameters:{type:'object',properties:{query:{type:'string'},limit:{type:'number'}},required:['query']}},async args=>{calls.push(args.query);return {results:[{title:'北京天气预报',url:'https://weather.example/beijing'}]}})
 service.capabilityRegistry.registerBuiltin({...capability('agent.web_fetch','read'),runtime:'builtin',parameters:{type:'object',properties:{url:{type:'string'},maxCharacters:{type:'number'}},required:['url']}},async args=>{calls.push(args.url);return {url:args.url,text:`北京 ${weatherDate('明天','Asia/Shanghai',new Date())} 天气预报 20℃`}})
 let outcome
 await withModel(()=>({content:'已查询北京最新天气预报。'}),async connection=>{
  await service.runConversation(options(connection,{workspace,approvalMode:'full',messages:[{role:'user',content:'北京明天天气'}],onOutcome:value=>outcome=value}))
 })
 assert.equal(outcome,'complete');assert.equal(calls.length,2);assert.match(calls[0],/北京.*site:weather\.example/)
 assert.equal(calls[1],'https://weather.example/beijing')
 assert.equal(service.experienceState().entries.length,1);assert.equal(service.experiences.get(entry.id).successes,2)
})

const screenshotCapability={name:'browser.screenshot',description:'screenshot',category:'browser',source:{type:'builtin'},runtime:'builtin',permissions:['network'],tags:['requires-approval','risk:high'],parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}
const screenshotResult=()=>({success:true,output:{url:'http://localhost:8080/',width:100,height:100,capturedAt:new Date().toISOString(),image:{name:'screenshot.jpg',dataUrl:'data:image/jpeg;base64,/9j/2Q=='}}})
const visualStep={title:'确认门头玻璃',acceptance:'正面视角下大门上方可见玻璃墙而非实墙'}

test('unfinished edits regain control before pending browser checks and only then ask for visual confirmation',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'myplane-implement-first-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}))
 writeFileSync(path.join(workspace,'door.js'),'const glass = "plain"')
 const write={...screenshotCapability,name:'agent.write_file',source:{type:'skill',skillId:'agent-tools'},parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}
 const queue={revision:0,checks:[]},action={title:'截图确认花纹',capability:'browser.screenshot',args:{url:'http://localhost:8080/'},basis:'玻璃门添加花纹',required:true}
 enqueueReviewActions(queue,[action]);const executed=[],snapshots=[];let turns=0,outcome
 await withModel(input=>{
  turns++
  if(turns===1){assert.ok(!input.tools.some(tool=>tool.function.description.startsWith('browser.screenshot:')));return {content:'还未修改代码，请先截图'}}
  if(!executed.includes('agent.write_file'))return toolCall(input,'agent.write_file',{path:'door.js',content:'const glass = "striped"'})
  return {content:'实现已写入，待核验画面'}
 },async connection=>{
  await runCoreChat({list:()=>[write,screenshotCapability],execute:async request=>{
   executed.push(request.capability)
   if(request.capability==='agent.write_file'){writeFileSync(path.join(workspace,request.args.path),request.args.content);return {success:true,output:{changed:true}}}
   return screenshotResult()
  }},options(connection,{workspace,filesEnabled:true,approvalMode:'full',currentStep:{title:'为玻璃门添加花纹',acceptance:'玻璃门画面显示花纹且开合正常'},taskScope:{goal:'玻璃门添加花纹',kind:'general',required:['添加花纹'],optional:[]},reviewQueue:queue,onReviewQueue:()=>snapshots.push(structuredClone(queue)),imageCapability:'unsupported',onOutcome:value=>outcome=value}))
 },()=>({content:JSON.stringify(!executed.includes('agent.write_file')?{status:'continue',reason:'源码中没有花纹',nextStep:'写入花纹实现',implementation:{status:'missing',evidenceIds:[]},missingEvidence:['花纹未实现'],actions:[action]}:!executed.includes('browser.screenshot')?{status:'continue',reason:'实现已写入，需要截图',nextStep:'截图',actions:[action]}:{status:'needs_input',reason:'画面需要人工确认',missingEvidence:['花纹视觉效果']})}))
 assert.deepEqual(executed,['agent.write_file','browser.screenshot'])
 assert.match(readFileSync(path.join(workspace,'door.js'),'utf8'),/striped/)
 assert.equal(outcome,'needs_input');assert.equal(queue.phase,'verify')
 assert.ok(snapshots.some(value=>value.phase==='implement'&&value.checks[0].status==='deferred'))
})

test('missing implementation cannot be replaced by screenshots or a false completion claim',async()=>{
 let outcome,text='',calls=0
 await withModel(()=>({content:'代码已落盘，可以确认'}),async connection=>{
  await runCoreChat({list:()=>[screenshotCapability],execute:async()=>{calls++;return screenshotResult()}},options(connection,{filesEnabled:true,approvalMode:'full',currentStep:{title:'为玻璃门添加花纹',acceptance:'画面显示花纹'},imageCapability:'unsupported',onOutcome:value=>outcome=value,onContent:value=>text+=value}))
 },()=>({content:JSON.stringify({status:'complete',reason:'没有代码修改证据',implementation:{status:'missing',evidenceIds:[]},missingEvidence:['花纹未实现'],actions:[{title:'截图',capability:'browser.screenshot',args:{url:'http://localhost:8080/'},basis:'添加花纹',required:true}]})}))
 assert.equal(calls,0);assert.equal(outcome,'blocked');assert.match(text,/未落实代码修改/);assert.doesNotMatch(text,/请查看下方验收卡片/)
})

test('existing implementation can be verified using actual source evidence without unnecessary writes',async()=>{
 const read={...screenshotCapability,name:'agent.read_file',source:{type:'skill',skillId:'agent-tools'},parameters:{type:'object',properties:{path:{type:'string'}}}}
 let calls=0,outcome
 await withModel(input=>calls?{content:'源码已存在所需功能，无需重复写入'}:toolCall(input,'agent.read_file',{path:'door.js'}),async connection=>{
  await runCoreChat({list:()=>[read],execute:async()=>{calls++;return {success:true,output:{text:'const glass = "striped"'}}}},options(connection,{filesEnabled:true,approvalMode:'full',currentStep:{title:'添加门花纹代码',acceptance:'door.js 包含花纹实现',implementationPaths:['door.js']},onOutcome:value=>outcome=value}))
 },input=>({content:JSON.stringify({status:'complete',reason:'源码已经实现',implementation:{status:'present',evidenceIds:input.messages.filter(message=>typeof message.content==='string'&&message.content.startsWith('以下是此前已执行的工具')).map(message=>JSON.parse(message.content.slice(message.content.indexOf('{'))).activityId)}})}))
 assert.equal(calls,1);assert.equal(outcome,'complete')
})

test('structured completion checks are executed by the host through ordinary approval and saved',async()=>{
 const read={...screenshotCapability,name:'agent.read_file',source:{type:'skill',skillId:'agent-tools'},parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}
 for(const approved of [true,false]){
  const queue={revision:0,checks:[]},saved=[];let executions=0,outcome,approvals=0
  const action={title:'核对入口',capability:'agent.read_file',args:{path:'index.html'},basis:'读取入口文件',required:true}
  await withModel(()=>({content:'准备核验入口'}),async connection=>{
   await runCoreChat({list:()=>[read],execute:async()=>{executions++;return {success:true,output:{text:'<html>入口</html>'}}}},options(connection,{filesEnabled:true,taskScope:{goal:'读取入口文件',kind:'general',required:['读取入口文件'],optional:[]},reviewQueue:queue,onReviewQueue:()=>saved.push(structuredClone(queue)),approve:async()=>{approvals++;return approved},onOutcome:value=>outcome=value}))
  },()=>({content:JSON.stringify(executions?{status:'complete',reason:'已读取入口'}:{status:'continue',reason:'需要实际读取',nextStep:'读取入口',actions:[action]})}))
  assert.equal(approvals,1);assert.equal(executions,approved?1:0);assert.equal(outcome,approved?'complete':'blocked')
  assert.ok(saved.some(value=>value.checks[0]?.status==='running'))
  assert.equal(queue.checks[0].status,approved?'complete':'failed')
 }
})

test('failed scheduled checks stop after two actual attempts, not two prose reviews',async()=>{
 const read={...screenshotCapability,name:'agent.read_file',source:{type:'skill',skillId:'agent-tools'},parameters:{type:'object',properties:{path:{type:'string'}}}}
 const queue={revision:0,checks:[]};let executions=0,outcome
 const action={title:'读取入口',capability:'agent.read_file',args:{path:'missing.html'},basis:'读取入口',required:true}
 await withModel(()=>({content:'准备读取'}),async connection=>{
  await runCoreChat({list:()=>[read],execute:async()=>{executions++;return {success:false,output:'文件不存在'}}},options(connection,{filesEnabled:true,approvalMode:'full',reviewQueue:queue,onOutcome:value=>outcome=value}))
 },()=>({content:JSON.stringify({status:'continue',reason:'还需入口证据',nextStep:'读取入口',actions:[action]})}))
 assert.equal(executions,2);assert.equal(queue.checks[0].attempts,2);assert.equal(outcome,'blocked')
})

test('truncated review actions are discarded even when their JSON looks complete',async()=>{
 let executions=0,outcome
 await withModel(()=>({content:'准备核验'}),async connection=>{
  await runCoreChat({list:()=>[screenshotCapability],execute:async()=>{executions++;return screenshotResult()}},options(connection,{onOutcome:value=>outcome=value}))
 },()=>({finish_reason:'length',content:JSON.stringify({status:'continue',reason:'截图',nextStep:'截图',actions:[{title:'截图',capability:'browser.screenshot',args:{url:'http://localhost/'},basis:'截图',required:true}]})}))
 assert.equal(executions,0);assert.equal(outcome,'blocked')
})

test('open-project acceptance does not grow into variant or performance testing after main-page evidence',async()=>{
 const caps=['preview.status','browser.read_page'].map(name=>({...screenshotCapability,name,parameters:{type:'object',properties:{}}}))
 let index=0,outcome,review,content=''
 await withModel(input=>index<caps.length?toolCall(input,caps[index++].name,{}):{content:'主入口已打开，但还想测试变体与性能'},async connection=>{
  await runCoreChat({list:()=>caps,execute:async request=>({success:true,output:request.capability==='preview.status'?{status:'running',url:'http://127.0.0.1:5000/'}:{url:'http://127.0.0.1:5000/',title:'项目',text:'主页面内容',pageErrors:[]}})},options(connection,{filesEnabled:true,approvalMode:'full',taskScope:{goal:'打开项目',kind:'open-preview',required:['主入口加载'],optional:['性能']},currentStep:{title:'核对整体任务结果',acceptance:'执行必要的集成验证'},onOutcome:value=>outcome=value,onCompletionReview:value=>review=value,onContent:value=>content+=value}))
 },()=>({content:JSON.stringify({status:'continue',reason:'还需覆盖更多页面',nextStep:'继续测试',missingEvidence:['index2.html 变体页','性能 FPS 采样']})}))
 assert.equal(index,2);assert.equal(outcome,'complete');assert.equal(review.optionalChecks.length,2);assert.deepEqual(review.missingEvidence,[]);assert.match(content,/主入口已打开/)
})

test('browser screenshots are delivered as images after all tool replies, with compact stored metadata',async()=>{
 const activities=[];let outcome,approvalCount=0
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 await withModel((input,n)=>{
  if(n!==1)return {content:'已根据实际画面核验玻璃'}
  const shot=toolCall(input,'browser.screenshot',{url:'http://localhost:8080/'}),page=toolCall(input,'browser.read_page',{})
  page.tool_calls[0].id='page-call';shot.tool_calls.push(...page.tool_calls);return shot
 },async(connection,requests)=>{
  await runCoreChat({list:()=>[screenshotCapability,read],execute:async request=>request.capability==='browser.screenshot'?screenshotResult():{success:true,output:{canvas:{width:100,height:100}}}},options(connection,{currentStep:visualStep,imageCapability:'supported',onActivity:a=>activities.push(a),onOutcome:value=>outcome=value,approve:async()=>{approvalCount++;return true}}))
  const execution=requests[1],lastTool=Math.max(...execution.messages.map((m,i)=>m.role==='tool'?i:-1))
  const imageIndex=execution.messages.findIndex(m=>Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url'))
  assert.ok(imageIndex>lastTool)
  assert.equal(execution.messages.filter(m=>m.role==='tool').length,2)
  const review=requests.at(-1)
  assert.ok(review.messages.some(m=>Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url')))
  assert.equal(outcome,'complete');assert.equal(approvalCount,2)
  const shot=activities.find(a=>a.capability==='browser.screenshot'&&a.status==='complete')
  assert.equal(shot.images.length,1);assert.equal(JSON.parse(shot.output).visualInput,true)
  assert.ok(!shot.output.includes('base64'))
 })
})

test('empty browser text automatically captures the visible page for a vision model',async()=>{
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 const calls=[],activities=[]
 await withModel((input,n)=>n===1?toolCall(input,'browser.read_page',{}):{content:'截图显示页面日期，已据此核对。'},async(connection,requests)=>{
  await runCoreChat({list:()=>[read,screenshotCapability],execute:async request=>{
   calls.push(request.capability)
   return request.capability==='browser.read_page'?{success:true,output:{url:'http://localhost:8080/',title:'日期页面',text:'',elements:[]}}:screenshotResult()
  }},options(connection,{messages:[{role:'user',content:'查看已经打开的日期页面'}],imageCapability:'supported',approvalMode:'full',onActivity:activity=>activities.push(activity)}))
  assert.deepEqual(calls,['browser.read_page','browser.screenshot'])
  assert.ok(requests[1].messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')))
  const shot=activities.find(activity=>activity.capability==='browser.screenshot'&&activity.status==='complete')
  assert.equal(shot.images.length,1)
  assert.equal(JSON.parse(shot.output).visualInput,true)
 })
})

test('empty browser text keeps a screenshot for the user without claiming text-only vision',async()=>{
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 const activities=[];let outcome,content=''
 await withModel((input,n)=>n===1?toolCall(input,'browser.read_page',{}):{content:'我看到了页面，明天是工作日。'},async(connection,requests)=>{
  await runCoreChat({list:()=>[read,screenshotCapability],execute:async request=>request.capability==='browser.read_page'?{success:true,output:{url:'http://localhost:8080/',text:'',elements:[]}}:screenshotResult()},options(connection,{messages:[{role:'user',content:'查看已经打开的日期页面'}],imageCapability:'unsupported',approvalMode:'full',onActivity:activity=>activities.push(activity),onOutcome:value=>outcome=value,onContent:value=>content+=value}))
  assert.ok(requests.every(request=>request.messages.every(message=>!Array.isArray(message.content)||message.content.every(part=>part.type!=='image_url'))))
  const shot=activities.find(activity=>activity.capability==='browser.screenshot'&&activity.status==='complete')
  assert.equal(shot.images.length,1)
  assert.equal(JSON.parse(shot.output).visualInput,false)
 },()=>({content:JSON.stringify({status:'complete',reason:'页面已核对'})}))
 assert.equal(outcome,'needs_input')
 assert.match(content,/网页正文未能读取/)
 assert.doesNotMatch(content,/明天是工作日/)
})

test('screenshot OCR supplies preliminary text to a text-only model and removes its temporary image',async()=>{
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 const ocr={...screenshotCapability,name:'agent.image_ocr',source:{type:'skill',skillId:'agent-tools'},runtime:'python-native',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}
 const activities=[],calls=[],hooks=[],executionContexts=[];let outcome,temporaryImage
 await withModel((input,n)=>n===1?toolCall(input,'browser.read_page',{}):{content:'OCR 显示页面日期；仍需核对当地工作日规则。'},async(connection,requests)=>{
  await runCoreChat({list:()=>[read,screenshotCapability,ocr],execute:async request=>{
   calls.push(request.capability);executionContexts.push(request.execution)
   if(request.capability==='browser.read_page')return {success:true,output:{url:'http://localhost:8080/',text:''}}
   if(request.capability==='browser.screenshot')return screenshotResult()
   temporaryImage=path.join(request.workspace,request.args.path)
   assert.ok(existsSync(temporaryImage))
   return {success:true,output:{provider:'test-ocr',text:'2026年10月16日 星期五',confidence:0.91}}
  }},options(connection,{executionContext:{taskId:'ocr-task',workerId:'worker'},beforeExecution:cap=>{hooks.push('before:'+cap.name)},afterExecution:cap=>{hooks.push('after:'+cap.name)},messages:[{role:'user',content:'查看日期网页'}],imageCapability:'unsupported',approvalMode:'full',onActivity:activity=>activities.push(activity),onOutcome:value=>outcome=value}))
  assert.deepEqual(calls,['browser.read_page','browser.screenshot','agent.image_ocr'])
  assert.deepEqual(hooks,calls.flatMap(name=>['before:'+name,'after:'+name]))
  assert.ok(executionContexts.every(context=>context.taskId==='ocr-task'&&context.workerId==='worker'))
  assert.equal(executionContexts[2].parentEvidenceId,executionContexts[1].activityId)
  assert.ok(requests[1].messages.some(message=>typeof message.content==='string'&&message.content.includes('2026年10月16日 星期五')))
  assert.ok(requests.every(request=>request.messages.every(message=>!Array.isArray(message.content)||message.content.every(part=>part.type!=='image_url'))))
 },()=>({content:JSON.stringify({status:'complete',reason:'OCR 文字可供初步判断'})}))
 assert.equal(outcome,'complete')
 assert.equal(existsSync(temporaryImage),false)
 assert.match(activities.find(activity=>activity.capability==='agent.image_ocr').output,/2026年10月16日/)
})

test('OCR failure still passes the screenshot to a vision model',async()=>{
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 const ocr={...screenshotCapability,name:'agent.image_ocr',source:{type:'skill',skillId:'agent-tools'},runtime:'python-native',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}
 const activities=[]
 await withModel((input,n)=>n===1?toolCall(input,'browser.read_page',{}):{content:'我已查看原始截图'},async(connection,requests)=>{
  await runCoreChat({list:()=>[read,screenshotCapability,ocr],execute:async request=>request.capability==='browser.read_page'?{success:true,output:{url:'http://localhost:8080/',text:''}}:request.capability==='browser.screenshot'?screenshotResult():{success:false,error:'未安装 OCR 依赖'}},options(connection,{imageCapability:'supported',approvalMode:'full',onActivity:activity=>activities.push(activity)}))
  assert.ok(requests[1].messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')))
 })
 assert.equal(activities.find(activity=>activity.capability==='agent.image_ocr').status,'error')
 assert.equal(activities.find(activity=>activity.capability==='browser.screenshot').status,'complete')
})

test('browser read failure after opening a page falls back to an approved screenshot',async()=>{
 const open={...screenshotCapability,name:'browser.open',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}
 const read={...screenshotCapability,name:'browser.read_page',parameters:{type:'object',properties:{}}}
 const calls=[];let approvals=0
 await withModel((input,n)=>n===1?toolCall(input,'browser.open',{url:'http://localhost:8080/'}):n===2?toolCall(input,'browser.read_page',{}):{content:'已根据页面截图分析可见内容'},async(connection,requests)=>{
  await runCoreChat({list:()=>[open,read,screenshotCapability],execute:async request=>{
   calls.push(request.capability)
   return request.capability==='browser.open'?{success:true,output:{url:'http://localhost:8080/',loading:false}}:request.capability==='browser.read_page'?{success:false,error:'正文读取失败'}:screenshotResult()
  }},options(connection,{messages:[{role:'user',content:'查看已打开的日期网页'}],imageCapability:'supported',approvalMode:'ask',approve:async()=>{approvals++;return true}}))
  assert.deepEqual(calls,['browser.open','browser.read_page','browser.screenshot'])
  assert.equal(approvals,3)
  assert.ok(requests[2].messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')))
 })
})

test('text-only model retains screenshot for the user and waits instead of certifying visual success',async()=>{
 let outcome,text='',review;const activities=[]
 await withModel((input,n)=>n===1?toolCall(input,'browser.screenshot',{url:'http://localhost:8080/'}):{content:'我已经看图，全部通过'},async(connection,requests)=>{
  await runCoreChat({list:()=>[screenshotCapability],execute:async()=>screenshotResult()},options(connection,{currentStep:visualStep,imageCapability:'unsupported',approvalMode:'full',onActivity:a=>activities.push(a),onOutcome:value=>outcome=value,onContent:value=>text+=value,onCompletionReview:value=>review=value}))
  assert.equal(outcome,'needs_input');assert.match(text,/不支持图片识别/);assert.doesNotMatch(text,/全部通过/)
  assert.equal(review.missingEvidence.length,1)
  assert.ok(requests.every(request=>request.messages.every(m=>!Array.isArray(m.content)||m.content.every(part=>part.type!=='image_url'))))
  assert.equal(activities.at(-1).images.length,1);assert.equal(JSON.parse(activities.at(-1).output).visualInput,false)
  assert.equal(requests.length,3)
 })
})

test('a file or canvas assertion cannot stand in for a screenshot even when reviewer says complete',async()=>{
 let outcome,text=''
 await withModel(()=>({content:'canvas 宽高正常，玻璃已通过'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[screenshotCapability],execute:async()=>assert.fail()},options(connection,{currentStep:visualStep,imageCapability:'supported',onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(outcome,'blocked');assert.match(text,/尚无.*画面/);assert.equal(requests.length,4)
 })
})

test('explicit task-specific human visual confirmation permits the remaining completion review',async()=>{
 let outcome
 await withModel(()=>({content:'用户已确认本项视觉效果，其他条件已核验'}),async connection=>{
  await runCoreChat({list:()=>[],execute:async()=>assert.fail()},options(connection,{currentStep:visualStep,imageCapability:'unsupported',messages:[{role:'user',content:'确认「确认门头玻璃」视觉验收通过'}],onOutcome:value=>outcome=value}))
 })
 assert.equal(outcome,'complete')
})

test('validated card acceptance confirms only the current visual evidence and expires after a page change',async()=>{
 for(const change of [false,true]){
  let outcome
  const click={...screenshotCapability,name:'browser.click'}
  await withModel((input,n)=>change&&n===1?toolCall(input,'browser.click',{url:'http://localhost:8080/'}):{content:'已核验'},async connection=>{
   await runCoreChat({list:()=>[click],execute:async()=>({success:true,output:{performed:true}})},options(connection,{currentStep:{...visualStep,visualConfirmed:true},imageCapability:'unsupported',approvalMode:'full',messages:[{role:'user',content:'视觉效果符合要求，请核验其余条件'}],onOutcome:value=>outcome=value}))
  })
  assert.equal(outcome,change?'needs_input':'complete')
 }
})

test('completion with declared missing evidence cannot certify success',async()=>{
 let outcome,review
 await withModel(()=>({content:'通过'}),async connection=>{
  await runCoreChat({list:()=>[],execute:async()=>assert.fail()},options(connection,{onOutcome:value=>outcome=value,onCompletionReview:value=>review=value}))
 },()=>({content:JSON.stringify({status:'complete',reason:'完成',missingEvidence:['尚未取得测试结果']})}))
 assert.equal(outcome,'blocked');assert.deepEqual(review.missingEvidence,['尚未取得测试结果'])
})

test('changing the browser view invalidates earlier visual evidence',async()=>{
 let outcome
 const click={...screenshotCapability,name:'browser.click'}
 await withModel((input,n)=>n===1?toolCall(input,'browser.screenshot',{url:'http://localhost:8080/'}):n===2?toolCall(input,'browser.click',{url:'http://localhost:8080/'}):{content:'通过'},async connection=>{
  await runCoreChat({list:()=>[screenshotCapability,click],execute:async request=>request.capability==='browser.screenshot'?screenshotResult():{success:true,output:{performed:true}}},options(connection,{currentStep:visualStep,imageCapability:'supported',approvalMode:'full',onOutcome:value=>outcome=value}))
 })
 assert.equal(outcome,'blocked')
})

test('fresh screenshot timestamps do not manufacture new progress for identical pixels',async()=>{
 let calls=0,outcome
 await withModel(input=>input.tools?.length?toolCall(input,'browser.screenshot',{url:'http://localhost:8080/'}):{content:'现有截图不足以确认'},async connection=>{
  await runCoreChat({list:()=>[screenshotCapability],execute:async()=>{calls++;return screenshotResult()}},options({...connection,contextLength:32768},{approvalMode:'full',imageCapability:'supported',onOutcome:value=>outcome=value}))
 },()=>({content:JSON.stringify({status:'continue',reason:'截图仍未证明目标',nextStep:'核对其他画面证据'})}))
 assert.equal(calls,7);assert.equal(outcome,'blocked')
})

test('resumed chat can reuse an already recorded preview and complete with its actual URL',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'myplane-chat-preview-')),service=new StaticPreview()
 t.after(async()=>{await service.dispose();rmSync(workspace,{recursive:true,force:true})})
 writeFileSync(path.join(workspace,'index.html'),'live preview')
 await service.configure(true)
 const registry=new CapabilityRegistry({getAllTools:()=>[]});service.register(registry)
 const live=await service.start(workspace,undefined,new AbortController().signal)
 const journal={[operationKey('task',workspace,'preview.start',{})]:{status:'succeeded',updatedAt:new Date().toISOString()}}
 let outcome,approvals=0;const activities=[]
 await withModel((input,n)=>n===1?toolCall(input,'preview.start',{}):{content:'预览服务 URL 已取得：'+live.url},async connection=>{
  await runCoreChat(registry,options(connection,{workspace,filesEnabled:true,approvalMode:'ask',currentStep:{title:'启动静态预览服务并取得访问 URL',acceptance:'取得实际服务 URL'},
   beforeExecution:(cap,args)=>journalRequired(cap,args)?beginOperation(journal,operationKey('task',workspace,cap.name,args),()=>{}):undefined,
   approve:async()=>{approvals++;return true},onActivity:activity=>activities.push(activity),onOutcome:value=>outcome=value
  }))
 })
 assert.equal(outcome,'complete');assert.equal(approvals,1,'normal approval still applies')
 const result=JSON.parse(activities.find(activity=>activity.status==='complete').output)
 assert.equal(result.reused,true);assert.equal(result.url,live.url)
 assert.equal(await(await fetch(result.url)).text(),'live preview')
})

test('pre-change hook runs after authorization and blocks mutation before journaling',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'myplane-preflight-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}))
 for(const approved of [false,true]){
  const order=[]
  await withModel(input=>input.tools?toolCall(input,'agent.run_command',{query:'change'}):{content:'操作未执行'},async connection=>{
   await runCoreChat({list:()=>[capability('agent.run_command')],execute:async()=>assert.fail('blocked preflight must not execute')},options(connection,{workspace,filesEnabled:true,
    approve:async()=>{order.push('approval');return approved},beforeMutation:async()=>{order.push('baseline');return '基线权限受阻'},beforeExecution:()=>assert.fail('no started marker before preflight succeeds')
   }))
  })
  assert.deepEqual(order,approved?['approval','baseline']:['approval'])
 }
})

test('nonzero verification exit code yields to the bounded scheduler immediately',async()=>{
 let executions=0,failures=0,outcome
 await withModel(input=>toolCall(input,'agent.run_test',{query:'test'}),async connection=>{
  await runCoreChat({list:()=>[capability('agent.run_test')],execute:async()=>{executions++;return {success:true,output:{exitCode:1,output:'assertion failed'}}}},options(connection,{
   filesEnabled:true,approvalMode:'full',currentStep:{title:'修复',acceptance:'测试通过'},
   onVerificationFailure:activity=>{failures++;assert.equal(activity.status,'error')},onOutcome:value=>outcome=value
  }))
 })
 assert.equal(executions,1);assert.equal(failures,1);assert.equal(outcome,'blocked')
})

test('unchanged edits receive one bounded automatic recovery before stopping',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'myplane-unchanged-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}))
 let edits=0,reads=0,outcome,content='',rounds=0
 const write={...capability('agent.write_file'),parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}
 await withModel(input=>{
  if(!input.tools)return {content:'此前编辑未改变文件；需要核对实际内容，不能宣称修复完成。'}
  const n=++rounds
  return n%2?toolCall(input,'agent.write_file',{path:'./'.repeat(n)+'same.txt',content:'same'}):toolCall(input,'agent.read_file',{query:'read-'+n})
 },async connection=>{
  await runCoreChat({list:()=>[write,capability('agent.read_file','read')],execute:async request=>request.capability==='agent.write_file'?(edits++,{success:true,output:{status:'unchanged',changed:false,paths:[],unchangedPaths:[request.args.path]}}):(reads++,{success:true,output:'read evidence '+reads})},options(connection,{workspace,approvalMode:'full',filesEnabled:true,onOutcome:value=>outcome=value,onContent:value=>content+=value}))
 })
 assert.equal(edits,6);assert.equal(reads,5);assert.equal(outcome,'blocked');assert.match(content,/仍未产生有效修改/)
})

test('automatic edit recovery can read current content and complete a corrected edit',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'myplane-edit-recovery-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}))
 const file=path.join(workspace,'tests.txt');writeFileSync(file,'before')
 const write={...capability('agent.write_file'),parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}
 let edits=0,reads=0,outcome='',answer=''
 await withModel(input=>{
  if(!input.tools?.length)return {content:'此前写入无变化；下一步读取 tests.txt 并核对内容。'}
  if(edits<3)return toolCall(input,'agent.write_file',{path:'tests.txt',content:'before'})
  if(!reads)return toolCall(input,'agent.read_file',{query:'tests.txt'})
  if(edits===3)return toolCall(input,'agent.write_file',{path:'tests.txt',content:'after'})
  return {content:'已核对修改后的测试内容'}
 },async connection=>{
  await runCoreChat({list:()=>[write,capability('agent.read_file','read')],execute:async request=>{
   if(request.capability==='agent.read_file'){reads++;return {success:true,output:readFileSync(file,'utf8')}}
   edits++
   if(edits<=3)return {success:true,output:{status:'unchanged',changed:false}}
   writeFileSync(file,String(request.args.content));return {success:true,output:{changed:true}}
  }},options({...connection,contextLength:131072},{workspace,approvalMode:'full',filesEnabled:true,onOutcome:value=>outcome=value,onContent:value=>answer+=value}))
 })
 assert.equal(edits,4)
 assert.equal(reads,1)
 assert.equal(outcome,'complete')
 assert.equal(readFileSync(file,'utf8'),'after')
 assert.match(answer,/核对修改/)
})

test('resuming with three old edit failures permits read-only diagnosis before recovery policy runs',async()=>{
 const progress={files:{},ineffective:3},recoveryCounts=[]
 let reads=0,outcome
 const policies={invoke:async(id,data)=>{
  if(id==='clarification-policy')return {ask:false,question:''}
  if(id==='model-adapter')return {maxTokens:1024,temperature:0.2,toolLimit:32}
  if(id==='tool-selection')return {ids:[]}
  if(id==='history-memory')return {ids:[]}
  if(id==='context-compaction')return {triggerRatio:0.8,retainRecent:4}
  if(id==='error-recovery'){
   recoveryCounts.push(data.ineffectiveEdits)
   return data.ineffectiveEdits>=3?{action:'pause',reason:'旧失败次数不应停止读取'}:{action:'continue',reason:'继续诊断'}
  }
  if(id==='completion-review')return {status:data.status,reason:data.reason,nextStep:data.nextStep}
  throw new Error(`Unexpected policy ${id}`)
 }}
 await withModel(input=>reads?{content:'已读取当前文件并核对内容'}:toolCall(input,'agent.read_file',{query:'tests/gomoku.test.js'}),async connection=>{
  await runCoreChat({list:()=>[capability('agent.read_file','read')],execute:async()=>{reads++;return {success:true,output:{text:'当前测试内容'}}}},options(connection,{
   filesEnabled:true,approvalMode:'full',editProgress:progress,abilityPolicies:policies,
   currentStep:{title:'读取测试文件',acceptance:'确认当前测试内容'},onOutcome:value=>outcome=value
  }))
 })
 assert.equal(reads,1)
 assert.equal(outcome,'complete')
 assert.deepEqual(recoveryCounts,[0])
 assert.equal(progress.ineffective,0)
})

test('failed verification exposes edit tools even when the step title only says run tests',async()=>{
 const policies={invoke:async(id,data)=>{
  if(id==='clarification-policy')return {ask:false,question:''}
  if(id==='model-adapter')return {maxTokens:1024,temperature:0.2,toolLimit:32}
  if(id==='tool-selection')return {ids:[]}
  if(id==='history-memory')return {ids:[]}
  if(id==='context-compaction')return {triggerRatio:0.8,retainRecent:4}
  if(id==='error-recovery')return {action:'pause',reason:'测试仅检查修复工具是否可用'}
  if(id==='completion-review')return {status:data.status,reason:data.reason,nextStep:data.nextStep}
  throw new Error(`Unexpected policy ${id}`)
 }}
 let offered=false
 await withModel(input=>{
  const names=input.tools?.map(tool=>tool.function.description)||[]
  offered ||= names.some(name=>name.startsWith('agent.replace_text:'))&&names.some(name=>name.startsWith('agent.read_file:'))
  return {content:'需要修改源码后重新验证'}
 },async connection=>{
  await runCoreChat({list:()=>[capability('agent.read_file','read'),capability('agent.replace_text')],execute:async()=>assert.fail('tool need not execute')},options(connection,{
   filesEnabled:true,approvalMode:'full',abilityPolicies:policies,
   currentStep:{title:'运行测试套件验证改动',acceptance:'npm test 全部断言通过',repairRequired:true}
  }))
 })
 assert.equal(offered,true)
})

test('command timing and timeout variations are not fresh evidence',async()=>{
 let executions=0,outcome
 await withModel((input,n)=>input.tools?.length?toolCall(input,'agent.run_command',{query:'same command '+n}):{content:'现有命令结果不足以确认'},async connection=>{
  await runCoreChat({list:()=>[capability('agent.run_command')],execute:async()=>({success:true,output:{exitCode:0,output:'unchanged',durationMs:++executions}})},options(connection,{approvalMode:'full',filesEnabled:true,onOutcome:value=>outcome=value}))
 },()=>({content:JSON.stringify({status:'continue',reason:'命令结果没有变化',nextStep:'检查实际验收证据'})}))
 assert.equal(executions,7);assert.equal(outcome,'blocked')
})

test('completion review is scoped to the scheduled item, not the entire original request',async()=>{
 let reviewSeen=false
 await withModel(()=>({content:'读取完成，文件内容已核对'}),async connection=>{
  await runCoreChat({list:()=>[],execute:()=>assert.fail()},options(connection,{currentStep:{title:'读取文件',acceptance:'确认当前内容'}}))
 },input=>{
  reviewSeen=true;const systems=input.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')
  assert.match(systems,/当前项已满足条件即可 complete/);assert.match(systems,/确认当前内容/)
  return {content:JSON.stringify({status:'complete',reason:'当前项完成',nextStep:''})}
 })
 assert.equal(reviewSeen,true)
})

test('execution journal stops repeated successful commands before executing them again',async()=>{
 const journal={};let executions=0,outcome
 await withModel(input=>toolCall(input,'agent.run_command',{query:'command'}),async connection=>{
  await runCoreChat({list:()=>[capability('agent.run_command')],execute:async()=>{executions++;return {success:true,output:'done'}}},options(connection,{
   approvalMode:'full',filesEnabled:true,webEnabled:true,
   beforeExecution:(cap,args)=>beginOperation(journal,operationKey('task','workspace',cap.name,args),()=>{}),
   afterExecution:(cap,args,success)=>{journal[operationKey('task','workspace',cap.name,args)].status=success?'succeeded':'failed'},
   onOutcome:value=>outcome=value
  }))
 })
 assert.equal(executions,1);assert.equal(outcome,'blocked')
})

const capability = (name, risk = 'high') => ({name,category:'agent',description:name,parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},source:{type:'skill',skillId:'agent-tools'},runtime:'python-native',permissions:['network'],tags:risk==='read'?[]:['requires-approval',`risk:${risk}`]})
async function withModel(call, work, reviewCall) {
  const requests=[]
  let modelError
  const server=createServer(async(request,response)=>{
   try{
    let body='';for await(const part of request)body+=part
    const input=JSON.parse(body);requests.push(input)
    const isReview=input.messages.some(item=>item.role==='system'&&String(item.content).includes('你是任务完成检查器'))
    const message=isReview ? (reviewCall ? await reviewCall(input) : {content:JSON.stringify({status:'complete',reason:'已完成',nextStep:''})}) : await call(input,requests.length)
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify({choices:[{finish_reason:message.finish_reason || (message.tool_calls?'tool_calls':'stop'),message}],usage:{prompt_tokens:30,completion_tokens:5}}))
   }catch(error){
    modelError??=error
    response.writeHead(500,{'content-type':'application/json'})
    response.end(JSON.stringify({error:{message:String(error)}}))
   }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
   await work({endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:1024,contextLength:8192},requests)
   if(modelError)throw modelError
  }catch(error){throw modelError??error}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}

test('mock model assertion failures propagate and close the server instead of hanging',{timeout:5000},async()=>{
 await assert.rejects(withModel(()=>assert.fail('model fixture assertion'),async connection=>{
  await runCoreChat({list:()=>[],execute:async()=>assert.fail('no tools expected')},options(connection))
 }),/model fixture assertion/)
})

test('read-only completion prompts omit implementation evidence instead of soliciting an unbounded history list',async()=>{
 let outcome,reviews=0
 await withModel(()=>({content:'全部批次已按原文核对。'}),async connection=>{
  await runCoreChat({list:()=>[],execute:async()=>assert.fail('no replay needed')},options(connection,{onOutcome:value=>outcome=value}))
 },input=>{
  reviews++
  const instruction=input.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n')
  assert.match(instruction,/必须省略 implementation 字段/)
  assert.match(instruction,/逐字核对完整值，包括前后缀/)
  if(reviews===1)return {content:JSON.stringify({status:'complete',reason:'原文已齐全',implementation:{status:'present',evidenceIds:Array.from({length:9},(_,i)=>'old-'+i)}})}
  assert.match(instruction,/上次完成检查未返回有效格式/)
  return {content:JSON.stringify({status:'complete',reason:'原文已齐全'})}
 })
 assert.equal(reviews,2);assert.equal(outcome,'complete')
})

test('short history pages resume automatic compaction after the growth window, before a hard overflow',async()=>{
 let pages=0
 const metrics=[],seen=new Set()
 await withModel(input=>{
  if(String(input.messages[0]?.content).startsWith('仅压缩历史'))return {content:'历史已整理；继续按页读取，不重复操作。'}
  return pages<12?toolCall(input,'runtime.read_history',{query:'page-'+pages}):{content:'已经逐页读取12页原文。'}
 },async connection=>{
  await runCoreChat({list:()=>[capability('runtime.read_history','read')],execute:async()=>({success:true,output:{workerId:'worker',generation:1,text:`page-${++pages}: `+'source '.repeat(100),offset:pages*700}})},options(connection,{
   messages:[{role:'user',content:'逐页回读12页历史原文。'},{role:'assistant',content:'old log '.repeat(4000)},{role:'user',content:'继续回读'}],
   onContext:status=>{const report=status.lastCompaction;if(report?.outcome==='compressed'&&!seen.has(report.startedAt)){seen.add(report.startedAt);metrics.push(report)}},
  }))
 })
 assert.equal(pages,12);assert.ok(metrics.length>=2)
 assert.ok(metrics.slice(1).some(report=>report.beforeInputTokens+report.reservedOutput+report.safetyTokens<report.capacity),'growth-based compaction should resume before the hard limit')
 assert.ok(metrics.length<pages,'do not summarize every page')
})

test('tool reload after model admission refreshes the next step and asks under the new policy',async()=>{
 const registry=new CapabilityRegistry({getAllTools:()=>[]})
 let requests=0,oldCalls=0,newCalls=0,approvals=0,outcome
 const old={...capability('agent.read_file','read'),runtime:'builtin',description:'original provider'}
 const replacement={...capability('agent.read_file','high'),runtime:'builtin',description:'reloaded provider'}
 registry.registerBuiltin(old,async()=>{oldCalls++;return 'old'})
 await withModel(input=>newCalls?{content:'已通过更新后的工具读取结果。'}:toolCall(input,'agent.read_file',{query:input.tools[0].function.description.includes('reloaded')?'new':'old'}),async(connection,bodies)=>{
  await runCoreChat(registry,options(connection,{filesEnabled:true,onRequest:()=>{if(++requests===1)registry.registerBuiltin(replacement,async()=>{newCalls++;return 'fresh'})},approve:async()=>{approvals++;return true},onOutcome:value=>outcome=value}))
  const turns=bodies.filter(body=>body.tools?.length)
  assert.equal(turns[0].tools[0].function.name,turns[1].tools[0].function.name)
  assert.match(turns[0].tools[0].function.description,/original/);assert.match(turns[1].tools[0].function.description,/reloaded/)
  assert.ok(turns[1].messages.some(row=>row.role==='tool'&&String(row.content).includes('tool-admission-changed')))
 })
 assert.equal(oldCalls,0);assert.equal(newCalls,1);assert.equal(approvals,1);assert.equal(outcome,'complete')
})

test('withdrawn research providers refresh browser facts and do not force a stale web handoff correction',async()=>{
 const registry=new CapabilityRegistry({getAllTools:()=>[]}),browser={...capability('browser.read_page','read'),source:{type:'builtin'},runtime:'builtin'}
 registry.registerBuiltin(browser,async()=>assert.fail('withdrawn provider must not run'))
 registry.registerBuiltin({...capability('agent.web_search','read'),runtime:'builtin'},async()=>assert.fail('withdrawn search must not run'))
 let calls=0
 await withModel(input=>{
  if(++calls===1)return toolCall(input,'browser.read_page',{query:'page'})
  assert.equal(input.tools?.length||0,0)
  const instructions=input.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n')
  assert.match(instructions,/本轮实际浏览器工具：无/)
  assert.doesNotMatch(instructions,/本轮已实际提供以下联网工具/)
  return {content:'建议你自行访问网站 https://example.org；当前没有可用的网页读取工具。'}
 },async connection=>{
  await runCoreChat(registry,options(connection,{messages:[{role:'user',content:'读取 https://example.org'}],onRequest:()=>{if(calls===0){registry.unregister(browser.name);registry.unregister('agent.web_search')}}}))
 })
 assert.equal(calls,2,'a removed provider cannot trigger a correction claiming it is still available')
})

test('chat discards truncated tool calls and recovers with bounded output without executing partial work',async()=>{
 const executions=[], progress=[];let count=0,usage=0
 await withModel((input,n)=>n===1?{...toolCall(input,'agent.web_search',{query:'truncated'}),finish_reason:'length'}:n===2?toolCall(input,'agent.web_search',{query:'complete'}):{content:'已有完整查询结果'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{executions.push(request.args.query);return {success:true,output:{text:'result'}}}},options(connection,{approvalMode:'full',onRequest:()=>count++,onUsage:()=>usage++,onProgress:text=>progress.push(text)}))
  assert.deepEqual(executions,['complete'])
  assert.ok(progress.some(text=>text.includes('缩小本轮工作量')))
  assert.ok(requests[1].messages.some(m=>String(m.content).includes('不要继续拼接被截断的 JSON')))
  assert.equal(requests[1].messages.some(m=>m.role==='assistant'&&m.tool_calls),false)
  assert.ok(requests.every(r=>r.max_tokens<=connection.contextLength/2));assert.ok(requests[1].max_tokens>requests[0].max_tokens);assert.ok(count>=3);assert.ok(usage>=3)
 })
})

test('oversized model stream retries a smaller step without publishing partial output',async()=>{
 const requests=[];let reviews=0
 const server=createServer(async(request,response)=>{
  let body='';for await(const part of request)body+=part
  const input=JSON.parse(body);requests.push(input)
  const review=input.messages.some(message=>message.role==='system'&&String(message.content).includes('你是任务完成检查器'))
  const content=review?(++reviews===1?'r'.repeat(1_100_000):JSON.stringify({status:'complete',reason:'已核对当前结果'})):requests.length===1?'x'.repeat(1_100_000):'当前步骤已完成'
  response.setHeader('content-type','text/event-stream')
  response.end(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const connection={endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:65536,contextLength:131072}
  let answer='',outcome=''
  await runCoreChat({list:()=>[],execute:async()=>assert.fail('partial tool calls must not run')},options(connection,{onContent:value=>answer+=value,onOutcome:value=>outcome=value}))
  assert.equal(outcome,'complete')
  assert.equal(answer,'当前步骤已完成')
  assert.equal(requests.length,4)
  assert.ok(requests[1].max_tokens<=4096)
  assert.ok(requests[1].messages.some(message=>String(message.content).includes('只处理下一个最小步骤')))
  assert.ok(requests[3].max_tokens<=2048)
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('chat repeated truncation stops after three requests and preserves a blocked outcome',async()=>{
 let content='',outcome
 await withModel(()=>({content:'残缺的答案',finish_reason:'length'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[],execute:()=>assert.fail('must not execute')},options(connection,{onContent:text=>content+=text,onOutcome:value=>outcome=value}))
  assert.equal(requests.length,3);assert.equal(outcome,'blocked');assert.match(content,/连续三次/);assert.ok(!content.includes('残缺的答案'))
 })
})

test('chat output recovery grows 2048 to 4096 to 8192 without replaying truncated tools',async()=>{
 const executed=[]
 await withModel((input,n)=>n<=2?{...toolCall(input,'agent.web_search',{query:'discard-'+n}),finish_reason:'length'}:n===3?toolCall(input,'agent.web_search',{query:'valid'}):{content:'已获得结果'},async(connection,requests)=>{
  const configured={...connection,maxTokens:2048,contextLength:32768}
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{executed.push(request.args.query);return {success:true,output:'查询结果'}}},options(configured,{approvalMode:'full'}))
  assert.deepEqual(requests.slice(0,3).map(r=>r.max_tokens),[2048,4096,8192])
  assert.deepEqual(executed,['valid']);assert.equal(configured.maxTokens,2048)
 })
})

test('chat recovery stops when context capacity prevents output budget growth',async()=>{
 let outcome,content=''
 await withModel(()=>({content:'partial',finish_reason:'length'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[],execute:()=>assert.fail('must not execute')},options({...connection,maxTokens:2048,contextLength:4096},{onContent:text=>content+=text,onOutcome:value=>outcome=value}))
  assert.equal(outcome,'blocked');assert.equal(requests.length,2);assert.ok(requests.every(r=>r.max_tokens<=2048));assert.match(content,/无法继续提高额度/)
 })
})

test('small-step recovery constrains schemas and rejects oversized complete arguments before execution',async()=>{
 const executed=[]
 await withModel((input,n)=>n===1?{content:'too long',finish_reason:'length'}:n===2?toolCall(input,'agent.web_search',{query:'x'.repeat(2049)}):n===3?toolCall(input,'agent.web_search',{query:'small'}):{content:'已核对结果'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{executed.push(request.args.query);return {success:true,output:'result'}}},options(connection,{approvalMode:'full'}))
  assert.deepEqual(executed,['small'])
  assert.equal(requests[1].tools[0].function.parameters.properties.query.maxLength,2048)
  assert.ok(requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('2048')))
 })
})

test('recovery processes complete multiple calls sequentially without replay and keeps per-call argument guards',async()=>{
 const executed=[],progress=[];let running=0,outcome
 await withModel((input,n)=>{
  if(n===1)return {content:'partial',finish_reason:'length'}
  if(n===2){
   const calls=['first','second','x'.repeat(2049)].map((query,i)=>({...toolCall(input,'agent.web_search',{query}).tool_calls[0],id:'batch-'+i}))
   return {content:null,tool_calls:calls}
  }
  if(n===3)return toolCall(input,'agent.web_search',{query:'corrected'})
  return {content:'所有结果已核对'}
 },async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{
   assert.equal(running,0,'execution is sequential');running++
   await new Promise(resolve=>setTimeout(resolve,5))
   executed.push(request.args.query);running--;return {success:true,output:{query:request.args.query}}
  }},options(connection,{approvalMode:'full',onProgress:text=>progress.push(text),onOutcome:value=>outcome=value}))
  assert.deepEqual(executed,['first','second','corrected'])
  assert.equal(outcome,'complete')
  assert.ok(progress.some(text=>text.includes('逐个校验并顺序处理')))
  const replies=requests[2].messages.filter(m=>m.role==='tool')
  for(const id of ['batch-0','batch-1','batch-2'])assert.equal(replies.filter(m=>m.tool_call_id===id).length,1)
  assert.ok(replies.find(m=>m.tool_call_id==='batch-2').content.includes('2048'))
 })
})

test('truncation diagnostics distinguish reasoning from tool arguments',async()=>{
 let content=''
 await withModel(()=>({content:'',reasoning_content:'r'.repeat(100),finish_reason:'length'}),async(connection)=>{
  await runCoreChat({list:()=>[],execute:()=>assert.fail('must not execute')},options(connection,{onContent:text=>content+=text}))
  assert.match(content,/思考 100 字符/);assert.match(content,/服务仍返回大量思考内容/)
 })
})

test('chat truncation recovery respects cancellation before another request',async()=>{
 const controller=new AbortController()
 await withModel(()=>({content:'partial',finish_reason:'length'}),async(connection,requests)=>{
  await assert.rejects(runCoreChat({list:()=>[],execute:()=>assert.fail('must not execute')},options(connection,{signal:controller.signal,onProgress:text=>{if(text.includes('缩小本轮工作量'))controller.abort(new Error('cancel recovery'))}})),/cancel recovery/)
  assert.equal(requests.length,1)
 })
})
const toolCall=(input,name,args)=>({role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:input.tools.find(tool=>tool.function.description.startsWith(name+':')).function.name,arguments:JSON.stringify(args)}}]})
const options=(connection,overrides={})=>({connection,model:'test-model',messages:[{role:'user',content:'搜索今日天气'}],workspace:tmpdir(),filesEnabled:false,webEnabled:true,approvalMode:'ask',signal:new AbortController().signal,onRequest(){},onUsage(){},onContent(){},onReasoning(){},onActivity(){},approve:async()=>true,...overrides})

test('changed queries with identical search evidence switch to page reading and then restore search',async()=>{
 const calls=[],progress=[]
 await withModel((input,n)=>n<=3?toolCall(input,'agent.web_search',{query:'北京天气 '+n}):n===4?toolCall(input,'agent.web_fetch',{query:'https://example.com/weather'}):{content:'已核对预报'},async(connection,requests)=>{
  const registry={list:()=>[capability('agent.web_search'),capability('agent.web_fetch')],execute:async request=>{calls.push(request.capability);return {success:true,output:request.capability==='agent.web_search'?{query:request.args.query,searchedAt:String(calls.length),results:[{url:'https://example.com/weather',title:'北京预报',snippet:'预报页面'}]}:{text:'27日（明天）晴'}}}}
  await runCoreChat(registry,options(connection,{approvalMode:'full',onProgress:text=>progress.push(text)}))
  assert.equal(requests[3].tools.some(t=>t.function.description.startsWith('agent.web_search:')),false)
  assert.equal(requests[4].tools.some(t=>t.function.description.startsWith('agent.web_search:')),true)
  assert.ok(progress.some(text=>text.includes('搜索结果重复')))
  assert.deepEqual(calls,['agent.web_search','agent.web_search','agent.web_search','agent.web_fetch'])
  assert.equal(requests.at(-1).messages.at(-1).role,'user')
  assert.match(requests.at(-1).messages.at(-1).content,/JSON 检查结果/)
 })
})

test('research handoff is corrected into a page read; failed text fetch can use authorized browser readers',async()=>{
 const names=['agent.web_fetch','browser.open','browser.read_page'],calls=[]
 const caps=names.map(name=>({...capability(name),...(name.startsWith('browser.')?{source:{type:'builtin'},runtime:'builtin'}:{})}))
 await withModel((input,n)=>n===1?{content:'建议您访问中国天气网查询。'}:n<=4?toolCall(input,names[n-2],{query:'https://example.com/weather'}):{content:'页面预报已读取，未提供降雨概率'},async(connection,requests)=>{
  await runCoreChat({list:()=>caps,execute:async request=>{calls.push(request.capability);return request.capability==='agent.web_fetch'?{success:false,error:'页面正文依赖动态加载'}:{success:true,output:{text:'27日 晴',url:'https://example.com/weather'}}}},options(connection,{approvalMode:'full',messages:[{role:'user',content:'请访问 https://example.com/weather 查询北京明天天气'}]}))
  assert.deepEqual(calls,names)
  assert.ok(requests[1].messages.some(m=>m.role==='system'&&m.content.includes('把已授权的查询交回用户')))
  assert.ok(requests[0].messages.some(m=>m.role==='system'&&m.content.includes('不得从“晴”推断精确降雨概率')))
 })
})

test('guessed encyclopedia entry is redirected to search while explicit encyclopedia requests remain allowed',async()=>{
 for(const explicit of [false,true]){
  const calls=[]
  const fetchCapability={...capability('agent.web_fetch'),parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}
  await withModel((input,n)=>n===1?toolCall(input,'agent.web_fetch',{url:'https://baike.baidu.com/item/example'}):!explicit&&n===2?toolCall(input,'agent.web_search',{query:'上海明天天气'}):{content:'已核对来源'},async connection=>{
   await runCoreChat({list:()=>[capability('agent.web_search'),fetchCapability],execute:async request=>{calls.push(request.capability);return {success:true,output:'来源资料'}}},options(connection,{messages:[{role:'user',content:explicit?'请查百度百科中的上海词条':'搜索上海明天天气'}],approvalMode:'full'}))
  })
  assert.deepEqual(calls,[explicit?'agent.web_fetch':'agent.web_search'])
 }
})

test('stale network denial in continued history is corrected with actual tool names before review',async()=>{
 let executed=0,text=''
 await withModel((input,n)=>n===1?{content:'当前可用的工具中**没有联网搜索或网页读取能力**，http_request 仅限 localhost。'}:n===2?toolCall(input,'agent.web_search',{query:'上海明天天气'}):{content:'已取得天气资料'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search'),capability('agent.web_fetch')],execute:async()=>{executed++;return {success:true,output:'天气资料'}}},options(connection,{messages:[{role:'user',content:'上海明天下雨不？'},{role:'assistant',content:'没有联网搜索或网页读取能力'},{role:'user',content:'继续'}],approvalMode:'full',onContent:value=>text+=value}))
  assert.equal(executed,1);assert.equal(text,'已取得天气资料')
  const actualName=requests[0].tools.find(tool=>tool.function.description.startsWith('agent.web_search:')).function.name
  assert.ok(requests[0].messages.some(m=>m.role==='system'&&m.content.includes('agent.web_search → '+actualName)))
  assert.ok(requests[1].messages.some(m=>m.role==='system'&&m.content.includes('与实际工具列表不符')))
  assert.equal(requests[1].messages.filter(m=>m.role==='assistant').length,1,'discard the new false claim while keeping original history')
 })
})
test('persistent false denial stops after one correction and reports actual availability',async()=>{
 let text='',outcome=''
 await withModel(()=>({content:'没有联网搜索或网页读取能力'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>assert.fail('no fabricated tool execution')},options(connection,{onContent:value=>text+=value,onOutcome:value=>outcome=value}))
  assert.equal(requests.length,2);assert.equal(outcome,'blocked');assert.match(text,/本轮已提供联网/);assert.doesNotMatch(text,/没有联网搜索/)
 })
})
test('network disabled does not trigger a false denial correction',async()=>{
 await withModel(()=>({content:'没有联网搜索或网页读取能力'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>assert.fail('network is disabled')},options(connection,{webEnabled:false}))
  assert.equal(requests.length,2,'normal answer and completion review only')
  assert.equal(requests[0].tools,undefined)
  assert.ok(!requests.some(r=>r.messages.some(m=>m.role==='system'&&m.content.includes('本轮已实际提供'))))
 })
})

test('project chat initializes local Git before inference, while ordinary chat leaves its directory untouched',async()=>{
 const workspace=isolatedGitWorkspace('myplane-chat-git-')
 try{
  let shouldExist=false
  await withModel(()=>{
   assert.equal(existsSync(path.join(workspace,'.git')),shouldExist)
   return {content:'已完成检查'}
  },async connection=>{
   const registry={list:()=>[],execute:async()=>assert.fail('no file tool should be needed')}
   await runCoreChat(registry,options(connection,{workspace,filesEnabled:true}))
   assert.equal(existsSync(path.join(workspace,'.git')),false)
   shouldExist=true
   await runCoreChat(registry,options(connection,{workspace,filesEnabled:true,initializeLocalGit:true}))
   const config=readFileSync(path.join(workspace,'.git','config'),'utf8')
   assert.match(config,/localHistory = true/)
   assert.doesNotMatch(config,/\[remote /)
  })
 }finally{rmSync(workspace,{recursive:true,force:true})}
})

test('chat file writes save complete snapshots and local Git versions without sending snapshots to the model',async()=>{
 const workspace=isolatedGitWorkspace('myplane-chat-write-'),activities=[]
 writeFileSync(path.join(workspace,'hello.txt'),'original\ncontext')
 try{
  const write={...capability('agent.write_file'),parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}
  const registry={list:()=>[write],execute:async request=>{writeFileSync(path.join(workspace,request.args.path),request.args.content);return {success:true,output:'saved'}}}
  await withModel((input,n)=>n===1?toolCall(input,'agent.write_file',{path:'hello.txt',content:'updated\ncontext'}):{content:'已更新'},async(connection,requests)=>{
   await runCoreChat(registry,options(connection,{workspace,filesEnabled:true,initializeLocalGit:true,onActivity:activity=>activities.push(activity)}))
   const completed=activities.find(activity=>activity.status==='complete')
   assert.deepEqual(completed.fileChanges,[{path:'hello.txt',before:'original\ncontext',after:'updated\ncontext'}])
   assert.equal(execFileSync('git',['show','HEAD~1:hello.txt'],{cwd:workspace,encoding:'utf8',windowsHide:true}),'original\ncontext')
   assert.equal(execFileSync('git',['show','HEAD:hello.txt'],{cwd:workspace,encoding:'utf8',windowsHide:true}),'updated\ncontext')
   assert.doesNotMatch(JSON.stringify(requests[1].messages),/fileChanges|original/)
   assert.match(JSON.stringify(requests[1].messages),/本地 Git 状态快照/)
  })
 }finally{rmSync(workspace,{recursive:true,force:true})}
})

test('chat search waits for approval, executes a registered Skill and returns tool results to the model',async()=>{
  let executed=0,approval=0,text='',release
  const waiting=new Promise(resolve=>{release=resolve})
  await withModel((input,n)=>n===1?toolCall(input,'agent.web_search',{query:'成都天气'}):{content:'今天有雨。来源 https://example.com/weather'},async(connection,requests)=>{
    const registry={list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true,output:{results:[{title:'天气',url:'https://example.com/weather'}]}}}}
    const running=runCoreChat(registry,options(connection,{approve:async()=>{approval++;await waiting;return true},onContent:value=>{text+=value}}))
    while(!approval)await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(executed,0);release();await running
    assert.equal(executed,1);assert.equal(approval,1);assert.match(text,/https:\/\/example.com\/weather/)
    assert.match(requests[1].messages.find(item=>item.role==='tool').content,/天气/)
    assert.equal(requests[0].model,'test-model')
  })
})

test('denied tool is not executed and the model receives a denial with tools disabled',async()=>{
  let executed=0
  await withModel((input,n)=>n===1?toolCall(input,'agent.web_search',{query:'weather'}):{content:'操作已取消'},async(connection,requests)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true}}},options(connection,{approve:async()=>false}))
    assert.equal(executed,0);assert.equal(requests[1].tools,undefined);assert.match(requests[1].messages.at(-1).content,/拒绝/)
  })
})

test('network switch removes web, process and MCP tools; fabricated calls cannot execute',async()=>{
  const web=capability('agent.web_search'),command=capability('agent.run_command'),mcp={...web,name:'mcp.example.echo',source:{type:'mcp',serverId:'example'}}
  for(const item of [web,command,mcp])assert.equal(chatCapabilityAllowed(item,{filesEnabled:true,webEnabled:false}),false)
  let executed=0
  await withModel(()=>({content:null,tool_calls:[{id:'x',type:'function',function:{name:'cap_0',arguments:'{}'}}]}),async(connection,requests)=>{
    await assert.rejects(runCoreChat({list:()=>[web],execute:async()=>{executed++}},options(connection,{webEnabled:false})),/未授权/)
    assert.equal(requests[0].tools,undefined);assert.equal(executed,0);assert.equal(requests.length,3)
  })
})

test('a mistaken capability name is corrected through tool feedback before approval and execution',async()=>{
  let executed=0,approvals=0
  await withModel((input,n)=>{
    if(n===1)return {content:null,tool_calls:[{id:'wrong',type:'function',function:{name:'web_search',arguments:'{"query":"weather"}'}}]}
    if(n===2){
      assert.match(input.messages.at(-1).content,/不在本轮可用工具列表/)
      assert.match(input.tools[0].function.name,/agent_web_search/)
      return toolCall(input,'agent.web_search',{query:'weather'})
    }
    return {content:'搜索完成'}
  },async(connection)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true,output:'天气证据'}}},options(connection,{approve:async()=>{approvals++;return true}}))
    assert.equal(executed,1);assert.equal(approvals,1)
  })
})

test('mixed valid and unknown calls keep paired results and never replay the successful operation',async()=>{
  let executed=0
  await withModel((input,n)=>{
    if(n===1){const answer=toolCall(input,'agent.web_search',{query:'weather'});answer.tool_calls.push({id:'unknown',type:'function',function:{name:'invented_tool',arguments:'{}'}});return answer}
    const results=input.messages.filter(message=>message.role==='tool')
    assert.deepEqual(results.map(message=>message.tool_call_id),['call1','unknown'])
    assert.match(results[0].content,/complete/);assert.match(results[1].content,/工具未执行/)
    return {content:'搜索已完成，另一个工具不可用'}
  },async(connection)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true,output:'天气证据'}}},options(connection))
    assert.equal(executed,1)
  })
})

test('approval modes distinguish searches, workspace writes, risky commands and external paths',()=>{
  const base={workspace:tmpdir(),approvalMode:'auto'}
  assert.equal(chatApprovalRequired(capability('agent.web_search'),{query:'weather'},base),false)
  assert.equal(chatApprovalRequired(capability('agent.write_file','write'),{path:'note.txt'},base),false)
  assert.equal(chatApprovalRequired(capability('agent.run_command'),{command:'ls'},base),true)
  assert.equal(chatApprovalRequired(capability('agent.read_file','read'),{path:'../outside'},base),true)
  assert.equal(chatApprovalRequired(capability('agent.web_search'),{}, {...base,approvalMode:'ask'}),true)
  assert.equal(chatApprovalRequired(capability('agent.run_command'),{}, {...base,approvalMode:'full'}),false)
})

test('cancelling while approval is pending executes no tool',async()=>{
  const controller=new AbortController();let executed=0
  await withModel(input=>toolCall(input,'agent.web_search',{query:'weather'}),async(connection)=>{
    await assert.rejects(runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++}},options(connection,{signal:controller.signal,approve:async()=>{controller.abort();return false}})),{name:'AbortError'})
    assert.equal(executed,0)
  })
})

test('explicit external-file approval reaches Python Skill and does not leak into later calls',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'myplane-chat-')),workspace=path.join(root,'workspace'),skillsDir=path.join(root,'skills')
  mkdirSync(workspace);mkdirSync(skillsDir);writeFileSync(path.join(root,'outside.txt'),'external test data')
  cpSync(path.resolve('skills/agent-tools'),path.join(skillsDir,'agent-tools'),{recursive:true})
  let approvals=0
  const core=new AgentCoreService({dataDir:path.join(root,'data'),skillsDir,getConnection:()=>{throw Error('explicit connection expected')}})
  core.on('error',()=>{})
  try{
    await core.initialize()
    await withModel((input,n)=>n===1?toolCall(input,'agent.read_file',{path:path.join(root,'outside.txt')}):{content:'已读取测试文件'},async(connection,requests)=>{
      await core.runConversation(options({...connection,contextLength:32768},{workspace,filesEnabled:true,webEnabled:false,approve:async()=>{approvals++;return true}}))
      assert.equal(approvals,1);assert.match(requests[1].messages.find(item=>item.role==='tool').content,/external test data/)
    })
    const result=await core.getCapabilityRegistry().execute({capability:'agent.read_file',args:{path:path.join(root,'outside.txt')},workspace},new AbortController().signal)
    assert.equal(result.success,false)
  }finally{await core.dispose();rmSync(root,{recursive:true,force:true})}
})


test('incomplete prose is checked, continues with tools, and only the final candidate is published',async()=>{
  let execution=0, reviews=0, text=''
  await withModel((input,n)=> n===1?{content:'我接下来会搜索。'}:n===3?toolCall(input,'agent.web_search',{query:'weather'}):{content:'已核实天气'},async(connection,requests)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{execution++;return {success:true,output:'天气证据'}}},options(connection,{onContent:value=>text+=value}))
    assert.equal(execution,1);assert.equal(text,'已核实天气');assert.equal(reviews,2)
    assert.ok(requests[2].messages.some(item=>item.role==='system'&&item.content.includes('核实天气')))
  },()=>({content:JSON.stringify(++reviews===1?{status:'continue',reason:'尚未查询',nextStep:'搜索并核实天气'}:{status:'complete',reason:'已有证据'})}))
})

test('completion checks stop on missing user input without running extra tools',async()=>{
  let executions=0,text=''
  await withModel(()=>({content:'请提供城市。'}),async(connection,requests)=>{
    await runCoreChat({list:()=>[],execute:async()=>{executions++}},options(connection,{onContent:value=>text+=value}))
    assert.equal(executions,0);assert.equal(requests.length,2);assert.match(text,/请提供城市/)
  },()=>({content:JSON.stringify({status:'needs_input',reason:'缺少城市'})}))
})

test('invalid completion checks preserve candidate as unverified and never declare success',async()=>{
  let outcome='',text='',executions=0
  await withModel(()=>({content:'计划稍后处理'}),async(connection,requests)=>{
    await runCoreChat({list:()=>[],execute:async()=>{executions++}},options(connection,{onOutcome:value=>outcome=value,onContent:value=>text+=value}))
    assert.equal(outcome,'blocked');assert.equal(executions,0);assert.equal(requests.length,3)
    assert.match(text,/完成状态未确认/);assert.match(text,/计划稍后处理/)
    assert.ok(requests[2].messages.some(message=>String(message.content).includes('上次完成检查未返回有效格式')))
  },()=>({content:'invalid'}))
})

test('long executions review a bounded evidence ledger with actual failures',async()=>{
 let calls=0,outcome='',reviewAttempts=0
 await withModel((input,n)=>n<=25?toolCall(input,'agent.web_search',{query:'source '+n}):{content:'已根据已读取资料列出可优化项。'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>++calls===1?{success:false,error:'first source unavailable'}:{success:true,output:'source evidence '+calls}},options({...connection,contextLength:131072},{messages:[{role:'user',content:'梳理项目可优化项'}],approvalMode:'full',onOutcome:value=>outcome=value}))
  const reviews=requests.filter(request=>request.messages.some(message=>message.role==='system'&&String(message.content).includes('你是任务完成检查器'))),review=reviews[0]
  assert.ok(review,'completion review was requested')
  assert.equal(reviews.length,2)
  assert.equal(calls,25)
  assert.equal(outcome,'blocked')
  assert.equal(review.messages.filter(message=>message.role==='tool').length,0,'the full tool transcript is omitted')
  assert.ok(review.messages.length<=4,'the review context is bounded independently of operation count')
  assert.ok(JSON.stringify(reviews[1].messages).length<JSON.stringify(review.messages).length,'the retry uses a smaller ledger')
  const context=JSON.stringify(review.messages)
  assert.match(context,/first source unavailable/)
  assert.match(JSON.stringify(reviews[1].messages),/first source unavailable/)
  assert.match(context,/source evidence 25/)
  assert.deepEqual(JSON.parse(String(review.messages[1].content).split('\n').slice(1).join('\n')).unresolvedFailures,['agent.web_search'])
  assert.match(context,/已根据已读取资料列出可优化项/)
 },()=>++reviewAttempts===1?{content:'invalid'}:{content:JSON.stringify({status:'blocked',reason:'首个来源读取失败，仍需核对',nextStep:'核对失败来源'})})
})

test('completion review accepts a single JSON object wrapped in explanation and completed thinking',async()=>{
 let outcome=''
 await withModel(()=>({content:'回答内容'}),async(connection,requests)=>{
  await runCoreChat({list:()=>[],execute:async()=>assert.fail('review must not execute tools')},options(connection,{onOutcome:value=>outcome=value}))
  assert.equal(outcome,'complete');assert.equal(requests.length,2)
 },()=>({content:'<think>检查内容</think>检查结果：\n```json\n{"status":"complete","reason":"已回答问题"}\n```'}))
})

test('repeated incomplete responses stop at a bounded continuation limit',async()=>{
  await withModel(()=>({content:'稍后处理'}),async(connection,requests)=>{
    let text='',outcome
    await runCoreChat({list:()=>[],execute:async()=>{}},options(connection,{onContent:value=>text+=value,onOutcome:value=>outcome=value}))
    assert.equal(outcome,'blocked');assert.match(text,/连续两次完成检查没有获得新的执行证据/)
    assert.equal(requests.length,4)
  },()=>({content:JSON.stringify({status:'continue',reason:'未完成',nextStep:'执行搜索'})}))
})


test('large tool results use a bounded source projection without a model summary or broken tool pairs',async()=>{
  let executed=0, summaries=0; const states=[]
  await withModel((input)=>{
    if(input.messages[0].content.startsWith('仅压缩历史')){summaries++;return {content:'已搜索；返回天气资料，需要核实来源。'}}
    return executed?{content:'天气已核实'}:toolCall(input,'agent.web_search',{query:'weather'})
  },async(connection,requests)=>{
    const original=[{role:'user',content:'查询成都天气，只使用官方来源'}]
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true,output:'天气资料'.repeat(3000)}}},options(connection,{messages:original,onContext:state=>states.push(state)}))
    assert.equal(executed,1);assert.equal(summaries,0);assert.equal(states.at(-1).state,'ready')
    assert.ok(requests.some(request=>request.messages.some(message=>message.role==='tool'&&JSON.parse(message.content).projection?.readWith==='runtime.read_evidence')))
    assert.deepEqual(original,[{role:'user',content:'查询成都天气，只使用官方来源'}])
    for(const request of requests){
      assert.ok(estimateTokens(request.messages)+estimateTokens(request.tools)+32+request.max_tokens<=connection.contextLength)
      const pending=new Set()
      for(const message of request.messages){
        for(const call of message.tool_calls||[])pending.add(call.id)
        if(message.role==='tool'){assert.ok(pending.has(message.tool_call_id));pending.delete(message.tool_call_id)}
      }
      assert.equal(pending.size,0)
    }
    const review=requests.find(request=>request.messages.some(message=>String(message.content).includes('你是任务完成检查器')))
    assert.ok(review.messages.some(message=>message.content===original[0].content))
  })
})

test('oversized tool definitions fail before any model or tool request',async()=>{
  await withModel(()=>{throw Error('must not request model')},async(connection,requests)=>{
    const oversized={...capability('agent.web_search'),description:'大型工具定义'.repeat(4000)}
    await assert.rejects(runCoreChat({list:()=>[oversized],execute:async()=>{throw Error('must not execute')}},options(connection)),/上下文/)
    assert.equal(requests.length,0)
  })
})

test('failed tool results remain explicit evidence and can lead to a different next action',async()=>{
  let executions=0,reviews=0
  await withModel(input=>executions===0?toolCall(input,'agent.web_search',{query:'first'}):executions===1&&reviews===1?toolCall(input,'agent.web_search',{query:'retry'}):{content:executions===1?'没查到':'已核实'},async(connection,requests)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>++executions===1?{success:false,error:'搜索失败'}:{success:true,output:'官方资料'}},options(connection))
    assert.equal(executions,2)
    assert.ok(requests.some(request=>request.messages.some(message=>message.role==='tool'&&JSON.parse(message.content).status==='error')))
  },()=>({content:JSON.stringify(++reviews===1?{status:'continue',reason:'仍可调整关键词',nextStep:'修改关键词搜索'}:{status:'complete',reason:'已核实'})}))
})


test('invalid tool arguments are returned for correction without executing the invalid call',async()=>{
  let executions=0;const ids=[]
  await withModel((input,n)=>n===1?toolCall(input,'agent.web_search',{}):n===2?toolCall(input,'agent.web_search',{query:'weather'}):{content:'已查询'},async(connection)=>{
    await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executions++;return {success:true,output:'天气'}}},options(connection,{onActivity:activity=>ids.push(activity.id)}))
    assert.equal(executions,1);assert.equal(new Set(ids).size,2)
  })
})

test('tool commentary is a progress event and final output contains only the final answer',async()=>{
 const progress=[];let text='',outcome
 await withModel((input,n)=>n===1?{...toolCall(input,'agent.web_search',{query:'weather'}),content:'正在查询天气来源。'}:{content:'已核实天气。'},async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'官方天气'})},options(connection,{onProgress:(text,phase)=>progress.push({text,phase}),onContent:value=>text+=value,onOutcome:value=>outcome=value}))
  assert.equal(text,'已核实天气。');assert.equal(outcome,'complete')
  assert.ok(progress.some(entry=>entry.text==='正在查询天气来源。'))
  assert.ok(progress.some(entry=>entry.phase==='reviewing'))
 })
})

test('productive tasks automatically continue past twenty rounds and still require completion review',async()=>{
 let executed=0,outcome='',text=''
 await withModel((input,n)=>n<=25?toolCall(input,'agent.web_search',{query:'step '+n}):{content:'已完成全部检查'},async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'result '+ ++executed})},options({...connection,contextLength:131072},{onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,25);assert.equal(outcome,'complete');assert.equal(text,'已完成全部检查')
 })
})

test('a saved eight-round subagent continues through twenty-five productive rounds',async()=>{
 let executed=0,outcome='',text=''
 await withModel((input,n)=>n<=25?toolCall(input,'agent.read_file',{path:'part-'+n+'.txt'}):{content:'已读取全部资料'},async connection=>{
  const workspace='/tmp/myplane-round-limit',items=parseTaskItems(JSON.stringify({steps:[{title:'读取项目资料',acceptance:'取得所有资料并给出结论',kind:'inspect'}]}))
  items[0].worker={id:'saved-worker',mode:'read',assignedAt:'before',maxRounds:8,maxToolCalls:32,toolCalls:0}
  items[0].status='blocked';items[0].attempts=1
  const plan={taskId:'round-limit',workspace,graphVersion:1,items,updatedAt:''}
  const reader={...capability('agent.read_file','read'),parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}
  await runTaskPlan(options({...connection,contextLength:131072},{workspace,filesEnabled:true,approvalMode:'full',messages:[{role:'user',content:'读取项目全部资料并给出结论'}],onOutcome:value=>outcome=value,onContent:value=>text+=value}),{taskId:plan.taskId,plan,save:()=>{}},step=>runCoreChat({list:()=>[reader],execute:async()=>({success:true,output:'unique source '+ ++executed})},step))
  assert.equal(executed,25);assert.equal(outcome,'complete');assert.equal(items[0].status,'complete')
  assert.match(text,/已读取全部资料/);assert.doesNotMatch(text,/达到设置的执行上限/)
  assert.equal(items[0].worker.maxRounds,undefined)
 })
})

test('an exhausted saved subagent completes eighty-five more tool calls with automatic budgets',async()=>{
 let executed=0,outcome='',text=''
 await withModel((input,n)=>n<=85?toolCall(input,'agent.read_file',{path:'part-'+n+'.txt'}):{content:'已读取全部资料'},async connection=>{
  const workspace='/tmp/myplane-tool-limit',items=parseTaskItems(JSON.stringify({steps:[{title:'读取项目资料',acceptance:'取得所有资料并给出结论',kind:'inspect'}]}))
  items[0].worker={id:'saved-worker',mode:'read',assignedAt:'before',maxRounds:8,maxToolCalls:32,toolCalls:32}
  items[0].status='blocked';items[0].attempts=1;items[0].evidenceIds=['previous-source']
  const plan={taskId:'tool-limit',workspace,graphVersion:1,items,updatedAt:''}
  const reader={...capability('agent.read_file','read'),parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}
  await runTaskPlan(options({...connection,contextLength:131072},{workspace,filesEnabled:true,approvalMode:'full',messages:[{role:'user',content:'读取项目全部资料并给出结论'}],onOutcome:value=>outcome=value,onContent:value=>text+=value}),{taskId:plan.taskId,plan,save:()=>{}},step=>runCoreChat({list:()=>[reader],execute:async()=>({success:true,output:'unique source '+ ++executed})},step))
  assert.equal(executed,85);assert.equal(outcome,'complete');assert.equal(items[0].status,'complete')
  assert.match(text,/已读取全部资料/);assert.doesNotMatch(text,/达到.*上限/)
  assert.equal(items[0].worker.maxToolCalls,undefined);assert.equal(items[0].worker.toolCalls,117)
  assert.equal(items[0].evidenceIds.length,86);assert.ok(items[0].evidenceIds.includes('previous-source'))
 })
})

test('unchanged successful tool results trigger a strategy correction and bounded pause',async()=>{
 let executed=0,outcome='',text=''
 await withModel(input=>input.tools?.length?toolCall(input,'agent.web_search',{query:'same query'}):{content:'现有搜索结果不足以回答'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{executed++;return {success:true,output:'unchanged'}}},options({...connection,contextLength:131072},{onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,7);assert.equal(outcome,'blocked');assert.match(text,/连续 6 轮/)
  assert.ok(requests.some(request=>request.messages.some(message=>String(message.content).includes('避免重复相同操作'))))
 },()=>({content:JSON.stringify({status:'continue',reason:'尚缺少可靠来源',nextStep:'读取实际来源网页'})}))
})

test('stalled read-only analysis can finish from collected evidence without another tool call',async()=>{
 let executed=0,outcome='',text=''
 await withModel(input=>input.tools?.length?toolCall(input,'agent.read_file',{query:'same file'}):input.messages.some(message=>message.role==='tool'||message.tool_calls?.length)?{content:'<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="cap_2_agent_read_file">'}:{content:'已根据读取结果列出性能、代码质量、可维护性、用户体验和测试覆盖的候选优化点。'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.read_file','read')],execute:async()=>{executed++;return {success:true,output:'项目源码与测试记录'}}},options({...connection,contextLength:131072},{filesEnabled:true,currentStep:{title:'梳理项目现状与可优化维度',acceptance:'依据已读取的源码和测试记录列出候选优化点，不修改文件'},reviewQueue:{phase:'implement',implementationRecovery:true,revision:0,checks:[]},onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,7)
  assert.equal(outcome,'complete',text)
  assert.match(text,/候选优化点/)
  assert.ok(requests.some(request=>!request.tools?.length&&request.messages.some(message=>String(message.content).includes('根据已成功取得的资料回答'))))
  assert.ok(requests.filter(request=>!request.tools?.length).every(request=>request.messages.every(message=>message.role!=='tool'&&!message.tool_calls?.length)))
 })
})

test('explicit round limits preserve partial progress and do not declare completion',async()=>{
 let executed=0,outcome='',text=''
 await withModel((input,n)=>toolCall(input,'agent.web_search',{query:'step '+n}),async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'result '+ ++executed})},options(connection,{maxRounds:2,onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,2);assert.equal(outcome,'blocked');assert.match(text,/成功 2 次/);assert.match(text,/2 轮/)
 })
})

test('productive auto continuation completes beyond sixty rounds',async()=>{
 let executed=0,outcome='',text=''
 await withModel((input,n)=>n<=65?toolCall(input,'agent.web_search',{query:'step '+n}):{content:'全部完成'},async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'result '+ ++executed})},options({...connection,contextLength:131072},{onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,65);assert.equal(outcome,'complete');assert.equal(text,'全部完成')
 })
})


test('browser snapshot IDs do not keep an unchanged page loop running',async()=>{
 let executed=0,text='',outcome
 const browser={...capability('browser.read_page'),parameters:{type:'object',properties:{}},source:{type:'builtin'},runtime:'builtin'}
 await withModel(input=>input.tools?.length?toolCall(input,'browser.read_page',{}):{content:'页面资料仍不足以完成'},async(connection)=>{
  await runCoreChat({list:()=>[browser],execute:async()=>({success:true,output:{snapshot:'fresh-'+ ++executed,url:'http://localhost/',text:'unchanged',elements:[]}})},options({...connection,contextLength:131072},{onOutcome:value=>outcome=value,onContent:value=>text+=value}))
  assert.equal(executed,7);assert.equal(outcome,'blocked');assert.match(text,/连续 6 轮/)
 },()=>({content:JSON.stringify({status:'continue',reason:'页面内容没有变化',nextStep:'核对其他来源'})}))
})

test('explicit limits above twenty are honored without an early stop',async()=>{
 let executed=0,text=''
 await withModel((input,n)=>toolCall(input,'agent.web_search',{query:'step '+n}),async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'result '+ ++executed})},options({...connection,contextLength:131072},{maxRounds:23,onContent:value=>text+=value}))
  assert.equal(executed,23);assert.match(text,/23 轮/)
 })
})

test('productive continuation remains cancellable after sixty rounds',async()=>{
 let executed=0
 const controller=new AbortController()
 await withModel((input,n)=>toolCall(input,'agent.web_search',{query:'step '+n}),async(connection)=>{
  await assert.rejects(runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>{if(++executed===62)controller.abort();return {success:true,output:'result '+executed}}},options({...connection,contextLength:131072},{signal:controller.signal})),{name:'AbortError'})
  assert.equal(executed,62)
 })
})


test('new execution evidence resets unsuccessful completion review retries',async()=>{
 let turns=0,reviews=0,executed=0,outcome
 await withModel(input=>++turns%2?toolCall(input,'agent.web_search',{query:'step '+turns}):{content:'本段处理结果'},async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'evidence '+ ++executed})},options({...connection,contextLength:131072},{onOutcome:value=>outcome=value}))
  assert.equal(reviews,6);assert.equal(executed,6);assert.equal(outcome,'complete')
 },()=>({content:JSON.stringify(++reviews<6?{status:'continue',reason:'还有剩余步骤',nextStep:'检查下一项'}:{status:'complete',reason:'全部核验完成'})}))
})


test('stalled execution reports the concrete tool failure',async()=>{
 let text=''
 await withModel(input=>toolCall(input,'agent.web_search',{query:'same'}),async(connection)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:false,error:'连接失败'})},options({...connection,contextLength:131072},{onContent:value=>text+=value}))
  assert.match(text,/最近一次工具失败：agent.web_search/);assert.match(text,/连接失败/)
 })
})

test('full approval takes effect before later waiting events and model requests',async()=>{
 let mode='ask',approvals=0;const activities=[],executed=[]
 await withModel((input,n)=>n<=3?toolCall(input,'agent.web_search',{query:'query-'+n}):{content:'已完成'},async(connection,requests)=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async request=>{executed.push(request.args.query);return {success:true,output:'结果 '+request.args.query}}},options(connection,{
   getApprovalMode:()=>mode,onActivity:activity=>activities.push({...activity}),
   approve:async()=>{approvals++;mode='full';return true}
  }))
  assert.equal(approvals,1)
  assert.equal(activities.filter(a=>a.status==='waiting').length,1)
  assert.equal(executed.length,3)
  assert.ok(requests[1].messages.some(m=>m.role==='system'&&String(m.content).includes('权限模式：full。')))
 })
})

test('saved task items continue past the former sixteen-round cap and complete with evidence',async()=>{
 let executed=0,outcome;const saved=[]
 const plan={taskId:'round-regression',workspace:tmpdir(),items:parseTaskItems(JSON.stringify({steps:[{title:'核验交互',acceptance:'取得全部检查证据'}]})),updatedAt:''}
 await withModel((input,n)=>n<=25?toolCall(input,'agent.web_search',{query:'step '+n}):{content:'全部检查完成'},async connection=>{
  const registry={list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'evidence '+ ++executed})}
  await runTaskPlan(options({...connection,contextLength:131072},{onOutcome:value=>outcome=value}),{taskId:plan.taskId,plan,save:value=>saved.push(structuredClone(value))},step=>runCoreChat(registry,step))
 })
 assert.equal(executed,25);assert.equal(outcome,'complete')
 assert.equal(saved.at(-1).items[0].status,'complete')
 assert.equal(saved.at(-1).items[0].evidenceIds.length,25)
})

test('resumed optimization advice defers an unrelated failed test instead of blocking its checklist',async()=>{
 const goal='项目还可以怎么优化',scope=createTaskScope(goal),check={id:'old-test',signature:'old-test',revision:0,status:'failed',attempts:1,title:'运行 Gomoku 测试',capability:'agent.run_test_case',args:{target:'tests/gomoku.test.js',runner:'node'},basis:goal,required:true,summary:'3 个用例失败'}
 const plan={taskId:'advice',workspace:tmpdir(),scope,items:[{id:'advice-item',title:'梳理并确认可优化项清单',acceptance:'列出可优化项，不修改文件',status:'blocked',attempts:1,summary:'此前测试失败',evidenceIds:[],verification:[{kind:'test',script:'test'}],reviewQueue:{revision:0,checks:[check]}}],updatedAt:''}
 let outcome='',verified=0
 await runTaskPlan(options({endpoint:'http://127.0.0.1:9/v1',key:'',maxTokens:1024,contextLength:8192},{onOutcome:value=>outcome=value}),{taskId:plan.taskId,plan,save(){}},async step=>{
  assert.equal(step.reviewQueue.checks[0].status,'deferred')
  assert.deepEqual(plan.items[0].verification,[])
  step.onOutcome('complete');step.onContent('候选优化项：补充失败用例分析与边界条件测试。')
 },async()=>{verified++;return []})
 assert.equal(outcome,'complete')
 assert.equal(verified,0)
 assert.equal(plan.items[0].status,'complete')
})
test('completed advice checklist discards model-added implementation tasks on resume',async()=>{
 const scope=createTaskScope('项目还可以怎么优化'),workspace=tmpdir()
 const plan={taskId:'advice-only',workspace,scope,items:[
  {id:'list',title:'梳理并确认可优化项清单',acceptance:'列出优化建议，不修改文件',status:'complete',attempts:1,summary:'P0 测试稳定性；P1 搜索性能；P2 移动端清晰度。',evidenceIds:['source']},
  {id:'edit',title:'实现 AI 搜索优化（置换表与迭代加深）',acceptance:'修改 useAI.js，npm test 全部通过',status:'blocked',attempts:1,summary:'没有修改源码',evidenceIds:[]},
  {id:'review',title:'核对整体任务结果',acceptance:'整体检查',status:'pending',attempts:0,summary:'',evidenceIds:[]},
 ],updatedAt:''}
 let saved,outcome='',content=''
 await runTaskPlan(options({endpoint:'http://127.0.0.1:9/v1',key:'',maxTokens:1024,contextLength:8192},{workspace,onOutcome:value=>outcome=value,onContent:value=>content+=value}),{taskId:plan.taskId,plan,save:value=>saved=value},async()=>assert.fail('已完成的建议清单无需再执行'))
 assert.equal(outcome,'complete')
 assert.equal(saved.items.length,1)
 assert.equal(saved.items[0].id,'list')
 assert.match(content,/搜索性能/)
 assert.doesNotMatch(content,/实现 AI 搜索优化/)
})

test('new optimization advice gets one read-only task regardless of planner output',async()=>{
 let seen,outcome=''
 await runTaskPlan(options({endpoint:'http://127.0.0.1:9/v1',key:'',maxTokens:1024,contextLength:8192},{workspace:tmpdir(),onOutcome:value=>outcome=value}),{taskId:'new-advice',goal:'项目还可以怎么优化',save:value=>{seen=value}},async step=>{
  assert.equal(step.currentStep.title,'梳理项目可优化项')
  assert.match(step.currentStep.acceptance,/不修改任何文件/)
  step.onOutcome('complete');step.onContent('候选项：改善 AI 搜索和测试稳定性。')
 })
 assert.equal(outcome,'complete')
 assert.equal(seen.items.length,1)
})
test('optimization review treats prior failing tests as findings without requiring a rerun',async()=>{
 const goal='项目还可以怎么优化';let outcome='',answer=''
 await withModel(input=>{
  assert.equal(input.tools?.some(tool=>/agent\.run_test_case|agent\.run_test|agent\.run_command/.test(tool.function.description)),false)
  assert.ok(input.messages.some(message=>String(message.content).includes('失败结果是可引用的问题线索')))
  return {content:'测试记录显示 63 项通过、3 项失败。候选优化项：定位失败用例的边界条件，补充对应测试；梳理性能和可维护性问题。'}
 },async connection=>{
  await runCoreChat({list:()=>[capability('agent.run_test_case'),capability('agent.read_file','read')],execute:async()=>assert.fail('无需重复运行测试')},options(connection,{filesEnabled:true,taskScope:createTaskScope(goal),currentStep:{title:'梳理并确认可优化项清单',acceptance:'依据已读取资料列出候选优化点，不修改文件'},onOutcome:value=>outcome=value,onContent:value=>answer+=value}))
 },input=>{
  assert.ok(input.messages.some(message=>String(message.content).includes('已有失败测试是待分析的项目现状')))
  return {content:JSON.stringify({status:'complete',reason:'已列出候选优化项'})}
 })
 assert.equal(outcome,'complete');assert.match(answer,/3 项失败/)
})

test('remembered operations bypass waiting while changed arguments still prompt',async()=>{
 const activities=[];let approvals=0
 await withModel((input,n)=>n<=2?toolCall(input,'agent.web_search',{query:n===1?'remembered':'changed'}):{content:'完成'},async connection=>{
  await runCoreChat({list:()=>[capability('agent.web_search')],execute:async()=>({success:true,output:'结果'})},options(connection,{
   approvalGranted:activity=>activity.args.query==='remembered',onActivity:a=>activities.push({...a}),approve:async()=>{approvals++;return true}
  }))
  assert.equal(approvals,1)
  assert.deepEqual(activities.filter(a=>a.status==='waiting').map(a=>a.args.query),['changed'])
 })
})

test('experience flow executes through normal chat permissions and reports actual checks',async t=>{
 const {ExperienceFlow}=await import('../dist-electron/main/agent/core/experience-flow.js')
 const {ExperienceStore}=await import('../dist-electron/main/agent/core/experience-store.js')
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-chat-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}))
 const store=new ExperienceStore(workspace);store.record('搜索 Vue 文档',workspace,['agent.web_search','agent.web_fetch'],true)
 const entry=store.state().entries[0],query='搜索 Vue 文档'
 const search=capability('agent.web_search','read')
 const fetch={...capability('agent.web_fetch','read'),parameters:{type:'object',properties:{url:{type:'string'},maxCharacters:{type:'number'}},required:['url']}}
 for(const allowed of [false,true]){
  const flow=new ExperienceFlow(entry,{query:'Vue 文档'},workspace),executions=[],progress=[];let approvals=0
  await withModel(()=>({content:allowed?'Vue 文档已读取。':'操作被拒绝。'}),async connection=>{
   await runCoreChat({list:()=>[search,fetch],execute:async request=>{
    executions.push(request.capability)
    return {success:true,output:request.capability==='agent.web_search'?{results:[{title:'Vue 文档',url:'https://vuejs.org/guide'}]}:{url:'https://vuejs.org/guide',text:'Vue 文档 Composition API'}}
   }},options(connection,{workspace,messages:[{role:'user',content:query}],experienceFlow:flow,approve:async()=>{approvals++;return allowed},onProgress:message=>progress.push(message)}))
  })
  assert.equal(approvals,allowed?2:1)
  assert.deepEqual(executions,allowed?['agent.web_search','agent.web_fetch']:[])
  assert.equal(flow.passed,allowed)
  assert.ok(progress.some(message=>message.includes(allowed?'本次检查通过':'本次检查未通过')))
 }
})
test('conversation adopts verified file recipe before asking the model and preserves use evidence',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-service-')),track=workspaceCleanup(t,workspace)
 writeFileSync(path.join(workspace,'README.md'),'Current file evidence.')
 const service=track(new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.experiences.record('读取 README.md',workspace,['agent.read_file'],true)
 const entry=service.experienceState().entries[0]
 service.experiences.verify(entry.id,1,true,[],'通过');service.enableExperience(entry.id,1,true)
 service.capabilityRegistry.registerBuiltin({...capability('agent.read_file','read'),runtime:'builtin',parameters:{type:'object',properties:{path:{type:'string'},startLine:{type:'number'},endLine:{type:'number'}},required:['path']}},async args=>({path:args.path,text:readFileSync(path.join(workspace,args.path),'utf8')}))
 let saved;const progress=[]
 await withModel(input=>{assert.ok(input.messages.some(m=>m.role==='tool'&&String(m.content).includes('Current file evidence')));return {content:'Current file evidence.'}},async connection=>{
  const query='读取 README.md'
  await service.runConversation(options(connection,{workspace,filesEnabled:true,webEnabled:false,messages:[{role:'user',content:query}],planExecution:{taskId:'recipe',goal:query,save:value=>saved=value},onProgress:message=>progress.push(message)}))
 })
 assert.equal(saved.items[0].status,'complete');assert.ok(saved.items[0].evidenceIds.length)
 assert.equal(service.experienceState().entries[0].uses,1)
 assert.ok(progress.some(message=>message.includes('采用经验流程')))
 assert.equal(service.experienceState().entries[0].enabled,true)
})

test('conversation recovers failed recipe pages without learning duplicate or failed tool traces',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-fallback-')),track=workspaceCleanup(t,workspace)
 const service=track(new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.experiences.record('搜索 Vue 文档',workspace,['agent.web_search','agent.web_fetch'],true)
 const entry=service.experienceState().entries[0]
 service.experiences.verify(entry.id,1,true,[],'通过');service.enableExperience(entry.id,1,true)
 const calls=[],progress=[]
 service.capabilityRegistry.registerBuiltin({...capability('agent.web_search','read'),runtime:'builtin'},async()=>({results:[{title:'Vue 文档',url:'https://example.org/broken'},{title:'Vue 文档',url:'https://example.org/guide'}]}))
 service.capabilityRegistry.registerBuiltin({...capability('agent.web_fetch','read'),runtime:'builtin',parameters:{type:'object',properties:{url:{type:'string'},maxCharacters:{type:'number'}},required:['url']}},async args=>{calls.push(args.url);if(args.url.endsWith('broken'))throw new Error('offline');return {url:args.url,text:'Vue 文档的完整说明'}})
 let outcome
 await withModel(input=>{return {content:'已取得 Vue 文档说明。'}},async connection=>{
  await service.runConversation(options(connection,{workspace,approvalMode:'full',messages:[{role:'user',content:'搜索 Vue 文档'}],onOutcome:value=>outcome=value,onProgress:message=>progress.push(message)}))
 })
 assert.equal(outcome,'complete',JSON.stringify({calls,progress}));assert.equal(calls.length,2,JSON.stringify({calls,progress}))
 assert.ok(progress.some(message=>message.includes('下一条')))
 assert.equal(service.experienceState().entries.length,1)
 const current=service.experienceState().entries[0];assert.equal(current.successes,2);assert.equal(current.failures,0);assert.equal(current.enabled,true)
})


test('recipe denial and cancellation preserve enabled status and use interruption counts',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-interruption-')),track=workspaceCleanup(t,workspace)
 for(const kind of ['denied','cancelled']){
  const service=track(new AgentCoreService({dataDir:path.join(workspace,kind),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
  service.experiences.record('搜索 Vue 文档',workspace,['agent.web_search','agent.web_fetch'],true)
  const entry=service.experienceState().entries[0];service.experiences.verify(entry.id,1,true,[],'ok');service.enableExperience(entry.id,1,true)
  const controller=new AbortController()
  service.capabilityRegistry.registerBuiltin({...capability('agent.web_search','read'),runtime:'builtin'},async()=>{controller.abort();controller.signal.throwIfAborted()})
  service.capabilityRegistry.registerBuiltin({...capability('agent.web_fetch','read'),runtime:'builtin'},async()=>assert.fail('fetch must not run'))
  await withModel(()=>({content:'本次未执行。'}),async connection=>{
   const run=service.runConversation(options(connection,{workspace,signal:controller.signal,messages:[{role:'user',content:'搜索 Vue 文档'}],approve:async()=>kind!=='denied'}))
   if(kind==='cancelled')await assert.rejects(run);else await run
  })
  const current=service.experienceState().entries[0]
  assert.equal(current.enabled,true);assert.equal(current.status,'verified');assert.equal(current.failures,0);assert.equal(current.interruptions,1);assert.equal(current.lastIssue.kind,kind)
 }
})
test('chat reports recipe mismatch and retains a safe diagnostic for the library',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-mismatch-')),track=workspaceCleanup(t,workspace)
 const service=track(new AgentCoreService({dataDir:workspace,skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.experiences.record('搜索 Vue 文档',workspace,['agent.web_search','agent.web_fetch'],true)
 const entry=service.experienceState().entries[0],progress=[]
 await withModel(()=>({content:'需要可用的搜索工具。'}),async connection=>{
  await service.runConversation(options(connection,{workspace,messages:[{role:'user',content:'搜索 Vue 文档'}],onProgress:message=>progress.push(message)}))
 })
 assert.ok(progress.some(line=>line.includes('经验未采用')&&line.includes('未通过验证')))
 assert.ok(service.experienceState().entries[0].lastMatch.reasons.includes('tools'))
})

test('equivalent file requests reuse one certified recipe with unchanged permission gates',async t=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'experience-phrases-')),track=workspaceCleanup(t,workspace)
 writeFileSync(path.join(workspace,'README.md'),'Current phrase evidence')
 const service=track(new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>({})}));service.initialized=true
 service.experiences.record('读取 README.md',workspace,['agent.read_file'],true)
 const entry=service.experienceState().entries[0]
 service.experiences.verify(entry.id,1,true,[],'ok');service.enableExperience(entry.id,1,true)
 const calls=[],progress=[]
 service.capabilityRegistry.registerBuiltin({...capability('agent.read_file','read'),runtime:'builtin',parameters:{type:'object',properties:{path:{type:'string'},startLine:{type:'number'},endLine:{type:'number'}},required:['path']}},async args=>{calls.push(args.path);return {path:args.path,text:readFileSync(path.join(workspace,args.path),'utf8')}})
 await withModel(()=>({content:'Current phrase evidence'}),async connection=>{
  for(const query of ['读取 README.md','请帮我看一下 README.md']){
   await service.runConversation(options(connection,{workspace,filesEnabled:true,webEnabled:false,messages:[{role:'user',content:query}],onProgress:message=>progress.push(message)}))
  }
 })
 assert.deepEqual(calls,['README.md','README.md']);assert.equal(service.experienceState().entries.length,1)
 assert.equal(service.experienceState().entries[0].uses,2)
 assert.equal(progress.filter(line=>line.includes('采用经验流程')).length,2)
 assert.equal(service.experiences.match('请帮我看一下 README.md',{workspace,region:'CN',webEnabled:false,filesEnabled:false,tools:['agent.read_file']}),undefined)
})
