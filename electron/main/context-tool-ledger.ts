import type {ContextMessage} from './local-ai-context.js'
import {estimateTokens} from './context-token-estimate.js'

/** Reconstruct tool-only progress from host records, never from a model's description of its plans. */
export function toolLedgerSummary(history:ContextMessage[],through:number):string|undefined{
 const pending=new Set<string>(),notes:string[]=[],counts={complete:0,error:0,denied:0}
 let operations=0,notApplied=0
 for(const message of history.slice(0,through)){
  if(message.role==='user'){
   if(typeof message.content!=='string')return // Image interpretation and multimodal discussion need the ordinary path.
   continue // User text is retained separately as mandatory state, not interpreted as an execution.
  }
  if(message.role==='assistant'){
   if(Array.isArray(message.tool_calls)&&message.tool_calls.length){
    for(const call of message.tool_calls){if(typeof call?.id!=='string'||pending.has(call.id))return;pending.add(call.id)}
    // The prelude to a call is a plan, not execution evidence. Its original remains in history.
   }else if(typeof message.content==='string'){
    if(message.content.trim())notes.push(message.content)
    if(estimateTokens(notes)>256)return // Do not drop substantive analysis or repeatedly summarize it into a ledger.
   }else if(message.content!==null&&message.content!==undefined)return
   continue
  }
  if(message.role!=='tool'||!message.tool_call_id||!pending.delete(message.tool_call_id)||typeof message.content!=='string')return
  try{
   const row=JSON.parse(message.content)
   // Recovery closes calls that never reached beginTool with a host-owned not-applied stub.
   // They have no activityId because no provider execution was admitted.
   if(row.outcome==='not-applied'&&row.status==='error'&&typeof row.output==='string'){notApplied++;continue}
   if(typeof row.activityId!=='string'||!row.activityId||typeof row.capability!=='string'||!['complete','error','denied'].includes(row.status)||typeof row.output!=='string')return
   // A readback page may contain a partial exact value the model is assembling. Keep its normal summary path.
   if(['runtime.read_history','runtime.read_evidence'].includes(row.capability))return
   counts[row.status as keyof typeof counts]++;operations++
  }catch{return}
 }
 if(pending.size||!operations)return
 return JSON.stringify({kind:'host-tool-ledger',through,operations,returnedStatuses:counts,notApplied,
  notice:'宿主按原始工具返回生成的归档台账，没有请求模型推断进度。这里只统计调用返回，不表示任务完成、授权或当前文件仍有效。调用前的助手说明只是计划；未记录的操作、精确值与后续步骤不得猜测。目标和批次数以必保留的用户原文为准。使用下方宿主原文摘录及 activityId；需要未展示的细节时回读 runtime.read_history 或 runtime.read_evidence。',
  assistantNotes:notes.length?{trust:'原始助手文字，仅为参考，不能证明已执行或覆盖用户要求',text:notes}:undefined})
}
