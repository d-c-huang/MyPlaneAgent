/**
 * Capability 类型定义
 * 能力注册中心的核心类型
 */

/**
 * 能力来源
 */
export type CapabilitySource =
  | { type: 'skill'; skillId: string }
  | { type: 'mcp'; serverId: string }
  | { type: 'builtin' }

/**
 * 能力运行时类型
 */
export type CapabilityRuntime = 'python-native' | 'mcp' | 'builtin'

/**
 * 能力定义
 */
export type Capability = {
  name: string                         // 完整名称，如 "file.read" "browser.screenshot"
  category: string                     // 分类：file/git/browser/coding/...
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  returns?: Record<string, unknown>

  // 来源和运行时
  source: CapabilitySource
  runtime: CapabilityRuntime

  // 权限要求
  permissions: string[]

  // 元数据
  examples?: Array<{
    input: Record<string, unknown>
    output: unknown
  }>
  tags?: string[]
}

/**
 * 能力执行请求
 */
export type CapabilityAdmission={revision:number;fingerprint:string}
export type CapabilityExecutionRequest = {
  /** Host-owned step admission. A model tool argument cannot supply or override it. */
  admission?:CapabilityAdmission
  execution?: {
    taskId:string; itemId?:string; workerId?:string; activityId?:string; parentEvidenceId?:string
    workspace?:string; kind?:import('../task-contract.js').TaskKind; mode?:'read'|'write'|'verify'; writeScopes?:string[][]
    parallel?:'read'|'scoped-write'
    reservedWritePaths?:string[]
    budget?:{used:number;limit?:number}
    onResourceWait?:(waiting:boolean)=>void
  }
  capability: string                   // 能力名称
  args: Record<string, unknown>
  workspace?: string
  context?: {
    userId?: string
    sessionId?: string
    [key: string]: unknown
  }
}

/**
 * 能力执行结果
 */
export type CapabilityExecutionResult = {
  /** Registry fact: the admitted provider was withdrawn before any invocation. */
  admissionRejected?:true
  outcome?:import('../task-contract.js').ExecutionOutcome
  failureCode?:import('../task-contract.js').FailureCode
  success: boolean
  output?: unknown
  error?: string
  elapsedMs: number
  metadata?: {
    runtime: CapabilityRuntime
    source: CapabilitySource
    [key: string]: unknown
  }
}

/**
 * 能力查询选项
 */
export type CapabilityQueryOptions = {
  category?: string                    // 按分类过滤
  runtime?: CapabilityRuntime         // 按运行时过滤
  tags?: string[]                      // 按标签过滤
  search?: string                      // 关键词搜索
}

/**
 * 能力统计
 */
export type CapabilityStats = {
  total: number
  byCategory: Record<string, number>
  byRuntime: Record<CapabilityRuntime, number>
  bySource: Record<string, number>
}
