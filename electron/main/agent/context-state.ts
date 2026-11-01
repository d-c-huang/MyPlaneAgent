import type {ContextPinnedState} from '../../shared/local-ai-context.js'
import type {StudioSession} from '../../shared/local-ai-studio.js'
import type {AgentTask} from '../../shared/local-ai-agent.js'
import {pinnedContext,type ContextMessage} from '../local-ai-context.js'

export function sessionContextState(session:StudioSession,history:ContextMessage[],workspace?:string):ContextPinnedState {
 return pinnedContext(history,{
  taskId:session.abilityTask?.id||session.id,goal:session.taskPlan?.scope?.goal,
  permissions:{workspace,filesEnabled:!!session.projectId||session.approvalMode==='full',webEnabled:session.webEnabled===true,approvalMode:session.approvalMode||'ask'},
  acceptance:session.taskPlan?.items.filter(item=>item.status!=='complete').map(item=>JSON.stringify({title:item.title,acceptance:item.acceptance,verification:item.verification})),
  unresolvedEffects:Object.entries(session.operationJournal||{}).filter(([,operation])=>operation.status==='started').map(([id])=>({id,status:'started'})),
 })
}

export function agentContextState(task:AgentTask,history:ContextMessage[]):ContextPinnedState {
 return pinnedContext(history,{
  taskId:task.id,goal:task.facts?.goal,
  permissions:{workspace:task.workspace,filesEnabled:task.mode!=='chat',approvalMode:task.approvalMode||'ask'},
  acceptance:task.plan.filter(item=>item.status!=='completed').map(item=>item.text),
  unresolvedEffects:task.events.filter(event=>event.execution?.state==='unknown'||event.execution?.state==='running').map(event=>({id:event.execution!.id,capability:event.tool,status:'unknown'})),
 })
}
