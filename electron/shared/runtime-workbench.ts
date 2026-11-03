import type {InspectionCall,InspectionState} from './execution-inspector.js'
import type {TaskItem} from './task-plan.js'

export type NodeConfiguration={
 instruction:string;input:string;model:string;tools?:string[]
 maxRequests?:number;maxToolCalls?:number;timeoutMs?:number
 title?:string;acceptance?:string;kind?:TaskItem['kind'];dependsOn?:string[];fileScope?:string[];parallel?:boolean
}
export type NodeRevision={revision:number;at:string;config:NodeConfiguration;reason:string}
export type SharedNodeTemplate={id:string;name:string;revision:number;updatedAt:string;config:NodeConfiguration;history:NodeRevision[]}
export type TemplateCommand={action:'save';id?:string;expectedRevision?:number;name:string;config:NodeConfiguration}|{action:'delete';id:string;expectedRevision:number}|{action:'import';json:string}
export type RuntimeHistoryEntry={id:string;runId:string;at:string;label:string}
export type RuntimeHistoryIndex={entries:RuntimeHistoryEntry[];truncated:boolean}
export type RuntimeHistoryFrame=RuntimeHistoryEntry&{snapshot:import('./runtime-graph.js').RuntimeGraphSnapshot}
export type WorkbenchData={
 calls?:InspectionCall[]
 nodes:Record<string,{revision:number;config:NodeConfiguration;draft?:NodeConfiguration;draftBase?:number;history:NodeRevision[]}>
 events:Array<{id:string;at:string;scopeId:string;action:string;detail:string}>
 archives:Array<{at:string;reason:string;item:TaskItem}>
 templates:Array<{id:string;name:string;config:NodeConfiguration}>
 receipts:string[]
}
export type WorkbenchActivity={scopeId:string;workerId?:string;phase:'queued'|'model'|'tool'|'stage'|'finished';label:string;at:string;appliedRevision:number;appliedRootRevision?:number;requests:number;toolCalls:number;cancelled?:boolean}
export type WorkbenchNodeDetail={
 approvals?:Array<{id:string;callId:string;capability:string;args:Record<string,unknown>}>
 sessionId:string;nodeId:string;scopeId:string;active:boolean;requestId?:string
 revision:number;config:NodeConfiguration;draft?:NodeConfiguration;draftBase?:number;history:NodeRevision[]
 rootRevision:number;controllable:boolean
 activity?:WorkbenchActivity;pauseRequested:boolean;checkpoint?:InspectionCall;calls:InspectionCall[]
 events:WorkbenchData['events'];archives:WorkbenchData['archives'];templates:WorkbenchData['templates']
 tasks:Array<{id:string;title:string;status:TaskItem['status']}>;affected:Array<{id:string;title:string}>
 structuralEditable:boolean;workspace:string;inspection?:InspectionState
}
export type WorkbenchCommand={sessionId:string;nodeId:string;commandId:string;requestId?:string;expectedRevision:number;
 action:'pause'|'continue'|'step'|'cancel'|'draft'|'apply'|'retry'|'template-save'|'template-delete'|'approve'|'reject';
 approvalId?:string;
 config?:NodeConfiguration;checkpointId?:string;args?:Record<string,unknown>;name?:string;templateId?:string;
 scope?:'node'|'branch'|'all'
}
export const emptyNodeConfiguration=():NodeConfiguration=>({instruction:'',input:'',model:''})
export const emptyWorkbench=():WorkbenchData=>({nodes:{},events:[],archives:[],templates:[],receipts:[]})
