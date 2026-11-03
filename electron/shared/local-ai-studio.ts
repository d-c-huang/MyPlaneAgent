import type {ContextCheckpoint,ContextStatus} from './local-ai-context.js'
import type {TokenUsage,TokenUsageTotals} from './local-ai-usage.js'
import type {LocalAiSettings,LocalAiSettingsInput,LocalAiSearchResult,LocalAiModelFile,LocalAiDownloadEntry,LocalAiRemoteProfile,LocalAiRemoteProfileInput} from './local-ai.js'
import type {StudioCatalog,StudioDiscoveryModel} from './local-ai-catalog.js'
import type {McpCommands} from './local-ai-mcp.js'
import type {AgentCommands} from './local-ai-agent.js'
import type {AgentToolCommands} from './local-ai-tools.js'
import type {StudioDeveloperCommands} from './local-ai-developer.js'
import type {AutomationCommands} from './local-ai-automation.js'
import type {WorkflowCommands} from './local-ai-workflow.js'
import type {AgentEvent as CoreAgentEvent, ExecutionResult as CoreExecutionResult} from './types/agent.js'

export type StudioSettings = LocalAiSettings & {
  source: 'external'|'managed'
  runtimePath: string
  runtimePort: number
  contextLength: number
  managedContextLength?: number
  gpuLayers: number
  threads: number
  showTokenSpeed?: boolean
  showExecutionInspector?: boolean
  pauseBeforeAgentCalls?: boolean
  temperature: number
  topP: number
  repeatPenalty: number
  systemPrompt: string
  appearance?: import('./app-appearance.js').AppAppearance
  backgroundImage?: string
  backgroundOpacity?: number
  theme: 'system'|'light'|'dark'
  appearanceStyle: 'minimal'|'ocean'|'paper'|'terminal'
}
export type StudioSettingsInput = LocalAiSettingsInput & Partial<Omit<StudioSettings,'hasApiKey'|'hasHfToken'>>
export type StudioGenerationSettings = Pick<StudioSettings,'temperature'|'topP'|'maxTokens'|'repeatPenalty'>
export type StudioModelFile = LocalAiModelFile & {format:string;quantization:string;revision?:string;sha256?:string}
export type StudioModelDetails = {model:StudioDiscoveryModel;files:StudioModelFile[];revision:string;gated:boolean;contextLength?:number}
export type StudioLocalModel = LocalAiDownloadEntry & {exists:boolean;format:string;quantization:string;imported?:boolean}
export type StudioDownload = {
  id:string;repoId:string;file:string;revision:string;sha256?:string;target:string
  status:'queued'|'downloading'|'paused'|'verifying'|'completed'|'failed'|'cancelled'
  received:number;total:number;speed:number;error:string;createdAt:string;etag?:string
}
export type StudioRuntime = {
  performance?: import('./model-performance.js').ModelTokenSample[]
  externalPerformance?: import('./model-performance.js').ModelTokenSample[]
  state:'stopped'|'starting'|'running'|'stopping'|'error';modelId:string;modelName:string
  endpoint:string;pid?:number;error:string;logs:string[];startedAt?:number;host?:string;parallel?:number;contextLength?:number;embedding?:boolean;vision?:boolean
}
export type StudioServerModel = {id:string;name:string;loaded?:boolean;instanceId?:string;contextLength?:number}
export type StudioRemoteModelCache = {apiFormat:string;endpoint:string;updatedAt:string;models:StudioServerModel[]}
export type StudioConnection = {ok:boolean;endpoint:string;latencyMs:number;models:StudioServerModel[];error:string;provider:'lmstudio'|'openai'|'deepseek'|'anthropic'}
export type StudioImage = {name:string;dataUrl:string}
export type StudioApprovalMode = 'ask'|'auto'|'full'
export type StudioFileChange = {path:string;before?:string;after:string}
export type StudioToolActivity = {id:string;capability:string;args:Record<string,unknown>;status:'waiting'|'running'|'complete'|'error'|'denied';notApplied?:true;workerId?:string;output?:string;fileChanges?:StudioFileChange[];images?:StudioImage[]}
export type StudioProgress = {id:string;type:'progress';text:string;phase:'working'|'reviewing'|'context';createdAt:string}
export type StudioExecutionEntry = StudioProgress | {id:string;type:'tool';activityId:string;createdAt:string}
export type StudioMessage = {visualDecision?:import('./visual-review.js').VisualDecision;abilityRoute?:import('./ability-modules.js').AbilityRoute;execution?:StudioExecutionEntry[];outcome?:'complete'|'needs_input'|'blocked';error?:string;toolActivity?:StudioToolActivity[];usage?:TokenUsage;usageTotals?:TokenUsageTotals;id:string;role:'user'|'assistant';content:string;images?:StudioImage[];reasoning?:string;createdAt:string;model?:string;elapsedMs?:number;tokens?:number;status?:'complete'|'stopped'|'error'}
export type StudioSession = {modelRef?:import('./local-ai-workflow.js').WorkflowModelRef;workbench?:import('./runtime-workbench.js').WorkbenchData;defaultWorkspace?:{kind:'cache'|'project';path:string};operationJournal?:import('../main/agent/core/operation-journal.js').OperationJournal;taskPlan?:import('./task-plan.js').TaskPlan;abilityTask?:import('./ability-modules.js').AbilityTask;abilityState?:import('./ability-modules.js').ConversationState;conversationStartMessageId?:string;pinned?:boolean;webEnabled?:boolean;approvalMode?:StudioApprovalMode;projectId?:string;checkpoint?:ContextCheckpoint;context?:ContextStatus;usage?:TokenUsageTotals;id:string;title:string;model:string;systemPrompt:string;messages:StudioMessage[];createdAt:string;updatedAt:string}
export type StudioSessionSummary = Omit<StudioSession,'messages'|'operationJournal'|'workbench'> & {messageCount:number}
/** Live state owned by the requesting window. The in-progress answer is excluded from session.messages. */
export type StudioChatRun = {requestId:string;sessionId:string;session:StudioSession;pending:StudioMessage;startedAt:string;compactOnly:boolean;sequence:number;workspace?:{path:string;token:string};phase:'starting'|'running'|'waiting_approval'|'stopping';approvals:Array<{approvalId:string;activity:StudioToolActivity}>}
export type StudioEventPayload = {type:'task-plan';requestId:string;plan:import('./task-plan.js').TaskPlan}|{type:'progress';requestId:string;entry:StudioProgress}|{type:'outcome';requestId:string;outcome:'complete'|'needs_input'|'blocked'}|{type:'tool';requestId:string;activity:StudioToolActivity}|{type:'approval';requestId:string;approvalId:string;activity:StudioToolActivity}|{type:'context';requestId:string;context:ContextStatus;sessionUsage?:TokenUsageTotals}|{type:'delta';requestId:string;content:string;reasoning:string;usage?:TokenUsage;sessionUsage?:TokenUsageTotals}|{type:'finished';requestId:string;session:StudioSession;error?:string}
export type StudioEvent = StudioEventPayload & {sessionId:string;sequence:number}
export type StudioHardware = {platform:string;arch:string;cpu:string;threads:number;totalMemory:number;freeMemory:number}
export type StudioSnapshot = {downloads:StudioDownload[];runtime:StudioRuntime;hardware:StudioHardware;remoteModelCache:StudioRemoteModelCache[]}
export type StudioBootstrap = StudioSnapshot & {settings:StudioSettings;models:StudioLocalModel[];sessions:StudioSessionSummary[];chatImagesSupported?:boolean;chatToolsSupported?:boolean}

export type StudioCommands = {
    chatInspect:{input:import('./execution-inspector.js').InspectionCommand;output:import('./execution-inspector.js').InspectionState}
    experienceSearchHealth:{input:undefined;output:import('../main/agent/search-health.js').SearchHealthRow[]}
    experienceConvert:{input:{id:string;revision:number};output:import('./experience.js').ExperienceState}
    experienceState:{input:undefined;output:import('./experience.js').ExperienceState}
    experienceConfigure:{input:{enabled:boolean};output:import('./experience.js').ExperienceState}
    experienceRemove:{input:{id:string};output:import('./experience.js').ExperienceState}
    experienceEdit:{input:{id:string;revision:number;recipe:import('./experience.js').ExperienceRecipe};output:import('./experience.js').ExperienceState}
    experienceEnable:{input:{id:string;revision:number;enabled:boolean};output:import('./experience.js').ExperienceState}
    experienceRollback:{input:{id:string;revision:number;target:number};output:import('./experience.js').ExperienceState}
    experienceTrial:{input:import('./experience.js').ExperienceTrialInput;output:import('./experience.js').ExperienceState}
    previewPluginState:{input:undefined;output:{enabled:boolean;running:number}}
    previewPluginConfigure:{input:{enabled:boolean};output:{enabled:boolean;running:number}}
  bootstrap:{input:undefined;output:StudioBootstrap}
  settings:{input:StudioSettingsInput;output:StudioSettings}
  remoteProfiles:{input:undefined;output:LocalAiRemoteProfile[]}
  remoteProfileSave:{input:LocalAiRemoteProfileInput;output:{settings:StudioSettings;profiles:LocalAiRemoteProfile[]}}
  remoteProfileUse:{input:{id:string};output:{settings:StudioSettings;profiles:LocalAiRemoteProfile[]}}
  remoteProfileDelete:{input:{id:string};output:LocalAiRemoteProfile[]}
  snapshot:{input:undefined;output:StudioSnapshot}
  connect:{input:{reason?:'startup'|'manual'}|undefined;output:StudioConnection}
  search:{input:{query:string;format:'gguf'|'all';sort:'downloads'|'likes'|'lastModified'};output:LocalAiSearchResult[]}
  catalog:{input:{query:string;format:'gguf'|'all';sort:'downloads'|'likes'|'lastModified';cachedOnly?:boolean};output:StudioCatalog}
  modelDetails:{input:{repoId:string};output:StudioModelDetails}
  modelIcon:{input:{author:string};output:string}
  readme:{input:{repoId:string;revision:string};output:string}
  files:{input:{repoId:string};output:StudioModelFile[]}
  enqueue:{input:{repoId:string;file:string};output:StudioDownload[]}
  downloadAction:{input:{id:string;action:'pause'|'resume'|'cancel'|'remove'};output:StudioDownload[]}
  models:{input:undefined;output:StudioLocalModel[]}
  importModels:{input:undefined;output:StudioLocalModel[]}
  removeModel:{input:{id:string;deleteFile:boolean};output:StudioLocalModel[]}
  revealModel:{input:{id:string};output:void}
  chooseDirectory:{input:undefined;output:string|null}
  chooseRuntime:{input:undefined;output:string|null}
  startRuntime:{input:{id:string};output:StudioRuntime}
  stopRuntime:{input:undefined;output:StudioRuntime}
  loadExternal:{input:{id:string;unload?:boolean};output:StudioConnection}
  sessions:{input:undefined;output:StudioSessionSummary[]}
  session:{input:{id:string};output:StudioSession}
  newSession:{input:{projectId?:string}|undefined;output:StudioSession}
  updateSession:{input:{id:string;pinned?:boolean;projectId?:string;title?:string;model?:string;systemPrompt?:string};output:StudioSession}
  deleteSession:{input:{id:string};output:void}
  exportSession:{input:{id:string;format?:'md'|'pdf'|'json'};output:boolean}
  chat:{input:{generation?:StudioGenerationSettings;modelRef?:import('./local-ai-workflow.js').WorkflowModelRef;visualDecision?:import('./visual-review.js').VisualDecision;sessionId:string;requestId:string;text:string;images?:StudioImage[];model:string;regenerate?:boolean;webEnabled?:boolean;approvalMode?:StudioApprovalMode;workspaceToken?:string};output:{started:boolean}}
  chatRuns:{input:undefined;output:StudioChatRun[]}
  compactSession:{input:{sessionId:string;requestId:string;model:string;modelRef?:import('./local-ai-workflow.js').WorkflowModelRef;generation?:StudioGenerationSettings};output:{started:boolean}}
  chatApprove:{input:{requestId:string;approvalId:string;approved:boolean;scope?:'once'|'similar'|'full'};output:void}
  stopChat:{input:{requestId:string};output:void}
}&StudioDeveloperCommands&AgentCommands&AgentToolCommands&McpCommands&AutomationCommands&WorkflowCommands&SkillCommands&AgentCoreCommands&import('./ability-modules.js').AbilityModuleCommands&import('./ability-catalog.js').AbilityCatalogCommands&import('./node-monitor.js').NodeMonitorCommands

export type AgentCoreUiEvent = {taskId:string;event:CoreAgentEvent}|{taskId:string;result:CoreExecutionResult}|{taskId:string;error:string}|{taskId:string;cancelled:true}|{taskId:string;approval:{id:string;capability:string;args:Record<string,unknown>}}
export type AgentCoreCommands = {
  agentCoreStatus:{input:undefined;output:{enabled:boolean;available:boolean;initialized:boolean;runningTasks:number;runningConversations:number;skillsCount:number;capabilitiesCount:number;mcpServers:number}}
  agentCoreChooseWorkspace:{input:undefined;output:{path:string;token:string}|null}
  agentCoreListCapabilities:{input:undefined;output:Array<{name:string;category:string;source:'builtin'|'skill'|'mcp';description:string;parameters:Array<{name:string;type:string;required:boolean;description?:string}>;enabled:boolean;status:'active'}>}
  agentCoreRun:{input:{workspaceToken:string;model:string;prompt:string;mode:'general'|'coding'|'documents'};output:{taskId:string}}
  agentCoreCancel:{input:{taskId:string};output:void}
  agentCoreApprove:{input:{taskId:string;approvalId:string;approved:boolean};output:void}
  agentCoreMcpList:{input:undefined;output:Array<{id:string;name:string;command:string;args:string[];connected:boolean}>}
  agentCoreMcpAdd:{input:{id:string;name:string;command:string;args:string[]};output:void}
  agentCoreMcpConnect:{input:{id:string};output:void}
  agentCoreMcpDisconnect:{input:{id:string};output:void}
  agentCoreMcpRemove:{input:{id:string};output:void}
}

export type SkillCommands = {
  skillsList: {input: undefined; output: any[]}
  skillsReload: {input: undefined; output: void}
  skillGetContent: {input: {skillName: string}; output: {skillJson: any; indexPy: string; enginePy: string | null; readme: string}}
  skillCompile: {input: {skillName: string; indexPy: string; enginePy?: string | null}; output: {success: boolean}}
  skillSave: {input: {skillName: string; skillJson: any; indexPy: string; enginePy: string | null; readme: string}; output: void}
  skillTestTool: {input: {skillName: string; toolName: string; args: any; workspace: string}; output: {output: string; elapsedMs: number}}
  skillDelete: {input: {skillName: string}; output: void}
  skillCreate: {input: {skillName: string}; output: void}
  getDefaultWorkspace: {input: undefined; output: string}
}
