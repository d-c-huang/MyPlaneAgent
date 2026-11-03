import type {NodeConfiguration} from './runtime-workbench.js'
import type {TaskItem} from './task-plan.js'
export type WorkflowExecutionPolicy=Pick<NodeConfiguration,'tools'|'maxRequests'|'maxToolCalls'|'timeoutMs'>&{
 task?:Pick<TaskItem,'title'|'acceptance'|'kind'|'mode'|'fileScope'|'verification'|'requiresVerification'>
}
