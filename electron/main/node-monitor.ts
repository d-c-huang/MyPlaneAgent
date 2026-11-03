import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {readIntegrationJson,writeIntegrationJson} from './integration-store.js'
import type {StudioSession} from '../shared/local-ai-studio.js'
import type {ModuleSnapshot} from '../shared/ability-modules.js'
import type {NodeMonitorCommand,NodeMonitorDiagnosis,NodeMonitorIssue,NodeMonitorPhase,NodeMonitorPolicy,NodeMonitorSnapshot} from '../shared/node-monitor.js'

export type MonitorRepairResult={phase:'applied'|'waiting'|'failed'|'resolved';message:string;jobId?:string;fromVersion?:string;toVersion?:string}
export type NodeMonitorDependencies={
 analyze:(issue:NodeMonitorIssue,signal:AbortSignal)=>Promise<NodeMonitorDiagnosis>
 repair:(issue:NodeMonitorIssue,policy:NodeMonitorPolicy,signal:AbortSignal,onPhase:(phase:NodeMonitorPhase,message:string)=>void)=>Promise<MonitorRepairResult>
 moduleSnapshots:()=>ModuleSnapshot[]
 onError?:(message:string)=>void
}
type StoredMonitor={schema:1;policy:NodeMonitorPolicy;issues:NodeMonitorIssue[];repairDates:string[];lastScanAt?:string}
const defaults:NodeMonitorPolicy={enabled:true,autoRepair:true,autoApply:true,maxAttemptsPerIssue:2,maxRepairsPerDay:6,analysisTimeoutSeconds:90}
const activePhases=new Set<NodeMonitorPhase>(['queued','analyzing','repairing','verifying'])
const finalPhases=new Set<NodeMonitorPhase>(['applied','resolved','dismissed','superseded'])
const stamp=()=>new Date().toISOString()
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Store concise diagnostics, never tool arguments, conversation bodies or images. */
export function monitorText(value:string,limit=2400){return value.replace(/\b(Bearer|Basic)\s+[\w.\-\/+=]+/gi,'$1 [已隐藏]').replace(/\bsk-[\w-]+/g,'[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi,'$1[已隐藏]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏]@').slice(0,limit)}
export function validateMonitorPolicy(input:NodeMonitorPolicy):NodeMonitorPolicy{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(defaults,key)))throw new Error('监控策略格式无效')
 for(const key of ['enabled','autoRepair','autoApply'] as const)if(typeof input[key]!=='boolean')throw new Error('监控开关必须为布尔值')
 for(const [key,min,max] of [['maxAttemptsPerIssue',1,5],['maxRepairsPerDay',1,50],['analysisTimeoutSeconds',15,300]] as const)if(!Number.isSafeInteger(input[key])||input[key]<min||input[key]>max)throw new Error(`${key} 必须为 ${min}–${max} 的整数`)
 return {...input}
}

/** Serialized, persisted background work. It never owns a foreground task or
 * mutates its plan; the Studio adapter must recheck live task ownership on apply. */
export class NodeMonitor {
 private readonly file:string
 private data:StoredMonitor
 private timer?:ReturnType<typeof setTimeout>
 private poll?:ReturnType<typeof setTimeout>
 private current?:{id:string;controller:AbortController;promise:Promise<void>}
 private readonly activeSessions=new Set<string>()
 private readonly manual=new Set<string>()
 private disposed=false
 constructor(directory:string,private readonly deps:NodeMonitorDependencies){
  this.file=path.join(directory,'node-monitor.json')
  this.data=readIntegrationJson<StoredMonitor>(this.file,{schema:1,policy:{...defaults},issues:[],repairDates:[]})
  if(this.data.schema!==1||!Array.isArray(this.data.issues)||!Array.isArray(this.data.repairDates))throw new Error('监控存档格式无效')
  this.data.policy=validateMonitorPolicy(this.data.policy)
  // A restart is not proof that an interrupted repair was not applied.
  for(const issue of this.data.issues)if(activePhases.has(issue.phase))this.record(issue,'waiting','应用重启中断了监控处理；请先核对现有版本与节点结果，再重试。')
  this.save();this.schedulePoll()
 }
 snapshot():NodeMonitorSnapshot{
  this.trimDates()
  return structuredClone({policy:this.data.policy,issues:[...this.data.issues].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),runningId:this.current?.id,repairsToday:this.data.repairDates.length,lastScanAt:this.data.lastScanAt,
   hotUpdateNote:'通过测试的能力模块可切换版本，并在后续调用生效；运行中的调用保留原版本。节点恢复沿用原权限与验收。应用内核代码不能在线替换，相关问题会保留为待应用更新。此处开关只管理监控发起的修复，独立能力优化任务沿用其原策略。'})
 }
 command(command:NodeMonitorCommand):NodeMonitorSnapshot{
  if(this.disposed)throw new Error('运行监控已关闭')
  if(!command||typeof command!=='object')throw new Error('监控操作无效')
  if(command.action==='policy'){
   const previous=this.data.policy,next=validateMonitorPolicy(command.policy);this.data.policy=next
   if(!next.enabled||previous.autoRepair&&!next.autoRepair||previous.autoApply&&!next.autoApply)this.current?.controller.abort(new Error('监控策略已收紧，停止本次后台处理'))
   if(!previous.enabled&&next.enabled)for(const issue of this.data.issues)if(issue.phase==='queued')this.manual.delete(issue.id)
   if(!previous.autoRepair&&next.autoRepair)for(const issue of this.data.issues)if(issue.phase==='waiting'&&issue.message==='自动修复已关闭，诊断已保存；可手动重试此问题。')this.record(issue,'queued','自动修复已开启，重新核对原问题的恢复条件。')
   this.save();this.schedule()
  }else if(command.action==='scan')this.scanModules()
  else if(command.action==='retry'||command.action==='dismiss'){
   const issue=this.data.issues.find(item=>item.id===command.id)
   if(!issue)throw new Error('监控记录不存在')
   if(command.action==='dismiss'){
    if(this.current?.id===issue.id)this.current.controller.abort(new Error('用户忽略此监控记录'))
    this.manual.delete(issue.id);this.record(issue,'dismissed','用户已忽略；保留原始诊断与处理记录。')
   }else{
    if(!this.data.policy.enabled)throw new Error('请先开启运行监控')
    if(issue.phase==='superseded')throw new Error('原任务已经切换，请检查当前任务的问题记录')
    if(this.current?.id===issue.id)throw new Error('此问题正在处理')
    if(issue.attempts>=this.data.policy.maxAttemptsPerIssue)throw new Error('此问题已达到修复次数上限，可调整预算后再试')
    this.manual.add(issue.id);this.record(issue,'queued','用户请求重新分析并处理此问题。');this.schedule()
   }
   this.save()
  }else throw new Error('不支持的监控操作')
  return this.snapshot()
 }
 observeSession(session:StudioSession,active:boolean){
  if(this.disposed)return
  if(active)this.activeSessions.add(session.id);else this.activeSessions.delete(session.id)
  if(session.abilityTask?.status==='paused'){
   let changed=false
   for(const issue of this.data.issues.filter(issue=>issue.sessionId===session.id&&activePhases.has(issue.phase))){
    if(this.current?.id===issue.id)this.current.controller.abort(new Error('用户已暂停原会话，停止后台恢复'))
    this.record(issue,'waiting','用户已暂停原会话，监控不会自动恢复。');changed=true
   }
   if(changed)this.save()
   return
  }
  let changed=false
  for(const issue of this.data.issues.filter(issue=>issue.sessionId===session.id&&!finalPhases.has(issue.phase))){
   if(issue.taskId&&session.taskPlan?.taskId!==issue.taskId){this.record(issue,'superseded','会话已切换任务，旧问题已过期；这不代表原节点已修复。');changed=true;continue}
   const item=session.taskPlan?.items.find(item=>item.id===issue.nodeId)
   if(item?.status==='complete'){this.record(issue,'resolved','关联节点已有完整验收结果，停止重复修复。');changed=true}
   else if(!active&&issue.phase==='waiting'&&issue.message==='等待当前会话执行结束，再处理受阻节点。'){
    this.record(issue,'queued','会话已结束，重新核对受阻节点。');changed=true
   }
  }
  const plan=session.taskPlan
  if(plan)for(const item of plan.items){
   if(item.status!=='blocked')continue
   const errors=(item.evidence||[]).filter(row=>row.status!=='complete')
   const last=errors.at(-1),error=monitorText([item.summary,last?.output,item.verificationProblem?.message].filter(Boolean).join('\n'))
   if(!error.trim())continue
   const denied=errors.some(row=>row.status==='denied')||/拒绝|permission|denied|权限|未知.*副作用|副作用.*未知|已取消|用户.*暂停|预算|上限|需要.*(?:用户|人工)|视觉.*确认|图片能力|未启用|API.?Key|HTTP (?:401|403)/i.test(error)
   const verify=item.verificationRuns?.at(-1)
   const retryable=!denied&&item.outcome!=='needs_input'&&(!!verify&&!verify.passed&&!verify.results.some(row=>row.blocked)||/HTTP (?:408|429|5\d\d)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|连接.*(?:重置|中断)|模型.*连接超时|工具参数|规则格式/.test(error))
   changed=this.upsert({source:'node',sessionId:session.id,sessionTitle:monitorText(session.title,160),taskId:plan.taskId,nodeId:item.id,title:monitorText(item.title,300),error,retryable},last?.activityId||item.worker?.attemptId||`${item.attempts}:${item.summary}`)||changed
  }
  const last=session.messages.filter(message=>message.role==='assistant').at(-1)
  if(!plan?.items.some(item=>item.status==='blocked')&&last?.status==='error'&&last.error)changed=this.upsert({source:'session',sessionId:session.id,sessionTitle:monitorText(session.title,160),taskId:session.abilityTask?.id,title:'会话执行异常',error:monitorText(last.error),retryable:false},last.id)||changed
  if(changed){this.save();this.schedule()}
 }
 scanModules(){
  if(this.disposed)return
  try{
   let changed=false
   for(const module of this.deps.moduleSnapshots()){
    const seenProblems=new Set<string>()
    for(const problem of module.problems.slice(-12).reverse()){
     const problemKey=hash([problem.versionId,monitorText(problem.description)])
     if(seenProblems.has(problemKey))continue
     seenProblems.add(problemKey)
     // A module may finish its own optimization between monitor scans. Keep
     // the original problem when a verified job explains the active version.
     const appliedJob=module.jobs.find(job=>job.parentId===problem.versionId&&job.resolution==='improved'&&job.candidateId===module.activeId)
     const active=module.versions.find(version=>version.id===module.activeId)
     const applied=appliedJob&&!appliedJob.shadow?.failed&&active?.report?.passed&&active.hash===active.report.sourceHash&&module.switches.some(row=>row.from===problem.versionId&&row.to===module.activeId&&row.reason.includes(appliedJob.id))
     if(problem.versionId!==module.activeId&&!applied)continue
     changed=this.upsert({source:'module',moduleId:module.moduleId,versionId:problem.versionId,title:monitorText(module.name,300),error:monitorText(problem.description),retryable:false},problem.id)||changed
    }
    for(const issue of this.data.issues.filter(issue=>issue.moduleId===module.moduleId&&!finalPhases.has(issue.phase))){
     const job=module.jobs.find(job=>job.parentId===issue.versionId&&job.resolution==='improved'&&job.candidateId===module.activeId)
     const active=module.versions.find(version=>version.id===module.activeId)
     if(job&&!job.shadow?.failed&&module.switches.some(row=>row.from===issue.versionId&&row.to===module.activeId&&row.reason.includes(job.id))&&active?.report?.passed&&active.hash===active.report.sourceHash){
      issue.fromVersion=issue.versionId;issue.toVersion=module.activeId;issue.jobId=job.id;this.record(issue,'applied','能力模块已通过评测并切换，新调用将使用新版本。');changed=true
     }
    }
   }
   this.data.lastScanAt=stamp();this.save();if(changed)this.schedule()
  }catch(error){this.deps.onError?.('扫描能力模块失败：'+monitorText(String(error),500))}
 }
 private upsert(input:Pick<NodeMonitorIssue,'source'|'title'|'error'> & Partial<NodeMonitorIssue>,observation:string){
  observation=hash(observation)
  const fingerprint=hash([input.source,input.sessionId,input.taskId,input.nodeId,input.moduleId,input.versionId,input.error]),existing=this.data.issues.find(item=>item.fingerprint===fingerprint)
  if(existing){
   existing.retryable=input.retryable
   if(existing.lastObservation===observation)return false
   existing.lastObservation=observation;existing.occurrences++;existing.updatedAt=stamp()
   // Repeated observations are evidence, not unlimited new repair budgets.
   if(!finalPhases.has(existing.phase)&&existing.phase==='failed'&&existing.attempts<this.data.policy.maxAttemptsPerIssue)this.record(existing,'queued','检测到同一问题的新执行记录，重新核对。')
   return true
  }
  if(this.data.issues.length>=200){const disposable=this.data.issues.findIndex(issue=>finalPhases.has(issue.phase));if(disposable<0)return false;this.data.issues.splice(disposable,1)}
  const issue:NodeMonitorIssue={...input,id:randomUUID(),fingerprint,source:input.source,title:input.title,error:input.error,phase:'queued',occurrences:1,attempts:0,createdAt:stamp(),updatedAt:stamp(),lastObservation:observation,message:'已发现异常，等待后台分析。',events:[]}
  this.record(issue,'queued',issue.message);this.data.issues.push(issue);return true
 }
 private record(issue:NodeMonitorIssue,phase:NodeMonitorPhase,message:string){
  issue.phase=phase;issue.message=monitorText(message,1500);issue.updatedAt=stamp();issue.events.push({at:issue.updatedAt,phase,message:issue.message});issue.events=issue.events.slice(-30)
 }
 private save(){this.trimDates();writeIntegrationJson(this.file,this.data)}
 private trimDates(){const day=stamp().slice(0,10);this.data.repairDates=this.data.repairDates.filter(date=>date.startsWith(day))}
 private schedule(){
  if(this.disposed||!this.data.policy.enabled||this.current||this.timer)return
  this.timer=setTimeout(()=>{this.timer=undefined;this.drain()},100);this.timer.unref()
 }
 private schedulePoll(){
  if(this.disposed)return
  this.poll=setTimeout(()=>{if(this.data.policy.enabled)this.scanModules();this.schedulePoll()},15_000);this.poll.unref()
 }
 private drain(){
  if(this.disposed||!this.data.policy.enabled||this.current)return
  const issue=this.data.issues.find(issue=>issue.phase==='queued')
  if(!issue)return
  const controller=new AbortController()
  // Assign the slot before starting asynchronous work so observations cannot fork it.
  const promise=Promise.resolve().then(()=>this.process(issue,controller.signal)).catch(error=>this.deps.onError?.(monitorText(String(error),500))).finally(()=>{if(this.current?.id===issue.id)this.current=undefined;this.manual.delete(issue.id);this.schedule()})
  this.current={id:issue.id,controller,promise}
 }
 private async process(issue:NodeMonitorIssue,signal:AbortSignal){
  const timeout=new AbortController(),combined=AbortSignal.any([signal,timeout.signal])
  const timer=setTimeout(()=>timeout.abort(new Error('监控分析或修复超过本次时间预算')),this.data.policy.analysisTimeoutSeconds*1000)
  const update=(phase:NodeMonitorPhase,message:string)=>{combined.throwIfAborted();if(finalPhases.has(issue.phase))return;this.record(issue,phase,message);this.save()}
  try{
   signal.throwIfAborted();update('analyzing','正在根据节点证据分析原因。')
   const diagnosis=await this.deps.analyze(structuredClone(issue),combined);combined.throwIfAborted()
   if(finalPhases.has(issue.phase))return
   if(!diagnosis||!['transient','verification','module','permission','configuration','application','unknown'].includes(diagnosis.cause)||!['retry_node','optimize_module','needs_user','application_update'].includes(diagnosis.action)||typeof diagnosis.summary!=='string'||typeof diagnosis.nextStep!=='string')throw new Error('监控分析结果格式无效，未执行修复')
   issue.diagnosis={...diagnosis,summary:monitorText(diagnosis.summary,1600),nextStep:monitorText(diagnosis.nextStep,1200)}
   if(diagnosis.action==='needs_user'||diagnosis.action==='application_update'){update('waiting',diagnosis.nextStep||diagnosis.summary);return}
   if(diagnosis.action==='retry_node'&&(issue.source!=='node'||!issue.retryable)||diagnosis.action==='optimize_module'&&issue.source!=='module'){update('waiting','当前证据不满足自动修复条件；保留诊断，等待核对。');return}
   if(!this.data.policy.autoRepair&&!this.manual.has(issue.id)){update('waiting','自动修复已关闭，诊断已保存；可手动重试此问题。');return}
   if(issue.sessionId&&this.activeSessions.has(issue.sessionId)){update('waiting','等待当前会话执行结束，再处理受阻节点。');return}
   this.trimDates()
   if(issue.attempts>=this.data.policy.maxAttemptsPerIssue||this.data.repairDates.length>=this.data.policy.maxRepairsPerDay){update('waiting','已达到监控修复预算；请调整预算或稍后重试。');return}
   issue.attempts++;this.data.repairDates.push(stamp());update('repairing','正在执行有范围限制的修复，保留原任务权限与验收。')
   const result=await this.deps.repair(structuredClone(issue),{...this.data.policy},combined,update);combined.throwIfAborted()
   if(finalPhases.has(issue.phase))return
   Object.assign(issue,{jobId:result.jobId,fromVersion:result.fromVersion,toVersion:result.toVersion});update(result.phase,result.message)
  }catch(error){
   if(!finalPhases.has(issue.phase)){this.record(issue,signal.aborted?'waiting':'failed',String(combined.aborted?combined.reason:error));this.save()}
  }finally{clearTimeout(timer)}
 }
 async dispose(){this.disposed=true;if(this.timer)clearTimeout(this.timer);if(this.poll)clearTimeout(this.poll);this.current?.controller.abort(new Error('运行监控已停止'));await this.current?.promise}
}
