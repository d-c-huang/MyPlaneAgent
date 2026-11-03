import type {WorkflowExecutionPolicy} from '../../shared/workflow-execution.js'
import type {StudioSession} from '../../shared/local-ai-studio.js'
import {emptyWorkbench} from '../../shared/runtime-workbench.js'
import {validateNodeConfiguration,RuntimeWorkbench} from './core/runtime-workbench.js'
import {ExecutionInspector} from './core/execution-inspector.js'
import {parseVerificationRules} from './core/verification-rules.js'

export function validateWorkflowExecution(value:unknown):WorkflowExecutionPolicy{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['tools','maxRequests','maxToolCalls','timeoutMs','task'].includes(key)))throw new Error('执行约束格式无效')
 const {task,...limits}=value as WorkflowExecutionPolicy
 const {instruction,input,model,...validated}=validateNodeConfiguration({...limits,instruction:'',input:'',model:''})
 if(task===undefined)return validated
 if(!task||typeof task!=='object'||Array.isArray(task)||Object.keys(task).some(key=>!['title','acceptance','kind','mode','fileScope','verification','requiresVerification'].includes(key)))throw new Error('任务定义格式无效')
 if(typeof task.title!=='string'||typeof task.acceptance!=='string')throw new Error('任务标题与验收条件不能为空')
 validateNodeConfiguration({instruction:'',input:'',model:'',title:task.title,acceptance:task.acceptance,kind:task.kind,fileScope:task.fileScope})
 if(task.mode!==undefined&&!['read','write','verify'].includes(task.mode))throw new Error('任务执行模式无效')
 if(task.requiresVerification!==undefined&&typeof task.requiresVerification!=='boolean')throw new Error('任务验收选项无效')
 const verification=parseVerificationRules(task.verification)
 // These paths are rebound to the new workflow workspace, never to the original project.
 for(const rule of verification)if('path' in rule&&rule.path)validateNodeConfiguration({instruction:'',input:'',model:'',fileScope:[rule.path]})
 return {...validated,task:{...structuredClone(task),verification}}
}

/** Reuse the same limits, tool policy and deterministic acceptance as the 3D workbench. */
export function createWorkflowExecution(value:WorkflowExecutionPolicy,id:string,workspace:string,model:string,signal:AbortSignal){
 const {task,...limits}=validateWorkflowExecution(value),at=new Date().toISOString()
 const session:StudioSession={id,title:task?.title||'工作流节点',model,systemPrompt:'',messages:[],createdAt:at,updatedAt:at,workbench:emptyWorkbench()}
 session.workbench!.nodes.main={revision:1,config:{instruction:'',input:'',model:'',...limits},history:[]}
 if(task)session.taskPlan={taskId:id,workspace,graphVersion:1,updatedAt:at,items:[{...task,id:'workflow-task',status:'pending',attempts:0,summary:'',evidenceIds:[],kindSource:task.kind?'explicit':undefined}]}
 const inspector=new ExecutionInspector(signal),workbench=new RuntimeWorkbench(session,inspector,()=>{})
 return {session,workbench,inspector}
}
