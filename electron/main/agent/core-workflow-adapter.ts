import { randomUUID } from 'node:crypto'
import type { AgentTask as LegacyTask } from '../../shared/local-ai-agent.js'
import type { AgentTask as CoreTask } from '../../shared/types/index.js'
import type { LocalAgentService } from './service.js'
import type { AgentCoreService } from './agent-core-service.js'

/** Runs workflow and scheduled Agent nodes through Agent Core. */
export class CoreWorkflowAdapter {
  private readonly cancelled = new Set<string>()
  constructor(
    private readonly core: () => Promise<AgentCoreService>,
    private readonly projectStore: Pick<LocalAgentService, 'projects'>,
    private readonly diagnosticLog?: (message: string) => void
  ) {}

  projects() { return this.projectStore.projects() }
  logModelConversation(_taskId: string, error: unknown, sink = this.diagnosticLog) { sink?.(String(error)) }

  start(input: Parameters<LocalAgentService['start']>[0], _owner: number, emit: (task: LegacyTask) => void): LegacyTask {
    const workspace = input.projectId
      ? this.projects().find(project => project.id === input.projectId)?.workspace
      : input.workspace
    if (!workspace) throw new Error('工作目录或项目不存在')
    const timestamp = new Date().toISOString()
    const task: LegacyTask = {
      id: randomUUID(), title: input.prompt.slice(0, 48), workspace,
      ...(input.projectId ? { projectId: input.projectId } : { projectless: true }),
      hidden: input.hidden, mode: input.mode, model: input.model, status: 'running',
      steps: 0, maxSteps: input.maxSteps, plan: [], events: [{ id: randomUUID(), kind: 'user', text: input.prompt, createdAt: timestamp }],
      artifacts: [], error: '', createdAt: timestamp, updatedAt: timestamp
    }
    setImmediate(() => { void this.execute(task, input, emit) })
    return task
  }

  stop(id: string, _owner: number) {
    this.cancelled.add(id)
    void this.core().then(core => core.cancelTask(id)).catch(() => {})
  }

  private async execute(task: LegacyTask, input: Parameters<LocalAgentService['start']>[0], emit: (task: LegacyTask) => void) {
    try {
      const core = await this.core()
      if (this.cancelled.has(task.id)) { task.status = 'stopped'; return }
      const request: CoreTask = {
        id: task.id, description: input.prompt,
        context: { workspace: task.workspace, userIntent: input.prompt }, createdAt: Date.now()
      }
      const project=input.projectId?this.projects().find(project=>project.id===input.projectId):undefined
      const result = await core.runPlannedTask(request, {
        webEnabled:project?.webAccess!=='disabled',
        model: input.model,
        mode: input.mode === 'chat' ? 'general' : input.mode,
        connection: input.connectionOverride,
        maxReplanAttempts: 1,
        maxSteps: input.maxSteps,
        execution: input.execution,
        approve: async capability => {
          if(['agent.web_search','agent.web_fetch','browser.open','browser.read_page','browser.screenshot'].includes(capability))return (project?.webAccess||'allow')==='allow'
          if(project?.policy==='read-only'&&core.getCapabilityRegistry().get(capability)?.tags?.includes('requires-approval'))return false
          if (input.approvalMode === 'unrestricted') return true
          const risk = core.getCapabilityRegistry().get(capability)?.tags || []
          return (input.approvalMode === 'auto' || input.approvalMode === 'full') && risk.includes('risk:write')
        }
      })
      task.status = this.cancelled.has(task.id) ? 'stopped' : result.success ? 'completed' : 'failed'
      task.error = result.success ? '' : result.errors?.filter(Boolean).join('; ') || 'Agent Core 执行失败'
      task.events.push({ id: randomUUID(), kind: 'assistant', text: result.answer || JSON.stringify(result.outputs), createdAt: new Date().toISOString() })
    } catch (error) {
      task.status = this.cancelled.has(task.id) ? 'stopped' : 'failed'
      task.error = String(error)
    } finally {
      task.updatedAt = new Date().toISOString()
      this.cancelled.delete(task.id)
      emit(task)
    }
  }
}
