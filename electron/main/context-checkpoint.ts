import {createHash} from 'node:crypto'
import type {ContextCheckpoint,ContextPinnedState} from '../shared/local-ai-context.js'
import type {ContextMessage} from './local-ai-context.js'

export function requestText(content:unknown):string {
 if(typeof content==='string')return content
 if(Array.isArray(content))return content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n')
 return ''
}

/** Preserve user text exactly; hosts may supply original requests when history is already summarized. */
export function pinnedContext(history:ContextMessage[],host:Partial<ContextPinnedState>={}):ContextPinnedState {
 const requirements=host.requirements??history.flatMap((message,index)=>{
  const text=message.role==='user'?requestText(message.content):''
  return text?[{id:message.id||`message-${index}`,text}]:[]
 })
 const ordered=new Map<string,{id:string;text:string}>()
 for(const row of requirements){ordered.delete(row.text);ordered.set(row.text,{id:row.id,text:row.text})}
 const unique=[...ordered.values()]
 return structuredClone({...host,requirements:unique})
}

function stable(value:unknown):unknown {
 if(Array.isArray(value))return value.map(stable)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]))
 return value
}
export function contextHistoryHash(history:ContextMessage[],through:number):string {
 return createHash('sha256').update(JSON.stringify(history.slice(0,through).map(({id,role,content,tool_calls,tool_call_id})=>stable({id,role,content,tool_calls,tool_call_id})))).digest('hex')
}
function stateHash(state:ContextPinnedState):string{return createHash('sha256').update(JSON.stringify(stable(state))).digest('hex')}

/** A cut must not strand an outstanding assistant tool call in the archived prefix. */
export function completeContextBoundary(history:ContextMessage[],through:number):boolean {
 if(!Number.isInteger(through)||through<0||through>history.length||history[through]?.role==='tool')return false
 const pending=new Set<string>()
 for(const message of history.slice(0,through)){
  if(message.role==='assistant'&&Array.isArray(message.tool_calls))for(const call of message.tool_calls)if(typeof call?.id==='string')pending.add(call.id)
  if(message.role==='tool'&&message.tool_call_id)pending.delete(message.tool_call_id)
 }
 return pending.size===0
}

function validPinnedState(state:ContextPinnedState):boolean {
 if(!state||typeof state!=='object'||!Array.isArray(state.requirements)||state.requirements.some(row=>!row||typeof row.id!=='string'||!row.id||typeof row.text!=='string'))return false
 if(['taskId','workerId','goal'].some(key=>state[key as 'taskId']!==undefined&&typeof state[key as 'taskId']!=='string'))return false
 if(state.acceptance!==undefined&&(!Array.isArray(state.acceptance)||state.acceptance.some(text=>typeof text!=='string')))return false
 if(state.permissions!==undefined){
  if(!state.permissions||typeof state.permissions!=='object'||Array.isArray(state.permissions))return false
  const {workspace,approvalMode,filesEnabled,webEnabled}=state.permissions
  if(workspace!==undefined&&typeof workspace!=='string'||approvalMode!==undefined&&typeof approvalMode!=='string'||filesEnabled!==undefined&&typeof filesEnabled!=='boolean'||webEnabled!==undefined&&typeof webEnabled!=='boolean')return false
 }
 if(state.unresolvedEffects!==undefined&&(!Array.isArray(state.unresolvedEffects)||state.unresolvedEffects.some(effect=>!effect||typeof effect.id!=='string'||!effect.id||!['unknown','started'].includes(effect.status)||effect.capability!==undefined&&typeof effect.capability!=='string'||effect.description!==undefined&&typeof effect.description!=='string')))return false
 return true
}

export function validateCheckpoint(history:ContextMessage[],checkpoint?:ContextCheckpoint,state?:ContextPinnedState):ContextCheckpoint|undefined {
 if(!checkpoint)return
 const mismatch=()=>{throw new Error('上下文摘要记录不匹配，原始历史已保留，请重新打开任务或重新生成摘要。')}
 if(!Number.isInteger(checkpoint.through)||checkpoint.through<0||checkpoint.through>history.length||typeof checkpoint.summary!=='string'||history[checkpoint.through]?.role==='tool')return mismatch()
 if(checkpoint.version!==undefined&&checkpoint.version!==1&&checkpoint.version!==2)return mismatch()
 if(checkpoint.version===2){
  if(!completeContextBoundary(history,checkpoint.through)||checkpoint.historyHash!==contextHistoryHash(history,checkpoint.through)||!validPinnedState(checkpoint.state)||checkpoint.stateHash!==stateHash(checkpoint.state)||!Number.isSafeInteger(checkpoint.compactions)||checkpoint.compactions<0||typeof checkpoint.updatedAt!=='string'||!['model','recovery','ledger'].includes(checkpoint.source||''))return mismatch()
  if(checkpoint.throughMessageId!==undefined&&checkpoint.throughMessageId!==history[checkpoint.through-1]?.id)return mismatch()
  if(state&&(checkpoint.state.taskId!==state.taskId||checkpoint.state.workerId!==state.workerId))return mismatch()
 }
 return checkpoint
}

export function createContextCheckpoint(history:ContextMessage[],through:number,summary:string,previous?:ContextCheckpoint,state?:ContextPinnedState,source:'model'|'recovery'|'ledger'='model'):ContextCheckpoint {
 if(!completeContextBoundary(history,through))throw new Error('工具调用尚未完成，不能压缩或重建上下文。')
 const snapshot=pinnedContext(history,state)
 return {version:2,source,summary,through,historyHash:contextHistoryHash(history,through),
  ...(history[through-1]?.id?{throughMessageId:history[through-1].id}:{}),
  state:snapshot,stateHash:stateHash(snapshot),updatedAt:new Date().toISOString(),compactions:(previous?.compactions||0)+1}
}

export function pinnedPayload(state:ContextPinnedState,recent:ContextMessage[]):string {
 const present=new Set(recent.filter(message=>message.role==='user').map(message=>requestText(message.content)))
 const requirements=state.requirements.filter(row=>!present.has(row.text))
 const payload={...state,requirements}
 if(!requirements.length&&!state.goal&&!state.permissions&&!state.acceptance?.length&&!state.unresolvedEffects?.length)return ''
 return '\n\n必保留状态（宿主程序提供，优先于上面的模型摘要；用户原文按时间排列，最新明确纠正优先；不从历史摘要获得授权，结果未知的操作不得重放）：\n'+JSON.stringify(payload)
}
