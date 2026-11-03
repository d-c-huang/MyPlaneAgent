import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {ExecutionRuntime} from '../dist-electron/main/agent/core/execution-runtime.js'
import {RuntimeStore} from '../dist-electron/main/agent/core/runtime-store.js'
import {ResourceScheduler} from '../dist-electron/main/agent/core/resource-scheduler.js'
import {normalizeExecution} from '../dist-electron/main/agent/core/execution-result.js'
import {workspaceVersion} from '../dist-electron/main/agent/core/evidence-version.js'
import {inspectTextEdit} from '../dist-electron/main/agent/core/edit-progress.js'

const cap=name=>({name,category:'agent',runtime:'python-native',source:{type:'skill',skillId:'agent-tools'},permissions:[],parameters:{type:'object'}})
const signal=()=>new AbortController().signal
// Directory junctions exercise canonical-path boundaries on Windows without
// requiring the symlink privilege or changing the machine's developer settings.
const directoryLink=(target,link)=>fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir')
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-runtime-')),workspace=path.join(root,'workspace'),directory=path.join(root,'data')
 fs.mkdirSync(workspace)
 const store=new RuntimeStore(directory),runtime=new ExecutionRuntime(store)
 t.after(async()=>{await runtime.dispose();fs.rmSync(root,{recursive:true,force:true})})
 const request=(name,args={},id='operation')=>({capability:name,args,workspace,execution:{taskId:'task',workspace,activityId:id,mode:'write'}})
 return {root,workspace,directory,store,runtime,request}
}
test('process and MCP failures share one result contract, including unknown exit status',()=>{
 for(const name of ['agent.run_test','agent.get_diagnostics','agent.run_command']){
  assert.equal(normalizeExecution(name,{success:true,output:{exitCode:1},elapsedMs:0}).failureCode,'verification')
  assert.equal(normalizeExecution(name,{success:true,output:{},elapsedMs:0}).outcome,'unknown')
  assert.equal(normalizeExecution(name,{success:true,output:'{"exitCode":0}',elapsedMs:0}).outcome,'succeeded')
 }
 assert.equal(normalizeExecution('mcp.example.call',{success:true,output:{isError:true},elapsedMs:0}).success,false)
})
test('resources share reads, serialize writes across aliases and cancel queued work',async()=>{
 const scheduler=new ResourceScheduler(),read={key:'workspace',mode:'read'},write={key:'workspace',mode:'write'}
 const a=await scheduler.acquire([read],signal()),b=await scheduler.acquire([read],signal())
 const controller=new AbortController();let entered=false
 const queued=scheduler.acquire([write],controller.signal).then(release=>{entered=true;release()})
 const rejected=assert.rejects(queued,/cancelled/);controller.abort(new Error('cancelled'));await rejected
 a();b();assert.equal(entered,false)
 const release=await scheduler.acquire([write],signal());let later=false
 const pending=scheduler.acquire([read],signal()).then(done=>{later=true;done()})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(later,false);release();await pending
})
test('runtime guards worker scopes and a shared tool budget before invoking tools',async t=>{
 const f=fixture(t),budget={used:0,limit:1};fs.mkdirSync(path.join(f.workspace,'allowed'))
 let calls=0;const invoke=async()=>{calls++;return {success:true,output:{},elapsedMs:0}}
 const name='agent.write_file',request=f.request(name,{path:'outside.txt',content:'x'})
 request.execution.writeScopes=[['allowed']]
 assert.equal((await f.runtime.execute(cap(name),request,signal(),invoke)).failureCode,'permission')
 request.execution.mode='read';request.args.path='allowed/x.txt'
 assert.equal((await f.runtime.execute(cap(name),request,signal(),invoke)).failureCode,'permission')
 const read=f.request('agent.read_file',{path:'allowed/x.txt'});read.execution.budget=budget
 assert.equal((await f.runtime.execute(cap(read.capability),read,signal(),invoke)).success,true)
 assert.equal((await f.runtime.execute(cap(read.capability),{...read,execution:{...read.execution,activityId:'next'}},signal(),invoke)).failureCode,'budget')
 assert.equal(calls,1)
})
test('automatic worker budgets keep counting beyond legacy caps and preserve evidence',async t=>{
 const f=fixture(t),budget={used:80};let calls=0
 for(const id of ['read-81','read-82']){
  const request=f.request('agent.read_file',{path:'source.txt'},id)
  request.execution.budget=budget
  const result=await f.runtime.execute(cap(request.capability),request,signal(),async()=>({success:true,output:'source '+ ++calls,elapsedMs:0}))
  assert.equal(result.success,true)
  assert.equal(f.store.read(id,'task',f.workspace).result.output,'source '+calls)
 }
 assert.equal(calls,2);assert.equal(budget.used,82);assert.equal(budget.limit,undefined)
})
test('symlink paths share the workspace lock and cannot escape inherited scopes',async t=>{
 const f=fixture(t),alias=path.join(f.root,'alias');directoryLink(f.workspace,alias)
 directoryLink(f.root,path.join(f.workspace,'outside'))
 const escaped=f.request('agent.write_file',{path:'outside/escape.txt',content:'no'})
 escaped.execution.writeScopes=[['.']]
 assert.equal((await f.runtime.execute(cap(escaped.capability),escaped,signal(),async()=>assert.fail())).failureCode,'permission')
 let unblock;const hold=new Promise(resolve=>unblock=resolve);let entered=false
 const first=f.runtime.execute(cap('agent.run_test'),f.request('agent.run_test',{},'first'),signal(),async()=>{await hold;return {success:true,output:{exitCode:0},elapsedMs:0}})
 const second=f.runtime.execute(cap('agent.read_file'),{...f.request('agent.read_file',{},'second'),workspace:alias},signal(),async()=>{entered=true;return {success:true,output:{},elapsedMs:0}})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,false);unblock();await Promise.all([first,second]);assert.equal(entered,true)
})
test('recovery reuses an actual file write and blocks unknown command replay',async t=>{
 const f=fixture(t),name='agent.write_file',args={path:'result.txt',content:'done'};let writes=0
 const write=async()=>{writes++;fs.writeFileSync(path.join(f.workspace,args.path),args.content);return {success:true,output:{changed:true},elapsedMs:0}}
 await f.runtime.execute(cap(name),f.request(name,args,'first'),signal(),write)
 const reused=await f.runtime.execute(cap(name),f.request(name,args,'second'),signal(),write)
 assert.equal(writes,1);assert.equal(reused.output.reconciled,true)
 assert.equal(f.store.read('second','task',f.workspace).result.metadata.reusedFrom,'first')
 const command='agent.run_command'
 await f.runtime.execute(cap(command),f.request(command,{command:'example'},'unknown'),signal(),async()=>({success:false,error:'connection interrupted',elapsedMs:0}))
 const blocked=await f.runtime.execute(cap(command),f.request(command,{command:'example'},'retry'),signal(),async()=>assert.fail('must reconcile external effects'))
 assert.equal(blocked.failureCode,'conflict')
})
test('durable evidence survives reopen, preserves original data and enforces task scope',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 let store=new RuntimeStore(root)
 const operation={id:'capture',taskId:'task',workspace:'/workspace',capability:'browser.screenshot',args:{url:'https://example.com'},createdAt:new Date().toISOString(),revision:0}
 store.begin(operation);store.finish(operation,{success:true,outcome:'succeeded',elapsedMs:4,output:{image:'pixels'}},false)
 store.begin({...operation,id:'interrupted'});store.savePlan({taskId:'task',workspace:'/workspace',updatedAt:new Date().toISOString(),items:[]});store.close()
 store=new RuntimeStore(root)
 try{
  assert.deepEqual(store.read('capture','task','/workspace').result.output,{image:'pixels'})
  assert.equal(store.read('interrupted','task','/workspace').state,'unknown')
  assert.throws(()=>store.read('capture','other','/workspace'),/当前任务/)
  assert.throws(()=>store.read('capture','task','/other'),/当前任务/)
  assert.equal(store.loadPlan('task','/workspace').taskId,'task')
 }finally{store.close()}
})
test('source versions detect external edits and ignore build output',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.workspace,'source.js'),'v1')
 const before=workspaceVersion(f.workspace);fs.mkdirSync(path.join(f.workspace,'dist'));fs.writeFileSync(path.join(f.workspace,'dist','app.js'),'generated')
 assert.equal(workspaceVersion(f.workspace),before)
 fs.writeFileSync(path.join(f.workspace,'source.js'),'v2');assert.notEqual(workspaceVersion(f.workspace),before)
})
test('preview workers may run declared service scripts but cannot use arbitrary edit commands',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.workspace,'package.json'),JSON.stringify({scripts:{dev:'vite'}}))
 let calls=0
 const invoke=async()=>{calls++;return {success:true,output:{exitCode:0},elapsedMs:0}}
 const request=f.request('agent.run_command',{command:'npm run dev -- --host 127.0.0.1'},'preview')
 request.execution={...request.execution,mode:'verify',kind:'preview'}
 assert.equal((await f.runtime.execute(cap(request.capability),request,signal(),invoke)).success,true)
 const edit={...request,args:{command:'node -e "writeFiles()"'},execution:{...request.execution,activityId:'edit'}}
 assert.equal((await f.runtime.execute(cap(edit.capability),edit,signal(),invoke)).failureCode,'permission')
 const verify={...request,execution:{...request.execution,kind:'verify',activityId:'verify'}}
 assert.equal((await f.runtime.execute(cap(verify.capability),verify,signal(),invoke)).failureCode,'permission')
 assert.equal(calls,1)
})
test('reported write success requires actual file contents, and an unapplied edit can retry',async t=>{
 const f=fixture(t),name='agent.write_file',args={path:'result.txt',content:'done'}
 const missing=await f.runtime.execute(cap(name),f.request(name,args,'missing'),signal(),async()=>({success:true,output:{status:'saved'},elapsedMs:0}))
 assert.equal(missing.success,false);assert.equal(missing.failureCode,'verification');assert.match(missing.error,/未达到预期/)
 assert.equal(f.store.read('missing','task',f.workspace).state,'failed')
 assert.equal(f.store.revision(f.workspace),0)
 const written=await f.runtime.execute(cap(name),f.request(name,args,'written'),signal(),async()=>{
  fs.writeFileSync(path.join(f.workspace,args.path),args.content);return {success:true,output:{status:'saved'},elapsedMs:0}
 })
 assert.equal(written.success,true);assert.equal(written.metadata.fileVersions[0].hash,inspectTextEdit(f.workspace,name,args)[0].after)
 assert.equal(f.store.read('written','task',f.workspace).stale,false)
})
test('partial multi-file edits fail and retain the actual version of every target',async t=>{
 const f=fixture(t),name='agent.apply_patch',args={changes:[{path:'a.txt',after:'a'},{path:'b.txt',after:'b'}]}
 const result=await f.runtime.execute(cap(name),f.request(name,args),signal(),async()=>{
  fs.writeFileSync(path.join(f.workspace,'a.txt'),'a');return {success:true,output:{status:'saved'},elapsedMs:0}
 })
 assert.equal(result.success,false);assert.equal(result.output.mismatchedFiles.length,1);assert.match(result.output.mismatchedFiles[0],/b\.txt$/)
 assert.equal(result.metadata.fileVersions.length,2);assert.equal(result.metadata.fileVersions[1].hash,'missing')
 assert.equal(f.store.revision(f.workspace),1)
 const blocked=await f.runtime.execute(cap(name),f.request(name,args,'retry'),signal(),async()=>assert.fail('partly applied patches need a fresh baseline'))
 assert.equal(blocked.failureCode,'conflict')
})
test('repeated checks keep source evidence current and detect concurrent source changes',async t=>{
 const f=fixture(t),name='agent.run_test';fs.writeFileSync(path.join(f.workspace,'source.js'),'first')
 const invoke=async()=>({success:true,output:{exitCode:0},elapsedMs:0})
 await f.runtime.execute(cap(name),f.request(name,{},'first'),signal(),invoke)
 await f.runtime.execute(cap(name),f.request(name,{},'second'),signal(),invoke)
 assert.equal(f.store.revision(f.workspace),0);assert.equal(f.store.read('first','task',f.workspace).stale,false)
 const changed=await f.runtime.execute(cap(name),f.request(name,{},'changed'),signal(),async()=>{
  fs.writeFileSync(path.join(f.workspace,'source.js'),'second');return invoke()
 })
 assert.equal(changed.metadata.sourceChangedDuringExecution,true);assert.equal(changed.metadata.sourceVersion,undefined)
 assert.equal(changed.success,false);assert.equal(changed.outcome,'unknown');assert.equal(changed.failureCode,'conflict')
 assert.equal(f.store.read('first','task',f.workspace).stale,true)
})
test('queued writes recheck file scopes and workspace aliases before invoking tools',async t=>{
 for(const scenario of ['scope','workspace']){
  const f=fixture(t),alias=path.join(f.root,'alias'),allowed=path.join(f.workspace,'allowed'),outside=path.join(f.root,'outside')
  fs.mkdirSync(allowed);fs.mkdirSync(outside);directoryLink(f.workspace,alias)
  let unblock;const hold=new Promise(resolve=>unblock=resolve)
  const first=f.runtime.execute(cap('agent.run_test'),f.request('agent.run_test',{},'hold'),signal(),async()=>{await hold;return {success:true,output:{exitCode:0},elapsedMs:0}})
  const request=f.request('agent.write_file',{path:'allowed/result.txt',content:'x'},'queued')
  request.workspace=alias;request.execution.writeScopes=[['allowed']]
  const second=f.runtime.execute(cap(request.capability),request,signal(),async()=>assert.fail('changed paths must not be invoked'))
  await new Promise(resolve=>setImmediate(resolve))
  if(scenario==='scope'){fs.rmdirSync(allowed);directoryLink(outside,allowed)}
  else{fs.unlinkSync(alias);directoryLink(outside,alias)}
  unblock();await first
  assert.equal((await second).failureCode,'conflict')
 }
})
test('legacy records migrate once and allow completed file edits to reconcile without another write',async t=>{
 const f=fixture(t),name='agent.replace_text',args={path:'result.txt',oldText:'before',newText:'after'}
 fs.writeFileSync(path.join(f.workspace,args.path),'before')
 const entry={status:'started',updatedAt:new Date().toISOString(),expectedFiles:inspectTextEdit(f.workspace,name,args)}
 fs.writeFileSync(path.join(f.workspace,args.path),'after')
 f.runtime.importLegacyOperation('task',f.workspace,name,args,entry)
 const first=await f.runtime.execute(cap(name),f.request(name,args,'recovered'),signal(),async()=>assert.fail('already applied'))
 assert.equal(first.success,true);assert.equal(first.output.reconciled,true)
 f.runtime.importLegacyOperation('task',f.workspace,name,args,entry)
 const second=await f.runtime.execute(cap(name),f.request(name,args,'again'),signal(),async()=>assert.fail('already applied'))
 assert.equal(second.metadata.reusedFrom,'recovered')
 const command='agent.run_command',commandArgs={command:'publish'}
 f.runtime.importLegacyOperation('task',f.workspace,command,commandArgs,{status:'succeeded',updatedAt:entry.updatedAt})
 assert.equal((await f.runtime.execute(cap(command),f.request(command,commandArgs,'blocked'),signal(),async()=>assert.fail('unconfirmed external effects'))).failureCode,'conflict')
})
