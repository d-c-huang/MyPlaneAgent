// Opt-in real-model tests. Providers only touch synthetic data in a fresh isolated workspace.
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
import {contextHistoryHash} from '../dist-electron/main/context-checkpoint.js'
import {isolatedGitWorkspace} from '../tests/helpers/workspace.mjs'
import {auditPassed,recordAuditUsage,phaseMetrics} from './lib/live-audit-metrics.mjs'

const endpoint=process.env.MYPLANE_LIVE_ENDPOINT||'http://127.0.0.1:8089/v1',key=process.env.MYPLANE_LIVE_API_KEY||'',model=process.env.MYPLANE_LIVE_MODEL
if(!model)throw Error('Set MYPLANE_LIVE_MODEL to an already loaded model ID')
const output=process.env.MYPLANE_LIFECYCLE_OUTPUT||isolatedGitWorkspace('myplane-lifecycle-live-')
fs.mkdirSync(output,{recursive:true})
const connection={endpoint,key,apiFormat:'openai',localLlama:process.env.MYPLANE_LIVE_LOCAL!=='0',contextLength:8192,maxTokens:1024}
const save=(name,value)=>fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(value,null,2))
const clean=error=>String(error instanceof Error?error.message:error).replaceAll(key||'\0','[REDACTED]')
const definition={name:'agent.read_file',category:'agent',description:'读取隔离验收文件 token.txt，返回实际凭据。',parameters:{type:'object',properties:{path:{type:'string',const:'token.txt'}},required:['path'],additionalProperties:false},source:{type:'skill',skillId:'agent-tools'},runtime:'builtin',permissions:['fileSystem:read'],tags:[]}
const cases=[]
console.log(JSON.stringify({output,model}))

async function reloadCase(kind){
 const workspace=path.join(output,kind);fs.mkdirSync(workspace)
 const code='LIVE-'+randomUUID(),scope={taskId:kind,workerId:'worker',workspace}
 const report={kind,requests:0,requestUsages:{},activities:[],answer:'',outcome:null,checks:{},startedAt:new Date().toISOString()}
 const core=new AgentCoreService({dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>connection})
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])
 let oldCalls=0,newCalls=0,approvals=0,swapped=false,queued=false,release=()=>{},lock
 try{
  await core.initialize()
  const registry=core.getCapabilityRegistry()
  registry.registerBuiltin(definition,async()=>{oldCalls++;return {code:'OLD-PROVIDER-MUST-NOT-RUN'}})
  const swap=()=>{
   if(swapped)return;swapped=true
   registry.registerBuiltin({...definition,description:'提供者已更新。读取 token.txt 时必须传 version="v2"。',parameters:{...definition.parameters,properties:{...definition.parameters.properties,version:{type:'string',const:'v2'}},required:['path','version']},tags:['requires-approval','risk:read']},async args=>{if(args.version!=='v2')throw Error('New schema was not used');newCalls++;return {path:'token.txt',version:'v2',code}})
  }
  if(kind==='resource-queue'){
   let started
   const ready=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
   registry.registerBuiltin({...definition,name:'fixture.lock',source:{type:'builtin'},parameters:{type:'object'}},async()=>{started();await gate;return 'released'})
   lock=registry.execute({capability:'fixture.lock',args:{},workspace,execution:{taskId:'lock',workspace,activityId:'lock'}},signal)
   await ready
  }
  await core.runConversation({connection,model,workspace,executionContext:{...scope,onResourceWait:value=>{if(value&&kind==='resource-queue'){queued=true;swap();release()}}},
   messages:[{role:'user',content:'这是隔离工具验收。必须调用本轮 agent.read_file 读取 token.txt，遵守当前工具 Schema；若提供者更新导致旧调用未执行，按下一轮新定义重新生成参数。最后逐字报告 code 的完整值。不要调用其他文件、联网、写入或命令。'}],
   filesEnabled:true,webEnabled:false,approvalMode:'ask',signal,maxRounds:8,temperature:0,
   approve:async activity=>{approvals++;report.approvedArgs=activity.args;return true},onRequest:()=>{report.requests++;if(kind==='model-wait'&&report.requests===1)swap();save(kind,report)},
   onUsage:usage=>recordAuditUsage(report,report.requests,usage),onReasoning(){},onContent:text=>{report.answer+=text},onOutcome:value=>{report.outcome=value},
   onActivity:activity=>{if(['complete','error','denied'].includes(activity.status)){report.activities.push(activity);save(kind,report);console.log(JSON.stringify({kind,tool:activity.capability,status:activity.status}))}},
  })
  const saved=core.runtimeStore.loadWorker(scope)
  report.checks={providerActuallyChanged:swapped,oldProviderNeverInvoked:oldCalls===0,newProviderInvokedOnce:newCalls===1,newPolicyApprovedOnce:approvals===1,newArgumentsApproved:report.approvedArgs?.version==='v2',
   rejectedCallRecorded:saved.history.some(row=>row.role==='tool'&&String(row.content).includes('tool-admission-changed')),noUnresolvedEffect:!saved.unresolvedEffects?.length,exactCode:report.answer.includes(code),completed:report.outcome==='complete',...(kind==='resource-queue'?{actuallyQueued:queued}:{})}
  report.worker={generation:saved.generation,phase:saved.phase,historyHash:contextHistoryHash(saved.history,saved.history.length)}
 }catch(error){report.error=clean(error);report.checks.noRunError=false}
 finally{release();await lock?.catch(()=>{});await core.dispose()}
 report.finishedAt=new Date().toISOString();report.metrics=phaseMetrics(report);report.passed=auditPassed(report.checks);save(kind,report);cases.push(report)
}

async function cancelCase(){
 const kind='cancel-recover',workspace=path.join(output,kind);fs.mkdirSync(workspace)
 const scope={taskId:kind,workerId:'worker',workspace},config={dataDir:path.join(workspace,'data'),skillsDir:path.join(workspace,'skills'),getConnection:()=>connection}
 const report={kind,requests:0,requestUsages:{},activities:[],answer:'',checks:{},startedAt:new Date().toISOString()},controller=new AbortController()
 let core=new AgentCoreService(config),calls=0,cancelled=false
 const options=message=>({connection,model,workspace,executionContext:scope,pinnedState:{goal:'隔离取消与恢复验收'},messages:[{role:'user',content:message}],filesEnabled:true,webEnabled:false,approvalMode:'ask',signal:AbortSignal.timeout(300000),maxRounds:6,temperature:0,
  approve:async()=>false,onRequest:()=>{report.requests++},onUsage:usage=>recordAuditUsage(report,report.requests,usage),onReasoning(){},onContent:text=>{report.answer+=text},onActivity:activity=>{if(['complete','error'].includes(activity.status))report.activities.push(activity)}})
 try{
  await core.initialize()
  core.getCapabilityRegistry().registerBuiltin(definition,async(_args,signal)=>{
   calls++
   await new Promise((_resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason)}
    const timer=setTimeout(()=>controller.abort(new Error('LIVE_USER_STOP')),50)
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
   })
  })
  try{await core.runConversation({...options('请调用 agent.read_file 读取 token.txt，最后报告实际返回。'),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])})}
  catch(error){if(!clean(error).includes('LIVE_USER_STOP'))throw error;cancelled=true}
  const before=core.runtimeStore.loadWorker(scope),hash=contextHistoryHash(before.history,before.history.length)
  report.before={generation:before.generation,phase:before.phase,historyHash:hash}
  await core.dispose();core=new AgentCoreService(config);await core.initialize()
  const loaded=core.runtimeStore.loadWorker(scope)
  report.checks={realToolBegan:calls===1,userCancellationObserved:cancelled,interruptedPersisted:before.phase==='interrupted',exactHistoryReload:contextHistoryHash(loaded.history,loaded.history.length)===hash}
  core.getCapabilityRegistry().registerBuiltin(definition,async()=>{calls++;throw Error('Cancelled tool must not be replayed')})
  await core.runConversation({...options('刚才的读取已由用户取消。现在停止读取，只说明此前没有取得完整结果，不调用任何工具。'),conversationOnly:true,filesEnabled:false})
  const after=core.runtimeStore.loadWorker(scope)
  Object.assign(report.checks,{sameGeneration:after.generation===before.generation,noToolReplay:calls===1,restoredPendingResult:after.history.some(row=>row.role==='tool'&&String(row.content).includes('"restored":true')),cancellationExplained:/取消|停止|中断|未.*(?:取得|获取|结果)|没有.*结果/.test(report.answer)})
 }catch(error){report.error=clean(error);report.checks.noRunError=false}
 finally{await core.dispose()}
 report.finishedAt=new Date().toISOString();report.metrics=phaseMetrics(report);report.passed=auditPassed(report.checks);save(kind,report);cases.push(report)
}

await reloadCase('model-wait');await reloadCase('resource-queue');await cancelCase()
const report={model,output,cases,passed:cases.length===3&&cases.every(row=>row.passed),finishedAt:new Date().toISOString()}
save('report',report);console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
