import type {WorkflowDefinitionInput,WorkflowNode} from '../shared/local-ai-workflow.js'
import type {RuntimeWorkbench} from './agent/core/runtime-workbench.js'
import {validateTaskGraph,taskDependencyIds} from './agent/core/task-graph.js'
import {validateWorkflowExecution} from './agent/workflow-execution.js'

/** Copies definitions only. The workflow engine owns scheduling, variables, versions and execution. */
export function runtimeWorkflowDraft(workbench:RuntimeWorkbench):WorkflowDefinitionInput{
 const {session}=workbench,plan=session.taskPlan,items=plan?.items||[]
 if(!plan||!items.length)throw new Error('当前会话尚未生成任务计划')
 if(items.length>64)throw new Error('任务超过 64 项，请先拆分后生成工作流')
 validateTaskGraph(items)
 const ids=new Map(items.map((item,index)=>[item.id,'task_'+(index+1)]))
 const dependencies=new Map(items.map((item,index)=>[item.id,plan.graphVersion?taskDependencyIds(items,item):index?[items[index-1]!.id]:[]]))
 const level=new Map<string,number>(),depth=(id:string):number=>{if(level.has(id))return level.get(id)!;const value=Math.max(-1,...dependencies.get(id)!.map(depth))+1;level.set(id,value);return value}
 const layout:{nodes:Record<string,{x:number;y:number}>;start:{x:number;y:number}}={nodes:{},start:{x:60,y:140}},rows=new Map<number,number>()
 const nodes:WorkflowNode[]=items.map((item,index)=>{
  if(item.verificationProblem)throw new Error('请先修复“'+item.title+'”的验收规则，再生成流程')
  const config=workbench.effective(item.id),instruction=[config.instruction,'任务：'+item.title,'验收条件：'+item.acceptance,config.input?'补充输入：\n'+config.input:''].filter(Boolean).join('\n\n')
  if(instruction.length>16000)throw new Error('“'+item.title+'”的合并指令超过流程节点 16000 字符限制，请精简后重试')
  const execution=validateWorkflowExecution({tools:config.tools,maxRequests:config.maxRequests,maxToolCalls:config.maxToolCalls,timeoutMs:config.timeoutMs,task:{title:item.title,acceptance:item.acceptance,kind:item.kind,mode:item.mode,fileScope:item.fileScope,verification:item.verification,requiresVerification:item.requiresVerification}})
  const id=ids.get(item.id)!,column=depth(item.id),row=rows.get(column)||0;rows.set(column,row+1);layout.nodes[id]={x:340+column*300,y:80+row*200}
  const model=config.model||session.model
  return {id,name:`${index+1}. ${item.title}`.slice(0,100),type:'agent',branches:[{id:'success',name:'完成',condition:'',color:'#54b88f',targetNodeIds:items.filter(target=>dependencies.get(target.id)!.includes(item.id)).map(target=>ids.get(target.id)!)}],config:{instruction,model,modelSource:model?'specified':'current',mode:item.mode==='write'?'coding':'general',maxSteps:Math.min(config.maxRequests||30,500),fastMode:true,approvalMode:'ask',inputSignalMode:'all',branchMode:'direct',execution}}
 })
 const entryNodeIds=items.filter(item=>!dependencies.get(item.id)!.length).map(item=>ids.get(item.id)!)
 return {name:(session.title||'节点工作流').slice(0,85)+' · 流程草稿',description:`从会话 ${session.id} 的已应用配置生成。保留依赖、工具限制、预算与验收条件；各节点在工作流独立缓存目录中执行。原项目文件、凭据、批准记录和执行结果不复制。`,enabled:false,entryNodeId:entryNodeIds[0]!,entryNodeIds,nodes,layout,timeoutMinutes:60}
}
