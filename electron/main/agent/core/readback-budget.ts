import {estimateTokens} from '../../context-token-estimate.js'

export type ReadbackEnvelope={capability:string;activityId?:string}
export function readbackTokens(value:unknown,envelope?:ReadbackEnvelope):number{
 const output=JSON.stringify(value)
 return estimateTokens(envelope?JSON.stringify({activityId:envelope.activityId||'00000000-0000-0000-0000-000000000000',status:'complete',capability:envelope.capability,output}):output)
}
export function readbackBudget(value:unknown):number|undefined{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined}

/** Fit a whole Unicode-safe page, updating its cursor rather than silently skipping omitted text. */
export function fitReadbackPage<T extends {offset:number;total:number;nextOffset?:number;truncated:boolean}>(page:T,field:keyof T,budget:number|undefined,envelope?:ReadbackEnvelope):T{
 if(budget===undefined||readbackTokens(page,envelope)<=budget)return page
 const text=page[field]
 if(typeof text!=='string')throw new Error('回读内容不是文本')
 const build=(length:number):T=>{
  if(length<text.length&&/[\uD800-\uDBFF]/.test(text[length-1]))length--
  const end=page.offset+length
  return {...page,[field]:text.slice(0,length),nextOffset:end<page.total?end:undefined,truncated:end<page.total}
 }
 if(readbackTokens(build(0),envelope)>budget)throw new Error('上下文预算不足以返回回读元数据，请增大上下文容量')
 let low=0,high=text.length
 while(low<high){const mid=Math.ceil((low+high)/2);if(readbackTokens(build(mid),envelope)<=budget)low=mid;else high=mid-1}
 const result=build(low)
 if(text.length&&(result[field] as string).length===0)throw new Error('回读预算不足以容纳当前字符，请增大上下文容量')
 return result
}

export function fitReadbackList<T>(rows:T[],offset:number,limit:number,budget:number|undefined,envelope?:ReadbackEnvelope){
 if(!Number.isSafeInteger(offset)||offset<0||offset>rows.length)throw new Error('历史列表偏移无效')
 let workers=rows.slice(offset,offset+limit)
 const build=()=>({workers,offset,nextOffset:offset+workers.length<rows.length?offset+workers.length:undefined,total:rows.length,notice:'仅列当前任务、工作目录内允许读取的 Worker 历史。'})
 while(budget!==undefined&&workers.length&&readbackTokens(build(),envelope)>budget)workers=workers.slice(0,-1)
 if(budget!==undefined&&(readbackTokens(build(),envelope)>budget||!workers.length&&offset<rows.length))throw new Error('上下文预算不足以返回历史列表，请增大上下文容量')
 return build()
}
