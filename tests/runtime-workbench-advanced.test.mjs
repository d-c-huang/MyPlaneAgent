import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {RuntimeTemplateLibrary} from '../dist-electron/main/runtime-template-library.js'
import {RuntimeGraphHistory} from '../dist-electron/main/runtime-graph-history.js'
import {RuntimeGraphStore} from '../dist-electron/main/runtime-graph-store.js'
import {LocalAgentService} from '../dist-electron/main/agent/service.js'
import {RuntimeWorkbench} from '../dist-electron/main/agent/core/runtime-workbench.js'
import {ExecutionInspector} from '../dist-electron/main/agent/core/execution-inspector.js'
import {runtimeWorkflowDraft} from '../dist-electron/main/runtime-workflow-export.js'
import {WorkflowService} from '../dist-electron/main/agent/workflow.js'
import {CoreWorkflowAdapter} from '../dist-electron/main/agent/core-workflow-adapter.js'
import {createWorkflowExecution,validateWorkflowExecution} from '../dist-electron/main/agent/workflow-execution.js'

function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-workbench-advanced-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
const config={instruction:'检查真实证据',input:'资料',model:'fixture',tools:['agent.read_file'],maxRequests:2}
function workbench(items){return new RuntimeWorkbench({id:randomUUID(),title:'模板与流程测试',model:'fixture',messages:[],createdAt:'',updatedAt:'',taskPlan:{taskId:'test',workspace:'D:/private-project',graphVersion:1,updatedAt:'',items}},new ExecutionInspector(new AbortController().signal),()=>{})}
const item=(id,extra={})=>({id,title:id,kind:'inspect',mode:'read',acceptance:'取得真实证据',status:'complete',attempts:3,summary:'旧结果',evidenceIds:['private-evidence'],...extra})

test('shared templates persist independently of sessions, version updates are optimistic and imports never overwrite',t=>{
 const root=directory(t),library=new RuntimeTemplateLibrary(root)
 const first=library.command({action:'save',name:'审查员',config:{...config,title:'不可移植的任务',dependsOn:['a'],fileScope:['file.txt']}})[0]
 assert.equal(first.revision,1);assert.equal(first.config.title,undefined);assert.equal(first.config.dependsOn,undefined);assert.equal(first.config.fileScope,undefined)
 const next=new RuntimeTemplateLibrary(root).command({action:'save',id:first.id,expectedRevision:1,name:'审查员',config:{...config,instruction:'新版指令'}})[0]
 assert.equal(next.revision,2);assert.equal(next.history[0].config.instruction,config.instruction)
 assert.throws(()=>library.command({action:'save',id:first.id,expectedRevision:1,name:'冲突',config}),/版本已变化/)
 const rows=library.command({action:'import',json:JSON.stringify({format:'myplane-node-template',version:1,name:first.name,config:first.config})})
 assert.equal(rows.length,2);assert.notEqual(rows[0].id,first.id);assert.equal(rows[1].revision,2)
 assert.throws(()=>library.command({action:'import',json:JSON.stringify({format:'myplane-node-template',version:1,name:'bad',config:{...config,workspace:'C:/'}})}),/不支持的字段/)
 assert.throws(()=>library.command({action:'import',json:'{"format":"myplane-node-template","version":2}'}),/格式或版本/)
 assert.throws(()=>library.command({action:'delete',id:first.id,expectedRevision:1}),/版本已变化/)
 assert.equal(library.command({action:'delete',id:first.id,expectedRevision:2}).length,1)
 assert.equal(new RuntimeTemplateLibrary(root).list()[0].id,rows[0].id)
})

test('history is immutable, bounded, deduplicated, session isolated and recoverable after restart',t=>{
 const root=directory(t),history=new RuntimeGraphHistory(root),sessionId=randomUUID()
 t.after(()=>history.dispose())
 const graph={version:1,sessionId,title:'记录',active:true,updatedAt:'now',sessions:[{id:'other',title:'其他会话'}],nodes:[{id:'worker:a',kind:'worker',status:'paused',detail:'x'.repeat(1000),metrics:[{label:'量',value:'y'.repeat(500)}]}],edges:[],events:[],truncated:false}
 history.capture(graph,'run-a','已暂停');const first=history.index(sessionId).entries[0]
 graph.updatedAt='later';history.capture(graph,'run-a','无变化');assert.equal(history.index(sessionId).entries.length,1)
 graph.nodes[0].status='running';history.capture(graph,'run-a','继续执行');assert.equal(history.frame(sessionId,first.id).snapshot.nodes[0].status,'paused')
 const copy=history.frame(sessionId,first.id);copy.snapshot.nodes[0].status='error';assert.equal(history.frame(sessionId,first.id).snapshot.nodes[0].status,'paused')
 assert.equal(copy.snapshot.sessions.length,0);assert.equal(copy.snapshot.nodes[0].detail.length,240)
 history.flush(sessionId);const restored=new RuntimeGraphHistory(root);t.after(()=>restored.dispose());assert.equal(restored.index(sessionId).entries.length,2)
 for(let i=0;i<130;i++){graph.nodes[0].activity=String(i);history.capture(graph,'run-a','变化')}
 assert.equal(history.index(sessionId).entries.length,120);assert.equal(history.index(sessionId).truncated,true)
 assert.throws(()=>history.frame(sessionId,first.id),/保留范围/);assert.throws(()=>history.index('../outside'),/会话 ID/)
 assert.equal(history.index(randomUUID()).entries.length,0)
 // Evict the read-only test instance before deletion to emulate an application restart.
 restored.dispose();history.remove(sessionId);assert.equal(fs.existsSync(path.join(root,sessionId+'.json')),false);history.dispose()
})

test('history reports disk write failures and recovers after the storage problem is resolved',t=>{
 const root=directory(t),history=new RuntimeGraphHistory(root),sessionId=randomUUID()
 history.capture({version:1,sessionId,title:'x',active:true,updatedAt:'',sessions:[],nodes:[],edges:[],events:[],truncated:false},'run','开始')
 const blocked=path.join(root,sessionId+'.json');fs.mkdirSync(blocked)
 assert.throws(()=>history.flush(sessionId));assert.throws(()=>history.index(sessionId),/无法写入磁盘/)
 fs.rmdirSync(blocked);history.flush(sessionId);assert.equal(history.index(sessionId).entries.length,1);history.dispose()
})

test('final and restored graph snapshots retain configuration revisions without copying private definitions',()=>{
 const wb=workbench([item('a',{worker:{id:'wa',mode:'read',assignedAt:'',toolCalls:0}})])
 wb.data.nodes.a={revision:3,config:{...config,instruction:'private instruction'},history:[]}
 const store=new RuntimeGraphStore();store.start(wb.session,'run');store.finish(wb.session.id,'run')
 const final=store.snapshot(wb.session.id);assert.equal(final.nodes.find(node=>node.id==='worker:wa').configRevision,3);assert.doesNotMatch(JSON.stringify(final),/private instruction/)
 const restored=new RuntimeGraphStore();restored.remember(wb.session,true);assert.equal(restored.snapshot(wb.session.id).nodes.find(node=>node.id==='task:a').configRevision,3)
})

test('checkpoint observer records actual paused and released states before the awaiting worker resumes',async()=>{
 const states=[];let inspector
 inspector=new ExecutionInspector(new AbortController().signal,true,label=>states.push({label,state:inspector.snapshot()}))
 const pending=inspector.before('tool','read','builtin',{}, {type:'object'},'checkpoint')
 assert.equal(states.at(-1).state.calls[0].status,'paused');assert.deepEqual(states.at(-1).state.checkpointIds,['checkpoint'])
 inspector.command({action:'step',checkpointId:'checkpoint'});await pending
 assert.equal(states.at(-1).state.calls[0].status,'ready');assert.equal(states[0].state.calls[0].status,'paused');inspector.finish()
})

test('workflow draft preserves effective parent prerequisites, applied restrictions and deterministic acceptance',t=>{
 const root=directory(t),wb=workbench([item('before'),item('parent',{dependsOn:['before'],childIds:['left','right']}),item('left',{parentId:'parent',verification:[{kind:'file',path:'proof.txt'}]}),item('right',{parentId:'parent'}),item('after',{dependsOn:['parent']})])
 wb.data.nodes.main={revision:2,config:{...config,input:'根资料',tools:['agent.read_file','agent.list_files']},history:[]}
 wb.data.nodes.left={revision:1,config:{...config,instruction:'子指令',tools:['agent.read_file','agent.write_file'],maxRequests:1},draft:{...config,instruction:'不导出草稿'},history:[]}
 const draft=runtimeWorkflowDraft(wb)
 assert.equal(draft.enabled,false);assert.deepEqual(draft.entryNodeIds,['task_1'])
 assert.deepEqual(draft.nodes[0].branches[0].targetNodeIds,['task_2','task_3','task_4'])
 assert.deepEqual(draft.nodes[2].branches[0].targetNodeIds,['task_2'])
 assert.deepEqual(draft.nodes[1].branches[0].targetNodeIds,['task_5'])
 assert.equal(draft.nodes[1].config.inputSignalMode,'all')
 const node=draft.nodes[2];assert.deepEqual(node.config.execution.tools,['agent.read_file']);assert.equal(node.config.execution.maxRequests,1)
 assert.deepEqual(node.config.execution.task.verification,[{kind:'file',path:'proof.txt'}]);assert.match(node.config.instruction,/子指令/);assert.match(node.config.instruction,/根资料/)
 assert.doesNotMatch(JSON.stringify(draft),/private-project|private-evidence|不导出草稿|旧结果/)
 const service=new WorkflowService(root,{projects:()=>[],start(){throw Error('must not execute')},stop(){}});t.after(()=>service.dispose())
 const saved=service.save(draft);assert.equal(saved.enabled,false);assert.equal(saved.version,1)
 const reloaded=service.definitions().find(row=>row.id===saved.id);assert.deepEqual(reloaded.nodes[2].config.execution,JSON.parse(JSON.stringify(node.config.execution)))
 const changed=service.save({...reloaded,nodes:reloaded.nodes.map(row=>row.id==='task_3'?{...row,config:{...row.config,execution:{...row.config.execution,maxRequests:4}}}:row)})
 assert.equal(changed.version,2);assert.equal(changed.nodes[2].config.execution.maxRequests,4)
})

test('legacy plans keep original sequence; invalid verification and cycles fail without exporting a partial workflow',()=>{
 const wb=workbench([item('a'),item('b')]);delete wb.session.taskPlan.graphVersion
 assert.deepEqual(runtimeWorkflowDraft(wb).nodes[0].branches[0].targetNodeIds,['task_2'])
 wb.session.taskPlan.items[0].verificationProblem={message:'bad'};assert.throws(()=>runtimeWorkflowDraft(wb),/验收规则/)
 delete wb.session.taskPlan.items[0].verificationProblem;wb.session.taskPlan.items[0].dependsOn=['b'];wb.session.taskPlan.items[1].dependsOn=['a'];assert.throws(()=>runtimeWorkflowDraft(wb),/循环/)
 assert.throws(()=>validateWorkflowExecution({task:{title:'a',acceptance:'b',verification:[{kind:'file',path:'../secret'}]}}),/相对路径/)
 assert.throws(()=>validateWorkflowExecution({tools:['agent.read_file'],approveAll:true}),/格式无效/)
})

test('exported workflow controls reach real model and tool boundaries and preserve task verification',async t=>{
 const root=directory(t),requests=[],server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 const policy={tools:['agent.read_file'],maxRequests:1,maxToolCalls:1,task:{title:'读取',acceptance:'文件存在',kind:'inspect',mode:'read',verification:[{kind:'file',path:'proof.txt'}]}}
 const controller=new AbortController(),runtime=createWorkflowExecution(policy,randomUUID(),root,'fixture',controller.signal)
 assert.equal(runtime.session.taskPlan.items[0].status,'pending');assert.deepEqual(runtime.session.taskPlan.items[0].verification,policy.task.verification)
 const connection={endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',contextLength:8192,maxTokens:1024}
 await runtime.workbench.requestModel('workflow-task',undefined,connection,'fixture',[{role:'user',content:'read'}],controller.signal,{tools:false})
 await assert.rejects(runtime.workbench.requestModel('workflow-task',undefined,connection,'fixture',[{role:'user',content:'read'}],controller.signal,{tools:false}),/请求预算/);assert.equal(requests.length,1)
 const cap={name:'agent.read_file',source:{type:'builtin'},parameters:{type:'object'}}
 await runtime.workbench.inspectTool(cap,{},'one','workflow-task')
 await assert.rejects(runtime.workbench.inspectTool(cap,{},'two','workflow-task'),/工具调用预算/)
 await assert.rejects(runtime.workbench.inspectTool({...cap,name:'agent.write_file'},{},'three','workflow-task'),/禁用此工具/)
 let forwarded
 const adapter=new CoreWorkflowAdapter(async()=>({runPlannedTask:async(_task,options)=>{forwarded=options;return {success:true,answer:'ok'}},getCapabilityRegistry:()=>({get:()=>undefined})}),{projects:()=>[]})
 await new Promise(resolve=>adapter.start({workspace:root,prompt:'读取',mode:'general',model:'fixture',maxSteps:10,approvalMode:'ask',execution:policy},0,resolve))
 assert.deepEqual(forwarded.execution,policy);runtime.inspector.finish();runtime.workbench.finish()
})

test('legacy execution cannot silently discard workflow restrictions',t=>{
 const root=directory(t),agent=new LocalAgentService(root,()=>({endpoint:'http://127.0.0.1:1/v1',key:'',maxTokens:1024,contextLength:8192}));t.after(()=>agent.dispose())
 assert.throws(()=>agent.start({workspace:root,prompt:'读取',mode:'general',model:'fixture',maxSteps:10,execution:{tools:[]}},0,()=>{}),/必须通过 Agent Core/)
})
