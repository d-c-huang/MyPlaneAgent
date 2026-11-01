import type {Capability} from '../../../shared/types/capability.js'
import {readTools} from '../tools.js'
import {textEditTools} from './edit-progress.js'

export type ParallelWorkerMode='read'|'scoped-write'
/** Stateful browser/MCP/process tools must run in a separate exclusive item. */
export function parallelCapabilityAllowed(capability:Capability,mode:ParallelWorkerMode):boolean {
  if(capability.source.type==='builtin')return ['runtime.current_time','runtime.read_evidence','runtime.read_history','runtime.check_file'].includes(capability.name)
  if(capability.source.type!=='skill'||capability.source.skillId!=='agent-tools')return false
  if(capability.name.startsWith('agent.')&&readTools.has(capability.name.slice(6)))return true
  return mode==='scoped-write'&&textEditTools.has(capability.name)
}
