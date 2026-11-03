import {workspaceVersion} from './evidence-version.js'
import fs from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {AgentWorkspace} from '../workspace.js'
import {chatCapabilityAllowed,chatApprovalRequired,type ChatRunOptions} from './chat-runner.js'
import {validateToolArguments} from './execution-guards.js'
import {verificationIssues} from './verification-baseline.js'
import {parseVerificationRules,isVerificationScript} from './verification-rules.js'
export {parseVerificationRules} from './verification-rules.js'
import type {CapabilityRegistry} from './capability-registry.js'
import type {TaskVerificationRule,TaskVerificationResult} from '../../../shared/task-plan.js'
import type {StudioToolActivity} from '../../../shared/local-ai-studio.js'

export function availableVerificationScripts(workspace:string):string[]{
  try{
    const root=new AgentWorkspace(workspace),file=root.resolve('package.json')
    if(fs.statSync(file).size>200000)return []
    const scripts=JSON.parse(fs.readFileSync(file,'utf8')).scripts
    return Object.keys(scripts||{}).filter(name=>isVerificationScript(name)&&typeof scripts[name]==='string'&&scripts[name].trim()).slice(0,80)
  }catch{return []}
}
export function discoverVerificationRules(workspace:string):TaskVerificationRule[]{
  const scripts=availableVerificationScripts(workspace),script=['test','check','lint','build'].find(name=>scripts.includes(name))
  return script?[{kind:'test',script}]:[]
}
export function parsedToolResult(value:unknown):Record<string,unknown>{
  try{const data=typeof value==='string'?JSON.parse(value):value;return data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:{}}catch{return {}}
}
export const processResultTools=new Set(['agent.run_command','agent.run_test','agent.run_test_case','agent.build_project','agent.get_diagnostics'])
export function processResultFailed(name:string,output:unknown){
  const result=parsedToolResult(output)
  return processResultTools.has(name)&&typeof result.exitCode==='number'&&result.exitCode!==0
}
export async function verifyTaskRules(registry:CapabilityRegistry,options:ChatRunOptions,rules:TaskVerificationRule[]):Promise<TaskVerificationResult[]>{
  let versionBefore:string|undefined
  const result=(rule:TaskVerificationRule,passed:boolean,summary:string,blocked=false,activityId?:string,data:Record<string,unknown>={}):TaskVerificationResult=>{
    const issues=passed?{issues:[],issuesComplete:true}:verificationIssues(rule,data,summary,options.workspace,blocked)
    return {rule,passed,blocked,sourceVersion:versionBefore&&versionBefore===workspaceVersion(options.workspace)?versionBefore:undefined,summary:summary.slice(0,6000),fingerprint:createHash('sha256').update(JSON.stringify([rule,passed,issues.issues.map(issue=>issue.key).sort()])).digest('hex'),activityId,...issues}
  }
  const results:TaskVerificationResult[]=[]
  for(const rule of parseVerificationRules(rules)){
    options.signal.throwIfAborted()
    versionBefore=workspaceVersion(options.workspace)
    if(rule.kind==='file'){
      const activity:StudioToolActivity={id:randomUUID(),capability:'runtime.check_file',args:{...rule},status:'running'}
      try{
        if(!options.filesEnabled)throw new Error('文件访问未开启')
        const inspectionSchema={type:'object',properties:Object.fromEntries(Object.entries(activity.args).map(([key,value])=>[key,{const:value}])),required:Object.keys(activity.args),additionalProperties:false}
        if(options.inspectTool)await options.inspectTool({name:activity.capability,description:'按保存的验收条件检查文件',category:'verification',source:{type:'builtin'},runtime:'builtin',permissions:['file:read'],tags:[],parameters:inspectionSchema},activity.args,activity.id,options.executionContext,options.signal)
        options.signal.throwIfAborted();options.workbench?.assertAllowed(options.executionContext?.itemId||'main',activity.capability)
        options.onActivity({...activity})
        const check=async():Promise<import('../../../shared/types/capability.js').CapabilityExecutionResult>=>{
          const root=new AgentWorkspace(options.workspace),file=root.resolve(rule.path,true)
          const exists=fs.existsSync(file)&&fs.statSync(file).isFile()
          return {success:true,output:{exists,passed:exists&&(rule.contains===undefined||root.read(rule.path).includes(rule.contains))},elapsedMs:0}
        }
        const execution=registry.executeFileCheck?await registry.executeFileCheck({capability:activity.capability,args:activity.args,workspace:options.workspace,execution:{...options.executionContext,taskId:options.executionContext?.taskId||'verification',activityId:activity.id}},options.signal,check):await check()
        options.signal.throwIfAborted()
        const changed=execution.metadata?.filesChangedDuringExecution===true
        const data=parsedToolResult(execution.output),passed=execution.success&&data.passed===true&&!changed
        const summary=changed?'检查期间文件发生变化，请重新验收：'+rule.path:!execution.success?execution.error||'文件验收受阻':passed?'文件检查通过：'+rule.path:!data.exists?'文件不存在：'+rule.path:'文件内容未满足指定条件：'+rule.path
        activity.status=passed?'complete':'error';activity.output=summary;options.onActivity({...activity})
        results.push(result(rule,passed,summary,!execution.success||changed,activity.id))
      }catch(error){options.signal.throwIfAborted();activity.status='error';activity.output=String(error);options.onActivity({...activity});results.push(result(rule,false,String(error),true,activity.id))}
    }else{
      const name=rule.kind==='test'?'agent.run_test':'agent.get_diagnostics'
      const capability=registry.list().find(cap=>cap.name===name&&cap.source.type==='skill'&&cap.source.skillId==='agent-tools')
      if(!capability||!chatCapabilityAllowed(capability,options)){results.push(result(rule,false,'当前权限或插件未提供验收工具：'+name,true));break}
      let args:Record<string,unknown>=rule.kind==='test'?{script:rule.script,timeoutSeconds:120}:{checker:rule.checker,path:rule.path||'.',timeoutSeconds:120}
      const activity:StudioToolActivity={id:randomUUID(),capability:name,args,status:'running'}
      try{
        // Fixed acceptance targets cannot be replaced by editing a verification call.
        const targets=Object.fromEntries(Object.entries(args).filter(([key])=>key!=='timeoutSeconds').map(([key,value])=>[key,{const:value}]))
        const inspectionSchema={allOf:[capability.parameters,{type:'object',properties:targets,required:Object.keys(targets)}]}
        if(options.inspectTool){args=await options.inspectTool({...capability,parameters:inspectionSchema},args,activity.id,options.executionContext,options.signal);options.signal.throwIfAborted();activity.args=args}
        validateToolArguments(inspectionSchema,args)
        validateToolArguments(capability.parameters,args)
        if(rule.kind==='test'){
          const root=new AgentWorkspace(options.workspace),file=root.resolve('package.json')
          if(fs.statSync(file).size>200000)throw new Error('项目配置过大，无法确认测试脚本')
          if(typeof JSON.parse(fs.readFileSync(file,'utf8')).scripts?.[rule.script]!=='string')throw new Error('项目没有定义验收脚本：'+rule.script)
        }else new AgentWorkspace(options.workspace).resolve(rule.path||'.')
        let approved=!chatApprovalRequired(capability,args,options)||options.approvalGranted?.(activity)===true
        if(!approved){activity.status='waiting';options.onActivity({...activity});approved=await options.approve({...activity})}
        options.signal.throwIfAborted()
        if(!approved){activity.status='denied';activity.output='用户拒绝运行验收工具';options.onActivity({...activity});results.push(result(rule,false,activity.output,true,activity.id));break}
        activity.status='running';options.onActivity({...activity})
        const replayBlock=options.beforeExecution?.(capability,args)
        if(replayBlock)throw new Error(replayBlock)
        options.workbench?.assertAllowed(options.executionContext?.itemId||'main',name)
        const execution=await registry.execute({capability:name,args,workspace:options.workspace,execution:{...options.executionContext,taskId:options.executionContext?.taskId||'verification',activityId:activity.id}},options.signal)
        options.afterExecution?.(capability,args,execution.success)
        options.signal.throwIfAborted()
        const data=parsedToolResult(execution.output)
        const changed=execution.metadata?.sourceChangedDuringExecution===true
        const passed=execution.success&&data.exitCode===0&&!changed
        const unknown=typeof data.exitCode!=='number'
        const summary=changed?'检查期间源码发生变化，当前结果不能证明新版本通过；请按当前文件重新验收。':unknown?'验收工具未提供可确认的退出码：'+String(execution.error||JSON.stringify(execution.output)||'无结果'):`${!execution.success&&execution.error?execution.error:`${name} 退出码 ${data.exitCode}`}\n${String(data.output??data.error??JSON.stringify(data.diagnostics??''))}`
        activity.status=passed?'complete':'error';activity.output=summary.slice(0,24000);options.onActivity({...activity})
        results.push(result(rule,passed,summary,unknown||changed,activity.id,data))
      }catch(error){
        options.signal.throwIfAborted()
        activity.status='error';activity.output=String(error);options.onActivity({...activity});results.push(result(rule,false,activity.output,true,activity.id))
      }
    }
    if(results.at(-1)?.blocked)break
  }
  return results
}
