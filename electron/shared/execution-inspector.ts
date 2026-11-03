export type InspectionCall = {
  id: string; kind: 'ability'|'tool'|'model'|'stage'; name: string; source: string
  scopeId?:string; workerId?:string; startedAt?:string; finishedAt?:string
  args: Record<string,unknown>; originalArgs: Record<string,unknown>; schema: object
  status: 'paused'|'ready'|'running'|'complete'|'error'; output?: string; edited?: boolean
}
export type InspectionState = { pauseRequested: boolean; checkpointId?: string; checkpointIds?:string[]; pausedScopes?:string[]; draft?:string; calls: InspectionCall[]; finished?: boolean }
export type InspectionCommand = { requestId: string; action: 'state'|'pause'|'continue'|'continueAll'|'step'|'draft'; scopeId?:string; checkpointId?: string; args?: Record<string,unknown>; draft?:string }
export type InspectorWindowContext={requestId:string;historyRequestId?:string;sessionId?:string;content:string;reasoning:string;theme:'system'|'light'|'dark'}
