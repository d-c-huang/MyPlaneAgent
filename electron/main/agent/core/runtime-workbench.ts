import {randomUUID} from 'node:crypto'
import path from 'node:path'
import type {StudioSession} from '../../../shared/local-ai-studio.js'
import {emptyNodeConfiguration,emptyWorkbench,type NodeConfiguration,type WorkbenchCommand,type WorkbenchNodeDetail,type WorkbenchActivity} from '../../../shared/runtime-workbench.js'
import type {TaskItem} from '../../../shared/task-plan.js'
import {validateTaskGraph,taskDependencyIds} from './task-graph.js'
import {ExecutionInspector} from './execution-inspector.js'
import {requestAgentModel,type AgentConnection} from '../model.js'

const configKeys=new Set(['instruction','input','model','tools','maxRequests','maxToolCalls','timeoutMs','title','acceptance','kind','dependsOn','fileScope','parallel'])
const structuralKeys=['title','acceptance','kind','dependsOn','fileScope','parallel'] as const
const modelSchema={type:'object',properties:{instruction:{type:'string',maxLength:60001},input:{type:'string',maxLength:60001},model:{type:'string',maxLength:500}},required:['instruction','input','model'],additionalProperties:false}
export function validateNodeConfiguration(value:unknown):NodeConfiguration{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('节点配置必须是对象')
 const config=structuredClone(value) as NodeConfiguration
 if(Object.keys(config).some(key=>!configKeys.has(key)))throw new Error('节点配置包含不支持的字段')
 for(const key of ['instruction','input','model'] as const)if(typeof config[key]!=='string'||config[key].length>(key==='model'?500:30000))throw new Error(key+' 必须是长度有效的文本')
 for(const key of ['title','acceptance'] as const)if(config[key]!==undefined&&(typeof config[key]!=='string'||!config[key]!.trim()||config[key]!.length>10000))throw new Error('标题或验收条件不能为空或过长')
 for(const key of ['tools','dependsOn','fileScope'] as const)if(config[key]!==undefined&&(!Array.isArray(config[key])||config[key]!.length>256||config[key]!.some(value=>typeof value!=='string'||!value.trim()||value.length>1000)||new Set(config[key]).size!==config[key]!.length))throw new Error(key+' 必须是无重复的字符串列表')
 for(const key of ['maxRequests','maxToolCalls','timeoutMs'] as const)if(config[key]!==undefined&&(!Number.isSafeInteger(config[key])||config[key]!<1||config[key]!>2147483647))throw new Error(key+' 必须是正整数；留空表示继承')
 if(config.fileScope?.some(value=>path.isAbsolute(value)||path.win32.isAbsolute(value)||value.replace(/\\/g,'/').split('/').includes('..')))throw new Error('文件范围必须是工作目录内的相对路径')
 if(config.kind!==undefined&&!['research','inspect','edit','verify','preview','answer'].includes(config.kind))throw new Error('任务类型无效')
 if(config.parallel!==undefined&&typeof config.parallel!=='boolean')throw new Error('并行选项无效')
 return config
}

/** One live session controller; persistence belongs to the existing session store. */
export class RuntimeWorkbench {
 readonly activities=new Map<string,WorkbenchActivity>()
 private readonly workers=new Map<string,AbortController>()
 private readonly cancelled=new Set<string>()
 active=true
 constructor(readonly session:StudioSession,readonly inspector:ExecutionInspector,private readonly save:()=>void,private readonly resolveModel?:(name:string)=>AgentConnection){session.workbench??=emptyWorkbench()}
 get data(){return this.session.workbench!}
 private record(scopeId:string,action:string,detail:string){this.data.events.push({id:randomUUID(),at:new Date().toISOString(),scopeId,action,detail});this.data.events=this.data.events.slice(-200);this.save()}
 scope(nodeId:string){
  if(nodeId==='task:root'||nodeId==='agent:coordinator')return 'main'
  const item=this.session.taskPlan?.items.find(item=>nodeId==='task:'+item.id||nodeId==='agent:'+item.id||nodeId==='worker:'+item.worker?.id||nodeId.startsWith('tool:worker:'+item.worker?.id+':'))
  if(item)return item.id
  if(nodeId.startsWith('tool:agent:coordinator:'))return 'main'
  throw new Error('节点不属于当前任务，刷新后重试')
 }
 configuration(scopeId:string){
  const item=this.session.taskPlan?.items.find(item=>item.id===scopeId)
  return this.data.nodes[scopeId]??{revision:0,config:{...emptyNodeConfiguration(),...(item?{title:item.title,acceptance:item.acceptance,kind:item.kind,dependsOn:item.dependsOn||[],fileScope:item.fileScope||[],parallel:!!item.parallel}:{})},history:[]}
 }
 effective(scopeId:string){
  const root=this.configuration('main').config,node=this.configuration(scopeId).config
  if(scopeId==='main')return root
  return {...root,...node,instruction:[root.instruction,node.instruction].filter(Boolean).join('\n'),input:[root.input,node.input].filter(Boolean).join('\n'),model:node.model||root.model,tools:node.tools===undefined?root.tools:root.tools===undefined?node.tools:node.tools.filter(tool=>root.tools!.includes(tool)),maxRequests:node.maxRequests??root.maxRequests,maxToolCalls:node.maxToolCalls??root.maxToolCalls,timeoutMs:node.timeoutMs??root.timeoutMs}
 }
 affected(scopeId:string){
  const items=this.session.taskPlan?.items||[],ids=new Set(scopeId==='main'?items.map(item=>item.id):[scopeId])
  for(let changed=true;changed;){changed=false;for(const item of items)if(!ids.has(item.id)&&taskDependencyIds(items,item).some(id=>ids.has(id))){ids.add(item.id);changed=true}}
  return items.filter(item=>ids.has(item.id))
 }
 allows(scopeId:string,tool:string){const list=this.effective(scopeId).tools;return list===undefined||list.includes(tool)}
 assertAllowed(scopeId:string,tool:string){if(!this.allows(scopeId,tool))throw new Error('节点配置已禁用此工具，调用未执行：'+tool)}
 workerSignal(scopeId:string,signal:AbortSignal){
  let controller=this.workers.get(scopeId)
  if(!controller){controller=new AbortController();this.workers.set(scopeId,controller);if(this.cancelled.has(scopeId))controller.abort(new Error('用户已取消此节点'))}
  return AbortSignal.any([signal,controller.signal])
 }
 isCancelled(scopeId:string){return this.cancelled.has(scopeId)}
 finishWorker(scopeId:string){const activity=this.activities.get(scopeId);if(activity)activity.phase='finished'}
 activityView(scopeId:string,calls=this.inspector.snapshot().calls){
  const value=this.activities.get(scopeId);if(!value)return undefined
  const activity={...value},last=calls.filter(call=>(call.scopeId||'main')===scopeId).at(-1)
  if(last&&activity.phase!=='finished'&&['complete','error'].includes(last.status))activity.label=(last.status==='error'?'执行失败 · ':'已返回 · ')+last.name
  return activity
 }
 async enterWorker(item:TaskItem,signal:AbortSignal){
  const id=randomUUID(),workerId=item.worker?.id||'worker-'+item.id
  this.activities.set(item.id,{scopeId:item.id,workerId,phase:'stage',label:'准备执行：'+item.title,at:new Date().toISOString(),appliedRevision:0,requests:0,toolCalls:0})
  await this.inspector.before('stage','开始子任务','调度器',{}, {type:'object',additionalProperties:false},id,undefined,{scopeId:item.id,workerId,signal})
  this.inspector.update(id,'complete','已进入子任务')
 }
 async inspectTool(capability:import('../../../shared/types/capability.js').Capability,args:Record<string,unknown>,id:string,scopeId='main',workerId?:string,signal?:AbortSignal){
  const activity=this.activity(scopeId,workerId);activity.phase='tool';activity.label='调用 '+capability.name;activity.at=new Date().toISOString()
  const next=await this.inspector.before('tool',capability.name,capability.source.type==='skill'?`插件 · ${capability.source.skillId}`:capability.source.type==='mcp'?`MCP · ${capability.source.serverId}`:'内置工具',args,capability.parameters,id,undefined,{scopeId,workerId,signal})
  this.assertAllowed(scopeId,capability.name)
  const config=this.effective(scopeId)
  if(config.maxToolCalls!==undefined&&activity.toolCalls>=config.maxToolCalls)throw new Error('节点工具调用预算已用完，请调整配置后继续')
  activity.toolCalls++;this.inspector.update(id,'running');return next
 }
 private activity(scopeId:string,workerId?:string){
  let activity=this.activities.get(scopeId)
  if(!activity){activity={scopeId,workerId,phase:'queued',label:'准备执行',at:new Date().toISOString(),appliedRevision:0,requests:0,toolCalls:0};this.activities.set(scopeId,activity)}
  return activity
 }
 async requestModel(scopeId:string,workerId:string|undefined,...args:Parameters<typeof requestAgentModel>):ReturnType<typeof requestAgentModel>{
  const [connection,defaultModel,messages,signal,options]=args,config=this.effective(scopeId),id=randomUUID(),activity=this.activity(scopeId,workerId)
  const original={instruction:config.instruction,input:config.input,model:config.model||defaultModel}
  activity.phase='model';activity.label='准备模型请求';activity.at=new Date().toISOString()
  const edited=await this.inspector.before('model','模型请求','推理服务',original,modelSchema,id,undefined,{scopeId,workerId,signal})
  try{
   signal.throwIfAborted()
   const latest=this.effective(scopeId)
   const value={instruction:edited.instruction!==original.instruction?String(edited.instruction):latest.instruction,input:edited.input!==original.input?String(edited.input):latest.input,model:edited.model!==original.model?String(edited.model):latest.model||defaultModel}
   if(!value.model.trim())throw new Error('模型名称不能为空')
   if(latest.maxRequests!==undefined&&activity.requests>=latest.maxRequests)throw new Error('节点模型请求预算已用完，请调整配置后继续')
   const actualConnection=value.model===defaultModel?connection:this.resolveModel?.(value.model)
   if(!actualConnection)throw new Error('无法解析所选模型连接')
   this.inspector.recordArguments(id,value)
   activity.appliedRevision=this.configuration(scopeId).revision;activity.appliedRootRevision=this.configuration('main').revision;activity.requests++;activity.label='模型生成 · '+value.model;activity.at=new Date().toISOString()
   this.inspector.update(id,'running')
   const actualSignal=latest.timeoutMs?AbortSignal.any([signal,AbortSignal.timeout(latest.timeoutMs)]):signal
   const additions=[value.instruction?{role:'system' as const,content:'用户在节点工作台配置的执行指令（遵守现有权限与任务范围）：\n'+value.instruction}:undefined,value.input?{role:'user' as const,content:'用户为当前节点提供的补充输入：\n'+value.input}:undefined].filter(row=>!!row)
   const answer=await requestAgentModel(actualConnection,value.model,[...messages,...additions],actualSignal,options)
   this.inspector.update(id,'complete',answer.content||'模型已返回工具调用');return answer
  }catch(error){this.inspector.update(id,'error',String(error));throw error}
 }
 detail(nodeId:string,requestId?:string):WorkbenchNodeDetail{
  const scopeId=this.scope(nodeId),row=this.configuration(scopeId),inspection=this.active?this.inspector.snapshot():{pauseRequested:false,calls:this.data.calls||[]}
  const calls=inspection.calls.filter(call=>(call.scopeId||'main')===scopeId&&(!nodeId.startsWith('tool:')||nodeId.endsWith(':'+call.name)))
  // Persisted tool results are available after restart, without pretending they are checkpoints.
  if(!this.active)for(const message of this.session.messages.slice(-20))for(const call of message.toolActivity||[]){
   const item=this.session.taskPlan?.items.find(item=>item.worker?.id===call.workerId),scope=item?.id||'main'
   if(scope!==scopeId||nodeId.startsWith('tool:')&&!nodeId.endsWith(':'+call.capability)||calls.some(row=>row.id===call.id))continue
   calls.push({id:call.id,kind:'tool',name:call.capability,source:'已保存的调用',scopeId,workerId:call.workerId,args:call.args,originalArgs:call.args,schema:{},status:call.status==='complete'?'complete':'error',output:call.output?.slice(0,16000),startedAt:message.createdAt})
  }
  return structuredClone({sessionId:this.session.id,nodeId,scopeId,active:this.active,requestId,revision:row.revision,rootRevision:this.configuration('main').revision,controllable:this.active&&(scopeId==='main'||this.activities.get(scopeId)?.phase!=='finished'&&this.session.taskPlan?.items.find(item=>item.id===scopeId)?.status!=='complete'),config:row.config,draft:row.draft,draftBase:row.draftBase,history:row.history,activity:this.activityView(scopeId,inspection.calls),pauseRequested:this.active&&this.inspector.isPaused(scopeId),checkpoint:this.active?calls.find(call=>call.status==='paused'):undefined,calls:calls.slice(-60),events:this.data.events.filter(event=>scopeId==='main'||event.scopeId===scopeId).slice(-60),archives:this.data.archives.filter(row=>scopeId==='main'||row.item.id===scopeId),templates:this.data.templates,tasks:(this.session.taskPlan?.items||[]).map(({id,title,status})=>({id,title,status})),affected:this.affected(scopeId).map(({id,title})=>({id,title})),structuralEditable:!this.active,workspace:this.session.taskPlan?.workspace||this.session.defaultWorkspace?.path||'',inspection:nodeId==='task:root'?inspection:undefined})
 }
 command(command:WorkbenchCommand){
  if(typeof command.commandId!=='string'||command.commandId.length>100||!command.commandId)throw new Error('命令编号无效')
  if(command.scope!==undefined&&!['node','branch','all'].includes(command.scope))throw new Error('控制范围无效')
  if(this.data.receipts.includes(command.commandId))return false
  const scopeId=this.scope(command.nodeId),row=this.configuration(scopeId)
  if(command.expectedRevision!==row.revision)throw new Error('节点版本已变化，请重新载入后合并修改')
  const all=command.scope==='all'||command.nodeId==='task:root',scopes=all?['main',...(this.session.taskPlan?.items.map(item=>item.id)||[])]:command.scope==='branch'?this.affected(scopeId).map(item=>item.id):[scopeId]
  if(['pause','continue','step','cancel'].includes(command.action)){
   if(!this.active)throw new Error('当前没有运行实例，请使用重新执行')
   if(!all&&scopes.length===1&&(this.activities.get(scopeId)?.phase==='finished'||this.session.taskPlan?.items.find(item=>item.id===scopeId)?.status==='complete'))throw new Error('此节点本轮已结束，请在任务结束后重新执行')
   if(command.action==='pause'){
    if(all)this.inspector.command({action:'pause'});else for(const scopeId of scopes)this.inspector.command({action:'pause',scopeId})
   }else if(command.action==='cancel'){
    for(const scopeId of scopes){this.cancelled.add(scopeId);this.workers.get(scopeId)?.abort(new Error('用户已取消此节点；已发生的操作保留在执行记录中'));const activity=this.activities.get(scopeId);if(activity)activity.cancelled=true}
   }else if(all&&command.action==='continue'&&!command.checkpointId)this.inspector.command({action:'continueAll'})
   else{
    if(command.scope==='branch')throw new Error('继续或单步请指定具体节点，或继续整个任务')
    this.inspector.command({action:command.action as 'continue'|'step',scopeId,checkpointId:command.checkpointId,args:command.args})
   }
  }else if(command.action==='draft'||command.action==='apply'){
   const config=validateNodeConfiguration(command.config)
   if(command.action==='draft')this.data.nodes[scopeId]={...row,draft:config,draftBase:row.revision}
   else{
    const structural=structuralKeys.some(key=>JSON.stringify(config[key])!==JSON.stringify(row.config[key]))
    if(structural&&this.active)throw new Error('修改任务类型、依赖或验收条件需要先结束当前运行；指令、输入和模型可在下一请求生效')
    const item=this.session.taskPlan?.items.find(item=>item.id===scopeId)
    if(this.active&&item?.status==='complete')throw new Error('此节点结果已被使用，请先保存草稿，待本轮结束后应用并重跑受影响分支')
    if(structural&&item){
     const copy=structuredClone(this.session.taskPlan!),target=copy.items.find(value=>value.id===scopeId)!
     this.updateDefinition(target,config);validateTaskGraph(copy.items)
    }
    if(!this.active&&this.affected(scopeId).some(item=>item.attempts>0||item.status==='complete'||item.evidenceIds.length))this.invalidate(scopeId,'节点配置已修改')
    if(structural&&item)this.updateDefinition(item,config)
    const revision=row.revision+1
    this.data.nodes[scopeId]={revision,config,history:[...(row.history.length?row.history:[{revision:row.revision,at:new Date().toISOString(),config:row.config,reason:'初始配置'}]),{revision,at:new Date().toISOString(),config,reason:'用户应用配置'}].slice(-40)}
   }
  }else if(command.action==='retry'){
   if(this.active)throw new Error('当前仍有运行实例，请先取消并等待结束后重跑')
   if(!this.session.taskPlan)throw new Error('当前会话尚无可恢复的任务计划')
   this.invalidate(scopeId,'用户请求重跑受影响分支')
  }else if(command.action==='template-save'){
   if(typeof command.name!=='string'||!command.name.trim()||command.name.length>80)throw new Error('请输入 1–80 字的模板名称')
   if(this.data.templates.length>=40)throw new Error('模板已达 40 个，请先删除不再使用的模板')
   const config=validateNodeConfiguration(command.config??row.config)
   // Relationships belong to a task, never to a reusable role template.
   for(const key of structuralKeys)delete config[key]
   this.data.templates.push({id:randomUUID(),name:command.name.trim(),config})
  }else if(command.action==='template-delete')this.data.templates=this.data.templates.filter(template=>template.id!==command.templateId)
  else throw new Error('不支持的工作台操作')
  this.data.receipts.push(command.commandId);this.data.receipts=this.data.receipts.slice(-100)
  this.record(scopeId,command.action,command.action==='apply'?`配置 v${row.revision+1}，${this.active?'下一次模型请求采用新指令；工具限制在调用前复核':'后续执行采用新配置'}`:command.action==='draft'?'配置草稿已保存':command.action==='pause'?'已请求暂停，等待执行边界':command.action==='cancel'?'已请求取消，等待执行退出':command.action)
  return true
 }
 private updateDefinition(item:TaskItem,config:NodeConfiguration){
  for(const key of structuralKeys)if(config[key]!==undefined)Object.assign(item,{[key]:structuredClone(config[key])})
  if(config.kind){item.kindSource='explicit';item.mode=config.kind==='edit'?'write':['verify','preview'].includes(config.kind)?'verify':'read'}
 }
 private invalidate(scopeId:string,reason:string){
  const now=new Date().toISOString()
  for(const item of this.affected(scopeId)){
   if(item.attempts||item.evidenceIds.length)this.data.archives.push({at:now,reason,item:structuredClone(item)})
   const definition={id:item.id,key:item.key,title:item.title,acceptance:item.acceptance,kind:item.kind,kindSource:item.kindSource,parentId:item.parentId,depth:item.depth,childIds:item.childIds,dependsOn:item.dependsOn,mode:item.mode,parallel:item.parallel,fileScope:item.fileScope,verification:item.verification,worker:item.worker?{id:item.worker.id,mode:item.worker.mode,assignedAt:now,toolCalls:0}:undefined}
   for(const key of Object.keys(item))delete (item as unknown as Record<string,unknown>)[key]
   Object.assign(item,definition,{status:'pending',attempts:0,summary:'原结果已过期：'+reason,evidenceIds:[],runtime:{status:'queued',phase:'observe',updatedAt:now}})
  }
  this.data.archives=this.data.archives.slice(-80)
  if(this.session.taskPlan)this.session.taskPlan.updatedAt=now
  if(this.session.abilityTask)this.session.abilityTask.status='paused'
 }
 finish(){this.active=false;this.data.calls=this.inspector.snapshot().calls.slice(-60);for(const activity of this.activities.values())activity.phase='finished';this.save()}
}
