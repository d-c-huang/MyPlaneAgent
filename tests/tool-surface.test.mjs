import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {capabilityAlias,capabilityFingerprint,createToolSurface,retainReadbackTools} from '../dist-electron/main/agent/core/tool-surface.js'
import {CapabilityRegistry} from '../dist-electron/main/agent/core/capability-registry.js'
import {ExecutionRuntime} from '../dist-electron/main/agent/core/execution-runtime.js'
import {RuntimeStore} from '../dist-electron/main/agent/core/runtime-store.js'

const capability=(name='agent.read_file')=>({name,category:'agent',description:'fixture',parameters:{type:'object',properties:{path:{type:'string'}}},source:{type:'skill',skillId:'agent-tools'},runtime:'builtin',permissions:['fileSystem:read'],tags:[]})
const signal=()=>new AbortController().signal
test('readback reservation only retains available readers without duplicating or granting other tools',()=>{
 const read=capability('runtime.read_history'),evidence=capability('runtime.read_evidence'),write=capability('agent.write_file')
 assert.deepEqual(retainReadbackTools([read],[read,evidence,write]),[read,evidence])
 assert.deepEqual(retainReadbackTools([],[]),[])
 assert.deepEqual(retainReadbackTools([],[write]),[])
})
function fixture(t,dispose){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-tool-surface-')),registry=new CapabilityRegistry({getAllTools:()=>[]})
 t.after(async()=>{await dispose?.();fs.rmSync(workspace,{recursive:true,force:true})})
 return {workspace,registry,execute:(name='agent.read_file',extra={})=>registry.execute({capability:name,args:{path:'a.txt'},workspace,...extra},signal())}
}

test('tool aliases remain stable across reorder, omissions, long names and sanitized-name collisions',()=>{
 const names=['agent.read_file','mcp.one.a-b','mcp.one.a_b','tool.'+'x'.repeat(100),'中文工具']
 const a=createToolSurface(names.map(capability)),b=createToolSurface(names.slice().reverse().map(capability))
 for(const name of names){assert.ok(a.aliases.has(capabilityAlias(name)));assert.equal(a.aliases.get(capabilityAlias(name)).name,b.aliases.get(capabilityAlias(name)).name);assert.ok(capabilityAlias(name).length<=64);assert.match(capabilityAlias(name),/^[a-zA-Z0-9_]+$/)}
 assert.equal(new Set(names.map(capabilityAlias)).size,names.length)
 assert.ok(createToolSurface([capability(names[1])]).aliases.has(capabilityAlias(names[1])))
})

test('step definitions and nested schemas are owned immutable snapshots',()=>{
 const original=capability(),snapshot=createToolSurface([original]),alias=capabilityAlias(original.name)
 original.description='mutated';original.parameters.properties.path.type='number'
 assert.equal(snapshot.aliases.get(alias).description,'fixture')
 assert.equal(snapshot.tools[0].function.parameters.properties.path.type,'string')
 assert.throws(()=>{snapshot.tools[0].function.parameters.properties.path.type='boolean'},TypeError)
 assert.equal(capabilityFingerprint(capability()),capabilityFingerprint({...capability(),parameters:{properties:{path:{type:'string'}},type:'object'}}))
})

test('an old step cannot invoke a newly registered provider, even with an unchanged schema',async t=>{
 const f=fixture(t),definition=capability();let old=0,reloaded=0
 f.registry.registerBuiltin(definition,async()=>{old++;return 'old'})
 const admission=f.registry.admit(definition)
 f.registry.registerBuiltin({...definition},async()=>{reloaded++;return 'new'})
 const rejected=await f.execute(undefined,{admission})
 assert.equal(rejected.success,false);assert.equal(rejected.failureCode,'conflict');assert.equal(rejected.admissionRejected,true)
 assert.equal(old,0);assert.equal(reloaded,0)
 assert.equal((await f.execute(undefined,{admission:f.registry.admit(definition)})).success,true);assert.equal(reloaded,1)
})

test('withdrawn and disabled admitted capabilities fail before invoking any tool',async t=>{
 const f=fixture(t),definition=capability();let enabled=true,calls=0
 f.registry.registerBuiltin(definition,async()=>{calls++;return 'ok'},()=>enabled)
 const admission=f.registry.admit(definition);enabled=false
 assert.equal((await f.execute(undefined,{admission})).admissionRejected,true)
 enabled=true;f.registry.unregister(definition.name)
 assert.equal((await f.execute(undefined,{admission})).admissionRejected,true);assert.equal(calls,0)
})

test('schema mutation after admission is fenced without relying only on registration revisions',async t=>{
 const f=fixture(t),definition=capability();let calls=0
 f.registry.registerBuiltin(definition,async()=>{calls++;return 'ok'})
 const admission=f.registry.admit(definition);definition.parameters.properties.path.type='number'
 assert.equal((await f.execute(undefined,{admission})).admissionRejected,true);assert.equal(calls,0)
})

async function blockWorkspace(f){
 let started,finish
 const ready=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{finish=resolve})
 f.registry.registerBuiltin(capability('agent.run_command'),async()=>{started();await gate;return {exitCode:0}})
 const running=f.execute('agent.run_command');await ready
 return {running,finish}
}

test('provider replacement while waiting for a workspace lock cannot dispatch the replacement',async t=>{
 const f=fixture(t),definition=capability();let calls=0,waiting
 f.registry.registerBuiltin(definition,async()=>{calls++;return 'old'})
 const blocker=await blockWorkspace(f),queued=new Promise(resolve=>{waiting=resolve})
 const pending=f.execute(undefined,{execution:{taskId:'task',onResourceWait:value=>{if(value)waiting()}}})
 await queued;f.registry.registerBuiltin({...definition},async()=>{calls++;return 'replacement'})
 blocker.finish();await blocker.running
 assert.equal((await pending).admissionRejected,true);assert.equal(calls,0)
})

test('a rejected queued effect stays unapplied after restart and cannot block the newly admitted provider',async t=>{
 let runtime
 const f=fixture(t,async()=>{await runtime?.dispose()}),directory=path.join(f.workspace,'store'),definition={...capability('fixture.publish'),tags:['requires-approval','risk:high']}
 let store=new RuntimeStore(directory),calls=0,waiting
 runtime=new ExecutionRuntime(store)
 f.registry.setExecutionRuntime(runtime)
 f.registry.registerBuiltin(definition,async()=>{calls++;return 'published'})
 const blocker=await blockWorkspace(f),queued=new Promise(resolve=>{waiting=resolve})
 const pending=f.execute(definition.name,{args:{target:'external'},execution:{taskId:'task',workspace:f.workspace,activityId:'rejected',onResourceWait:value=>{if(value)waiting()}}})
 await queued;f.registry.registerBuiltin({...definition},async()=>{calls++;return 'new publication'})
 blocker.finish();await blocker.running
 const result=await pending
 assert.equal(result.admissionRejected,true);assert.equal(calls,0)
 const rejectedEvidence=store.read('rejected','task',f.workspace)
 assert.equal(store.revision(f.workspace),rejectedEvidence.operation.revision,'unapplied calls cannot invalidate workspace evidence')
 assert.equal(rejectedEvidence.state,'failed')
 await runtime.dispose();store=new RuntimeStore(directory);runtime=new ExecutionRuntime(store);f.registry.setExecutionRuntime(runtime)
 const applied=await f.execute(definition.name,{args:{target:'external'},admission:f.registry.admit(definition),execution:{taskId:'task',workspace:f.workspace,activityId:'applied'}})
 assert.equal(applied.success,true,applied.error);assert.equal(calls,1)
 // A provider result that merely contains this flag is still an actual effect.
 f.registry.registerBuiltin(definition,async()=>({admissionRejected:true}))
 const spoof=await f.execute(definition.name,{args:{target:'fakeflag'},execution:{taskId:'task',workspace:f.workspace,activityId:'fakeflag'}})
 assert.equal(spoof.success,true);assert.equal(spoof.admissionRejected,undefined)
 assert.deepEqual(spoof.output,{admissionRejected:true})
 await runtime.dispose();store=new RuntimeStore(directory);runtime=new ExecutionRuntime(store);f.registry.setExecutionRuntime(runtime)
 const blocked=await f.execute(definition.name,{args:{target:'fakeflag'},execution:{taskId:'task',workspace:f.workspace,activityId:'must-not-replay'}})
 assert.equal(blocked.success,false);assert.match(blocked.error,/副作用/)
})

test('queued arguments are isolated from caller edits while execution counters remain shared',async t=>{
 const f=fixture(t),definition=capability(),args={path:'a.txt'},budget={used:0,limit:2};let observed,waiting
 f.registry.registerBuiltin(definition,async value=>{observed=value.path;return 'read'})
 const blocker=await blockWorkspace(f),queued=new Promise(resolve=>{waiting=resolve})
 const pending=f.execute(undefined,{args,execution:{taskId:'task',budget,onResourceWait:value=>{if(value)waiting()}}})
 await queued;args.path='not-approved.txt';blocker.finish();await blocker.running
 assert.equal((await pending).success,true);assert.equal(observed,'a.txt');assert.equal(budget.used,1)
})

test('a capability withdrawn by its availability check is rechecked immediately before the body',async t=>{
 const f=fixture(t),definition=capability();let armed=false,checks=0,calls=0
 f.registry.registerBuiltin(definition,async()=>{calls++;return 'old'},()=>{
  if(armed&&++checks===3)f.registry.registerBuiltin({...definition},async()=>{calls++;return 'new'})
  return true
 })
 const admission=f.registry.admit(definition);armed=true
 assert.equal((await f.execute(undefined,{admission})).admissionRejected,true);assert.equal(calls,0)
})

test('no-op MCP refresh preserves active admissions; changed declarations replace them',()=>{
 let declarations=[{...capability('mcp.server.read'),runtime:'mcp',source:{type:'mcp',serverId:'server'}}]
 const registry=new CapabilityRegistry({getAllTools:()=>[]},{getAllCapabilities:()=>declarations.map(row=>structuredClone(row))})
 registry.refreshMCP();const admitted=registry.admit(declarations[0]);registry.refreshMCP()
 assert.deepEqual(registry.admit(declarations[0]),admitted)
 declarations=[{...declarations[0],description:'changed'}];registry.refreshMCP()
 assert.notDeepEqual(registry.admit(declarations[0]),admitted)
 declarations=[];registry.refreshMCP();assert.equal(registry.has('mcp.server.read'),false)
})
