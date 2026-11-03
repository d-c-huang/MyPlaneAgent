import { randomUUID } from 'node:crypto'
import { validateToolArguments } from './execution-guards.js'
import type { InspectionCall, InspectionCommand, InspectionState } from '../../../shared/execution-inspector.js'

type Pending={call:InspectionCall;draft?:string;resolve:(args:Record<string,unknown>)=>void;reject:(reason:unknown)=>void;validate?:(args:Record<string,unknown>)=>void}
export type InspectionScope={scopeId?:string;workerId?:string;signal?:AbortSignal}

/** Each concurrent execution owns its checkpoint. Closing a view never releases it. */
export class ExecutionInspector {
  private calls:InspectionCall[]=[]
  private pauseRequested:boolean
  private readonly scopes=new Map<string,boolean>()
  private readonly pending=new Map<string,Pending>()
  constructor(private signal:AbortSignal,pause=false,private readonly onChange?:(label:string)=>void){this.pauseRequested=pause}
  isPaused(scopeId='main'){return this.scopes.get(scopeId)??this.pauseRequested}
  snapshot():InspectionState{
    const first=this.pending.values().next().value as Pending|undefined
    return structuredClone({pauseRequested:this.pauseRequested||[...this.scopes.values()].some(Boolean),checkpointId:first?.call.id,checkpointIds:[...this.pending.keys()],pausedScopes:[...this.scopes].filter(([,paused])=>paused).map(([id])=>id),draft:first?.draft,calls:this.calls})
  }
  finish():InspectionState{
    for(const pending of this.pending.values())pending.reject(new Error('对话已结束'))
    this.pending.clear()
    for(const call of this.calls)if(['ready','running','paused'].includes(call.status)){call.status='error';call.output??='对话已结束，此调用未返回完成结果'}
    this.pauseRequested=false;this.scopes.clear()
    this.onChange?.('执行检查结束')
    return {...this.snapshot(),finished:true,checkpointId:undefined}
  }
  private validate(pending:Pending,args:Record<string,unknown>){
    if(JSON.stringify(args).length>200000)throw new Error('入参不能超过 200000 字符')
    validateToolArguments(pending.call.schema,args);pending.validate?.(args)
  }
  private release(pending:Pending,args:Record<string,unknown>){
    pending.call.args=structuredClone(args);pending.call.edited=JSON.stringify(args)!==JSON.stringify(pending.call.originalArgs)
    pending.call.status='ready';this.pending.delete(pending.call.id);pending.resolve(args)
  }
  command(command:Omit<InspectionCommand,'requestId'>){
    if(command.action==='state')return this.snapshot()
    this.signal.throwIfAborted()
    if(command.action==='pause'){
      if(command.scopeId)this.scopes.set(command.scopeId,true)
      else{this.pauseRequested=true;this.scopes.clear()}
      this.onChange?.('申请暂停')
      return this.snapshot()
    }
    if(command.action==='continueAll'){
      const rows=[...this.pending.values()]
      for(const pending of rows)this.validate(pending,pending.call.args)
      this.pauseRequested=false;this.scopes.clear()
      for(const pending of rows)this.release(pending,pending.call.args)
      this.onChange?.('继续全部执行')
      return this.snapshot()
    }
    const pending=command.checkpointId?this.pending.get(command.checkpointId):undefined
    if(command.action==='draft'){
      if(!pending||command.scopeId&&pending.call.scopeId!==command.scopeId)throw new Error('暂停点已变化')
      if(typeof command.draft!=='string'||command.draft.length>200000)throw new Error('入参草稿不能超过 200000 字符')
      pending.draft=command.draft;return this.snapshot()
    }
    if(command.action!=='continue'&&command.action!=='step')throw new Error('不支持的检查器操作')
    if(command.checkpointId&&!pending)throw new Error('暂停点已变化，请刷新后重试')
    if(pending){
      const scope=pending.call.scopeId||'main'
      if(command.scopeId&&scope!==command.scopeId)throw new Error('暂停点不属于所选节点')
      const args=structuredClone(command.args??pending.call.args);this.validate(pending,args)
      if(command.scopeId)this.scopes.set(scope,command.action==='step')
      else{this.pauseRequested=command.action==='step';this.scopes.delete(scope)}
      this.release(pending,args)
    }else{
      if(command.args||command.action==='step')throw new Error('当前没有可修改的暂停点')
      if([...this.pending.values()].some(row=>!command.scopeId||row.call.scopeId===command.scopeId))throw new Error('暂停点已变化，请选择当前调用')
      if(command.scopeId)this.scopes.set(command.scopeId,false);else{this.pauseRequested=false;this.scopes.clear()}
    }
    this.onChange?.(command.action==='step'?'单步执行':'继续执行')
    return this.snapshot()
  }
  async before(kind:InspectionCall['kind'],name:string,source:string,args:Record<string,unknown>,schema:object,id:string=randomUUID(),validate?:(args:Record<string,unknown>)=>void,scope:InspectionScope={}){
    const signal=scope.signal??this.signal;signal.throwIfAborted();this.signal.throwIfAborted()
    if(this.calls.some(call=>call.id===id))throw new Error('调用 ID 重复')
    const scopeId=scope.scopeId||'main',paused=this.isPaused(scopeId)
    const call:InspectionCall={id,kind,name,source,args:structuredClone(args),originalArgs:structuredClone(args),schema:structuredClone(schema),scopeId,workerId:scope.workerId,startedAt:new Date().toISOString(),status:paused?'paused':'ready'}
    this.calls.push(call)
    while(this.calls.length>60){const index=this.calls.findIndex(row=>['complete','error'].includes(row.status));if(index<0)break;this.calls.splice(index,1)}
    if(!paused){this.onChange?.('准备调用 · '+name);return args}
    return new Promise<Record<string,unknown>>((resolve,reject)=>{
      const cleanup=()=>{signal.removeEventListener('abort',abort);this.signal.removeEventListener('abort',abort)}
      const fail=(reason:unknown)=>{cleanup();this.pending.delete(id);call.status='error';call.output='执行已停止';this.onChange?.('调用已停止 · '+name);reject(reason)}
      const abort=()=>fail(signal.reason??this.signal.reason??new Error('执行已停止'))
      this.pending.set(id,{call,validate,resolve:value=>{cleanup();resolve(value)},reject:fail})
      this.onChange?.('已暂停 · '+name)
      signal.addEventListener('abort',abort,{once:true});if(signal!==this.signal)this.signal.addEventListener('abort',abort,{once:true})
      if(signal.aborted||this.signal.aborted)abort()
    })
  }
  update(id:string,status:InspectionCall['status'],output?:unknown){
    const call=this.calls.find(item=>item.id===id);if(!call)return
    call.status=status;if(['complete','error'].includes(status))call.finishedAt=new Date().toISOString()
    if(output!==undefined){let text:string;try{text=typeof output==='string'?output:JSON.stringify(output)}catch{text=String(output)}call.output=text.length>16000?text.slice(0,16000)+'\n[展示已截断]':text}
    this.onChange?.(({running:'正在调用',complete:'调用完成',error:'调用异常',paused:'已暂停',ready:'准备调用'})[status]+' · '+call.name)
  }
  recordArguments(id:string,args:Record<string,unknown>){
    const call=this.calls.find(item=>item.id===id);if(!call||call.status!=='ready')throw new Error('调用已开始，不能修改执行参数')
    validateToolArguments(call.schema,args)
    call.args=structuredClone(args);call.edited=JSON.stringify(args)!==JSON.stringify(call.originalArgs)
  }
  async run<I extends object,O>(name:string,input:I,schema:object,work:(input:I)=>Promise<O>,validate?:(input:I)=>void):Promise<O>{
    const id=randomUUID()
    const args=await this.before('ability',name,'能力模块',input as Record<string,unknown>,schema,id,validate?value=>validate(value as I):undefined)
    try{this.signal.throwIfAborted();validateToolArguments(schema,args);validate?.(args as I);this.update(id,'running');const result=await work(args as I);this.update(id,'complete',result);return result}
    catch(error){this.update(id,'error',String(error));throw error}
  }
}
