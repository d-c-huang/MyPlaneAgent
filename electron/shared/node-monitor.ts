export type NodeMonitorPhase='queued'|'analyzing'|'repairing'|'verifying'|'applied'|'resolved'|'waiting'|'failed'|'dismissed'|'superseded'
export type NodeMonitorCause='transient'|'verification'|'module'|'permission'|'configuration'|'application'|'unknown'
export type NodeMonitorPolicy={enabled:boolean;autoRepair:boolean;autoApply:boolean;maxAttemptsPerIssue:number;maxRepairsPerDay:number;analysisTimeoutSeconds:number}
export type NodeMonitorDiagnosis={cause:NodeMonitorCause;summary:string;action:'retry_node'|'optimize_module'|'needs_user'|'application_update';nextStep:string}
export type NodeMonitorIssue={
 id:string;fingerprint:string;source:'node'|'module'|'session';sessionId?:string;sessionTitle?:string;taskId?:string;nodeId?:string;moduleId?:string;versionId?:string;
 title:string;error:string;phase:NodeMonitorPhase;occurrences:number;attempts:number;createdAt:string;updatedAt:string;
 diagnosis?:NodeMonitorDiagnosis;message:string;jobId?:string;fromVersion?:string;toVersion?:string;
 retryable?:boolean;lastObservation?:string;
 events:Array<{at:string;phase:NodeMonitorPhase;message:string}>;
}
export type NodeMonitorSnapshot={policy:NodeMonitorPolicy;issues:NodeMonitorIssue[];runningId?:string;repairsToday:number;lastScanAt?:string;model?:string;hotUpdateNote:string}
export type NodeMonitorCommand={action:'policy';policy:NodeMonitorPolicy}|{action:'retry'|'dismiss';id:string}|{action:'scan'}
export type NodeMonitorCommands={
 nodeMonitorState:{input:undefined;output:NodeMonitorSnapshot};
 nodeMonitorCommand:{input:NodeMonitorCommand;output:NodeMonitorSnapshot};
}
