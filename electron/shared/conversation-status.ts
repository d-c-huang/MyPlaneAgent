import type {StudioMessage} from './local-ai-studio.js'
import type {ContextStatus} from './local-ai-context.js'
import type {TaskPlan} from './task-plan.js'
import {visibleTaskPlan,type VisibleTask} from './task-plan-presentation.js'
import {waitReasonLabels} from './task-contract.js'
import {toolLabel} from './chat-presentation.js'

export type ConversationTaskRow=VisibleTask&{depth:number}
export function conversationTaskRows(plan?:TaskPlan):ConversationTaskRow[]{
 const rows:ConversationTaskRow[]=[]
 const add=(entry:VisibleTask,depth:number)=>{rows.push({...entry,depth});entry.children.forEach(child=>add(child,depth+1))}
 if(plan)visibleTaskPlan(plan).items.forEach(entry=>add(entry,0))
 return rows
}
export function taskNeedsAttention(row:VisibleTask):boolean{return row.status==='blocked'&&!row.children.some(child=>child.status==='blocked')}
export function conversationTaskLabel(row:VisibleTask):string{
 if(row.status==='complete')return '已完成'
 const item=row.attention||row.item
 if(row.status==='blocked'&&item.outcome==='needs_input')return '等你补充'
 if(item.runtime?.status==='waiting'&&item.runtime.waitReason)return waitReasonLabels[item.runtime.waitReason]
 return {pending:'待开始',running:'进行中',verifying:'验收中',blocked:'需要处理'}[row.status]
}
export function contextPercent(context?:ContextStatus):number{
 if(!context||!Number.isFinite(context.capacity)||context.capacity<=0)return 0
 const safe=(value:number|undefined)=>Number.isFinite(value)&&Number(value)>0?Number(value):0
 return Math.round((safe(context.inputTokens)+safe(context.reservedOutput)+safe(context.safetyTokens))/context.capacity*100)
}
export function conversationRunState(options:{sending:boolean;loading?:boolean;approval?:boolean;messages:StudioMessage[];plan?:TaskPlan;context?:ContextStatus}){
 const rows=conversationTaskRows(options.plan),attention=rows.filter(taskNeedsAttention).length
 const workers=options.plan?.items.filter(item=>item.worker&&['running','verifying'].includes(item.status))||[]
 const running=workers.filter(item=>item.runtime?.status!=='waiting').length,waiting=workers.length-running
 const latest=options.messages.filter(message=>message.role==='assistant').at(-1)
 const state=(label:string,detail:string,tone:'idle'|'working'|'attention'|'success'|'error')=>({label,detail,tone,attention,running,waiting})
 if(options.loading)return state('正在打开会话','正在读取已保存的消息与执行记录','working')
 if(options.approval)return state('等待你批准','请查看输入框上方的操作请求','attention')
 if(options.sending){
  if(options.context?.state==='compacting')return state('正在整理上下文','保留你的要求与执行记录，整理后继续','working')
  const operation=latest?.toolActivity?.find(activity=>activity.status==='running')
  if(operation)return state(toolLabel(operation),'工具执行中，结果将保存在本轮记录里','working')
  if(running||waiting)return state(running?'正在推进任务':'等待执行条件',`${running} 项进行中${waiting?'，'+waiting+' 项等待资源或依赖':''}`,'working')
  if(latest?.execution?.at(-1)?.type==='progress'&&(latest.execution.at(-1) as {phase?:string}).phase==='reviewing')return state('正在验收结果','对照当前目标核对实际执行证据','working')
  return state('正在处理','进度和工具结果会在下方同步更新','working')
 }
 if(latest?.status==='error')return state('本轮未完成','消息与执行记录已保留，可补充要求后继续','error')
 if(latest?.status==='stopped')return state('已停止','已执行的操作记录保留，继续前会核对已有结果','idle')
 if(attention)return state('有事项需要处理',`${attention} 项需要补充信息、调整预算或核对结果`,'attention')
 if(latest?.outcome==='blocked'||latest?.outcome==='needs_input')return state(latest.outcome==='needs_input'?'等待你补充':'任务暂时受阻','具体原因已保留在本轮回复中','attention')
 if(latest?.outcome==='complete')return state('本轮已完成','结果与执行记录已保存','success')
 return state(latest?'可以继续对话':'准备就绪',latest?'补充要求，或开始下一个目标':'描述目标，或选择工作目录开始文件任务','idle')
}
