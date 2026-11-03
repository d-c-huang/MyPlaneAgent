import fs from 'node:fs'
import path from 'node:path'
import type {Capability} from '../../../shared/types/capability.js'
import type {ChatRunOptions} from './chat-runner.js'
import {browserCapabilityNames} from '../../browser-plugin.js'
import {previewCapabilityNames} from '../static-preview.js'
import {readTools} from '../tools.js'
import {parallelCapabilityAllowed} from './parallel-capabilities.js'
import {textEditTools} from './edit-progress.js'
import {projectAdviceRequested,projectChecksRequested,projectCheckTools} from '../../../shared/task-scope.js'
const webTools=new Set(['agent.web_search','agent.web_fetch'])
const processes=new Set(['agent.run_command','agent.run_test','agent.run_test_case','agent.build_project','agent.get_diagnostics'])

const knownSkills = new Set(['agent-tools', 'file-operations', 'git-operations'])
export function chatCapabilityAllowed(capability: Capability, options: Pick<ChatRunOptions, 'filesEnabled'|'webEnabled'|'taskScope'|'currentStep'|'workerMode'|'parallelReadOnly'|'parallelWrites'|'conversationOnly'|'readOnlyConversation'|'workbench'|'executionContext'>): boolean {
  if(options.workbench&&!options.workbench.allows(options.executionContext?.itemId||'main',capability.name))return false
  if(options.conversationOnly)return false
  if(['runtime.current_time','runtime.read_evidence','runtime.read_history'].includes(capability.name))return true
  if(options.readOnlyConversation&&!['agent.inspect_project','agent.list_files','agent.search_files','agent.read_file','agent.read_files','agent.read_document','agent.dependency_report','agent.code_outline','agent.file_info'].includes(capability.name))return false
  if((options.parallelReadOnly||options.parallelWrites)&&!parallelCapabilityAllowed(capability,options.parallelWrites?'scoped-write':'read'))return false
  if(options.workerMode==='read'&&!(capability.name.startsWith('agent.')&&readTools.has(capability.name.slice(6)))&&!webTools.has(capability.name)&&!['browser.open','browser.read_page','browser.inspect','browser.screenshot','preview.status'].includes(capability.name))return false
  if(options.workerMode==='verify'&&textEditTools.has(capability.name))return false
  if(options.taskScope&&projectAdviceRequested(options.taskScope.goal)&&!options.currentStep?.implementationChanged&&(processes.has(capability.name)||textEditTools.has(capability.name)||['agent.create_document','agent.replace_document_text','agent.create_spreadsheet','agent.update_spreadsheet_cells'].includes(capability.name)))return false
  if(options.taskScope&&!projectChecksRequested(options.taskScope.goal)&&!options.currentStep?.implementationChanged&&projectCheckTools.has(capability.name))return false
  if (capability.source.type==='builtin'&&previewCapabilityNames.has(capability.name)) return options.filesEnabled&&options.webEnabled
  if (capability.source.type==='builtin'&&browserCapabilityNames.has(capability.name)) return options.webEnabled
  if (webTools.has(capability.name)) return options.webEnabled
  if (!options.filesEnabled) return false
  // Native processes and third party tools can access the network themselves.
  if (!options.webEnabled && (capability.tags?.includes('risk:high') || processes.has(capability.name) || capability.source.type === 'mcp' ||
    capability.source.type !== 'skill' || !knownSkills.has(capability.source.skillId))) return false
  // The migrated tools support explicit per-call external path grants.
  if (capability.source.type === 'skill' && capability.source.skillId === 'file-operations') return false
  return true
}
export function externalPath(args: Record<string, unknown>, workspace: string): boolean {
  try { workspace = fs.realpathSync(workspace) } catch { /* Missing workspace is rejected at execution. */ }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && /path|file|directory|cwd/i.test(key)) {
      let target = path.resolve(workspace, value)
      let parent = target
      while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent)
      try { target = path.join(fs.realpathSync(parent), path.relative(parent, target)) } catch { /* Execution reports missing paths. */ }
      const relative = path.relative(workspace, target)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true
    }
  }
  return false
}
export function chatApprovalRequired(capability: Capability, args: Record<string, unknown>, options: Pick<ChatRunOptions, 'workspace'|'approvalMode'|'getApprovalMode'>): boolean {
  const mode = options.getApprovalMode?.() ?? options.approvalMode
  if (mode === 'full') return false
  if (externalPath(args, options.workspace)) return true
  if (mode === 'ask') return capability.tags?.includes('requires-approval') === true || webTools.has(capability.name)
  return capability.source.type === 'mcp' || processes.has(capability.name) ||
    (!webTools.has(capability.name) && capability.tags?.includes('risk:high') === true)
}
