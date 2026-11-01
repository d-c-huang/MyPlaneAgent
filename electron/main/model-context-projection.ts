import type {ContextMessage} from './local-ai-context.js'
import {estimateTokens} from './context-token-estimate.js'
import {capabilityAlias} from './agent/core/tool-surface.js'

const cache=new WeakMap<ContextMessage,{source:string;capacity:number;content:string}>()
export const toolResultContextBudget=(capacity:number)=>Math.max(256,Math.min(2048,Math.floor(capacity*.12)))
const readers=new Set(['runtime.read_history','runtime.read_evidence'])

/** Pure view: preserve originals, statuses, call pairing and evidence IDs; never summarize with a model. */
function projectResult(message:ContextMessage,capacity:number):ContextMessage{
 if(message.role!=='tool'||typeof message.content!=='string')return message
 const cached=cache.get(message)
 if(cached?.source===message.content&&cached.capacity===capacity)return cached.content===message.content?message:{...message,content:cached.content}
 let content=message.content
 try{
  const row=JSON.parse(content),limit=toolResultContextBudget(capacity)
  // Only host result envelopes are projected. Readback pages must remain lossless.
  if(typeof row.activityId==='string'&&typeof row.capability==='string'&&['complete','error','denied'].includes(row.status)&&
   typeof row.output==='string'&&!readers.has(row.capability)&&estimateTokens(content)>limit){
   const original=row.output,chars=Array.from(original)
   const envelope={...row,projection:{version:1,kind:'excerpt',readWith:'runtime.read_evidence',originalCharacters:row.projection?.originalCharacters??original.length}}
   const encode=(length:number)=>JSON.stringify({...envelope,output:chars.slice(0,Math.ceil(length*.65)).join('')+'\n[中段省略；用 activityId 回读完整结果，省略部分不能作为验收依据]\n'+(length?chars.slice(chars.length-Math.floor(length*.35)).join(''):'')})
   // If metadata itself cannot fit, retain it and let the normal budget guard explain the limit.
   if(estimateTokens(encode(0))<=limit){
    let low=0,high=chars.length
    while(low<high){const mid=Math.ceil((low+high)/2);if(estimateTokens(encode(mid))<=limit)low=mid;else high=mid-1}
    content=encode(low)
   }
  }
 }catch{/* Unstructured, legacy and malformed results remain available without reinterpretation. */}
 cache.set(message,{source:message.content,capacity,content})
 return content===message.content?message:{...message,content}
}

/** Bind historical core aliases by the paired host capability, without rewriting the durable log. */
export function projectModelHistory(messages:ContextMessage[],capacity:number):ContextMessage[]{
 const pending=new Map<string,{message:number;call:number}>(),renames=new Map<number,Map<number,string>>()
 for(let index=0;index<messages.length;index++){
  const message=messages[index]
  if(message.role==='assistant'&&Array.isArray(message.tool_calls))message.tool_calls.forEach((call,position)=>{if(typeof call?.id==='string')pending.set(call.id,{message:index,call:position})})
  if(message.role!=='tool'||!message.tool_call_id)continue
  const call=pending.get(message.tool_call_id);pending.delete(message.tool_call_id)
  if(!call||typeof message.content!=='string')continue
  try{
   const row=JSON.parse(message.content),original=messages[call.message].tool_calls as Array<{function?:{name?:string}}>
   if(typeof row.activityId!=='string'||typeof row.capability!=='string'||!original[call.call].function?.name?.startsWith('cap_'))continue
   const alias=capabilityAlias(row.capability)
   if(alias!==original[call.call].function!.name){
    const changes=renames.get(call.message)||new Map<number,string>();changes.set(call.call,alias);renames.set(call.message,changes)
   }
  }catch{/* Do not guess identities from partial text or model-generated names. */}
 }
 return messages.map((message,index)=>{
  const changes=renames.get(index)
  if(changes&&Array.isArray(message.tool_calls))return {...message,tool_calls:message.tool_calls.map((call,position)=>changes.has(position)?{...call,function:{...call.function,name:changes.get(position)}}:call)}
  return projectResult(message,capacity)
 })
}
