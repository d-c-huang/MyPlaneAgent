import {createHash} from 'node:crypto'
import type {ContextCheckpoint,ContextPinnedState,ContextCompactionReport} from '../../../shared/local-ai-context.js'
import type {StudioToolActivity} from '../../../shared/local-ai-studio.js'
import type {ContextMessage} from '../../local-ai-context.js'
import {pinnedContext} from '../../local-ai-context.js'
import {operationKey} from './operation-journal.js'
import {RuntimeStore} from './runtime-store.js'
import {historyMessage,type WorkerContext,type WorkerScope} from './worker-history.js'

export class WorkerContextSession {
 private release:()=>void
 private context:WorkerContext
 private failure?:Error
 readonly restored:boolean
 readonly recoveredEffects:NonNullable<ContextPinnedState['unresolvedEffects']>=[]
 constructor(private store:RuntimeStore,scope:WorkerScope,contract:unknown,history:ContextMessage[],state:ContextPinnedState){
  this.release=store.acquireWorker(scope)
  try{
   const key=createHash('sha256').update(JSON.stringify(contract)).digest('hex'),saved=store.loadWorker(scope)
   const resume=saved&&saved.contract===key&&saved.phase!=='complete'
   this.restored=!!resume
   this.context=resume?saved:{scope,generation:(saved?.generation||0)+1,revision:0,contract:key,updatedAt:'',phase:'active',history:history.map(historyMessage),requirements:state.requirements,outbox:[]}
   if(resume){
    this.recoverPending()
    const old=new Set(saved.requirements.map(row=>row.id+'\0'+row.text))
    for(const requirement of state.requirements)if(!old.has(requirement.id+'\0'+requirement.text)&&!saved.requirements.some(row=>row.text===requirement.text))this.context.history.push({role:'user',content:requirement.text})
    this.context.requirements=pinnedContext([],{requirements:[...saved.requirements,...state.requirements]}).requirements
    this.context.history.push({role:'user',content:'本 Worker 从已保存的中断点恢复。请按当前任务要求和权限继续，先核对已有工具结果；不要自动重放历史命令、写入或外部操作。'})
   }
   this.context.phase='active'
   this.commit()
  }catch(error){this.release();throw error}
 }
 get history(){return this.context.history}
 get checkpoint(){return this.context.checkpoint}
 get lastCompaction(){return this.context.lastCompaction??this.context.checkpoint?.compaction}
 get requirements(){return this.context.requirements}
 get effects(){return [...new Map([...(this.context.unresolvedEffects||[]),...this.recoveredEffects].map(effect=>[effect.id,effect])).values()]}
 private commit(next=this.context){
  if(this.failure)throw this.failure
  try{this.context=this.store.saveWorker(next,next.revision)}catch(error){this.failure=new Error('Worker 恢复点保存失败，已停止后续执行：'+String(error));throw this.failure}
 }
 save(history:ContextMessage[],checkpoint:ContextCheckpoint|undefined,effects=this.effects,lastCompaction=this.lastCompaction){
  this.commit({...this.context,history:history.map(historyMessage),checkpoint,unresolvedEffects:effects,lastCompaction})
 }
 beginTool(callId:string,activity:StudioToolActivity,history:ContextMessage[],checkpoint?:ContextCheckpoint){
  this.commit({...this.context,pending:{callId,activityId:activity.id,capability:activity.capability,args:structuredClone(activity.args)},history:history.map(historyMessage),checkpoint})
 }
 finishTool(activity:StudioToolActivity,history:ContextMessage[],checkpoint?:ContextCheckpoint,effects=this.effects){
  this.commit({...this.context,pending:undefined,outbox:[...this.context.outbox,structuredClone(activity)],history:history.map(historyMessage),checkpoint,unresolvedEffects:effects})
 }
 publish(emit:(activity:StudioToolActivity)=>void){
  while(this.context.outbox.length){
   emit(structuredClone(this.context.outbox[0]))
   this.commit({...this.context,outbox:this.context.outbox.slice(1)})
  }
 }
 finish(history:ContextMessage[],checkpoint:ContextCheckpoint|undefined,complete:boolean,lastCompaction:ContextCompactionReport|undefined=this.lastCompaction){
  try{if(!this.failure)this.commit({...this.context,phase:complete?'complete':'interrupted',history:history.map(historyMessage),checkpoint,unresolvedEffects:this.effects,lastCompaction})}finally{this.release()}
 }
 private recoverPending(){
  const outstanding=new Map<string,any>()
  for(const message of this.context.history){
   if(message.role==='assistant'&&Array.isArray(message.tool_calls))for(const call of message.tool_calls)outstanding.set(call.id,call)
   if(message.role==='tool'&&message.tool_call_id)outstanding.delete(message.tool_call_id)
  }
  const pending=this.context.pending
  for(const call of outstanding.values()){
   let output:unknown={status:'error',outcome:'not-applied',output:'上次工具调用在执行前中断，未自动重放；如仍有需要，请按当前权限重新提出。'}
   if(pending&&pending.callId===call.id){
    if(!this.store.has(pending.activityId)){
     const scope=this.context.scope
     const operation={id:pending.activityId,taskId:scope.taskId,itemId:scope.itemId,workerId:scope.workerId,workspace:scope.workspace,capability:pending.capability,args:pending.args,createdAt:new Date().toISOString(),revision:this.store.revision(scope.workspace),effectKey:operationKey(scope.taskId,scope.workspace,pending.capability,pending.args)}
     this.store.begin(operation)
     this.store.finish(operation,{success:false,outcome:'unknown',elapsedMs:0,error:'进程在工具提交阶段中断，副作用未确认；先核对状态，不得自动重放。'},false)
    }
    const evidence=this.store.read(pending.activityId,this.context.scope.taskId,this.context.scope.workspace)
    const result=evidence.result,unknown=evidence.state==='unknown'||!result||result.outcome==='unknown'
    const activity:StudioToolActivity={id:pending.activityId,capability:pending.capability,args:pending.args,status:result?.success&&!unknown?'complete':'error',output:typeof result?.output==='string'?result.output:result?.output!==undefined?JSON.stringify(result.output):result?.error||'结果未知，请读取执行证据后核对，不能自动重放。'}
    output={activityId:activity.id,status:activity.status,capability:activity.capability,output:activity.output,outcome:unknown?'unknown':result?.outcome,restored:true}
    if(unknown)this.recoveredEffects.push({id:activity.id,capability:activity.capability,status:'unknown'})
    this.context.outbox.push(activity)
   }
   this.context.history.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(output)})
  }
  this.context.pending=undefined
 }
}
