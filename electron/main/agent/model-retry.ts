const transientCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'])
const maxAttempts=3,maxDelayMs=30_000
export type ModelRetryNotice={attempt:number;maxAttempts:number;delayMs:number;error:string}
export class ModelRequestError extends Error {
 constructor(message:string,readonly status:number,readonly retryAfterMs?:number){super(message);this.name='ModelRequestError'}
}
export function modelRetryAfter(value:string|null,now=Date.now()):number|undefined {
 if(!value?.trim())return
 const seconds=Number(value)
 if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000
 const date=Date.parse(value)
 if(Number.isFinite(date))return Math.max(0,date-now)
}
export function transientModelError(error:unknown):boolean {
 if(error instanceof ModelRequestError)return error.status===408||error.status===429||error.status>=500&&error.status<=599
 // Only known transport failures are retryable. Validation, authentication,
 // user cancellation and model-format failures must keep their original meaning.
 let current=error
 for(let depth=0;depth<4&&current&&typeof current==='object';depth++){
  const cause=current as {code?:unknown;cause?:unknown}
  if(typeof cause.code==='string'&&transientCodes.has(cause.code))return true
  current=cause.cause
 }
 return false
}
function waitForRetry(ms:number,signal:AbortSignal){
 signal.throwIfAborted()
 return new Promise<void>((resolve,reject)=>{
  const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(signal.reason)}
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},ms)
  signal.addEventListener('abort',stop,{once:true})
 })
}
export async function retryModelRequest<T>(request:()=>Promise<T>,signal:AbortSignal,hasOutput:()=>boolean,onRetry?:(notice:ModelRetryNotice)=>void):Promise<T>{
 for(let attempt=1;;attempt++){
  signal.throwIfAborted()
  try{return await request()}catch(error){
   signal.throwIfAborted()
   if(attempt>=maxAttempts||hasOutput()||!transientModelError(error))throw error
   const retryAfter=error instanceof ModelRequestError?error.retryAfterMs:undefined
   // Do not retry earlier than the provider permits, or hold a task indefinitely.
   if(retryAfter!==undefined&&retryAfter>maxDelayMs)throw error
   const delayMs=Math.max(1000*2**(attempt-1),retryAfter??0)
   onRetry?.({attempt:attempt+1,maxAttempts,delayMs,error:error instanceof Error?error.message:String(error)})
   await waitForRetry(delayMs,signal)
  }
 }
}
