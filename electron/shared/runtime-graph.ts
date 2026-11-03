import type {StudioSession,StudioToolActivity} from './local-ai-studio.js'
import {waitReasonLabels} from './task-contract.js'

export type RuntimeNodeKind='task'|'agent'|'worker'|'tool'
export type RuntimeNodeStatus='idle'|'queued'|'running'|'waiting'|'complete'|'error'|'paused'|'cancelled'
export type RuntimeGraphNode={id:string;sourceId:string;kind:RuntimeNodeKind;label:string;status:RuntimeNodeStatus;detail:string;lane:number;order:number;metrics:Array<{label:string;value:string}>;activity?:string;phase?:string;pauseRequested?:boolean;configRevision?:number;appliedRevision?:number}
export type RuntimeGraphEdge={id:string;source:string;target:string;kind:'contains'|'dependency'|'delegates'|'executes'|'calls';label:string;status:RuntimeNodeStatus;activeAt?:string;returning?:boolean}
export type RuntimeGraphEvent={id:string;at:string;label:string;nodeId:string;status:RuntimeNodeStatus;detail?:string}
export type RuntimeGraphSession={id:string;title:string;active:boolean;updatedAt:string}
export type RuntimeGraphSnapshot={version:1;sessionId?:string;title:string;active:boolean;updatedAt:string;sessions:RuntimeGraphSession[];nodes:RuntimeGraphNode[];edges:RuntimeGraphEdge[];events:RuntimeGraphEvent[];truncated:boolean}
export type RuntimeGraphActivity={activity:StudioToolActivity;at:string}
export const runtimeNodeLabels:Record<RuntimeNodeKind,string>={task:'任务',agent:'智能体',worker:'Worker',tool:'工具'}
export const runtimeStatusLabels:Record<RuntimeNodeStatus,string>={idle:'空闲',queued:'待执行',running:'运行中',waiting:'等待中',complete:'已完成',error:'异常',paused:'已暂停',cancelled:'已取消'}
export const runtimeStatusColors:Record<RuntimeNodeStatus,string>={idle:'#8292ae',queued:'#8292ae',running:'#50d9ef',waiting:'#f8c572',complete:'#69dbb0',error:'#ff829c',paused:'#b3a1ef',cancelled:'#8192ad'}
const text=(value:unknown,max=1200)=>typeof value==='string'?value.slice(0,max):''
const toolStatus=(activity:StudioToolActivity):RuntimeNodeStatus=>activity.status==='denied'?'waiting':activity.status==='complete'&&activity.notApplied?'waiting':activity.status

/** Build a bounded view from actual saved/live state; no synthetic workers or calls. */
export function buildRuntimeGraph(session:StudioSession,active=false,live:RuntimeGraphActivity[]=[],liveEvents:RuntimeGraphEvent[]=[]):Omit<RuntimeGraphSnapshot,'sessions'> {
 const nodes:RuntimeGraphNode[]=[],edges:RuntimeGraphEdge[]=[],events:RuntimeGraphEvent[]=[]
 const plan=session.taskPlan,rootId='task:root',coordinator='agent:coordinator'
 const title=text(plan?.scope?.goal,120)||text(session.title,120)||'当前会话'
 const last=session.messages.filter(message=>message.role==='assistant').at(-1)
 const state:RuntimeNodeStatus=active?'running':last?.status==='stopped'?'cancelled':session.abilityTask?.status==='complete'||(!plan&&last?.status==='complete')?'complete':last?.error?'error':last?.outcome==='needs_input'||last?.outcome==='blocked'||session.abilityTask?.status==='paused'?'waiting':plan?'paused':'idle'
 const settled=(status:RuntimeNodeStatus)=>!active&&status==='running'?'paused':status
 const add=(node:RuntimeGraphNode)=>nodes.push(node)
 const edge=(source:string,target:string,kind:RuntimeGraphEdge['kind'],label:string,status:RuntimeNodeStatus,extra:Partial<RuntimeGraphEdge>={})=>edges.push({id:`${kind}:${source}:${target}`,source,target,kind,label,status,...extra})
 add({id:rootId,sourceId:plan?.taskId||session.id,kind:'task',label:title,status:state,detail:text(plan?.scope?.goal||session.messages.filter(message=>message.role==='user').at(-1)?.content),lane:0,order:0,metrics:[{label:'任务完成',value:`${plan?.items.filter(item=>item.status==='complete').length||0} / ${plan?.items.length||0}`},{label:'工作目录',value:plan?.workspace||session.defaultWorkspace?.path||'未记录'}]})
 add({id:coordinator,sourceId:session.id,kind:'agent',label:'主智能体',status:state,detail:'负责理解目标、分解任务和汇总结果。',lane:-1,order:0,metrics:[{label:'模型',value:session.model||'未记录'},{label:'会话',value:session.id}]})
 edge(coordinator,rootId,'delegates','协调任务',state)
 const items=(plan?.items||[]).slice(0,64),byId=new Map(items.map(item=>[item.id,item])),workers=new Map<string,string>()
 items.forEach((item,index)=>{
  const id='task:'+item.id
  const status:RuntimeNodeStatus=settled(item.status==='complete'?'complete':item.runtime?.status==='cancelled'?'cancelled':item.runtime?.status==='waiting'||item.outcome==='needs_input'?'waiting':item.runtime?.status==='failed'?'error':item.status==='blocked'?'waiting':item.status==='running'||item.status==='verifying'?'running':'queued')
  add({id,sourceId:item.id,kind:'task',label:text(item.title,180),status,detail:text(item.summary||item.acceptance),lane:1,order:index,metrics:[{label:'验收条件',value:text(item.acceptance)},{label:'执行阶段',value:item.runtime?.phase||item.kind||'未开始'},...(item.runtime?.waitReason?[{label:'等待原因',value:waitReasonLabels[item.runtime.waitReason]}]:[]),{label:'尝试次数',value:String(item.attempts)}]})
  edge(item.parentId&&byId.has(item.parentId)?'task:'+item.parentId:rootId,id,'contains','包含子任务',status)
  for(const dep of item.dependsOn||[])if(byId.has(dep)&&dep!==item.id)edge('task:'+dep,id,'dependency','前置 → 后续',byId.get(dep)?.status==='complete'?'complete':'queued')
  const agent='agent:'+item.id
  const role={read:'读取',write:'修改',verify:'核验'}[item.worker?.mode||item.mode||'read']
  add({id:agent,sourceId:item.id,kind:'agent',label:`子智能体 · ${role} ${index+1}`,status,detail:'此子任务的执行角色；下方 Worker 是它实际绑定的运行实例。',lane:2,order:index,metrics:[{label:'负责',value:text(item.title)},{label:'模型',value:session.model||'未记录'}]})
  edge(id,agent,'delegates','交给子智能体',status)
  if(!item.worker)return
  const worker='worker:'+item.worker.id;workers.set(item.worker.id,worker)
  add({id:worker,sourceId:item.worker.id,kind:'worker',label:`Worker ${index+1}`,status,detail:text(item.summary)||`正在为“${item.title}”执行${role}工作。`,lane:3,order:index,metrics:[{label:'实例 ID',value:item.worker.id},{label:'工具调用',value:String(item.worker.toolCalls)},{label:'模型请求',value:String(item.worker.modelRequests||0)},{label:'Tokens',value:(item.worker.tokens||0).toLocaleString('zh-CN')},{label:'开始',value:item.worker.startedAt||item.worker.assignedAt},{label:'结束',value:item.worker.finishedAt||'—'}]})
  edge(agent,worker,'executes','运行实例',status)
 })
 const boundary=session.abilityTask?.startMessageId||session.conversationStartMessageId
 const start=boundary?session.messages.findIndex(message=>message.id===boundary):-1
 const messages=start>=0?session.messages.slice(start):session.messages.slice(-2)
 const activities=new Map<string,RuntimeGraphActivity>()
 for(const message of messages)for(const activity of message.toolActivity||[]){const at=message.execution?.find(entry=>entry.type==='tool'&&entry.activityId===activity.id)?.createdAt||message.createdAt;activities.set(activity.id,{activity,at})}
 for(const row of live)activities.set(row.activity.id,row)
 const recent=[...activities.values()].slice(-80),toolNodes=new Map<string,RuntimeGraphNode>()
 for(const {activity,at} of recent){
  let source=activity.workerId?workers.get(activity.workerId):coordinator
  if(!source&&activity.workerId){source='worker:'+activity.workerId;workers.set(activity.workerId,source);add({id:source,sourceId:activity.workerId,kind:'worker',label:'Worker · '+activity.workerId.slice(-6),status:settled(toolStatus(activity)),detail:'工具记录中的 Worker；当前计划未保留它的任务归属。',lane:3,order:workers.size,metrics:[{label:'实例 ID',value:activity.workerId}]})}
  source??=coordinator
  const id=`tool:${source}:${activity.capability}`,status=settled(toolStatus(activity))
  if(!toolNodes.has(id)){const node:RuntimeGraphNode={id,sourceId:activity.capability,kind:'tool',label:activity.capability.replace(/^agent\./,''),status,detail:text(activity.output)||'等待工具结果。',lane:4,order:toolNodes.size,metrics:[]};add(node);toolNodes.set(id,node);edge(source,id,'calls','调用 → 返回',status)}
  const node=toolNodes.get(id)!,link=edges.find(row=>row.source===source&&row.target===id)!
  node.status=status;node.detail=text(activity.output)||'等待工具结果。';node.metrics=[{label:'能力',value:activity.capability},{label:'调用 ID',value:activity.id},{label:'更新时间',value:at}]
  link.status=status;link.activeAt=active?at:undefined;link.returning=['complete','error','denied'].includes(activity.status)
  events.push({id:activity.id+':'+activity.status,at,label:activity.capability,nodeId:id,status,detail:text(activity.output,300)})
 }
 // Keep live transitions (running → complete/error) alongside the final saved result.
 const eventMap=new Map(events.map(event=>[event.id,event]))
 for(const event of liveEvents){const nodeId=nodes.some(node=>node.id===event.nodeId)?event.nodeId:rootId;eventMap.set(event.id,{...event,nodeId})}
 const ids=new Set(nodes.map(node=>node.id))
 return {version:1,sessionId:session.id,title,active,updatedAt:live.at(-1)?.at||plan?.updatedAt||session.updatedAt,nodes,edges:edges.filter(link=>ids.has(link.source)&&ids.has(link.target)),events:[...eventMap.values()].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,60),truncated:(plan?.items.length||0)>items.length||activities.size>recent.length}
}
