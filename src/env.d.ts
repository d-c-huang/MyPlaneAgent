import type {BrowserAction,BrowserState} from '../electron/shared/browser'
/// <reference types="vite/client" />
import type {StudioCommands,StudioEvent,AgentCoreUiEvent} from '../electron/shared/local-ai-studio'
import type {AgentTask} from '../electron/shared/local-ai-agent'
import type {ApplicationLogAction,ApplicationLogResult} from '../electron/shared/application-log'
declare global {
 interface Window {
  myplane:{
   desktopPlatform?:string
   runtimeGraphWindow(action:'open'|'close'|'state',sessionId?:string):Promise<boolean>
   runtimeGraphSnapshot(sessionId?:string):Promise<import('../electron/shared/runtime-graph').RuntimeGraphSnapshot>
   runtimeGraphHistory(sessionId:string):Promise<import('../electron/shared/runtime-workbench').RuntimeHistoryIndex>
   runtimeGraphFrame(sessionId:string,id:string):Promise<import('../electron/shared/runtime-workbench').RuntimeHistoryFrame>
   runtimeGraphTemplates(command?:import('../electron/shared/runtime-workbench').TemplateCommand):Promise<import('../electron/shared/runtime-workbench').SharedNodeTemplate[]>
   runtimeGraphWorkflow(sessionId:string):Promise<string>
   runtimeGraphDetail(sessionId:string,nodeId:string):Promise<import('../electron/shared/runtime-workbench').WorkbenchNodeDetail>
   runtimeGraphCommand(command:import('../electron/shared/runtime-workbench').WorkbenchCommand):Promise<import('../electron/shared/runtime-workbench').WorkbenchNodeDetail>
   onRuntimeGraphSelection(callback:(sessionId:string)=>void):()=>void
   inspectorSnapshot():Promise<import('../electron/shared/execution-inspector').InspectorWindowContext>
   inspectorContext(value:import('../electron/shared/execution-inspector').InspectorWindowContext):Promise<void>
   inspectorWindow(action:'open'|'close'|'state'):Promise<boolean>
   onInspectorWindowState(callback:(open:boolean)=>void):()=>void
   showTitleMenu(label:string,x:number):Promise<void>
   setTitleBarColors(color:string,symbolColor:string):Promise<void>
   localAiStudio<K extends keyof StudioCommands>(action:K,payload?:StudioCommands[K]['input']):Promise<StudioCommands[K]['output']>
   onLocalAiAgentEvent(callback:(task:AgentTask)=>void):()=>void
   onAgentCoreEvent(callback:(event:AgentCoreUiEvent)=>void):()=>void
   onLocalAiStudioEvent(callback:(event:StudioEvent)=>void):()=>void
   applicationLogs(action:ApplicationLogAction,limit?:number):Promise<ApplicationLogResult>
   onApplicationLogToggle(callback:()=>void):()=>void
   browser(action:BrowserAction,value?:string|boolean):Promise<BrowserState>
   onBrowserState(callback:(state:BrowserState)=>void):()=>void
   openAiLink(url:string):Promise<void>
   openWorkflowEditor(workflowId?:string):Promise<void>
   openHelpDocument(documentId?:import('../electron/shared/help-documents').HelpDocumentId):Promise<void>
   performanceWindow(action:'open'|'close'|'state'):Promise<boolean>
   performanceSnapshot():Promise<{runtime:import('../electron/shared/local-ai-studio').StudioRuntime;source:'managed'|'external';theme:'system'|'light'|'dark'}>
   onPerformanceWindowState(callback:(open:boolean)=>void):()=>void
   closeWorkflowEditor():Promise<void>
   workflowEditorSaved(workflowId:string):Promise<void>
   onWorkflowSaved(callback:(workflowId?:string)=>void):()=>void
  }
 }
}
export {}
