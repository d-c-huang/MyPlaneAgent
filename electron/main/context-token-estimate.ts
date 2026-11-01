// Text estimate, not provider usage. Image cost is approximate and varies by model/resolution.
export function estimateTokens(value:unknown):number{
 if(value==null)return 0
 if(typeof value==='string'){let ascii=0,other=0;for(const ch of value){if(ch.codePointAt(0)!<128)ascii++;else other+=ch.codePointAt(0)!>0xffff?3:2}return Math.ceil(ascii/3)+other}
 if(Array.isArray(value))return value.reduce((sum,item)=>sum+estimateTokens(item),0)
 if(typeof value==='object'){
  const obj=value as Record<string,unknown>
  if(obj.type==='image_url')return 1024
  return Object.entries(obj).reduce((sum,[key,item])=>sum+estimateTokens(key)+estimateTokens(item)+4,0)
 }
 return 4
}
