import {createApp} from 'vue'
import DesktopTitleBar from './DesktopTitleBar.vue'
import {helpDocumentMetadata} from '../electron/shared/help-documents'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'
import {installThemeBridge} from './themeBridge'
const disposeThemeBridge=installThemeBridge()
if(import.meta.hot)import.meta.hot.dispose(disposeThemeBridge)
import LocalAiStudio from './LocalAiStudio.vue'
import WorkflowDesigner from './local-ai/WorkflowDesigner.vue'
import {installTooltips} from './tooltips'
import {installFloatingMenus} from './floatingMenus'
import type {WorkflowModelRef} from '../electron/shared/local-ai-workflow'
type WorkflowModelOption={id:string;name:string;instanceId?:string;modelRef?:WorkflowModelRef}
const disposeFloatingMenus=installFloatingMenus()
if(import.meta.hot)import.meta.hot.dispose(disposeFloatingMenus)
const disposeTooltips=installTooltips()
if(import.meta.hot)import.meta.hot.dispose(disposeTooltips)
const params=new URLSearchParams(location.search)
if(window.myplane?.desktopPlatform==='win32'&&!['performance','inspector','runtime-graph'].includes(params.get('surface')||'')){
 const bar=document.createElement('div');document.body.prepend(bar);createApp(DesktopTitleBar,{minimal:!params.get('surface')}).mount(bar)
 document.documentElement.classList.add('desktop-titlebar-enabled')
}
if(!window.myplane){
 document.title='请从桌面应用打开 · MyPlaneAgent'
 const root=document.querySelector('#app')
 if(root){
  const panel=document.createElement('main');panel.setAttribute('role','alert');panel.style.cssText='max-width:620px;margin:12vh auto;padding:28px;line-height:1.8'
  const heading=document.createElement('h1');heading.textContent='此页面需要 MyPlaneAgent 桌面接口'
  const explanation=document.createElement('p');explanation.textContent='当前页面未连接桌面应用，无法读取会话或调用本机功能。如果在内置浏览器中打开了应用地址，请返回 MyPlaneAgent 主窗口使用；浏览器用于浏览网页。'
  const recovery=document.createElement('p');recovery.textContent='如果这是应用主窗口，请完全退出后重新启动；仍无法恢复时，请检查预加载脚本是否完整安装。'
  panel.append(heading,explanation,recovery);root.replaceChildren(panel)
 }
}else if(params.get('surface')==='runtime-graph'){
 document.title='3D 运行视图 · MyPlaneAgent'
 void import('./local-ai/RuntimeGraphWindow.vue').then(({default:RuntimeGraphWindow})=>createApp(RuntimeGraphWindow).mount('#app'))
}else if(params.get('surface')==='inspector'){
 document.title='执行检查器 · MyPlaneAgent'
 void import('./local-ai/ExecutionInspectorWindow.vue').then(({default:ExecutionInspectorWindow})=>createApp(ExecutionInspectorWindow).mount('#app'))
}else if(params.get('surface')==='performance'){
 document.title='Token 速度 · MyPlaneAgent'
 void import('./local-ai/ModelPerformanceWindow.vue').then(({default:ModelPerformanceWindow})=>createApp(ModelPerformanceWindow).mount('#app'))
}else if(params.get('surface')==='browser'){
 void import('./local-ai/InternalBrowser.vue').then(({default:InternalBrowser})=>createApp(InternalBrowser).mount('#app'))
}else if(params.get('surface')==='help'){
 document.title=`${(helpDocumentMetadata.find(item=>item.id===params.get('document'))||helpDocumentMetadata[0]).title} · MyPlaneAgent`
 void import('./help/HelpWindow.vue').then(async({default:HelpWindow})=>{
  const bootstrap=await window.myplane.localAiStudio('bootstrap').catch(()=>null)
  createApp(HelpWindow,{documentId:params.get('document')||'workflow',appearanceStyle:bootstrap?.settings.appearanceStyle||'minimal',theme:bootstrap?.settings.theme||'system'}).mount('#app')
 })
}else if(params.get('surface')==='workflow-editor'){
 void Promise.all([window.myplane.localAiStudio('bootstrap'),window.myplane.localAiStudio('connect',{reason:'startup'})]).then(([bootstrap,connection])=>{
  document.title=params.get('workflowId')?'编辑工作流 · MyPlaneAgent':'新建工作流 · MyPlaneAgent'
  const remoteCache=bootstrap.remoteModelCache.find(item=>item.apiFormat===bootstrap.settings.apiFormat&&item.endpoint===bootstrap.settings.endpoint),
    localModels:WorkflowModelOption[]=bootstrap.models.filter(item=>item.exists&&item.format==='GGUF'&&!/(?:^|\/)mmproj[-.]/i.test(item.file)).map(item=>({id:item.id,name:`本地 · ${item.file}`,instanceId:bootstrap.runtime.modelId===item.id&&bootstrap.runtime.modelName?bootstrap.runtime.modelName:undefined,modelRef:{source:'local' as const,id:item.id,name:item.file}})),
    remoteModels:WorkflowModelOption[]=(connection.ok&&connection.models.length?connection.models:remoteCache?.models||[]).map(item=>({id:item.instanceId||item.id,name:`远程 · ${item.name||item.id}`,instanceId:item.instanceId,modelRef:{source:'remote' as const,id:item.instanceId||item.id,name:item.name||item.id,apiFormat:bootstrap.settings.apiFormat,endpoint:bootstrap.settings.endpoint,contextLength:bootstrap.settings.contextLength}})),
    models=bootstrap.settings.source==='managed'?[...localModels,...remoteModels]:[...remoteModels,...localModels],
    fallback=bootstrap.settings.source==='managed'?bootstrap.runtime.modelName||bootstrap.settings.model:bootstrap.settings.model;
  if(fallback&&!models.some(item=>item.id===fallback||item.instanceId===fallback))models.unshift({id:fallback,name:fallback,instanceId:undefined,modelRef:bootstrap.settings.source==='external'?{source:'remote' as const,id:fallback,name:fallback,apiFormat:bootstrap.settings.apiFormat,endpoint:bootstrap.settings.endpoint,contextLength:bootstrap.settings.contextLength}:{source:'current' as const,id:fallback,name:fallback}})
  createApp(WorkflowDesigner,{windowMode:true,workflowId:params.get('workflowId')||'',model:bootstrap.settings.source==='managed'?bootstrap.runtime.modelName:bootstrap.settings.model,models,appearanceStyle:bootstrap.settings.appearanceStyle,theme:bootstrap.settings.theme}).mount('#app')
 })
}else if(params.get('surface')==='workspace'){
 document.title='工作区控制台 · MyPlaneAgent'
 createApp(LocalAiStudio,{standalone:true,initialTab:'workflow'}).mount('#app')
}else createApp(LocalAiStudio,{standalone:true,initialTab:'chat'}).mount('#app')
