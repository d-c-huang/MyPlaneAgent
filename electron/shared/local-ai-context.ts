import type {TokenUsageTotals} from './local-ai-usage.js'

export type ContextCompactionReport={
 outcome:'compressed'|'recovered'|'unchanged'|'failed'|'cancelled';
 method?:'model'|'ledger'|'recovery';
 startedAt:string;durationMs:number;requests:number;
 messages:number;archivedMessages:number;capacity:number;
 beforeInputTokens?:number;afterInputTokens?:number;savedInputTokens?:number;
 reservedOutput?:number;safetyTokens?:number;
 usage:TokenUsageTotals;
 quality?:{requirements:number;unresolvedEffects:number;completeToolBoundary:true;historyUnchanged:true};
}
export type ContextRequirement={id:string;text:string}
export type ContextPinnedState={
 taskId?:string;workerId?:string;goal?:string;
 requirements:ContextRequirement[];
 permissions?:{workspace?:string;filesEnabled?:boolean;webEnabled?:boolean;approvalMode?:string};
 acceptance?:string[];
 unresolvedEffects?:Array<{id:string;capability?:string;status:'unknown'|'started';description?:string}>;
}
type CheckpointBody={source?:'model'|'recovery'|'ledger';summary:string;through:number;updatedAt:string;compactions:number;compaction?:ContextCompactionReport}
export type ContextCheckpoint=CheckpointBody&(
 | {version?:1;historyHash?:never;stateHash?:never;throughMessageId?:never;state?:never}
 | {version:2;historyHash:string;stateHash:string;throughMessageId?:string;state:ContextPinnedState}
)
export type ContextRecovery={restoredAt:string;messages:number;generation:number;workerId?:string;checkpointSource?:'model'|'ledger'|'recovery';unconfirmedEffects:number}
export type ContextStatus={inputTokens:number;capacity:number;reservedOutput:number;safetyTokens?:number;fixedTokens?:number;historyBudget?:number;triggerRatio?:number;targetRatio?:number;estimated:true;state:'ready'|'compacting'|'error';compactions:number;message?:string;lastCompaction?:ContextCompactionReport;recovery?:ContextRecovery;origin?:'worker';model?:string}
