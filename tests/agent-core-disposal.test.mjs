import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'

for(const failed of ['preview','mcpAdapter','skillPlatform','runtimeManager','executionRuntime']){
 test(`Agent Core releases its database and other resources after ${failed} shutdown fails`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-core-disposal-'))
  const service=new AgentCoreService({dataDir:root,skillsDir:path.join(root,'skills'),getConnection:()=>({})})
  const components=['preview','mcpAdapter','skillPlatform','runtimeManager','executionRuntime']
  const originals=new Map(components.map(name=>[name,service[name].dispose.bind(service[name])]))
  t.after(async()=>{
   for(const name of components)service[name].dispose=originals.get(name)
   await service.dispose()
   fs.rmSync(root,{recursive:true,force:true})
  })
  const controller=new AbortController(),failure=new Error(`${failed} failed`),attempted=[]
  service.runningTasks.set('active',controller)
  service.initialized=true
  let reported
  service.on('error',error=>{reported=error})
  for(const name of components)service[name].dispose=async()=>{
   assert.equal(controller.signal.aborted,true,'cancel tasks before releasing their resources')
   attempted.push(name)
   if(name===failed&&name!=='executionRuntime')throw failure
   await originals.get(name)()
   if(name===failed)throw failure
  }
  await assert.rejects(service.dispose(),error=>{
   assert.ok(error instanceof AggregateError)
   assert.deepEqual(error.errors,[failure])
   assert.equal(error,reported)
   return true
  })
  assert.deepEqual(attempted,components)
  assert.equal(service.initialized,false)
  assert.equal(service.runningTasks.size,0)
  assert.throws(()=>service.runtimeStore.has('missing'),/not open|closed/i)
 })
}

test('Agent Core reports all shutdown failures after still closing its database',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-core-disposal-'))
 const service=new AgentCoreService({dataDir:root,skillsDir:path.join(root,'skills'),getConnection:()=>({})})
 const previewDispose=service.preview.dispose.bind(service.preview),mcpDispose=service.mcpAdapter.dispose.bind(service.mcpAdapter)
 t.after(async()=>{service.preview.dispose=previewDispose;service.mcpAdapter.dispose=mcpDispose;await service.dispose();fs.rmSync(root,{recursive:true,force:true})})
 const failures=[new Error('preview failed'),new Error('MCP failed')]
 service.preview.dispose=async()=>{throw failures[0]}
 service.mcpAdapter.dispose=async()=>{throw failures[1]}
 service.on('error',()=>{})
 await assert.rejects(service.dispose(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors.every((failure,i)=>failure===failures[i]))
 assert.throws(()=>service.runtimeStore.has('missing'),/not open|closed/i)
})
