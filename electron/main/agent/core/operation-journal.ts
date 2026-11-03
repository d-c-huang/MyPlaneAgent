import fs from 'node:fs'
import {inspectTextEdit} from './edit-progress.js'
import {createHash} from 'node:crypto'
import {readTools} from '../tools.js'
import {previewCapabilityNames} from '../static-preview.js'
import type {Capability} from '../../../shared/types/capability.js'
import {isReadOnlyCommand} from './read-only-command.js'
export type OperationJournal = Record<string,{status:'started'|'succeeded'|'failed';updatedAt:string;expectedFiles?:ReturnType<typeof inspectTextEdit>}>
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]))
  return value
}
export function operationKey(taskId:string,workspace:string,name:string,args:Record<string,unknown>){
  return createHash('sha256').update(JSON.stringify([taskId,workspace,name,stable(args)])).digest('hex')
}
// Preview lifecycle calls inspect current process state and are idempotent. An old
// journal entry must not prevent reuse or restarting a service after app restart.
// This only controls replay protection; normal capability and approval checks remain.
export function journalRequired(capability:Capability,args:Record<string,unknown>={}){
  if(['runtime.current_time','runtime.read_evidence','runtime.read_history','runtime.check_file'].includes(capability.name))return false
  if(capability.source.type==='mcp')return true
  if(capability.source.type==='builtin')return !previewCapabilityNames.has(capability.name)&&!['browser.open','browser.read_page','browser.inspect','browser.screenshot'].includes(capability.name)
  if(!['agent-tools','git-operations','file-operations'].includes(capability.source.skillId))return true
  if(isReadOnlyCommand(capability.name,args))return false
  const name=capability.name.replace(/^agent\./,'')
  if(name==='http_request'&&['GET','HEAD'].includes(String(args.method??'GET').toUpperCase()))return false
  return !readTools.has(name)&&!['get_diagnostics','run_test','run_test_case','build_project','web_search','web_fetch','inspect_build','read_history','read_tool_result','reconcile_execution'].includes(name)
}
export function beginOperation(journal:OperationJournal,key:string,save:()=>void,expectedFiles?:ReturnType<typeof inspectTextEdit>):string|undefined{
  const previous=journal[key]
  const unchanged=previous?.expectedFiles?.length&&previous.expectedFiles.every(file=>{try{return createHash('sha256').update(fs.readFileSync(file.file)).digest('hex')===file.before}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'&&file.before==='missing'}})
  if(previous&&!unchanged)return previous.status==='succeeded'
    ? '相同操作已有成功记录，已阻止重复执行。请先核对实际结果；重新规划不会清除执行记录。'
    : '相同操作曾开始执行，结果可能包含部分副作用。已阻止自动重试，请先核对实际状态。'
  journal[key]={status:'started',updatedAt:new Date().toISOString(),expectedFiles};save()
}
