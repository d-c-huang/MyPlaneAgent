import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {RuntimeWorkbench,validateNodeConfiguration} from '../dist-electron/main/agent/core/runtime-workbench.js'
import {ExecutionInspector} from '../dist-electron/main/agent/core/execution-inspector.js'
import {runTaskPlan} from '../dist-electron/main/agent/core/task-plan-runner.js'
import {runCoreChat} from '../dist-electron/main/agent/core/chat-runner.js'
import {verifyTaskRules} from '../dist-electron/main/agent/core/task-verification.js'
const schema={type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}
const item=(id,dependsOn=[])=>({id,title:'读取 '+id,acceptance:'取得真实结果',kind:'inspect',kindSource:'explicit',mode:'read',parallel:true,dependsOn,status:'pending',attempts:0,summary:'',evidenceIds:[]})
function fixture(){
 const abort=new AbortController(),inspector=new ExecutionInspector(abort.signal),session={id:randomUUID(),title:'测试',model:'fixture',systemPrompt:'',messages:[],createdAt:'',updatedAt:'',taskPlan:{taskId:'test',workspace:tmpdir(),graphVersion:1,items:[item('a'),item('b'),item('c',['a'])],updatedAt:''}}
 let saves=0
 const workbench=new RuntimeWorkbench(session,inspector,()=>saves++)
 const command=(action,nodeId='task:a',extra={})=>workbench.command({sessionId:session.id,nodeId,commandId:randomUUID(),expectedRevision:workbench.configuration(workbench.scope(nodeId)).revision,action,...extra})
 return {abort,inspector,session,workbench,command,saves:()=>saves}
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5))
async function until(check){for(let i=0;i<300;i++){if(check())return;await tick()}throw Error('checkpoint timeout')}
async function modelServer(t,respond){
 const requests=[],server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);requests.push(input);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:respond?.(input)||{role:'assistant',content:'已取得真实结果'}}],usage:{prompt_tokens:20,completion_tokens:5}}))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 return {requests,connection:{endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:1024,contextLength:8192}}
}
const options=(connection,overrides={})=>({connection,model:'fixture',messages:[{role:'user',content:'读取并汇总资料'}],workspace:tmpdir(),filesEnabled:true,webEnabled:true,approvalMode:'full',signal:new AbortController().signal,onRequest(){},onUsage(){},onContent(){},onReasoning(){},onActivity(){},approve:async()=>true,...overrides})

test('concurrent checkpoints are independently editable and scope mismatch cannot release another worker',async()=>{
 const {inspector}=fixture();inspector.command({action:'pause',scopeId:'a'});inspector.command({action:'pause',scopeId:'b'})
 const a=inspector.before('tool','search','plugin',{query:'a'},schema,'call-a',undefined,{scopeId:'a'})
 const b=inspector.before('tool','search','plugin',{query:'b'},schema,'call-b',undefined,{scopeId:'b'})
 assert.equal(inspector.snapshot().checkpointIds.length,2)
 assert.throws(()=>inspector.command({action:'step',scopeId:'b',checkpointId:'call-a'}),/不属于/)
 inspector.command({action:'step',scopeId:'a',checkpointId:'call-a',args:{query:'changed'}})
 assert.deepEqual(await a,{query:'changed'});assert.deepEqual(inspector.snapshot().checkpointIds,['call-b'])
 inspector.command({action:'continue',scopeId:'b',checkpointId:'call-b'});await b
 assert.equal(inspector.isPaused('a'),true);assert.equal(inspector.isPaused('b'),false)
})

test('real model transport receives applied prompt at the paused boundary and step pauses the next request',async t=>{
 const {requests,connection}=await modelServer(t),{workbench,command,abort,inspector}=fixture()
 command('pause')
 const request=workbench.requestModel('a','worker-a',connection,'fixture',[{role:'user',content:'原始目标'}],abort.signal,{tools:false})
 assert.equal(requests.length,0)
 command('apply','task:a',{config:{...workbench.configuration('a').config,instruction:'返回精确的三行内容',input:'人工补充资料'}})
 const checkpoint=inspector.snapshot().calls.find(call=>call.status==='paused')
 command('step','task:a',{checkpointId:checkpoint.id})
 await request
 assert.ok(requests[0].messages.some(message=>message.content.includes('返回精确的三行内容')))
 assert.ok(requests[0].messages.some(message=>message.content.includes('人工补充资料')))
 assert.equal(workbench.activities.get('a').appliedRevision,1)
 assert.equal(inspector.snapshot().calls.find(call=>call.id===checkpoint.id).args.instruction,'返回精确的三行内容')
 assert.equal(inspector.snapshot().calls.find(call=>call.id===checkpoint.id).edited,true)
 const next=workbench.requestModel('a','worker-a',connection,'fixture',[],abort.signal,{tools:false})
 assert.equal(requests.length,1)
 const reject=assert.rejects(next);abort.abort();await reject
})

test('scheduler keeps independent worker B moving while A pauses, then resumes A and its downstream',async()=>{
 const {workbench,command,abort,session}=fixture(),seen=[]
 command('pause')
 const run=runTaskPlan(options({},{workbench,signal:abort.signal}),{taskId:'test',goal:'读取并汇总资料',plan:session.taskPlan,save:plan=>{session.taskPlan=plan}},async step=>{seen.push(step.executionContext.itemId);step.onOutcome('complete');step.onContent('读取成功')})
 await until(()=>seen.includes('b'))
 assert.deepEqual(seen,['b']);assert.equal(workbench.detail('task:a').checkpoint.kind,'stage')
 command('continue','task:a',{checkpointId:workbench.detail('task:a').checkpoint.id})
 await run;assert.deepEqual(seen,['b','a','c']);assert.ok(session.taskPlan.items.every(item=>item.status==='complete'))
})

test('cancelling a paused worker does not cancel its independent peer or run dependents',async()=>{
 const {workbench,command,abort,session}=fixture(),seen=[]
 command('pause')
 const run=runTaskPlan(options({},{workbench,signal:abort.signal}),{taskId:'test',goal:'读取并汇总资料',plan:session.taskPlan,save:plan=>{session.taskPlan=plan}},async step=>{seen.push(step.executionContext.itemId);step.onOutcome('complete');step.onContent('ok')})
 await until(()=>seen.includes('b'));command('cancel');await run
 assert.deepEqual(seen,['b']);assert.equal(session.taskPlan.items[1].status,'complete');assert.equal(session.taskPlan.items[2].status,'pending');assert.equal(abort.signal.aborted,false)
})

test('configuration changes archive evidence and invalidate only effective downstream dependencies',()=>{
 const {workbench,command,session}=fixture();workbench.active=false
 for(const task of session.taskPlan.items){task.status='complete';task.attempts=1;task.evidenceIds=['evidence-'+task.id];task.summary='original result '+task.id}
 session.operationJournal={already:{status:'succeeded',updatedAt:'now'}}
 command('apply','task:a',{config:{...workbench.configuration('a').config,instruction:'新的处理要求'}})
 assert.deepEqual(session.taskPlan.items.map(item=>item.status),['pending','complete','pending'])
 assert.deepEqual(workbench.data.archives.map(row=>row.item.evidenceIds),[['evidence-a'],['evidence-c']])
 assert.equal(session.operationJournal.already.status,'succeeded')
 assert.throws(()=>command('apply','task:a',{expectedRevision:0,config:workbench.configuration('a').config}),/版本已变化/)
 const id=randomUUID(),config={...workbench.configuration('a').config,instruction:'下一版'}
 command('apply','task:a',{commandId:id,config});command('apply','task:a',{commandId:id,config})
 assert.equal(workbench.configuration('a').revision,2)
})

test('invalid dependencies and live structural edits are rejected before any plan or version mutation',()=>{
 const {workbench,command,session}=fixture(),config={...workbench.configuration('a').config,dependsOn:['c']}
 assert.throws(()=>command('apply','task:a',{config}),/结束当前运行/)
 workbench.active=false;const before=JSON.stringify(session.taskPlan)
 assert.throws(()=>command('apply','task:a',{config}),/循环/)
 assert.equal(JSON.stringify(session.taskPlan),before);assert.equal(workbench.configuration('a').revision,0)
 assert.throws(()=>validateNodeConfiguration({instruction:'',input:'',model:'',maxRequests:-1}),/正整数/)
 assert.throws(()=>validateNodeConfiguration({instruction:'',input:'',model:'',fileScope:['../outside']}),/相对路径/)
})

test('completed nodes retain valid downstream evidence until an inactive versioned rerun is possible',()=>{
 const {workbench,command,session}=fixture();session.taskPlan.items[0].status='complete'
 const config={...workbench.configuration('a').config,instruction:'修改已完成环节'}
 assert.equal(workbench.detail('task:a').controllable,false)
 assert.throws(()=>command('pause'),/本轮已结束/)
 assert.throws(()=>command('apply','task:a',{config}),/结果已被使用/)
 command('draft','task:a',{config})
 assert.equal(workbench.configuration('a').revision,0)
 workbench.active=false;command('apply','task:a',{config})
 assert.equal(session.taskPlan.items[0].status,'pending')
})

test('paused tool edits reach real execution, while revoked tools cannot execute',async t=>{
 const {connection}=await modelServer(t,input=>!input.tools?{role:'assistant',content:JSON.stringify({status:'complete',reason:'已核验',nextStep:''})}:input.messages.some(row=>row.role==='tool')?{role:'assistant',content:'查询完成'}:{role:'assistant',content:'',tool_calls:[{id:'one',type:'function',function:{name:input.tools[0].function.name,arguments:JSON.stringify({query:'original'})}}]})
 const {workbench,command,abort,inspector}=fixture(),executed=[]
 const capability={name:'agent.web_search',description:'search',source:{type:'skill',skillId:'agent-tools'},runtime:'python',permissions:['network'],parameters:schema,tags:['requires-approval']}
 // Arm pause from the model response via onUsage, so the following tool is the checkpoint.
 const run=runCoreChat({list:()=>[capability],execute:async request=>{executed.push(request.args);return {success:true,output:'真实结果'}}},options(connection,{workbench,signal:abort.signal,executionContext:{itemId:'a',workerId:'worker-a'},inspectTool:(cap,args,id,context,signal)=>workbench.inspectTool(cap,args,id,context.itemId,context.workerId,signal),onUsage:()=>{if(!executed.length)command('pause')},onActivity:activity=>inspector.update(activity.id,activity.status==='denied'?'error':activity.status,activity.output)}))
 await until(()=>workbench.detail('task:a').checkpoint?.kind==='tool')
 assert.equal(executed.length,0)
 command('continue','task:a',{checkpointId:workbench.detail('task:a').checkpoint.id,args:{query:'用户修正的参数'}})
 await run;assert.deepEqual(executed,[{query:'用户修正的参数'}])
 command('apply','task:a',{config:{...workbench.configuration('a').config,tools:[]}})
 await assert.rejects(workbench.inspectTool(capability,{query:'blocked'},randomUUID(),'a'),/已禁用/)
})

test('drafts, templates and historical calls survive reconstruction without acquiring live controls',async()=>{
 const {workbench,command,session}=fixture()
 command('draft','task:a',{config:{...workbench.configuration('a').config,instruction:'未应用草稿'}})
 assert.equal(workbench.configuration('a').revision,0)
 command('template-save','task:a',{name:'审查员',config:{...workbench.configuration('a').config,instruction:'审查代码'}})
 assert.equal(workbench.data.templates[0].config.dependsOn,undefined)
 workbench.finish()
 const restored=new RuntimeWorkbench(structuredClone(session),new ExecutionInspector(new AbortController().signal),()=>{});restored.active=false
 assert.equal(restored.detail('task:a').draft.instruction,'未应用草稿');assert.equal(restored.detail('task:a').templates.length,1)
 assert.equal(restored.detail('task:a').checkpoint,undefined)
})

test('revoking a tool while its approval is open prevents execution even after approval',async t=>{
 const {workbench,command,abort}=fixture(),executed=[],activities=[]
 const {connection}=await modelServer(t,input=>!input.tools||input.messages.some(row=>row.role==='tool')?{role:'assistant',content:JSON.stringify({status:'complete',reason:'已检查',nextStep:''})}:{role:'assistant',content:'',tool_calls:[{id:'one',type:'function',function:{name:input.tools[0].function.name,arguments:JSON.stringify({query:'pending approval'})}}]})
 const cap={name:'agent.web_search',description:'search',source:{type:'skill',skillId:'agent-tools'},runtime:'python',permissions:['network'],parameters:schema,tags:['requires-approval']}
 await runCoreChat({list:()=>[cap],execute:async request=>{executed.push(request);return {success:true,output:'must not run'}}},options(connection,{workbench,signal:abort.signal,approvalMode:'ask',maxRounds:2,executionContext:{itemId:'a',workerId:'worker-a'},onActivity:activity=>activities.push(activity),approve:async()=>{command('apply','task:a',{config:{...workbench.configuration('a').config,tools:[]}});return true}}))
 assert.equal(executed.length,0)
 assert.ok(activities.some(activity=>activity.status==='error'&&activity.output.includes('已禁用')))
})

test('deterministic file verification has a checkpoint and its acceptance target cannot be edited',async()=>{
 const {workbench,command,abort}=fixture();command('pause')
 let checks=0
 const run=verifyTaskRules({list:()=>[],executeFileCheck:async()=>{checks++;return {success:true,output:{exists:true,passed:true}}}},options({},{workbench,signal:abort.signal,executionContext:{itemId:'a',workerId:'worker-a'},inspectTool:(cap,args,id,context,signal)=>workbench.inspectTool(cap,args,id,context.itemId,context.workerId,signal)}),[{kind:'file',path:'expected.txt',contains:'required content'}])
 await until(()=>workbench.detail('task:a').checkpoint?.kind==='tool')
 const checkpoint=workbench.detail('task:a').checkpoint
 assert.equal(checks,0)
 assert.throws(()=>command('continue','task:a',{checkpointId:checkpoint.id,args:{kind:'file',path:'wrong.txt'}}),/参数无效/)
 command('continue','task:a',{checkpointId:checkpoint.id})
 const results=await run;assert.equal(checks,1);assert.equal(results[0].passed,true)
})
