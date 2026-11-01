import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {RuntimeStore} from '../dist-electron/main/agent/core/runtime-store.js'
import {WorkerContextSession} from '../dist-electron/main/agent/core/worker-context.js'
import {historyPage} from '../dist-electron/main/agent/core/worker-history.js'
import {pinnedContext,createContextCheckpoint,contextMessages} from '../dist-electron/main/local-ai-context.js'
import {ExecutionRuntime} from '../dist-electron/main/agent/core/execution-runtime.js'

const history=()=>[{id:'u',role:'user',content:'保留 customer_id，不部署。'},{id:'a',role:'assistant',content:'原始检查证据 😀\nend'}]
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-worker-context-')),scope={taskId:'task',workspace:path.join(root,'workspace'),workerId:'worker',itemId:'item'}
 fs.mkdirSync(scope.workspace)
 let store=new RuntimeStore(path.join(root,'runtime'))
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true})})
 return {root,scope,get store(){return store},reopen(){store.close();store=new RuntimeStore(path.join(root,'runtime'));return store}}
}
const state=(messages,scope)=>pinnedContext(messages,{taskId:scope.taskId,workerId:scope.workerId,permissions:{approvalMode:'ask',webEnabled:false}})
const contract={goal:'test'}

test('history and a V2 checkpoint survive SQLite reopen as one scoped snapshot',t=>{
 const f=fixture(t),messages=history(),pinned=state(messages,f.scope),session=new WorkerContextSession(f.store,f.scope,contract,messages,pinned)
 const checkpoint=createContextCheckpoint(messages,1,'待验证',undefined,pinned)
 session.save(messages,checkpoint);session.finish(messages,checkpoint,false)
 const restored=new WorkerContextSession(f.reopen(),f.scope,contract,messages,pinned)
 assert.deepEqual(restored.checkpoint,checkpoint)
 assert.deepEqual(restored.history.slice(0,2),messages)
 assert.match(restored.history.at(-1).content,/中断点恢复/)
 assert.match(JSON.stringify(contextMessages(restored.history,[],restored.checkpoint)),/customer_id/)
 restored.finish(restored.history,restored.checkpoint,false)
})

test('task, workspace, Worker and item boundaries never select another context',t=>{
 const f=fixture(t),messages=history(),s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope));s.finish(messages,undefined,false)
 assert.equal(f.store.loadWorker({...f.scope,taskId:'other'}),undefined)
 assert.equal(f.store.loadWorker({...f.scope,workspace:f.scope.workspace+'other'}),undefined)
 assert.equal(f.store.loadWorker({...f.scope,workerId:'other'}),undefined)
 assert.throws(()=>f.store.loadWorker({...f.scope,itemId:'other'}),/范围不匹配/)
 const checkpoint=createContextCheckpoint(messages,1,'wrong',undefined,{...state(messages,f.scope),workerId:'other'})
 const saved=f.store.loadWorker(f.scope)
 assert.throws(()=>f.store.saveWorker({...saved,checkpoint},saved.revision),/检查点范围/)
})

test('same Worker has one live owner; compare-and-swap prevents stale overwrites',t=>{
 const f=fixture(t),messages=history(),s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope))
 assert.throws(()=>new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope)),/仍在执行/)
 const old=f.store.loadWorker(f.scope)
 s.save([...messages,{role:'assistant',content:'new result'}],undefined)
 assert.throws(()=>f.store.saveWorker(old,old.revision),/版本冲突/)
 assert.equal(f.store.loadWorker(f.scope).history.at(-1).content,'new result')
 s.finish(s.history,undefined,false)
})

test('changed acceptance or completed runs start a generation and retain earlier archives',t=>{
 const f=fixture(t),messages=history(),pinned=state(messages,f.scope)
 const first=new WorkerContextSession(f.store,f.scope,{acceptance:'one'},messages,pinned);first.finish(messages,undefined,false)
 const second=new WorkerContextSession(f.store,f.scope,{acceptance:'two'},[{role:'user',content:'new goal'}],pinned)
 second.finish(second.history,undefined,true)
 const third=new WorkerContextSession(f.store,f.scope,{acceptance:'two'},messages,pinned);third.finish(third.history,undefined,false)
 assert.deepEqual(f.store.listWorkers(f.scope.taskId,f.scope.workspace).map(row=>row.generation),[1,2,3])
 assert.deepEqual(f.store.loadWorker(f.scope,1).history,messages)
 assert.equal(f.store.loadWorker(f.scope,2).history[0].content,'new goal')
})

test('a failed metadata/message transaction keeps the old checkpoint and history intact',t=>{
 const f=fixture(t),messages=history(),s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope))
 const before=f.store.loadWorker(f.scope),db=new DatabaseSync(path.join(f.root,'runtime','runtime.sqlite'))
 db.exec("CREATE TRIGGER fail_worker_message BEFORE INSERT ON worker_messages WHEN NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'injected disk failure'); END")
 assert.throws(()=>s.save([...messages,{role:'assistant',content:'not committed'}],undefined),/保存失败/)
 db.exec('DROP TRIGGER fail_worker_message');db.close()
 s.finish([...messages,{role:'assistant',content:'must not retry a failed save'}],undefined,false)
 assert.deepEqual(f.store.loadWorker(f.scope),before)
 const next=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope));next.finish(next.history,undefined,false)
})

test('corrupt persisted messages fail closed without discarding their original records',t=>{
 const f=fixture(t),messages=history(),s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope));s.finish(messages,undefined,false)
 const db=new DatabaseSync(path.join(f.root,'runtime','runtime.sqlite'))
 db.prepare('UPDATE worker_messages SET body=? WHERE ordinal=0').run(JSON.stringify({role:'user',content:'forged'}));db.close()
 assert.throws(()=>f.store.loadWorker(f.scope),/损坏/)
 assert.equal(f.store.listWorkers(f.scope.taskId,f.scope.workspace).length,1)
})

test('opening a v1 runtime database adds Worker tables without losing plans or evidence',t=>{
 const f=fixture(t),plan={taskId:'legacy',workspace:f.scope.workspace,items:[],updatedAt:'before'}
 f.store.savePlan(plan)
 const operation={id:'legacy-op',taskId:'legacy',workspace:f.scope.workspace,capability:'read',args:{},revision:0,createdAt:'before'}
 f.store.begin(operation);f.store.finish(operation,{success:true,outcome:'succeeded',output:'original evidence',elapsedMs:1},false)
 f.store.close()
 const db=new DatabaseSync(path.join(f.root,'runtime','runtime.sqlite'));db.exec('DROP TABLE worker_messages; DROP TABLE worker_contexts; PRAGMA user_version=1;');db.close()
 f.reopen()
 assert.deepEqual(f.store.loadPlan('legacy',f.scope.workspace),plan)
 assert.equal(f.store.read('legacy-op','legacy',f.scope.workspace).result.output,'original evidence')
 const s=new WorkerContextSession(f.store,f.scope,contract,history(),state(history(),f.scope));s.finish(s.history,undefined,false)
 assert.equal(f.store.loadWorker(f.scope).generation,1)
})

test('parallel Worker commits and restarts keep distinct histories and permissions',t=>{
 const f=fixture(t),a=new WorkerContextSession(f.store,f.scope,contract,history(),state(history(),f.scope))
 const other={...f.scope,workerId:'second',itemId:'second-item'},b=new WorkerContextSession(f.store,other,contract,[{role:'user',content:'second secret'}],state(history(),other))
 a.save([...a.history,{role:'assistant',content:'first evidence'}],undefined);b.save([...b.history,{role:'assistant',content:'second evidence'}],undefined)
 a.finish(a.history,undefined,false);b.finish(b.history,undefined,false);f.reopen()
 assert.match(JSON.stringify(f.store.loadWorker(f.scope).history),/first evidence/)
 assert.doesNotMatch(JSON.stringify(f.store.loadWorker(f.scope).history),/second/)
 assert.match(JSON.stringify(f.store.loadWorker(other).history),/second evidence/)
})

for(const phase of ['intent','result','history'])test(`crash after ${phase} recovers tool replies without running the write again`,t=>{
 const f=fixture(t);f.store.close()
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/worker-context-crash.mjs',import.meta.url)),f.root,phase],{encoding:'utf8',windowsHide:true})
 assert.equal(child.status,23,child.stderr)
 f.reopen()
 const s=new WorkerContextSession(f.store,f.scope,contract,history(),state(history(),f.scope)),replayed=[]
 s.publish(activity=>replayed.push(activity))
 const reply=JSON.parse(s.history.find(message=>message.role==='tool').content)
 assert.equal(reply.activityId,'operation');assert.equal(reply.outcome,phase==='intent'?'unknown':phase==='result'?'succeeded':undefined)
 assert.equal(replayed.length,1)
 assert.equal(replayed[0].status,phase==='intent'?'error':'complete')
 assert.equal(fs.readFileSync(path.join(f.scope.workspace,'writes.txt'),'utf8'),'1')
 assert.deepEqual(s.effects.map(effect=>effect.id),phase==='intent'?['operation']:[])
 s.publish(()=>assert.fail('acknowledged activity must not be replayed twice'))
 s.finish(s.history,s.checkpoint,false)
})

test('a crash before Registry.begin fences the same effect even in another Worker',async t=>{
 const f=fixture(t);f.store.close()
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/worker-context-crash.mjs',import.meta.url)),f.root,'intent'],{encoding:'utf8',windowsHide:true});assert.equal(child.status,23,child.stderr)
 f.reopen()
 const runtime=new ExecutionRuntime(f.store)
 const capability={name:'agent.write_file',category:'agent',parameters:{type:'object'},source:{type:'skill',skillId:'agent-tools'},runtime:'python-native',tags:['requires-approval','risk:write'],permissions:['fileSystem:write']}
 const result=await runtime.execute(capability,{capability:capability.name,args:{path:'result.txt',content:'done'},workspace:f.scope.workspace,execution:{taskId:'task',workerId:'other',mode:'write'}},new AbortController().signal,async()=>assert.fail('unknown write must not replay'))
 assert.equal(result.success,false);assert.equal(result.failureCode,'conflict')
})

test('activity delivery failure retains the durable outbox for idempotent acknowledgement',t=>{
 const f=fixture(t),messages=history(),s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope))
 const activity={id:'event',capability:'agent.read_file',args:{path:'a'},status:'complete',output:'evidence'}
 s.finishTool(activity,messages)
 assert.throws(()=>s.publish(()=>{throw new Error('UI unavailable')}),/UI unavailable/)
 s.finish(messages,undefined,false)
 const restored=new WorkerContextSession(f.reopen(),f.scope,contract,messages,state(messages,f.scope)),ids=[]
 restored.publish(activity=>ids.push(activity.id));restored.publish(()=>assert.fail('duplicate'))
 assert.deepEqual(ids,['event']);restored.finish(restored.history,undefined,false)
})

test('a reused model call ID does not hide the latest interrupted invocation',t=>{
 const f=fixture(t),messages=[{role:'user',content:'读取文件'},
  {role:'assistant',content:null,tool_calls:[{id:'same',function:{name:'read',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'same',content:'old result'},
  {role:'assistant',content:null,tool_calls:[{id:'same',function:{name:'read',arguments:'{}'}}]}]
 const s=new WorkerContextSession(f.store,f.scope,contract,messages,state(messages,f.scope))
 s.beginTool('same',{id:'latest',capability:'agent.read_file',args:{path:'a'},status:'running'},messages)
 s.finish(messages,undefined,false)
 const recovered=new WorkerContextSession(f.reopen(),f.scope,contract,messages,state(messages,f.scope))
 assert.equal(recovered.history.filter(message=>message.role==='tool').length,2)
 assert.equal(JSON.parse(recovered.history.filter(message=>message.role==='tool').at(-1).content).activityId,'latest')
 recovered.finish(recovered.history,undefined,false)
})

test('history keyword pages reconstruct JSONL, exclude images/reasoning and survive append-only writes',()=>{
 const messages=[{role:'user',content:'needle 😀'.repeat(30),reasoning_content:'PRIVATE'},{role:'assistant',content:[{type:'text',text:'needle evidence'},{type:'image_url',image_url:{url:'data:image/png;base64,SECRET'}}]},{role:'assistant',content:'unrelated'}]
 let page=historyPage(messages,{query:'needle',limit:37}),joined=page.text
 const through=page.through,snapshot=page.snapshot
 messages.push({role:'user',content:'new needle'})
 while(page.nextOffset!==undefined){page=historyPage(messages,{query:'needle',limit:37,offset:page.nextOffset,through,snapshot});joined+=page.text}
 const rows=joined.split('\n').map(line=>JSON.parse(line))
 assert.equal(rows.length,2);assert.equal(rows[0].content,'needle 😀'.repeat(30));assert.doesNotMatch(joined,/PRIVATE|SECRET|unrelated|new needle/)
 assert.throws(()=>historyPage(messages,{offset:1}),/through/)
 messages[0].content='changed';assert.throws(()=>historyPage(messages,{query:'needle',offset:1,through,snapshot}),/历史前缀已变化/)
 assert.throws(()=>historyPage(messages,{query:'x'.repeat(201)}),/参数无效/)
})
