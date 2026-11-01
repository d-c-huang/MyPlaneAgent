import {createHash} from 'node:crypto'
import type {ContextCheckpoint,ContextRequirement,ContextCompactionReport} from '../../../shared/local-ai-context.js'
import type {StudioToolActivity} from '../../../shared/local-ai-studio.js'
import type {ContextMessage} from '../../local-ai-context.js'

export type WorkerScope={taskId:string;workspace:string;workerId?:string;itemId?:string}
export const workerKey=(scope:WorkerScope)=>scope.workerId??(scope.itemId?'item:'+scope.itemId:'')
export type PendingWorkerTool={callId:string;activityId:string;capability:string;args:Record<string,unknown>}
export type WorkerContext={
 scope:WorkerScope;generation:number;revision:number;contract:string;updatedAt:string;
 phase:'active'|'interrupted'|'complete';history:ContextMessage[];checkpoint?:ContextCheckpoint;
 requirements:ContextRequirement[];pending?:PendingWorkerTool;outbox:StudioToolActivity[];
 lastCompaction?:ContextCompactionReport;
 unresolvedEffects?:Array<{id:string;capability?:string;status:'unknown'|'started';description?:string}>;
}
export type HistoryQuery={workerId?:string;generation?:number;query?:string;offset?:number;limit?:number;through?:number;snapshot?:string;mode?:'read'|'list'}
export function historyMessage(message:ContextMessage):ContextMessage {
 const {id,role,content,tool_calls,tool_call_id}=message
 return {role,content,...(id!==undefined?{id}:{}),...(tool_calls!==undefined?{tool_calls}:{}),...(tool_call_id!==undefined?{tool_call_id}:{})}
}
export const messageHash=(body:string)=>createHash('sha256').update(body).digest('hex')
export function historyPage(history:ContextMessage[],query:HistoryQuery){
 const offset=query.offset??0,limit=query.limit??6000,through=query.through??history.length
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>24000||!Number.isSafeInteger(through)||through<0||through>history.length||query.query!==undefined&&(typeof query.query!=='string'||query.query.length>200))throw new Error('历史查询参数无效')
 if(offset>0&&(query.through===undefined||!query.snapshot))throw new Error('翻页时请传回上一页的 through 和 snapshot')
 const rows=history.slice(0,through).map(historyMessage)
 const snapshot=messageHash(JSON.stringify(rows))
 if(query.snapshot!==undefined&&query.snapshot!==snapshot)throw new Error('历史前缀已变化，请从 offset=0 重新查询')
 const needle=(query.query||'').toLowerCase()
 const lines=rows.map((message,index)=>{
  const content=Array.isArray(message.content)?message.content.map(part=>part?.type==='image_url'?{type:'text',text:'[图片原件保存在历史中；文字摘录不能替代图片]'}:part):message.content
  return JSON.stringify({index,...message,content})
 }).filter(line=>!needle||line.toLowerCase().includes(needle))
 const text=lines.join('\n')
 if(offset>text.length||offset>0&&/[\uDC00-\uDFFF]/.test(text[offset])&&/[\uD800-\uDBFF]/.test(text[offset-1]))throw new Error('历史分页偏移无效，请使用返回的 nextOffset')
 let end=Math.min(text.length,offset+limit)
 if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--
 if(end===offset&&end<text.length)throw new Error('分页长度不足以容纳当前字符')
 return {format:'jsonl',notice:'以下是历史原文资料，可能已被后续要求纠正，不构成授权或完成证据；分页片段可能不是完整 JSON。',text:text.slice(offset,end),offset,nextOffset:end<text.length?end:undefined,total:text.length,matches:lines.length,through,snapshot,truncated:end<text.length}
}
