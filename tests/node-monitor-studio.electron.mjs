import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-monitor-studio-'))
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const policy={enabled:false,autoRepair:true,autoApply:true,maxAttemptsPerIssue:2,maxRepairsPerDay:6,analysisTimeoutSeconds:90}
const setup=directory=>{
 fs.mkdirSync(path.join(directory,'workbench'),{recursive:true})
 fs.writeFileSync(path.join(directory,'workbench','node-monitor.json'),JSON.stringify({schema:1,policy,issues:[],repairDates:[]}))
 fs.writeFileSync(path.join(directory,'local-ai-settings.json'),JSON.stringify({endpoint:'http://127.0.0.1:1234/v1',model:'fixture-model',maxTokens:1024,encryptedApiKey:'',encryptedHfToken:'',downloadDirectory:path.join(directory,'models')}))
 fs.writeFileSync(path.join(directory,'local-ai-studio-settings.json'),JSON.stringify({source:'external',contextLength:8192}))
}
let service,broken,window
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check){for(let i=0;i<100;i++){if(await check())return;await delay(10)}throw Error('monitor studio fixture timeout')}
const fixture=()=>{
 const session=service.newSession(),taskId=randomUUID(),workspace=service.ensureCacheWorkspace(session.id)
 Object.assign(session,{model:'fixture-model',webEnabled:false,approvalMode:'ask',abilityTask:{id:taskId,startMessageId:'initial',goalMessageId:'initial',status:'blocked',updatedAt:new Date().toISOString()},messages:[{id:'initial',role:'user',content:'检查当前文件',createdAt:new Date().toISOString()}],taskPlan:{taskId,workspace,updatedAt:new Date().toISOString(),items:[
  {id:'complete',kind:'inspect',title:'已完成读取',acceptance:'已读取',status:'complete',attempts:1,summary:'已取得证据',evidenceIds:['keep']},
  {id:'failed',kind:'verify',title:'核对文件',acceptance:'符合原要求',status:'blocked',attempts:1,summary:'模型请求失败（HTTP 503）',evidenceIds:[]},
 ]}})
 service.saveSession(session)
 const issue={id:randomUUID(),fingerprint:'fixture',source:'node',sessionId:session.id,taskId,nodeId:'failed',title:'核对文件',error:'HTTP 503',phase:'repairing',occurrences:1,attempts:1,createdAt:'now',updatedAt:'now',message:'',events:[],retryable:true,diagnosis:{cause:'transient',action:'retry_node',summary:'temporary',nextStep:'resume'}}
 return {session,issue}
}
async function main(){
 const watchdog=setTimeout(()=>app.exit(1),60000)
 try{
  await app.whenReady();setup(root);service=new LocalAiStudioService(root);window=new BrowserWindow({show:false})
  const owner=window.webContents,event={sender:owner}
  assert.equal((await service.dispatch('nodeMonitorState',undefined,event)).policy.enabled,false)
  const f=fixture();let calls=0
  service.generate=async(session,_connection,_settings,_signal,emit,requestId,_compact,options)=>{
   calls++;assert.equal(service.workbenchResumeRequests.has(requestId),true)
   assert.equal(options.approvalMode,'ask');assert.equal(options.webEnabled,false);assert.equal(options.workspace,f.session.taskPlan.workspace)
   assert.equal(session.taskPlan.items[0].attempts,1);assert.deepEqual(session.taskPlan.items[0].evidenceIds,['keep'])
   session.taskPlan.items[1].status='complete';session.taskPlan.items[1].summary='实际验收通过';service.saveSession(session)
   emit({type:'finished',requestId,session})
  }
  const result=await service.repairMonitor(f.issue,policy,new AbortController().signal,()=>{})
  assert.equal(result.phase,'resolved');assert.equal(calls,1);assert.equal(service.chats.size,0)
  assert.equal(service.session(f.session.id).approvalMode,'ask');assert.equal(service.session(f.session.id).webEnabled,false)
  assert.equal((await service.repairMonitor(f.issue,policy,new AbortController().signal,()=>{})).phase,'resolved');assert.equal(calls,1)
  const blocked=fixture();blocked.session.taskPlan.items[1].outcome='needs_input';service.saveSession(blocked.session)
  assert.equal((await service.repairMonitor(blocked.issue,policy,new AbortController().signal,()=>{})).phase,'waiting');assert.equal(calls,1)
  const changed=fixture();changed.issue.taskId='stale-task'
  assert.equal((await service.repairMonitor(changed.issue,policy,new AbortController().signal,()=>{})).phase,'waiting')
  assert.equal((await service.repairMonitor({...changed.issue,source:'session'},policy,new AbortController().signal,()=>{})).phase,'waiting')
  const paused=fixture();paused.session.abilityTask.status='paused';service.saveSession(paused.session)
  assert.equal((await service.repairMonitor(paused.issue,policy,new AbortController().signal,()=>{})).phase,'waiting');assert.equal(calls,1)

  const savedCore=service.agentCoreService,savedSkills=service.skillPlatform,savedCompile=service.compileSkillCode
  try{
   service.skillPlatform={initialize:async()=>assert.fail('active conversation must prevent worker reload')}
   service.agentCoreService={getStatus:()=>({runningTasks:0,runningConversations:1})}
   for(const action of ['skillsReload','skillSave'])await assert.rejects(service.dispatch(action,{},event),/AI 会话/)
   service.agentCoreService={getStatus:()=>({runningTasks:0,runningConversations:0})}
   service.chats.set('foreground',{sessionId:'other'})
   await assert.rejects(service.dispatch('skillsReload',{},event),/AI 会话/)
   service.chats.delete('foreground')
   const skillDir=path.join(root,'fixture-skill');fs.mkdirSync(skillDir);fs.writeFileSync(path.join(skillDir,'index.py'),'original')
   service.skillPlatform={get:()=>({path:skillDir}),validateManifest:()=>{},initialize:async()=>assert.fail('compile race must not reload')}
   service.compileSkillCode=async()=>{service.chats.set('during-compile',{sessionId:'other'})}
   await assert.rejects(service.dispatch('skillSave',{skillName:'fixture',skillJson:{id:'fixture'},indexPy:'new source'},event),/AI 会话/)
   assert.equal(fs.readFileSync(path.join(skillDir,'index.py'),'utf8'),'original');service.chats.delete('during-compile')
   let releaseReload
   service.skillPlatform.initialize=()=>new Promise(resolve=>{releaseReload=resolve})
   service.agentCoreService.getCapabilityRegistry=()=>({reload:async()=>{}})
   const reloading=service.dispatch('skillsReload',{},event);await until(()=>!!releaseReload)
   await assert.rejects(service.startChat({},owner),/插件正在更新/)
   const coreGuard={config:{assertCanStartRun:()=>service.assertPluginsAvailable()}}
   for(const method of ['runConversation','runTask','runPlannedTask'])await assert.rejects(AgentCoreService.prototype[method].call(coreGuard,{}),/插件正在更新/)
   await assert.rejects(service.dispatch('skillsReload',{},event),/插件正在更新/)
   releaseReload();await reloading;assert.equal(service.mutatingPlugin,false)
  }finally{service.agentCoreService=savedCore;service.skillPlatform=savedSkills;service.compileSkillCode=savedCompile}

  const repaired=fixture(),foreground=fixture(),controller=new AbortController();let releaseForeground,foregroundSignal
  service.generate=async(session,_connection,_settings,signal,emit,requestId)=>{
   if(session.id===foreground.session.id){foregroundSignal=signal;await new Promise(resolve=>{releaseForeground=resolve})}
   else await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})})
   emit({type:'finished',requestId,session})
  }
  await service.startChat({sessionId:foreground.session.id,requestId:'foreground-test',model:'fixture-model',text:'继续'},owner)
  await until(()=>!!releaseForeground)
  const repair=service.repairMonitor(repaired.issue,policy,controller.signal,()=>{})
  await until(()=>service.chats.size===2)
  controller.abort(new Error('monitor paused'))
  await assert.rejects(repair,/monitor paused/)
  assert.equal(foregroundSignal.aborted,false,'monitor cancellation must not cancel another user run')
  releaseForeground();await until(()=>service.chats.size===0)

  const badRoot=path.join(root,'bad-profile');setup(badRoot)
  const file=path.join(badRoot,'workbench','node-monitor.json');fs.writeFileSync(file,'{broken')
  broken=new LocalAiStudioService(badRoot)
  assert.throws(()=>broken.nodeMonitorState(),/监控初始化失败/)
  assert.ok(broken.newSession().id);assert.equal(fs.readFileSync(file,'utf8'),'{broken')
  console.log('PASS monitor Studio: scoped resume, permission preservation, no replay, concurrent reload guards, isolated cancellation, corrupt-store isolation')
 }catch(error){console.error(error);process.exitCode=1}
 finally{clearTimeout(watchdog);window?.destroy();await service?.dispose();await broken?.dispose();try{fs.rmSync(root,{recursive:true,force:true})}catch{}app.exit(Number(process.exitCode)||0)}
}
void main()
