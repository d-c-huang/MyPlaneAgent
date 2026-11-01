export type TaskVerificationRule =
  | {kind:'file';path:string;contains?:string}
  | {kind:'test';script:string}
  | {kind:'diagnostics';checker:'auto'|'typescript'|'python';path?:string}
export type VerificationIssue = {key:string;category:'code'|'environment'|'unknown';message:string;path?:string;advice?:string}
export type VerificationComparison = {
  failures:Array<{issue:VerificationIssue;origin:'new'|'existing'|'unknown';related:boolean}>;
  resolved:VerificationIssue[];
}
export type TaskVerificationResult = {rule:TaskVerificationRule;sourceVersion?:string;passed:boolean;blocked?:boolean;summary:string;fingerprint:string;activityId?:string;issues?:VerificationIssue[];issuesComplete?:boolean}
export type TaskVerificationRun = {createdAt:string;results:TaskVerificationResult[];passed:boolean;comparison?:VerificationComparison}
export type TaskReviewAction={title:string;capability:string;args:Record<string,unknown>;basis:string;required:boolean}
export type TaskReviewCheck=TaskReviewAction&{id:string;signature:string;revision:number;status:'pending'|'running'|'complete'|'failed'|'invalid'|'deferred';attempts:number;activityId?:string;summary?:string}
export type TaskReviewQueue={phase?:'implement'|'verify';implementationRecovery?:boolean;implementationEvidence?:string[];fileRevision?:number;revision:number;checks:TaskReviewCheck[]}
export type TaskCompletionReview = {status:'complete'|'continue'|'needs_input'|'blocked';reason:string;nextStep:string;implementation?:{status:'missing'|'present'|'unknown';evidenceIds:string[]};missingEvidence?:string[];actions?:TaskReviewAction[];optionalChecks?:string[]}
export type TaskEvidence = {activityId:string;capability:string;status:'complete'|'error'|'denied';args:Record<string,unknown>;output:string;truncated:boolean}
export type TaskItem = {
  id:string; title:string; acceptance:string;
  kind?:import('./task-contract.js').TaskKind;kindSource?:'explicit'|'migrated'; runtime?:import('./task-contract.js').TaskRuntimeState;
  parentId?:string;depth?:number;childIds?:string[];
  key?:string;dependsOn?:string[];mode?:'read'|'write'|'verify';parallel?:boolean;fileScope?:string[];
  worker?:{id:string;mode:'read'|'write'|'verify';assignedAt:string;maxRounds?:number;roundLimitSource?:'automatic'|'configured';maxToolCalls?:number;toolLimitSource?:'automatic'|'configured';toolCalls:number;attemptId?:string;startedAt?:string;finishedAt?:string;modelRequests?:number;tokens?:number};
  status:'pending'|'running'|'verifying'|'complete'|'blocked';
  attempts:number; summary:string; evidenceIds:string[];
  evidence?:TaskEvidence[];
  editProgress?:import('../main/agent/core/edit-progress.js').EditProgressState;
  reviewQueue?:TaskReviewQueue;
  visualResponses?:Array<import('./visual-review.js').VisualDecision & {createdAt:string}>;
  outcome?:'complete'|'needs_input'|'blocked';completionReview?:TaskCompletionReview;
  verification?:TaskVerificationRule[];verificationRuns?:TaskVerificationRun[];repairAttempts?:number;repairPending?:boolean;modifiedFiles?:string[];requiresVerification?:boolean;
  verificationProblem?:{input:unknown;message:string;attempts:number};
  verificationRepairs?:Array<{createdAt:string;input:unknown;output?:string;error?:string}>;
  baseline?:TaskVerificationRun;baselineHistory?:TaskVerificationRun[];baselineUnavailableReason?:string;mutationStarted?:boolean;
  excludedProjectChecks?:Array<{createdAt:string;reason:string;rules:TaskVerificationRule[];baseline?:TaskVerificationRun;runs?:TaskVerificationRun[]}>;
}
export type TaskPlan = {workerTimeoutMs?:number;scope?:import('./task-scope.js').TaskScope;needsReplan?:boolean;graphVersion?:1;maxParallelWorkers?:number;editProgress?:import('../main/agent/core/edit-progress.js').EditProgressState;taskId:string;workspace:string;items:TaskItem[];updatedAt:string}
