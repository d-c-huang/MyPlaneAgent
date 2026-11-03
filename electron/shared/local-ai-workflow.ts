import type {AgentApprovalMode,AgentMode} from './local-ai-agent.js'
import type {RemoteApiFormat} from './local-ai.js'

export type WorkflowBranch={id:string;name:string;condition:string;color:string;targetNodeIds?:string[];targetNodeId?:string;outputValue?:string}
export type WorkflowInputParameter={name:string;description:string;value?:string}
export type WorkflowVariableAssignment={name:string;value:string}
export type WorkflowModelRef={source:'current';id?:string;name?:string}|{source:'local';id:string;name?:string}|{source:'remote';id:string;name?:string;apiFormat:RemoteApiFormat;endpoint:string;profileId?:string;contextLength?:number}
export type WorkflowNodeBase={id:string;name:string;branches?:WorkflowBranch[];onSuccess?:string;onFailure?:string}
export type WorkflowAgentNode=WorkflowNodeBase&{type:'agent';config:{instruction:string;model?:string;modelRef?:WorkflowModelRef;modelSource?:'current'|'specified';mode:Exclude<AgentMode,'chat'>;maxSteps:number;fastMode:boolean;approvalMode:AgentApprovalMode;inputs?:WorkflowInputParameter[];inputSignalMode?:'all'|'any';branchMode?:'direct'|'ai'|'rules';execution?:import('./workflow-execution.js').WorkflowExecutionPolicy}}
export type WorkflowAiJudgeNode=WorkflowNodeBase&{type:'ai-judge';config:WorkflowAgentNode['config']&{judgeMode?:'classify'|'legacy';judgeInput?:string;unknownBranchId?:string}}
export type WorkflowConditionNode=WorkflowNodeBase&{type:'condition';config:{sourceNodeId:string;operator:'succeeded'|'failed'}}
export type WorkflowRouteNode=WorkflowNodeBase&{type:'route';config:{sourceNodeId:string}}
export type WorkflowDataNode=WorkflowNodeBase&{type:'data';config:{assignments:WorkflowVariableAssignment[]}}
export type WorkflowJoinNode=WorkflowNodeBase&{type:'join';config:{mode:'all'|'any'}}
export type WorkflowApprovalNode=WorkflowNodeBase&{type:'approval';config:{title?:string;prompt:string;approveLabel:string;rejectLabel:string;wait?:{mode:'forever'|'duration'|'until';durationMinutes?:number;deadline?:string;onTimeout:'reject'|'fail'}}}
export type WorkflowNotifyNode=WorkflowNodeBase&{type:'notify';config:{title:string;body:string;fixedBranches?:boolean}}
export type WorkflowEndNode=WorkflowNodeBase&{type:'end';config:{status:'succeeded'|'failed';summary:string;scope?:'path'|'workflow';resultJson?:string}}
export type WorkflowRule={kind:'text'|'number'|'boolean'|'collection';left:string;operator:string;right:string}
export type WorkflowDecisionNode=WorkflowNodeBase&({type:'judge';config:{mode:'all'|'any';rules:WorkflowRule[]}}|{type:'predicate';config:{mode:'all'|'any';rules:WorkflowRule[]}})
export type WorkflowSwitchNode=WorkflowNodeBase&{type:'switch';config:{value:string;kind:'text'|'number'|'boolean';cases:{branchId:string;value:string}[];defaultBranchId:string}}
export type WorkflowNode=WorkflowAiJudgeNode|WorkflowDecisionNode|WorkflowSwitchNode|WorkflowAgentNode|WorkflowConditionNode|WorkflowRouteNode|WorkflowDataNode|WorkflowJoinNode|WorkflowApprovalNode|WorkflowNotifyNode|WorkflowEndNode
export type WorkflowLayout={nodes:Record<string,{x:number;y:number}>;start?:{x:number;y:number}}

export type WorkflowDefinition={id:string;name:string;description:string;enabled:boolean;version:number;entryNodeId:string;entryNodeIds?:string[];nodes:WorkflowNode[];layout?:WorkflowLayout;timeoutMinutes:number;createdAt:string;updatedAt:string}
export type WorkflowDefinitionInput=Omit<WorkflowDefinition,'id'|'version'|'createdAt'|'updatedAt'>&{id?:string}
export type WorkflowNodeRun={nodeId:string;nodeName:string;type:WorkflowNode['type'];status:'running'|'waiting'|'succeeded'|'failed'|'skipped';startedAt:string;finishedAt?:string;agentTaskId?:string;summary?:string;error?:string;branchId?:string;branchName?:string;outputValue?:string;approval?:{title?:string;approveLabel:string;rejectLabel:string;deadline?:string;decision?:'approved'|'rejected'|'timeout';decidedAt?:string;note?:string;onTimeout?:'reject'|'fail'}}
export type WorkflowRunLog={at:string;level:'info'|'warn'|'error';message:string;nodeId?:string}
export type WorkflowRun={id:string;workflowId:string;workflowName:string;workflowVersion:number;status:'running'|'waiting'|'succeeded'|'failed'|'cancelled';executionRemainingMs?:number;executionStartedAt?:string;currentNodeId?:string;pendingNodeIds?:string[];nodeInputSignals?:Record<string,string[]>;variables?:Record<string,string>;nodeVariables?:Record<string,Record<string,string>>;nodeRuns:WorkflowNodeRun[];logs?:WorkflowRunLog[];agentTaskIds:string[];startedAt:string;finishedAt?:string;error?:string;summary?:string;resumedFromRunId?:string}

export type WorkflowCommands={
 workflowDefinitions:{input:undefined;output:WorkflowDefinition[]}
 workflowSave:{input:WorkflowDefinitionInput;output:WorkflowDefinition}
 workflowDelete:{input:{id:string};output:void}
 workflowAction:{input:{id:string;action:'run'|'enable'|'pause'};output:WorkflowDefinition|WorkflowRun}
 workflowRuns:{input:{workflowId?:string;limit?:number}|undefined;output:WorkflowRun[]}
 workflowCancel:{input:{runId:string};output:WorkflowRun}
 workflowRetry:{input:{runId:string;nodeId:string};output:WorkflowRun}
 workflowResolveApproval:{input:{runId:string;decision:'approved'|'rejected';nodeId?:string;note?:string};output:WorkflowRun}
}
