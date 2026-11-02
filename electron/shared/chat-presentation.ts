import type {StudioMessage, StudioToolActivity} from './local-ai-studio.js'
export type ChatArtifact={id:string;path:string;kind:'diff'|'text'|'document';before?:string;after?:string;note:string;activityId:string;change?:'added'|'modified';scope?:'file'|'fragment';edits?:number}
const labels:Record<string,string>={web_search:'搜索网页',web_fetch:'读取网页',read_file:'读取文件',read_document:'读取文档',list_files:'浏览文件',search_files:'搜索文件',run_command:'运行命令',run_test:'运行测试',build_project:'构建项目',apply_patch:'修改文件',replace_text:'替换文本',write_file:'写入文件',create_document:'生成文档',create_spreadsheet:'生成表格',inspect_project:'检查项目',git_diff:'查看差异'}
export function toolLabel(activity:StudioToolActivity){const name=activity.capability.split('.').at(-1)||activity.capability;return labels[name]||activity.capability}
export function toolTarget(activity:StudioToolActivity){for(const key of ['command','query','path','url','script','action'])if(typeof activity.args[key]==='string')return activity.args[key] as string;if(Array.isArray(activity.args.changes))return activity.args.changes.map(change=>change&&typeof change.path==='string'?change.path:'').filter(Boolean).join('、');return ''}
export function toolOutput(activity:StudioToolActivity):Record<string,unknown>|undefined{try{const value=JSON.parse(activity.output||'');return value&&typeof value==='object'&&!Array.isArray(value)?value:undefined}catch{return}}
export function toolState(activity:StudioToolActivity){if(activity.notApplied===true&&activity.status==='error')return 'unapplied';const result=toolOutput(activity);return activity.status==='complete'&&typeof result?.exitCode==='number'&&result.exitCode!==0?'error':activity.status}
export function chatArtifacts(messages:StudioMessage[]):ChatArtifact[]{
 const artifacts=new Map<string,ChatArtifact>()
 for(const message of messages)for(const activity of message.toolActivity||[]){
  if(toolState(activity)!=='complete')continue
  const name=activity.capability, args=activity.args
  const add=(path:unknown,kind:ChatArtifact['kind'],before:unknown,after:unknown,note:string,index:number|string=0,scope?:ChatArtifact['scope'],change?:ChatArtifact['change'])=>{
   if(typeof path!=='string'||!path)return
   const key=path.replace(/\\/g,'/').replace(/^(\.\/)+/,'')
   // Keep the latest successful operation and order files by their latest update.
   const previous=artifacts.get(key),sameMessage=previous?.id.startsWith(message.id+':'),edits=(sameMessage?previous?.edits||0:0)+1
   if(sameMessage&&scope==='file'&&previous?.scope==='file'&&previous.after===before){before=previous.before;change=previous.change;note='本次回复中该文件从首次修改前到最后一次修改后的完整内容。'}
   artifacts.delete(key)
   artifacts.set(key,{id:`${message.id}:${activity.id}:${index}`,path,kind,activityId:activity.id,before:typeof before==='string'?before:undefined,after:typeof after==='string'?after:undefined,note,scope,change,edits})
  }
  const snapshots=new Set<string>()
  activity.fileChanges?.forEach((change,index)=>{
   snapshots.add(change.path)
   add(change.path,'diff',change.before,change.after,'文件操作前后保存的完整内容。',`snapshot-${index}`,'file',change.before===undefined?'added':'modified')
  })
  if(name==='agent.apply_patch'&&Array.isArray(args.changes))args.changes.forEach((change,index)=>{
   if(change&&typeof change==='object'&&!snapshots.has(change.path))add(change.path,'diff',change.before??'',change.after,'本次工具执行记录中的修改前后内容。',index,'file',change.before==null?'added':'modified')
  })
  else if(name==='agent.replace_text'&&!snapshots.has(String(args.path)))add(args.path,'diff',args.oldText,args.newText,'显示本次替换的文本片段，不是整个文件。',0,'fragment','modified')
  else if(name==='agent.write_file'&&!snapshots.has(String(args.path)))add(args.path,'text',undefined,args.content,'本次写入内容；未记录修改前版本。')
  else if(name==='agent.create_document')add(args.path,'document',undefined,args.content,'文档生成时的内容，不代表文件当前版本。')
  else if(name==='agent.create_spreadsheet')add(args.path,'document',undefined,JSON.stringify(args.sheets,null,2),'表格生成时的数据，不代表文件当前版本。')
 }
 return [...artifacts.values()]
}
export function executionEntries(message:StudioMessage){
 const activities=new Map((message.toolActivity||[]).map(activity=>[activity.id,activity]))
 const entries=message.execution|| (message.toolActivity||[]).map(activity=>({id:activity.id,type:'tool' as const,activityId:activity.id,createdAt:message.createdAt}))
 return entries.map(entry=>entry.type==='tool'?{...entry,activity:activities.get(entry.activityId)}:entry)
}
export function formatElapsedTime(milliseconds:number):string{
 const seconds=Math.floor(Math.max(0,Number.isFinite(milliseconds)?milliseconds:0)/1000)
 const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60
 return `${hours?hours+'小时':''}${hours||minutes?minutes+'分':''}${rest}秒`
}
