import type {StudioEvent,StudioSession} from '../shared/local-ai-studio.js'
import {buildRuntimeGraph,type RuntimeGraphActivity,type RuntimeGraphEvent,type RuntimeGraphSnapshot} from '../shared/runtime-graph.js'
import type {TaskPlan} from '../shared/task-plan.js'

const compactPlan=(plan:TaskPlan|undefined):TaskPlan|undefined=>plan&&({taskId:plan.taskId,workspace:plan.workspace,scope:plan.scope,updatedAt:plan.updatedAt,items:plan.items.slice(0,64).map(item=>({id:item.id,title:item.title,acceptance:item.acceptance,kind:item.kind,parentId:item.parentId,dependsOn:item.dependsOn,worker:item.worker&&{...item.worker},runtime:item.runtime&&{...item.runtime},status:item.status,outcome:item.outcome,attempts:item.attempts,summary:item.summary.slice(0,1200),evidenceIds:[]}))})
const compactActivity=(activity:import('../shared/local-ai-studio.js').StudioToolActivity)=>({id:activity.id,capability:activity.capability,args:{},status:activity.status,workerId:activity.workerId,notApplied:activity.notApplied,output:activity.output?.slice(0,1200)})
function compactSession(session:StudioSession):StudioSession {
 const boundary=session.abilityTask?.startMessageId||session.conversationStartMessageId,index=boundary?session.messages.findIndex(message=>message.id===boundary):-1
 return {id:session.id,title:session.title,model:session.model,systemPrompt:'',createdAt:session.createdAt,updatedAt:session.updatedAt,defaultWorkspace:session.defaultWorkspace,abilityTask:session.abilityTask&&{...session.abilityTask},conversationStartMessageId:session.conversationStartMessageId,taskPlan:compactPlan(session.taskPlan),messages:(index>=0?session.messages.slice(index):session.messages.slice(-2)).slice(-30).map(message=>({id:message.id,role:message.role,content:message.content.slice(0,1200),createdAt:message.createdAt,status:message.status,outcome:message.outcome,error:message.error,execution:message.execution?.slice(-100),toolActivity:message.toolActivity?.slice(-80).map(compactActivity)}))}
}

const configRevisions=(session:StudioSession)=>Object.fromEntries(Object.entries(session.workbench?.nodes||{}).map(([id,node])=>[id,node.revision]))
type Run={session:StudioSession;revisions:Record<string,number>;requestId?:string;tools:Map<string,RuntimeGraphActivity>;events:RuntimeGraphEvent[];truncated:boolean}
export class RuntimeGraphStore {
 private readonly runs=new Map<string,Run>()
 has(sessionId:string){return this.runs.has(sessionId)}
 remember(session:StudioSession,fromDisk=false){
  const run=this.runs.get(session.id)
  const truncated=(session.taskPlan?.items.length||0)>64||session.messages.some(message=>(message.toolActivity?.length||0)>80)
  if(run){if(!fromDisk||!run.requestId){run.session=compactSession(session);run.revisions=configRevisions(session);run.truncated||=truncated}return}
  this.runs.set(session.id,{session:compactSession(session),revisions:configRevisions(session),tools:new Map(),events:[],truncated})
  if(this.runs.size>40){const oldest=[...this.runs.values()].filter(row=>!row.requestId).sort((a,b)=>a.session.updatedAt.localeCompare(b.session.updatedAt))[0];if(oldest)this.runs.delete(oldest.session.id)}
 }
 start(session:StudioSession,requestId:string){this.remember(session);const run=this.runs.get(session.id)!;run.requestId=requestId;run.tools.clear();run.events=[]}
 event(sessionId:string,event:StudioEvent){
  const run=this.runs.get(sessionId);if(!run||run.requestId!==event.requestId)return
  const at=new Date().toISOString()
  if(event.type==='task-plan')run.session.taskPlan=compactPlan(event.plan)
  if(event.type==='tool'||event.type==='approval'){
   const activity=event.activity,previous=run.tools.get(activity.id)
   run.tools.set(activity.id,{activity:compactActivity(activity),at})
   while(run.tools.size>80){run.truncated=true;run.tools.delete(run.tools.keys().next().value!)}
   if(previous?.activity.status!==activity.status)run.events.push({id:activity.id+':'+activity.status,at,label:activity.capability,nodeId:`tool:${activity.workerId?'worker:'+activity.workerId:'agent:coordinator'}:${activity.capability}`,status:activity.status==='denied'?'waiting':activity.status,detail:activity.output?.slice(0,300)})
  }else if(event.type==='progress')run.events.push({id:event.entry.id,at:event.entry.createdAt,label:event.entry.text.slice(0,300),nodeId:'task:root',status:'running'})
  else if(event.type==='finished'){run.session=compactSession(event.session);run.revisions=configRevisions(event.session)}
  run.events=run.events.slice(-60)
 }
 finish(sessionId:string,requestId:string){const run=this.runs.get(sessionId);if(run?.requestId===requestId)run.requestId=undefined}
 remove(sessionId:string){this.runs.delete(sessionId)}
 snapshot(sessionId?:string):RuntimeGraphSnapshot {
  const runs=[...this.runs.values()].sort((a,b)=>Number(!!b.requestId)-Number(!!a.requestId)||b.session.updatedAt.localeCompare(a.session.updatedAt))
  const sessions=runs.map(({session,requestId})=>({id:session.id,title:session.title,active:!!requestId,updatedAt:session.updatedAt}))
  const run=sessionId?this.runs.get(sessionId):runs[0]
  if(!run)return {version:1,title:'暂无运行记录',active:false,updatedAt:new Date().toISOString(),sessions,nodes:[],edges:[],events:[],truncated:false}
  const graph=buildRuntimeGraph(run.session,!!run.requestId,[...run.tools.values()],run.events)
  for(const node of graph.nodes){
   const item=run.session.taskPlan?.items.find(item=>node.id==='task:'+item.id||node.id==='agent:'+item.id||node.id==='worker:'+item.worker?.id||node.id.startsWith('tool:worker:'+item.worker?.id+':'))
   const scope=item?.id||(node.id==='task:root'||node.id==='agent:coordinator'||node.id.startsWith('tool:agent:coordinator:')?'main':undefined)
   if(scope)node.configRevision=run.revisions[scope]||0
  }
  return {...graph,truncated:graph.truncated||run.truncated,sessions}
 }
}
