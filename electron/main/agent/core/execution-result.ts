import type {CapabilityExecutionResult} from '../../../shared/types/capability.js'

import type {FailureCode} from '../../../shared/task-contract.js'
export type {FailureCode,ExecutionOutcome} from '../../../shared/task-contract.js'
export function toolData(value:unknown):Record<string,unknown> {
  try { const parsed=typeof value==='string'?JSON.parse(value):value; return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{} } catch { return {} }
}
export const processTools=new Set(['agent.run_command','agent.run_test','agent.run_test_case','agent.build_project','agent.get_diagnostics'])
export function failureCode(message:string):FailureCode {
  if(/timeout|timed out|超时/i.test(message))return 'timeout'
  if(/cancel|abort|取消|中止/i.test(message))return 'cancelled'
  if(/budget|上限|预算/i.test(message))return 'budget'
  if(/permission|denied|权限|拒绝|越界|超出.*范围/i.test(message))return 'permission'
  if(/schema|argument|参数|请选择目录|expected.*(?:string|object)/i.test(message))return 'arguments'
  if(/not found|not available|ENOENT|未找到|不可用|未启用|没有定义|环境/i.test(message))return 'environment'
  if(/conflict|冲突|版本.*变化|副作用/i.test(message))return 'conflict'
  return 'unknown'
}
/** Every entry point uses the same interpretation of process and MCP results. */
export function normalizeExecution(name:string,result:CapabilityExecutionResult):CapabilityExecutionResult {
  const data=toolData(result.output)
  if(!result.success)return {...result,outcome:result.outcome??'failed',failureCode:result.failureCode??failureCode(result.error||String(data.error||''))}
  if(data.isError===true||data.success===false)return {...result,success:false,outcome:'failed',failureCode:'unknown',error:String(data.error||'工具报告执行失败')}
  if(processTools.has(name)) {
    if(typeof data.exitCode!=='number'||!Number.isInteger(data.exitCode))return {...result,success:false,outcome:'unknown',failureCode:'unknown',error:'工具未提供可确认的退出码'}
    if(data.exitCode!==0)return {...result,success:false,outcome:'failed',failureCode:'verification',error:`${name} 退出码 ${data.exitCode}`}
  }
  return {...result,outcome:'succeeded'}
}
