import { estimateTokens,contextSafetyTokens } from '../local-ai-context.js'
import type { AgentConnection, AgentMessage } from './model.js'
import type { ToolDefinition } from './registry.js'

const capacities = new Map<string, number>()
const key = (connection: AgentConnection, model: string) => JSON.stringify([connection.endpoint.replace(/\/$/, ''), connection.apiFormat || 'openai', model])
export class ModelContextCapacityError extends Error {
 constructor(public capacity: number, public inputTokens?: number) {
  super(`模型上下文容量为 ${capacity} Tokens，当前输入与输出预算超出容量，需要压缩上下文后继续。`)
  this.name = 'ModelContextCapacityError'
 }
}
export function modelCapacity(connection: AgentConnection, model: string): number {
 return Math.min(connection.contextLength, capacities.get(key(connection, model)) ?? Infinity)
}
export function rememberModelCapacity(connection: AgentConnection, model: string, capacity: number) {
 if (!Number.isSafeInteger(capacity) || capacity < 256) return
 if (capacities.size >= 128) capacities.delete(capacities.keys().next().value!)
 capacities.set(key(connection, model), capacity)
}
export function readModelCapacityError(body: string): ModelContextCapacityError | undefined {
 const match = body.match(/maximum context length is\s*([\d,]+)\s*tokens/i)
 if (!match) return
 const capacity = Number(match[1].replaceAll(',', ''))
 if (!Number.isSafeInteger(capacity) || capacity < 256) return
 const input = body.match(/(?:prompt contains(?: at least)?|messages resulted in)\s*([\d,]+)\s*(?:input )?tokens/i)
 return new ModelContextCapacityError(capacity, input ? Number(input[1].replaceAll(',', '')) : undefined)
}
export function requestBudget(connection: AgentConnection, model: string, messages: AgentMessage[], tools: false | ToolDefinition[] | undefined, actualInput = 0): AgentConnection {
 const capacity = modelCapacity(connection, model)
 const input = Math.max(actualInput, estimateTokens(messages) + estimateTokens(tools || undefined) + 32)
 const headroom = contextSafetyTokens(capacity)
 const available = capacity - input - headroom
 if (available < 1) throw new ModelContextCapacityError(capacity, input)
 return { ...connection, contextLength: capacity, maxTokens: Math.max(1, Math.floor(Math.min(connection.maxTokens, capacity / 2, available))) }
}
