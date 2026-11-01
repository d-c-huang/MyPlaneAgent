import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import type {TaskPlan} from '../../../shared/task-plan.js'
import type {CapabilityExecutionResult} from '../../../shared/types/capability.js'
import {validateCheckpoint,contextHistoryHash} from '../../context-checkpoint.js'
import {workerKey,historyMessage,messageHash,type WorkerContext,type WorkerScope} from './worker-history.js'
import {operationKey} from './operation-journal.js'

export type StoredOperation={id:string;taskId:string;itemId?:string;workerId?:string;workspace:string;capability:string;args:Record<string,unknown>;createdAt:string;parentEvidenceId?:string;revision:number;effectKey?:string;expectedFiles?:Array<{file:string;before:string;after:string}>}
/** SQLite commits metadata and evidence together. Large payloads are content-addressed. */
export class RuntimeStore {
  private db:DatabaseSync
  private blobs:string
  private closed=false
  private workerLeases=new Set<string>()
  constructor(directory:string) {
    fs.mkdirSync(directory,{recursive:true});this.blobs=path.join(directory,'evidence');fs.mkdirSync(this.blobs,{recursive:true})
    this.db=new DatabaseSync(path.join(directory,'runtime.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace TEXT NOT NULL, state TEXT NOT NULL, metadata TEXT NOT NULL, result_hash TEXT);
      CREATE TABLE IF NOT EXISTS plans(task_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
      CREATE TABLE IF NOT EXISTS worker_contexts(task_id TEXT NOT NULL, workspace TEXT NOT NULL, worker_id TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(task_id,workspace,worker_id,generation));
      CREATE TABLE IF NOT EXISTS worker_messages(task_id TEXT NOT NULL, workspace TEXT NOT NULL, worker_id TEXT NOT NULL, generation INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(task_id,workspace,worker_id,generation,ordinal));
      PRAGMA user_version=2;`)
    // A process interruption is not a failed/no-effect execution.
    this.db.exec("UPDATE operations SET state='unknown' WHERE state='running'")
    // Cover the crash window between a durable tool intent and Registry.begin().
    const interrupted=this.db.prepare('SELECT metadata FROM worker_contexts').all() as Array<{metadata:string}>
    for(const row of interrupted){
      const saved=JSON.parse(row.metadata) as WorkerContext,pending=saved.pending
      if(pending&&!this.has(pending.activityId)){
        const operation={id:pending.activityId,taskId:saved.scope.taskId,itemId:saved.scope.itemId,workerId:saved.scope.workerId,workspace:saved.scope.workspace,capability:pending.capability,args:pending.args,createdAt:new Date().toISOString(),revision:this.revision(saved.scope.workspace),effectKey:operationKey(saved.scope.taskId,saved.scope.workspace,pending.capability,pending.args)}
        this.begin(operation);this.finish(operation,{success:false,outcome:'unknown',elapsedMs:0,error:'进程在工具提交阶段中断，副作用未确认；先核对状态，不得自动重放。'},false)
      }
    }
  }
  revision(workspace:string):number {return Number((this.db.prepare('SELECT revision FROM revisions WHERE workspace=?').get(workspace) as {revision:number}|undefined)?.revision||0)}
  has(id:string){return !!this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(id)}
  begin(operation:StoredOperation) {
    this.db.exec('BEGIN IMMEDIATE')
    try{
      this.db.prepare('INSERT INTO operations(id,task_id,workspace,state,metadata) VALUES(?,?,?,?,?)').run(operation.id,operation.taskId,operation.workspace,'running',JSON.stringify(operation))
      if(operation.effectKey)this.db.prepare('INSERT INTO effects VALUES(?,?) ON CONFLICT(key) DO UPDATE SET operation_id=excluded.operation_id').run(operation.effectKey,operation.id)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  previousEffect(key:string,taskId:string,workspace:string) {
    const row=this.db.prepare('SELECT operation_id FROM effects WHERE key=?').get(key) as {operation_id:string}|undefined
    const previous=row?this.read(row.operation_id,taskId,workspace):undefined
    // The host proved that no provider body ran. Retain evidence without reserving a side effect.
    return previous?.result?.admissionRejected===true&&!previous.result.success&&previous.state==='failed'?undefined:previous
  }
  finish(operation:StoredOperation,result:CapabilityExecutionResult,mutates:boolean) {
    const body=JSON.stringify(result),hash=createHash('sha256').update(body).digest('hex'),file=path.join(this.blobs,hash+'.json')
    if(!fs.existsSync(file)){
      const temporary=file+'.'+randomUUID()+'.tmp'
      try{fs.writeFileSync(temporary,body,{mode:0o600,flush:true});fs.renameSync(temporary,file)}finally{fs.rmSync(temporary,{force:true})}
    }
    this.db.exec('BEGIN IMMEDIATE')
    try{
      this.db.prepare('UPDATE operations SET state=?, result_hash=? WHERE id=?').run(result.outcome||'unknown',hash,operation.id)
      if(mutates)this.db.prepare('INSERT INTO revisions VALUES(?,1) ON CONFLICT(workspace) DO UPDATE SET revision=revision+1').run(operation.workspace)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  read(id:string,taskId:string,workspace:string) {
    const row=this.db.prepare('SELECT state,metadata,result_hash FROM operations WHERE id=? AND task_id=? AND workspace=?').get(id,taskId,workspace) as {state:string;metadata:string;result_hash?:string}|undefined
    if(!row)throw new Error('当前任务不存在该证据')
    const operation=JSON.parse(row.metadata) as StoredOperation
    const result=row.result_hash?JSON.parse(fs.readFileSync(path.join(this.blobs,row.result_hash+'.json'),'utf8')) as CapabilityExecutionResult:undefined
    return {operation,state:row.state,result,stale:(result?.metadata?.revision??operation.revision)!==this.revision(workspace)}
  }
  savePlan(plan:TaskPlan) {this.db.prepare('INSERT INTO plans VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET workspace=excluded.workspace,updated_at=excluded.updated_at,body=excluded.body').run(plan.taskId,plan.workspace,plan.updatedAt,JSON.stringify(plan))}
  loadPlan(taskId:string,workspace:string):TaskPlan|undefined {
    const row=this.db.prepare('SELECT body FROM plans WHERE task_id=? AND workspace=?').get(taskId,workspace) as {body:string}|undefined
    return row?JSON.parse(row.body):undefined
  }
  acquireWorker(scope:WorkerScope):()=>void {
    const key=JSON.stringify([scope.taskId,scope.workspace,workerKey(scope)])
    if(this.workerLeases.has(key))throw new Error('同一 Worker 仍在执行，不能并发恢复')
    this.workerLeases.add(key)
    return ()=>this.workerLeases.delete(key)
  }
  loadWorker(scope:WorkerScope,generation?:number):WorkerContext|undefined {
    const row=(generation===undefined?this.db.prepare('SELECT generation,revision,metadata FROM worker_contexts WHERE task_id=? AND workspace=? AND worker_id=? ORDER BY generation DESC LIMIT 1').get(scope.taskId,scope.workspace,workerKey(scope)):this.db.prepare('SELECT generation,revision,metadata FROM worker_contexts WHERE task_id=? AND workspace=? AND worker_id=? AND generation=?').get(scope.taskId,scope.workspace,workerKey(scope),generation)) as {generation:number;revision:number;metadata:string}|undefined
    if(!row)return
    const metadata=JSON.parse(row.metadata)
    if(metadata.scope?.taskId!==scope.taskId||metadata.scope?.workspace!==scope.workspace||workerKey(metadata.scope)!==workerKey(scope)||scope.itemId!==undefined&&metadata.scope.itemId!==scope.itemId)throw new Error('Worker 历史范围不匹配，原记录已保留')
    const rows=this.db.prepare('SELECT ordinal,body,hash FROM worker_messages WHERE task_id=? AND workspace=? AND worker_id=? AND generation=? ORDER BY ordinal').all(scope.taskId,scope.workspace,workerKey(scope),row.generation) as Array<{ordinal:number;body:string;hash:string}>
    if(rows.length!==metadata.historyLength||rows.some((entry,index)=>entry.ordinal!==index||entry.hash!==messageHash(entry.body)))throw new Error('Worker 历史记录损坏，原记录已保留')
    const history=rows.map(entry=>JSON.parse(entry.body))
    if(contextHistoryHash(history,history.length)!==metadata.historyHash)throw new Error('Worker 历史哈希不匹配，原记录已保留')
    validateCheckpoint(history,metadata.checkpoint)
    if(metadata.checkpoint?.version===2&&(metadata.checkpoint.state.taskId!==scope.taskId||(metadata.checkpoint.state.workerId||'')!==(metadata.scope.workerId||'')))throw new Error('Worker 检查点范围不匹配')
    return {...metadata,history,generation:row.generation,revision:row.revision}
  }
  saveWorker(context:WorkerContext,expectedRevision:number):WorkerContext {
    validateCheckpoint(context.history,context.checkpoint)
    if(context.checkpoint?.version===2&&(context.checkpoint.state.taskId!==context.scope.taskId||(context.checkpoint.state.workerId||'')!==(context.scope.workerId||'')))throw new Error('Worker 检查点范围不匹配')
    const {history,...body}=context,scope=context.scope,key=workerKey(scope)
    const metadata={...body,revision:expectedRevision+1,updatedAt:new Date().toISOString(),historyLength:history.length,historyHash:contextHistoryHash(history,history.length)}
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const row=this.db.prepare('SELECT revision FROM worker_contexts WHERE task_id=? AND workspace=? AND worker_id=? AND generation=?').get(scope.taskId,scope.workspace,key,context.generation) as {revision:number}|undefined
      if((row?.revision??0)!==expectedRevision)throw new Error('Worker 历史版本冲突，已阻止覆盖其他执行记录')
      this.db.prepare('INSERT INTO worker_contexts VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,workspace,worker_id,generation) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,metadata=excluded.metadata').run(scope.taskId,scope.workspace,key,context.generation,metadata.revision,metadata.updatedAt,JSON.stringify(metadata))
      const write=this.db.prepare('INSERT INTO worker_messages VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,workspace,worker_id,generation,ordinal) DO UPDATE SET body=excluded.body,hash=excluded.hash WHERE body<>excluded.body')
      history.forEach((message,index)=>{const json=JSON.stringify(historyMessage(message));write.run(scope.taskId,scope.workspace,key,context.generation,index,json,messageHash(json))})
      this.db.prepare('DELETE FROM worker_messages WHERE task_id=? AND workspace=? AND worker_id=? AND generation=? AND ordinal>=?').run(scope.taskId,scope.workspace,key,context.generation,history.length)
      this.db.exec('COMMIT')
      return {...context,revision:metadata.revision,updatedAt:metadata.updatedAt}
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  listWorkers(taskId:string,workspace:string,workerId?:string){
    const rows=(workerId===undefined?this.db.prepare('SELECT worker_id,generation,revision,updated_at FROM worker_contexts WHERE task_id=? AND workspace=? ORDER BY worker_id,generation').all(taskId,workspace):this.db.prepare('SELECT worker_id,generation,revision,updated_at FROM worker_contexts WHERE task_id=? AND workspace=? AND worker_id=? ORDER BY generation').all(taskId,workspace,workerId)) as Array<{worker_id:string;generation:number;revision:number;updated_at:string}>
    return rows.map(row=>({workerId:row.worker_id,generation:row.generation,revision:row.revision,updatedAt:row.updated_at}))
  }
  close(){if(!this.closed){this.closed=true;this.db.close()}}
}
