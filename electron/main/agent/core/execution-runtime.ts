import {workspaceVersion} from './evidence-version.js'
import {isPreviewCommand} from './preview-command.js'
import path from 'node:path'
import fs from 'node:fs'
import {randomUUID,createHash} from 'node:crypto'
import type {Capability,CapabilityExecutionRequest,CapabilityExecutionResult} from '../../../shared/types/capability.js'
import {ResourceScheduler,type ResourceClaim} from './resource-scheduler.js'
import {RuntimeStore,type StoredOperation} from './runtime-store.js'
import {normalizeExecution,processTools,toolData} from './execution-result.js'
import {journalRequired,operationKey,type OperationJournal} from './operation-journal.js'
import {inspectTextEdit} from './edit-progress.js'
import {validateToolArguments} from './execution-guards.js'
import {parallelCapabilityAllowed} from './parallel-capabilities.js'

export function canonicalPath(workspace:string,target='.') {
  const absolute=path.resolve(workspace,target)
  let ancestor=absolute
  while(!fs.existsSync(ancestor)&&path.dirname(ancestor)!==ancestor)ancestor=path.dirname(ancestor)
  return path.join(fs.realpathSync(ancestor),path.relative(ancestor,absolute))
}
export function fileVersions(workspace:string,args:Record<string,unknown>) {
  return fileTargets(args).slice(0,40).map(name=>{
    const file=path.resolve(workspace,name)
    try {const resolvedPath=canonicalPath(workspace,name);return {path:file,resolvedPath,hash:fileHash(resolvedPath)}}catch{return {path:file,hash:null}}
  })
}
function fileTargets(args:Record<string,unknown>) {
  return [...new Set([...writeTargets(args),...(Array.isArray(args.paths)?args.paths:[])].filter((p):p is string=>typeof p==='string'))]
}
function fileHash(file:string):string|null {
  try {const stat=fs.statSync(file);return stat.isFile()&&stat.size<=4_000_000?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null}
  catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'missing':null}
}
function sameVersions(before:ReturnType<typeof fileVersions>,after:ReturnType<typeof fileVersions>) {
  return before.length===after.length&&before.every((file,i)=>file.path===after[i].path&&file.resolvedPath===after[i].resolvedPath&&file.hash===after[i].hash)
}
function writeTargets(args:Record<string,unknown>):string[] {
  return [args.path,...(Array.isArray(args.changes)?args.changes.map(row=>row?.path):[])].filter((p):p is string=>typeof p==='string')
}
export function scopeFailure(workspace:string,args:Record<string,unknown>,scopes:string[][],reserved=false):string|undefined {
  if(!scopes.length)return
  try{
    const root=canonicalPath(workspace),inside=(file:string,dir:string)=>{if(process.platform==='win32'){file=file.toLowerCase();dir=dir.toLowerCase()}return file===dir||file.startsWith(dir+path.sep)},targets=writeTargets(args)
    if(targets.length&&targets.every(target=>{const file=canonicalPath(root,target);return inside(file,root)&&scopes.every(group=>group.some(allowed=>{const dir=reserved?allowed:canonicalPath(root,allowed);return inside(dir,root)&&inside(file,dir)}))}))return
  }catch{/* Fail closed when the target cannot be resolved. */}
  return '子任务写入超出已分配文件范围，请交回协调器重新分配。'
}
export class ExecutionRuntime {
  private resources=new ResourceScheduler()
  private active=new Set<Promise<CapabilityExecutionResult>>()
  private disposed=false
  constructor(readonly store?:RuntimeStore){}
  /** Import a matching old session record once; replay decisions stay in this runtime. */
  importLegacyOperation(taskId:string,workspace:string,name:string,args:Record<string,unknown>,entry:OperationJournal[string]|undefined) {
    if(!entry||!this.store)return
    const effectKey=operationKey(taskId,workspace,name,args)
    if(this.store.previousEffect(effectKey,taskId,workspace))return
    const operation:StoredOperation={id:randomUUID(),taskId,workspace,capability:name,args,createdAt:entry.updatedAt,revision:this.store.revision(workspace),effectKey,expectedFiles:entry.expectedFiles}
    this.store.begin(operation)
    this.store.finish(operation,{success:false,outcome:'unknown',elapsedMs:0,output:{legacyStatus:entry.status},error:'历史执行记录已迁移，需按实际状态核对结果。'},false)
  }
  execute(capability:Capability,request:CapabilityExecutionRequest,signal:AbortSignal,invoke:()=>Promise<CapabilityExecutionResult>):Promise<CapabilityExecutionResult> {
    if(this.disposed)return Promise.reject(new Error('执行运行时已关闭'))
    const pending=this.executeRequest(capability,request,signal,invoke)
    this.active.add(pending)
    void pending.finally(()=>this.active.delete(pending)).catch(()=>{})
    return pending
  }
  async dispose(){this.disposed=true;await Promise.allSettled([...this.active]);this.store?.close()}
  private async executeRequest(capability:Capability,request:CapabilityExecutionRequest,signal:AbortSignal,invoke:()=>Promise<CapabilityExecutionResult>):Promise<CapabilityExecutionResult> {
    const start=Date.now(),context=request.execution
    const failure=(error:string,failureCode:CapabilityExecutionResult['failureCode']):CapabilityExecutionResult=>({success:false,outcome:'failed',failureCode,error,elapsedMs:Date.now()-start})
    signal.throwIfAborted()
    try{validateToolArguments(capability.parameters,request.args)}catch(error){return failure(String(error),'arguments')}
    if(context?.parallel&&!parallelCapabilityAllowed(capability,context.parallel))return failure('并行子任务仅可读取资料或修改已分配文件；项目命令、浏览器与外部操作需要独立步骤。','permission')
    const effectful=journalRequired(capability,request.args)
    if(effectful&&context?.parallel==='scoped-write'){
      const error=scopeFailure(request.workspace||'',request.args,[context.reservedWritePaths||[]],true)
      if(error)return failure(error,'permission')
    }
    const isProcess=processTools.has(capability.name)
    if(context?.mode==='read'&&(effectful||isProcess))return failure('只读子任务不能执行修改或项目命令','permission')
    const previewCommand=context?.kind==='preview'&&isPreviewCommand(request.workspace||'',capability.name,request.args)
    if(context?.mode==='verify'&&effectful&&!capability.name.startsWith('browser.')&&!previewCommand)return failure('验收子任务不能修改文件；需要修复时交回调度器','permission')
    if(effectful&&!capability.name.startsWith('browser.')&&context?.writeScopes?.length){const error=scopeFailure(request.workspace||'',request.args,context.writeScopes);if(error)return failure(error,'permission')}
    const budget=context?.budget
    if(budget?.limit!==undefined&&budget.used>=budget.limit)return failure(`子智能体工具调用已达到本项上限（${budget.used}/${budget.limit} 次）；调整设置的上限后可继续。`,'budget')
    if(budget)budget.used++
    let workspace=request.workspace||''
    try{if(workspace)workspace=canonicalPath(workspace)}catch{/* The tool reports a missing workspace. */}
    const pathIdentity=()=>JSON.stringify({workspace:request.workspace?canonicalPath(request.workspace):'',targets:effectful?writeTargets(request.args).map(target=>canonicalPath(workspace,target)):[],scopes:effectful?context?.writeScopes?.map(group=>group.map(scope=>canonicalPath(workspace,scope))):undefined})
    let identity:string|undefined
    try{identity=pathIdentity()}catch{/* Leave missing paths to the tool validator. */}
    const claims:ResourceClaim[]=workspace?[{key:'workspace:'+workspace,mode:effectful||isProcess||['preview.start','preview.stop'].includes(capability.name)?'write':'read'}]:[]
    if(capability.name.startsWith('browser.'))claims.push({key:'browser',mode:'write'})
    if(capability.source.type==='mcp')claims.push({key:'mcp:'+capability.source.serverId,mode:'write'})
    let waiting=false
    const release=await this.resources.acquire(claims,signal,()=>{waiting=true;context?.onResourceWait?.(true)})
    try{
      if(waiting)context?.onResourceWait?.(false)
      signal.throwIfAborted()
      // A queued operation must not inherit a changed symlink or scope while it waits.
      if(identity!==undefined){try{if(pathIdentity()!==identity)return failure('等待期间工作目录或文件路径发生变化，请重新读取后再执行。','conflict')}catch{return failure('等待期间文件路径已不可用，请重新核对。','conflict')}}
      if(effectful&&!capability.name.startsWith('browser.')&&context?.writeScopes?.length){const error=scopeFailure(request.workspace||'',request.args,context.writeScopes);if(error)return failure(error,'permission')}
      if(effectful&&context?.parallel==='scoped-write'){const error=scopeFailure(request.workspace||'',request.args,[context.reservedWritePaths||[]],true);if(error)return failure(error,'permission')}
      const logicalWorkspace=context?.workspace??workspace
      const effectKey=effectful&&context?operationKey(context.taskId,logicalWorkspace,capability.name,request.args):undefined
      const previous=effectKey?this.store?.previousEffect(effectKey,context!.taskId,logicalWorkspace):undefined
      let reused:CapabilityExecutionResult|undefined
      if(previous){
        const files=previous.operation.expectedFiles
        if(files?.length){
          const targets=writeTargets(request.args).map(target=>canonicalPath(workspace,target))
          const identity=(file:string)=>process.platform==='win32'?file.toLowerCase():file
          if(files.length!==targets.length||files.some((file,i)=>identity(file.file)!==identity(targets[i])))return failure('历史操作的文件路径已变化，请重新读取实际文件后调整操作。','conflict')
        }
        const current=files?.map(file=>fileHash(file.file))
        if(files?.length&&files.every((file,i)=>file.after===current![i]))reused={success:true,outcome:'succeeded',output:{changed:false,reconciled:true,paths:files.map(file=>file.file),evidenceId:previous.operation.id},elapsedMs:0}
        else if(!files?.length||!files.every((file,i)=>file.before===current![i]))return failure('相同操作已有记录，结果可能包含副作用。请先核对实际状态，不能自动重复执行。','conflict')
      }
      const operation:StoredOperation={id:context?.activityId||randomUUID(),taskId:context?.taskId||'standalone',itemId:context?.itemId,workerId:context?.workerId,workspace:logicalWorkspace,capability:capability.name,args:request.args,createdAt:new Date().toISOString(),parentEvidenceId:context?.parentEvidenceId,revision:this.store?.revision(logicalWorkspace)||0,effectKey,expectedFiles:inspectTextEdit(workspace,capability.name,request.args)??previous?.operation.expectedFiles}
      const versions=fileVersions(request.workspace||workspace,request.args)
      const sourceVersion=isProcess?workspaceVersion(workspace):undefined
      this.store?.begin(operation)
      let result:CapabilityExecutionResult
      try{result=reused??normalizeExecution(capability.name,await invoke())}catch(error){result=normalizeExecution(capability.name,{success:false,error:String(error),elapsedMs:Date.now()-start})}
      const finishedFiles=fileVersions(request.workspace||workspace,request.args)
      const mismatchedFiles=operation.expectedFiles?.filter(file=>fileHash(file.file)!==file.after).map(file=>file.file)||[]
      if(result.success&&mismatchedFiles.length){
        const error='工具报告成功，但文件内容未达到预期；请读取实际文件后修复：'+mismatchedFiles.join('、')
        result={...result,success:false,outcome:'failed',failureCode:'verification',error,output:{error,reportedOutput:result.output,mismatchedFiles}}
      }
      if(signal.aborted&&!result.admissionRejected)result={...result,success:false,outcome:'unknown',failureCode:signal.reason?.name==='TimeoutError'?'timeout':'cancelled',error:String(signal.reason)}
      const finishedVersion=isProcess?workspaceVersion(workspace):undefined
      const sourceChangedDuringExecution=isProcess&&sourceVersion!==finishedVersion
      if(result.success&&isProcess&&!effectful&&sourceChangedDuringExecution){
        const error='检查期间源码发生变化，当前结果不能证明新版本通过；请按当前文件重新验收。'
        result={...result,success:false,outcome:'unknown',failureCode:'conflict',error,output:{...toolData(result.output),error}}
      }
      const filesUnchanged=!!operation.expectedFiles?.length&&versions.every(file=>file.hash!==null)&&sameVersions(versions,finishedFiles)
      const mutated=!result.admissionRejected&&!reused&&(effectful?!filesUnchanged:isProcess&&(!sourceVersion||sourceChangedDuringExecution))
      result={...result,metadata:{...result.metadata,runtime:capability.runtime,source:capability.source,evidenceId:operation.id,revision:operation.revision+(mutated?1:0),fileVersions:effectful?finishedFiles:versions,fileVersionsComplete:fileTargets(request.args).length<=40,parentEvidenceId:operation.parentEvidenceId,sourceVersion:sourceVersion===finishedVersion?sourceVersion:undefined,sourceChangedDuringExecution,filesChangedDuringExecution:!effectful&&!sameVersions(versions,finishedFiles),reusedFrom:reused?previous?.operation.id:undefined}}
      this.store?.finish(operation,result,mutated)
      signal.throwIfAborted()
      return result
    }finally{release()}
  }
}
