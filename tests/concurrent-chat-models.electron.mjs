import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-concurrent-models-'))
app.setPath('userData',path.join(root,'profile'))
app.disableHardwareAcceleration()
const tick=()=>new Promise(resolve=>setImmediate(resolve))

async function main(){
 await app.whenReady()
 const window=new BrowserWindow({show:false}),service=new LocalAiStudioService(path.join(root,'data'))
 const runs=new Map()
 let profiles=[
  {id:'provider-a',name:'A',apiFormat:'openai',endpoint:'https://a.example/v1',model:'same-model',contextLength:12000,encryptedApiKey:'secret-a'},
  {id:'provider-b',name:'B',apiFormat:'anthropic',endpoint:'https://b.example/v1',model:'same-model',contextLength:24000,encryptedApiKey:'secret-b'},
 ]
 service.storedProfiles=()=>structuredClone(profiles)
 service.decrypt=value=>value
 service.generate=async(session,connection,settings,signal,emit,requestId,compactOnly,options)=>{
  const fixture={session,connection,settings,signal,emit,requestId,compactOnly,options}
  runs.set(requestId,fixture)
  emit({type:'delta',requestId,content:'开始 '+session.id,reasoning:''})
  await new Promise(resolve=>{fixture.finish=resolve;if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})})
  emit({type:'finished',requestId,session})
 }
 const ref=id=>({source:'remote',id:'same-model',profileId:id,apiFormat:profiles.find(row=>row.id===id).apiFormat,endpoint:profiles.find(row=>row.id===id).endpoint})
 async function start(modelRef,options={}){
  const session=service.newSession(),requestId=randomUUID()
  await service.startChat({sessionId:session.id,requestId,model:'same-model',modelRef,text:'test',...options},window.webContents)
  return runs.get(requestId)
 }
 try{
  service.saveStudioSettings({source:'external',endpoint:'https://a.example/v1',model:'same-model',contextLength:12000,maxTokens:1024})
  const generationA={temperature:0.15,topP:0.65,maxTokens:768,repeatPenalty:1.3}
  const selectedDirectory=path.join(root,'selected-workspace'),workspaceToken=randomUUID()
  fs.mkdirSync(selectedDirectory)
  service.agentWorkspaces.set(workspaceToken,{owner:window.webContents.id,path:selectedDirectory})
  // B changed saved defaults after A captured its composer, before A's chat IPC.
  service.saveStudioSettings({temperature:1.5,topP:0.9,maxTokens:2048,repeatPenalty:1.05})
  const a=await start(ref('provider-a'),{generation:generationA,workspaceToken})
  for(const [key,value] of Object.entries(generationA))assert.equal(a.settings[key],value,'request generation overrides interleaved defaults: '+key)
  service.saveStudioSettings({source:'external',apiFormat:'anthropic',endpoint:'https://b.example/v1',contextLength:24000})
  const b=await start(ref('provider-b'))
  assert.equal(service.chatRuns(window.webContents.id).length,2)
  assert.equal(a.connection.endpoint,'https://a.example/v1')
  assert.equal(a.connection.key,'secret-a')
  assert.equal(b.connection.endpoint,'https://b.example/v1')
  assert.equal(b.connection.key,'secret-b')
  profiles[0].encryptedApiKey='replacement-key'
  service.saveStudioSettings({contextLength:8192,maxTokens:2048})
  const nodeConnection=a.options.workbench.resolveModel('alternate-model')
  assert.equal(nodeConnection.endpoint,'https://a.example/v1')
  assert.equal(nodeConnection.key,'secret-a','node model edits retain this run credential')
  assert.equal(nodeConnection.contextLength,12000,'node budgets retain this run provider context')
  assert.equal(nodeConnection.maxTokens,768,'node requests retain original generation budget')
  const recovery=service.chatRuns(window.webContents.id)
  assert.deepEqual(recovery.find(run=>run.requestId===a.requestId).workspace,{path:selectedDirectory,token:workspaceToken},'owner recovery retains explicit workspace authorization')
  assert.equal(recovery.find(run=>run.requestId===b.requestId).workspace,undefined,'cache workspaces never expose an explicit grant')
  assert.deepEqual(service.chatRuns(window.webContents.id+10000),[],'other owners cannot retrieve workspace grants')
  assert.equal(recovery.find(run=>run.requestId===a.requestId).session.modelRef.profileId,'provider-a')
  assert.equal(JSON.stringify(recovery).includes('secret-'),false,'recovery contains no credentials')
  assert.equal(recovery.find(run=>run.requestId===a.requestId).sequence,1)

  const broken=service.newSession()
  await assert.rejects(service.startChat({sessionId:broken.id,requestId:randomUUID(),model:'same-model',modelRef:ref('provider-a'),generation:{...generationA,temperature:3},text:'test'},window.webContents),/生成参数 temperature/)
  await assert.rejects(service.startChat({sessionId:broken.id,requestId:randomUUID(),model:'same-model',modelRef:ref('provider-a'),generation:{...generationA,maxTokens:768.5},text:'test'},window.webContents),/生成参数 maxTokens/)
  await assert.rejects(service.startChat({sessionId:broken.id,requestId:randomUUID(),model:'same-model',modelRef:{...ref('provider-a'),endpoint:'https://unexpected.example/v1'},text:'test'},window.webContents),/重新选择模型/)
  assert.equal(service.session(broken.id).messages.length,0,'invalid provider identity does not append a user message')
  const duplicate=randomUUID(),atomic=service.newSession()
  const results=await Promise.allSettled([
   service.startChat({sessionId:atomic.id,requestId:duplicate,model:'same-model',modelRef:ref('provider-b'),text:'first'},window.webContents),
   service.startChat({sessionId:atomic.id,requestId:randomUUID(),model:'same-model',modelRef:ref('provider-b'),text:'second'},window.webContents),
  ])
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
  assert.equal(service.chatRuns(window.webContents.id).find(run=>run.sessionId===atomic.id).session.messages.filter(message=>message.role==='user').length,1)
  service.stopChat(duplicate,window.webContents.id);await tick()
  await assert.rejects(service.startChat({sessionId:atomic.id,requestId:duplicate,model:'same-model',text:'reused'},window.webContents),/请求 ID 已使用/)

  let stops=0
  service.runtime.snapshot=()=>({state:'running',modelId:'local-id',modelName:'local-model',endpoint:'http://127.0.0.1:43210/v1',contextLength:8192,parallel:2,logs:[],error:''})
  service.gateway.stop=async()=>{stops++}
  service.runtime.stop=async()=>{stops++;return service.runtime.snapshot()}
  const local=await start({source:'local',id:'local-id'})
  assert.equal(local.settings.source,'managed','explicit local ref works while global source is remote')
  assert.equal(local.session.model,'local-model')
  assert.equal(local.settings.contextLength,4096,'local per-slot context is retained')
  service.saveStudioSettings({source:'external',endpoint:'https://b.example/v1'})
  await assert.rejects(service.stopRuntime(),/本地模型仍被会话使用/)
  await assert.rejects(service.startRuntime('other-local-id'),/本地模型仍被会话使用/)
  assert.throws(()=>service.gateway.backend.unload(),/本地模型仍被会话使用/)
  assert.equal(stops,0,'neither runtime nor public gateway is touched while a local chat runs')
  assert.throws(()=>local.options.workbench.resolveModel('other-model'),/当前只加载一个模型/)
  await assert.rejects(service.startChat({sessionId:broken.id,requestId:randomUUID(),model:'other-model',modelRef:{source:'local',id:'other-local-id'},text:'test'},window.webContents),/本地模型尚未加载或已经切换/)
  service.stopChat(local.requestId,window.webContents.id);await tick()
  assert.equal(a.signal.aborted,false)
  assert.equal(b.signal.aborted,false)
  await service.stopRuntime()
  assert.equal(stops,2,'unrelated remote runs do not lock local shutdown')
  const next=await start(ref('provider-a'))
  assert.equal(next.connection.endpoint,'https://a.example/v1','next turn still resolves saved provider A while defaults point at B')
  assert.equal(next.connection.key,'replacement-key','new runs pick up current credentials without changing earlier runs')
  const compactSession=service.newSession(),compactId=randomUUID()
  await service.startChat({sessionId:compactSession.id,requestId:compactId,model:'same-model',modelRef:ref('provider-a'),generation:generationA},window.webContents,true)
  const compact=runs.get(compactId)
  assert.equal(compact.compactOnly,true)
  for(const [key,value] of Object.entries(generationA))assert.equal(compact.settings[key],value,'compaction uses its captured generation: '+key)
  for(const run of runs.values())run.finish()
  await tick()
  assert.equal(service.chatRuns(window.webContents.id).length,0)
  console.log('PASS: atomic sessions, unique requests, provider identity, frozen model/credential/budget, secret-free sequenced recovery and local runtime lifecycle isolation')
 }finally{
  for(const run of runs.values())run.finish()
  await tick();window.destroy();await service.dispose()
 }
}
void main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
