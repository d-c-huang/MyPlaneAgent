/** Scheduler-owned semantics. Titles are presentation, never execution policy. */
export const taskKinds = ['research', 'inspect', 'edit', 'verify', 'preview', 'answer'] as const
export type TaskKind = typeof taskKinds[number]
export type FailureCode = 'arguments' | 'permission' | 'environment' | 'verification' | 'timeout' | 'cancelled' | 'conflict' | 'budget' | 'unknown'
export type ExecutionOutcome = 'succeeded' | 'failed' | 'unknown'
export type WaitReason = 'dependency' | 'approval' | 'input' | 'resource' | 'environment' | 'budget' | 'evidence' | 'timeout'
export type TaskRuntimeState = {
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  phase: 'observe' | 'plan' | 'act' | 'verify'
  waitReason?: WaitReason
  updatedAt: string
}
export function taskMode(kind: TaskKind): 'read' | 'write' | 'verify' {
  return kind === 'edit' ? 'write' : kind === 'verify' || kind === 'preview' ? 'verify' : 'read'
}
export const waitReasonLabels: Record<WaitReason, string> = {
  dependency: '等待前置任务', approval: '等待授权', input: '等待补充信息',
  resource: '等待资源', environment: '环境待处理', budget: '已达执行上限', evidence: '待补充验证结果', timeout:'等待超时，可恢复'
}
