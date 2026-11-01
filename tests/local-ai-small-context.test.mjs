import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {ToolResultStore,selectDefinitions,recoveryCheckpoint} from '../dist-electron/main/agent/context-policy.js'
import {estimateTokens,contextMessages} from '../dist-electron/main/local-ai-context.js'
import {LocalAgentService} from '../dist-electron/main/agent/service.js'
const call=(name,args)=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}})
const response=(content,tool_calls)=>({choices:[{finish_reason:tool_calls?'tool_calls':'stop',message:{role:'assistant',content,tool_calls}}]})
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check){for(let i=0;i<1000;i++){if(check())return;await pause(10)}throw new Error('Timed out')}
function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-small-context-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}

test('long JSON results round trip with bounded valid pages and task isolation',t=>{
 const store=new ToolResultStore(sandbox(t)),task=randomUUID(),id=randomUUID(),original=JSON.stringify({exitCode:1,output:'中文😀"\n'.repeat(3000),last:'failure at end'})
 store.save(task,id,original);let offset=0,reconstructed=''
 do{const raw=store.read(task,id,offset,512);assert.ok(estimateTokens(raw)<=512);const page=JSON.parse(raw);reconstructed+=page.text;assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));offset=page.nextOffset}while(offset!==undefined)
 assert.equal(reconstructed,original);assert.throws(()=>store.read(randomUUID(),id,0,512));assert.throws(()=>store.read(task,'../escape',0,512));assert.throws(()=>store.save(task,id,'overwrite'))
})

test('schema selection counts large external schemas and prioritizes explicitly loaded tools',()=>{
 const definition=(name,size)=>({type:'function',function:{name,description:'x'.repeat(size),parameters:{type:'object',properties:{}}}})
 const definitions=[definition('load_tool_pack',30),definition('read_tool_result',30),definition('external_huge',20000),definition('external_small',30),definition('read_file',30)]
 const result=selectDefinitions(definitions,['load_tool_pack','read_tool_result','external_small'],400)
 assert.ok(estimateTokens(result)<=400);assert.ok(result.some(item=>item.function.name==='external_small'));assert.ok(!result.some(item=>item.function.name==='external_huge'))
})

test('deterministic recovery keeps every user constraint and execution evidence without changing history',()=>{
 const history=[{role:'user',content:'保留 customer_id；禁止部署'},{role:'assistant',content:'背景'.repeat(10000)},{role:'user',content:'继续验证'}],before=structuredClone(history)
 const checkpoint=recoveryCheckpoint(history,[],undefined,{contextLength:4096,maxTokens:512},'write_file completed; test failed exit 1')
 const payload=JSON.stringify(contextMessages(history,[],checkpoint))
 assert.match(payload,/customer_id/);assert.match(payload,/禁止部署/);assert.match(payload,/exit 1/);assert.deepEqual(history,before)
 assert.throws(()=>recoveryCheckpoint([{role:'user',content:'约束'.repeat(4000)},history[1]],[],undefined,{contextLength:4096,maxTokens:512},''),/超出容量/)
 assert.throws(()=>recoveryCheckpoint([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,x'}}]},history[1]],[],undefined,{contextLength:4096,maxTokens:512},''),/图片/)
})

async function harness(t,reply,capacity=4096,external){
 const root=sandbox(t),workspace=path.join(root,'project');fs.mkdirSync(workspace)
 const bodies=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);bodies.push(body)
  try{assert.ok(estimateTokens(body.messages)+estimateTokens(body.tools)+body.max_tokens+32<=capacity,'request must fit configured context');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await reply(body)))}catch(error){res.writeHead(500);res.end(String(error))}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 const connection=()=>({endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:4096,contextLength:capacity})
 const directory=path.join(root,'tasks'),service=new LocalAgentService(directory,connection,external);t.after(()=>service.dispose())
 return {root,workspace,directory,service,bodies,connection,start:(extra={})=>service.start({workspace,mode:'coding',model:'weak-fixture',prompt:'保留 customer_id，禁止部署。检查文件。',maxSteps:10,approvalMode:'full',...extra},7,()=>{})}
}

for(const capacity of [4096,8192])test(`${capacity} context loads tools, persists long output and retrieves it after restart`,async t=>{
 let stage=0,id,nextOffset
 const h=await harness(t,body=>{
  if(!body.tools)return response('用户要求保留 customer_id，禁止部署；文件尚未修改。')
  const names=body.tools.map(item=>item.function.name)
  if(stage++===0)return response(null,[call('load_tool_pack',{pack:'read_file'})])
  if(stage===2){assert.ok(names.includes('read_file'));return response(null,[call('read_file',{path:'large.txt',startLine:1,endLine:200})])}
  if(stage===3){const raw=body.messages.findLast(item=>item.role==='tool')?.content;const page=raw?JSON.parse(raw):null;id=page?.resultId||body.messages[0].content.match(/"resultId":"([^"]+)"/)?.[1];nextOffset=page?.nextOffset||0;assert.ok(id);return response('已读取部分文件，未修改。')}
  return response(null,[call('read_tool_result',{resultId:id,offset:nextOffset})])
 },capacity)
 fs.writeFileSync(path.join(h.workspace,'large.txt'),'中文日志内容'.repeat(5000))
 const first=h.start();await until(()=>!h.service.active(first.id));assert.equal(h.service.get(first.id).status,'completed',h.service.get(first.id).error)
 const restored=new LocalAgentService(h.directory,h.connection);t.after(()=>restored.dispose())
 restored.start({taskId:first.id,mode:'coding',model:'weak-fixture',prompt:'继续读取原文',maxSteps:1},7,()=>{})
 await until(()=>!restored.active(first.id));const task=restored.get(first.id),event=task.events.find(item=>item.tool==='read_tool_result')
 assert.equal(event.status,'completed');assert.equal(JSON.parse(event.output).offset,nextOffset)
 assert.equal(fs.readFileSync(path.join(h.workspace,'large.txt'),'utf8'),'中文日志内容'.repeat(5000))
 restored.delete(first.id);assert.equal(fs.existsSync(path.join(h.directory,'results',first.id)),false)
})

test('failed model summaries recover a completed write without replaying it and retain constraints',async t=>{
 let stage=0,summaries=0
 const h=await harness(t,body=>{
  if(!body.tools){summaries++;throw new Error('summary unavailable')}
  if(stage++===0)return response(null,[call('write_file',{path:'saved.txt',content:'done'})])
  assert.match(JSON.stringify(body.messages),/customer_id/);assert.match(JSON.stringify(body.messages),/禁止部署/)
  return response('已完成写入，继续核对。')
 })
 const first=h.start();await until(()=>!h.service.active(first.id));assert.equal(h.service.get(first.id).status,'completed',h.service.get(first.id).error)
 const file=path.join(h.directory,first.id+'.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'))
 saved.messages.push({role:'assistant',content:'旧工具资料'.repeat(5000)})
 fs.writeFileSync(file,JSON.stringify(saved))
 const count=saved.events.filter(event=>event.tool==='write_file').length
 h.start({taskId:first.id,prompt:'继续验证，不重复写入。'});await until(()=>!h.service.active(first.id))
 const task=h.service.get(first.id);assert.equal(task.status,'completed',task.error);assert.ok(summaries>0);assert.equal(task.checkpoint.source,'recovery')
 assert.equal(task.events.filter(event=>event.tool==='write_file').length,count);assert.deepEqual(task.facts.changedFiles,['saved.txt']);assert.equal(fs.readFileSync(path.join(h.workspace,'saved.txt'),'utf8'),'done')
 assert.equal(task.context.lastCompaction.outcome,'recovered')
 assert.equal(task.checkpoint.compaction.outcome,'recovered')
 assert.ok(task.checkpoint.compaction.requests>0);assert.equal(task.checkpoint.compaction.usage.totalReports,0)
 const reopened=new LocalAgentService(h.directory,h.connection);t.after(()=>reopened.dispose())
 assert.deepEqual(reopened.get(first.id).context.lastCompaction,task.context.lastCompaction)
})

test('legacy recovery cannot mark changed history as validated after a summary fails',async t=>{
 let changeHistory=false,first
 const h=await harness(t,body=>{
  if(!body.tools){
   if(changeHistory){
    h.service.runs.get(first.id).task.messages.push({role:'user',content:'并发新增要求：禁止上传任何文件。'})
    throw new Error('summary failed after history changed')
   }
   return response('用户要求保留 customer_id，禁止部署。')
  }
  return response('尚未修改文件。')
 })
 first=h.start();await until(()=>!h.service.active(first.id))
 const file=path.join(h.directory,first.id+'.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'))
 saved.messages.push({role:'assistant',content:'历史日志'.repeat(5000)})
 fs.writeFileSync(file,JSON.stringify(saved));changeHistory=true
 h.start({taskId:first.id,prompt:'继续核对现有数据'});await until(()=>!h.service.active(first.id))
 const after=JSON.parse(fs.readFileSync(file,'utf8'))
 assert.deepEqual(after.checkpoint,saved.checkpoint)
 assert.match(after.error,/历史已变化/)
 assert.equal(after.context.lastCompaction.outcome,'failed');assert.equal(after.context.lastCompaction.quality,undefined)
 assert.ok(after.messages.some(message=>message.content==='并发新增要求：禁止上传任何文件。'))
})

test('small context rejects a batch before executing any write and retries one tool',async t=>{
 let round=0
 const h=await harness(t,body=>{if(round++===0)return response(null,[call('write_file',{path:'bad.txt',content:'bad'}),call('write_file',{path:'also-bad.txt',content:'bad'})]);return response('已调整为单步处理。')})
 const first=h.start();await until(()=>!h.service.active(first.id));assert.equal(h.service.get(first.id).status,'completed');assert.equal(fs.existsSync(path.join(h.workspace,'bad.txt')),false);assert.equal(fs.existsSync(path.join(h.workspace,'also-bad.txt')),false)
})

test('external tools share the schema budget and can be selected by name',async t=>{
 let round=0
 const spec=(name,description)=>({definition:{type:'function',function:{name,description,parameters:{type:'object',properties:{},additionalProperties:false}}},source:'mcp:fixture',risk:'high',timeoutMs:1000,execute:async()=>JSON.stringify({ok:true})})
 const h=await harness(t,body=>{
  if(!body.tools)return response('已保留原始用户要求和已完成的工具调用。')
  const names=body.tools.map(item=>item.function.name);assert.ok(!names.includes('external_huge'))
  if(round++===0)return response(null,[call('load_tool_pack',{pack:'external_small'})])
  assert.ok(names.includes('external_small'));return response('已发现外部工具')
 },4096,()=>[spec('external_huge','大'.repeat(20000)),spec('external_small','小工具')])
 const task=h.start();await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'completed',h.service.get(task.id).error)
})

test('cancelling automatic compaction never creates a recovery checkpoint',async t=>{
 let summaryStarted=false
 const h=await harness(t,async body=>{if(!body.tools){summaryStarted=true;await pause(300);return response('摘要')}return response('完成')})
 const first=h.start();await until(()=>!h.service.active(first.id))
 const file=path.join(h.directory,first.id+'.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'))
 saved.messages.push({role:'assistant',content:'资料'.repeat(6000)});fs.writeFileSync(file,JSON.stringify(saved))
 h.start({taskId:first.id,prompt:'继续'});await until(()=>summaryStarted);h.service.stop(first.id,7);await until(()=>!h.service.active(first.id))
 const task=h.service.get(first.id);assert.equal(task.status,'stopped');assert.deepEqual(task.checkpoint,saved.checkpoint)
})
