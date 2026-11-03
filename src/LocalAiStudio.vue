<script setup lang="ts">
import AppPreferences from './local-ai/AppPreferences.vue'
import {appearanceVariables,normalizeAppearance} from '../electron/shared/app-appearance'
import {backgroundImageUrl} from './local-ai/background-presets'
import {validBackgroundImage,backgroundOpacity} from '../electron/shared/app-background'
import {modelFileRole} from '../electron/shared/model-library'
import type {StudioLocalModel,StudioModelFile} from '../electron/shared/local-ai-studio'
import {DEEPSEEK_CONTEXT_TOKENS,isDeepSeek,deepseekModels} from '../electron/shared/local-ai-providers'
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import ChatWorkbench from './local-ai/ChatWorkbench.vue'
import WorkflowDesigner from './local-ai/WorkflowDesigner.vue'
import AutomationTasks from './local-ai/AutomationTasks.vue'
import NodeMonitorPanel from './local-ai/NodeMonitorPanel.vue'
import {Search,FolderOpened,Connection,Setting,Plus,Close,Download,Refresh,CopyDocument,VideoPause,VideoPlay,Operation,Document,Cpu,ChatDotRound,ArrowRight,Check,AlarmClock,Share,DataLine} from '@element-plus/icons-vue'
import LocalAiDeveloper from './local-ai/LocalAiDeveloper.vue'
import AgentSkillManager from './local-ai/AgentSkillManager.vue'
import ExperienceLibraryCard from './local-ai/ExperienceLibraryCard.vue'
import AbilityModuleManager from './local-ai/AbilityModuleManager.vue'
import AgentCoreMcpManager from './local-ai/AgentCoreMcpManager.vue'
import ModelReadme from './local-ai/ModelReadme.vue'
import {useModelIcons} from './local-ai/useModelIcons'
import {useLocalAiStudio} from './local-ai/useLocalAiStudio'
import {useStudioLayout} from './local-ai/useStudioLayout'
import {LOCAL_AI_MAX_OUTPUT_TOKENS} from '../electron/shared/local-ai'
import ApplicationLogOutput from './local-ai/ApplicationLogOutput.vue'
import {applicationLogRequested} from './local-ai/service-error-dialog'
const props=defineProps<{standalone?:boolean; initialTab?: 'chat' | 'workflow' | 'automation' | 'monitor' | 'abilities' | 'experience' | 'skills' | 'mcp' | 'discover' | 'models' | 'server' | 'settings'}>()
const studio=useLocalAiStudio()
const {modelsBusy,tab,ready,error,busy,drawer,parameters,data,settings,apiKey,hfToken,connection,connecting,remoteProfiles,input,model,systemPrompt,query,format,sort,searching,results,selected,filesBusy,fileFilter,ggufOnly,modelFilter,showMissing,enqueueBusy,sending,anySending,downloads,runtime,hardware,activeDownloads,totalSize,localModels,isVisionProjector,localModelKind,localModelState,canStartLocalModel,serverModels,workflowModels,statusText,online,bytes,count,percent,downloadLabel,fit,refreshModels,saveSettings,saveRemoteProfile,useRemoteProfile,deleteRemoteProfile,clearKey,connect,switchSource,selectRemoteApiFormat,usePreset,search,selectRepo,enqueue,downloadAction,importModels,removeModel,startModel,stopModel,chooseDirectory,copy,reveal,openLink,catalogSource,catalogUpdatedAt,catalogError,catalogLabel,details,detailsError,readme,readmeBusy,readmeError,loadReadme,selectedFileName,downloadChoices,selectedDownload,selectedDownloadState,downloadSize,downloadParts,modelFormats,parameterLabel,dateLabel}=studio
const appearance=computed(()=>normalizeAppearance(settings.appearance))
const performanceDetached=ref(false)
const inspectorDetached=ref(false),inspectorLastRequests=new Map<string,string>()
let disposeInspectorState:(()=>void)|undefined,contextTimer:ReturnType<typeof setTimeout>|undefined
async function publishInspector(){const sessionId=studio.session.value?.id,message=studio.pending.value||studio.session.value?.messages.filter(item=>item.role==='assistant').at(-1);await window.myplane.inspectorContext({requestId:studio.requestId.value,historyRequestId:sessionId?inspectorLastRequests.get(sessionId)||'':'',sessionId,content:(message?.content||'').slice(-800000),reasoning:(message?.reasoning||'').slice(-800000),theme:settings.theme})}
async function openInspector(){try{await publishInspector();inspectorDetached.value=await window.myplane.inspectorWindow('open')}catch(cause){error.value=`打开执行检查器失败：${String(cause)}`}}
async function openRuntimeGraph(){try{await window.myplane.runtimeGraphWindow('open',studio.session.value?.id)}catch(cause){error.value=`打开 3D 运行视图失败：${String(cause)}`}}
watch(()=>[studio.session.value?.id,studio.requestId.value] as const,([sessionId,requestId])=>{if(sessionId&&requestId)inspectorLastRequests.set(sessionId,requestId)})
watch(()=>[studio.requestId.value,studio.session.value?.id,studio.pending.value?.content,studio.pending.value?.reasoning,studio.session.value?.messages.at(-1)?.content,settings.theme],()=>{if(!contextTimer)contextTimer=setTimeout(()=>{contextTimer=undefined;void publishInspector().catch(()=>{})},100)})
watch(()=>[ready.value,settings.showExecutionInspector],async([loaded,enabled])=>{if(!loaded)return;if(enabled)await openInspector();else if(inspectorDetached.value){const open=await window.myplane.inspectorWindow('close').catch(()=>false);if(open)settings.showExecutionInspector=true}})
let disposePerformanceState:(()=>void)|undefined
async function detachPerformance(){try{performanceDetached.value=await window.myplane.performanceWindow('open')}catch(cause){error.value=`打开性能窗口失败：${String(cause)}`}}
onMounted(()=>{
 if (props.initialTab) tab.value = props.initialTab
 disposePerformanceState=window.myplane.onPerformanceWindowState(open=>{performanceDetached.value=open})
 void window.myplane.performanceWindow('state').then(open=>{performanceDetached.value=open}).catch(()=>{})
 disposeInspectorState=window.myplane.onInspectorWindowState(open=>{inspectorDetached.value=open})
 void window.myplane.inspectorWindow('state').then(open=>{inspectorDetached.value=open}).catch(()=>{})
})
onBeforeUnmount(()=>{disposePerformanceState?.();disposeInspectorState?.();clearTimeout(contextTimer)})
watch(()=>[ready.value,settings.showTokenSpeed],([loaded,enabled])=>{if(!loaded)return;if(enabled)void detachPerformance();else if(performanceDetached.value)void window.myplane.performanceWindow('close').catch(cause=>{error.value=String(cause)})})
const appearanceStyle=computed(()=>appearanceVariables(appearance.value))
const backgroundStyle=computed(()=>validBackgroundImage(settings.backgroundImage)?{'--app-background':`url("${backgroundImageUrl(settings.backgroundImage)}")`,'--app-background-opacity':backgroundOpacity(settings.backgroundOpacity)}:{})
const {studioRoot,narrow,compact,floatingInspector,detailsOpen,resizing,layoutStyle,layoutKey}=useStudioLayout(parameters,tab,drawer)
const {modelIcons,iconFailed}=useModelIcons(computed(()=>ready.value&&tab.value==='discover'?results.value.map(item=>item.author):[]))
const agentSkillManager=ref<InstanceType<typeof AgentSkillManager>|null>(null)
const workflowDesigner=ref<InstanceType<typeof WorkflowDesigner>|null>(null)
const automationTasks=ref<InstanceType<typeof AutomationTasks>|null>(null)
const logOutputOpen=ref(false)
const moreOpen=ref(false)
const moreWrap=ref<HTMLElement|null>(null)
const moreTrigger=ref<HTMLButtonElement|null>(null)
let disposeLogToggle:(()=>void)|undefined,disposeLogRequest:(()=>void)|undefined
function closeMoreOnOutside(event:PointerEvent){if(!moreWrap.value?.contains(event.target as Node))moreOpen.value=false}
onMounted(()=>{disposeLogToggle=window.myplane.onApplicationLogToggle(()=>{logOutputOpen.value=!logOutputOpen.value});disposeLogRequest=applicationLogRequested(()=>{logOutputOpen.value=true});document.addEventListener('pointerdown',closeMoreOnOutside)})
onBeforeUnmount(()=>{disposeLogToggle?.();disposeLogRequest?.();document.removeEventListener('pointerdown',closeMoreOnOutside)})
const navigation=[{id:'chat',label:'会话',icon:ChatDotRound},{id:'workflow',label:'工作流',icon:Share},{id:'automation',label:'定时任务',icon:AlarmClock},{id:'abilities',label:'能力模块',icon:Cpu},{id:'monitor',label:'运行监控',icon:DataLine},{id:'experience',label:'知识库',icon:Document},{id:'skills',label:'插件',icon:Operation},{id:'mcp',label:'MCP 服务',icon:Connection},{id:'discover',label:'发现模型',icon:Search},{id:'models',label:'我的模型',icon:FolderOpened},{id:'server',label:'模型服务',icon:VideoPlay},{id:'settings',label:'应用设置',icon:Setting}] as const
const visibleNavigation=navigation.slice(0,4)
const moreNavigation=navigation.slice(4)
const moreActive=computed(()=>moreNavigation.some(item=>item.id===tab.value))
const settingsMode=computed(()=>tab.value!=='chat')
watch(tab,()=>{moreOpen.value=false})
async function focusActiveNavigation(){await nextTick();if(moreActive.value)moreTrigger.value?.focus();else studioRoot.value?.querySelector<HTMLButtonElement>('.settings-feature-list [aria-current="page"]')?.focus()}
async function toggleMoreMenu(){moreOpen.value=!moreOpen.value;if(moreOpen.value){await nextTick();const item=moreWrap.value?.querySelector<HTMLButtonElement>('.settings-more-menu [aria-current="page"]')||moreWrap.value?.querySelector<HTMLButtonElement>('.settings-more-menu button');item?.focus()}}
function closeMoreMenu(){moreOpen.value=false;moreTrigger.value?.focus()}
function onNavigationEscape(event:KeyboardEvent){if(!moreOpen.value)return;event.preventDefault();event.stopPropagation();closeMoreMenu()}
function onMoreMenuKeydown(event:KeyboardEvent){
 if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
 const items=Array.from(moreWrap.value?.querySelectorAll<HTMLButtonElement>('.settings-more-menu button')||[])
 if(!items.length)return
 event.preventDefault()
 const current=items.indexOf(document.activeElement as HTMLButtonElement)
 const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(current+1)%items.length:(current-1+items.length)%items.length
 items[next]?.focus()
}
async function openModelSettings(){tab.value='server';await focusActiveNavigation()}
function openWorkspaceMenu(){selectNavigation('workflow')}
function selectNavigation(id:typeof tab.value){if(id==='chat'){drawer.value=false;logOutputOpen.value=false}tab.value=id;moreOpen.value=false}
function returnToChat(){selectNavigation('chat')}

const pageTitle=computed(()=>navigation.find(item=>item.id===tab.value)?.label||'本地 AI')
const memoryPercent=computed(()=>hardware.value?Math.round((1-hardware.value.freeMemory/hardware.value.totalMemory)*100):0)
const profileName=ref(''),profileId=ref(''),profileNameEdited=ref(false)
const suggestedProfileName=computed(()=>{
 let provider=settings.apiFormat==='anthropic'?'Anthropic':'OpenAI'
 if(isDeepSeek(settings.endpoint))provider='DeepSeek'
 else try{const url=new URL(settings.endpoint),host=url.hostname.replace(/^(api|www)\./i,'');provider=url.hostname==='127.0.0.1'||url.hostname==='localhost'?url.port==='1234'?'LM Studio':url.port==='11434'?'Ollama':url.port==='8080'?'llama.cpp':'本地兼容 API':host||provider}catch{}
 return `${provider}${settings.model.trim()?` · ${settings.model.trim()}`:''}`.slice(0,80)
})
const activeRemoteProfile=computed(()=>remoteProfiles.value.find(profile=>profile.apiFormat===settings.apiFormat&&profile.endpoint===settings.endpoint&&profile.model===settings.model))
const remoteContextLength=ref(settings.contextLength)
watch(()=>[settings.source,settings.endpoint,settings.apiFormat,settings.contextLength,activeRemoteProfile.value?.contextLength],()=>{
 remoteContextLength.value=settings.source==='external'?settings.contextLength:activeRemoteProfile.value?.contextLength??(isDeepSeek(settings.endpoint)?DEEPSEEK_CONTEXT_TOKENS:4096)
},{immediate:true})
watch(suggestedProfileName,name=>{if(!profileId.value&&!profileNameEdited.value)profileName.value=name},{immediate:true})
watch(activeRemoteProfile,profile=>{if(profile&&!profileId.value){profileId.value=profile.id;profileName.value=profile.name;profileNameEdited.value=true}},{immediate:true})
const serviceMode=ref<'local'|'remote'>('remote')
watch(()=>settings.source,source=>{serviceMode.value=source==='managed'?'local':'remote'},{immediate:true})
function selectServiceMode(value:'local'|'remote'){serviceMode.value=value}
const selectedServiceOnline=computed(()=>serviceMode.value==='local'?runtime.value?.state==='running':settings.source==='external'&&connection.value?.ok===true)
const viewedServiceActive=computed(()=>serviceMode.value==='local'?settings.source==='managed':settings.source==='external')
const canActivateViewedService=computed(()=>serviceMode.value==='remote'||runtime.value?.state==='running')
const viewedServiceState=computed(()=>!viewedServiceActive.value?(serviceMode.value==='local'&&runtime.value?.state!=='running'?'需要先启动本地模型':'当前未使用'):serviceMode.value==='local'&&runtime.value?.state!=='running'?'当前已选用 · 服务未启动':serviceMode.value==='remote'&&!connection.value?.ok?'当前已选用 · 尚未连接':'当前正在使用')
async function activateViewedService(){if(viewedServiceActive.value)return;if(serviceMode.value==='local')await switchSource('managed');else await saveRemoteConnection()}
async function saveRemoteConnection(){await saveProfile(true)}
const profileLabel=(profile:{name:string;endpoint:string})=>profile.name||new URL(profile.endpoint).host
function newProfile(){profileId.value='';profileNameEdited.value=false;profileName.value=suggestedProfileName.value}
async function deleteProfile(){if(!profileId.value)return;await deleteRemoteProfile(profileId.value);newProfile()}
async function selectRemoteProfile(event:Event){const id=(event.target as HTMLSelectElement).value,profile=remoteProfiles.value.find(item=>item.id===id);if(!profile)return;profileId.value=profile.id;profileName.value=profile.name;profileNameEdited.value=true;await useRemoteProfile(id)}
async function saveProfile(activate=false){
 const name=profileName.value.trim()||suggestedProfileName.value
 const editingId=profileId.value
 if(!await saveRemoteProfile({...(editingId?{id:editingId}:{}),name,apiFormat:settings.apiFormat,endpoint:settings.endpoint,model:settings.model,contextLength:remoteContextLength.value,...(apiKey.value?{apiKey:apiKey.value}:{})},false))return
 const saved=remoteProfiles.value.find(item=>item.id===editingId)||remoteProfiles.value.find(item=>item.name===name&&item.apiFormat===settings.apiFormat&&item.endpoint===settings.endpoint&&item.model===settings.model)
 if(saved){profileId.value=saved.id;profileName.value=saved.name;profileNameEdited.value=true}
 if(activate){if(settings.source==='external')await connect();else await switchSource('external')}
}

const libraryView=ref<'all'|'models'|'components'>('all')
const libraryFiles=computed(()=>localModels.value.filter(item=>libraryView.value==='all'||(modelFileRole(item.file)==='model'?libraryView.value==='models':libraryView.value==='components')))
const storedModels=computed(()=>(data.value?.models||[]).filter(item=>item.exists&&modelFileRole(item.file)==='model'))
function openLocalService(){selectServiceMode('local');tab.value='server'}
async function loadLocalModel(item:StudioLocalModel){selectServiceMode('local');await startModel(item)}
function showDownloadedModel(){modelFilter.value=selected.value?.id||'';showMissing.value=false;libraryView.value='all';tab.value='models'}
async function downloadSelection(){
 if(!selectedDownload.value)return
 if(selectedDownloadState.value==='local'){showDownloadedModel();return}
 if(selectedDownloadState.value!=='download'){drawer.value=true;return}
 await enqueue(selectedDownload.value)
}
const downloadActionLabel=computed(()=>({local:'已下载 · 查看模型',active:'查看下载进度',paused:'已暂停 · 继续下载',failed:'下载失败 · 重试',download:'下载所选版本'}[selectedDownloadState.value]))
function versionLabel(file:StudioModelFile){return modelFileRole(file.file)==='projector'?'视觉组件':file.quantization||file.format}

function fillRemotePreset(event:Event){
 const select=event.target as HTMLSelectElement
 const value=select.value
 if(value==='deepseek'||value==='lmstudio'||value==='ollama'||value==='llamacpp')void usePreset(value)
 select.value=''
}
</script>

<template>
 <section ref="studioRoot" class="local-ai-studio" :class="{standalone,'custom-font-size':appearance.fontSize!==14,'reduce-motion':appearance.reduceMotion,'has-background':validBackgroundImage(settings.backgroundImage),'settings-view':settingsMode,'chat-view':!settingsMode,'narrow-layout':narrow,'compact-layout':compact,'floating-inspector':floatingInspector,'is-resizing':resizing}" :style="[layoutStyle,backgroundStyle,appearanceStyle]" :data-theme="settings.theme" :data-style="settings.appearanceStyle" @keydown="layoutKey">
  <aside v-if="settingsMode" class="settings-navigation" aria-label="主菜单">
   <nav class="settings-feature-list" aria-label="主菜单" @keydown.esc="onNavigationEscape">
    <button v-for="item in visibleNavigation" :key="item.id" type="button" class="settings-rail-button" :class="{active:tab===item.id}" :title="item.label" :aria-label="item.label" :aria-current="tab===item.id?'page':undefined" @click="selectNavigation(item.id)"><component :is="item.icon"/></button>
    <div ref="moreWrap" class="settings-more">
     <button ref="moreTrigger" type="button" class="settings-rail-button settings-more-trigger" :class="{active:moreActive}" title="更多菜单" aria-label="更多菜单" aria-haspopup="menu" aria-controls="settings-more-menu" :aria-expanded="moreOpen" @click="toggleMoreMenu">···</button>
     <div v-if="moreOpen" id="settings-more-menu" class="settings-more-menu" role="menu" aria-label="更多菜单" @keydown="onMoreMenuKeydown">
      <button v-for="item in moreNavigation" :key="item.id" type="button" role="menuitem" :class="{active:tab===item.id}" :aria-current="tab===item.id?'page':undefined" @click="selectNavigation(item.id)"><component :is="item.icon"/><span>{{item.label}}</span></button>
     </div>
    </div>
   </nav>
  </aside>
  <div class="studio-main">
   <header v-if="settingsMode" class="studio-topbar"><button type="button" class="topbar-return-chat" title="返回 AI 会话" @click="returnToChat"><ChatDotRound/><span>返回 AI 会话</span></button><div class="brand"><strong>{{pageTitle}}</strong></div><button v-if="tab==='workflow'" class="studio-topbar-create" type="button" title="新建工作流" aria-label="新建工作流" @click="workflowDesigner?.create()"><Plus/></button><button v-if="tab==='automation'" class="studio-topbar-create" type="button" title="新建定时任务" aria-label="新建定时任务" @click="automationTasks?.create()"><Plus/></button><button v-if="tab==='skills'" class="studio-topbar-create" type="button" title="新建插件" aria-label="新建插件" @click="agentSkillManager?.create()"><Plus/></button><button class="connection-indicator" :class="{online}" @click="tab='server'"><i></i>{{statusText}}<ArrowRight/></button><button v-if="settings.showTokenSpeed" type="button" class="studio-topbar-create" title="显示性能窗口" aria-label="显示性能窗口" @click="detachPerformance"><DataLine/></button><button v-if="settings.showExecutionInspector" type="button" class="studio-topbar-create" title="显示执行检查器" aria-label="显示执行检查器" @click="openInspector"><Operation/></button><span class="privacy-label">{{settings.source==='managed'?'本机托管 · 数据留在本机':'外部 API · 请求发送至 API'}}</span></header>
   <div v-if="error" class="error-banner" role="alert"><span>{{error}}</span><button @click="error=''">关闭</button></div>
   <ChatWorkbench v-if="ready" v-show="!settingsMode" :studio="studio" :show-performance-launcher="!!settings.showTokenSpeed" :show-inspector-launcher="!!settings.showExecutionInspector" @models="openModelSettings" @menu="openWorkspaceMenu" @performance="detachPerformance" @inspector="openInspector" @runtime-graph="openRuntimeGraph"/>
   <div v-if="!ready" class="initial-loading"><div class="loading-orbit"></div><h3>{{error?'工作区暂时无法载入':'正在准备本地工作区'}}</h3><p>{{error?'请检查上方错误提示，修复后重新打开此窗口。':'读取本地模型、配置和会话记录'}}</p></div>

   <WorkflowDesigner ref="workflowDesigner" v-else-if="tab==='workflow'" :model="model" :models="workflowModels" :theme="settings.theme" :appearance-style="settings.appearanceStyle"/>
   <AutomationTasks ref="automationTasks" v-else-if="tab==='automation'" :model="model" :models="workflowModels"/>
   <NodeMonitorPanel v-else-if="tab==='monitor'"/>
   <ExperienceLibraryCard v-else-if="tab==='experience'"/>
   <AgentCoreMcpManager v-else-if="tab==='mcp'"/>

   <main v-else-if="tab==='discover'" class="discover-workspace catalog-workspace" :class="{'has-details':!!selected,'details-open':detailsOpen}">
    <button v-if="narrow&&detailsOpen&&selected" class="panel-backdrop" aria-label="关闭模型详情" @click="detailsOpen=false"></button>
    <section class="discovery-browser">
     <div class="discovery-controls">
      <header class="catalog-intro"><span class="eyebrow">MODEL DISCOVERY</span><h1>发现模型</h1><p class="model-page-hint">选择版本并下载，完成后在“我的模型”启动。</p></header>
      <form class="discovery-search" @submit.prevent="search()"><Search/><input v-model="query" placeholder="在 Hugging Face 上搜索模型…" aria-label="搜索 Hugging Face 模型"/><button type="submit" class="icon-btn" :disabled="searching" aria-label="搜索模型"><ArrowRight/></button></form>
      <div class="catalog-quick-filters"><button :class="{active:!query}" @click="search('')">全部</button><button v-for="family in ['Qwen','Llama','DeepSeek','Gemma']" :key="family" :class="{active:query===family}" @click="search(family)">{{family}}</button></div>
      <div class="discovery-filters"><div class="segmented"><button :class="{active:format==='gguf'}" @click="format='gguf'">GGUF</button><button :class="{active:format==='all'}" @click="format='all'">所有格式</button></div><select v-model="sort" aria-label="模型排序"><option value="downloads">热门下载</option><option value="likes">最多喜欢</option><option value="lastModified">最近更新</option></select></div>
     </div>
     <div class="catalog-caption"><strong>{{catalogSource==='builtin'?'精选模型':query?'搜索结果':'热门模型'}} <span>{{results.length}}</span></strong><button class="icon-btn" :class="{spinning:searching}" :disabled="searching" aria-label="刷新模型目录" title="刷新模型目录" @click="search()"><Refresh/></button></div>
     <div class="catalog-source" aria-live="polite"><i :class="{live:catalogSource==='live'}"></i><span>{{searching?'正在更新，仍可浏览当前列表':catalogLabel}}{{!searching&&catalogUpdatedAt?' · '+dateLabel(catalogUpdatedAt):''}}</span></div>
     <div v-if="catalogError" class="catalog-warning" role="status"><p>{{catalogError}}</p><button class="text-button" :disabled="searching" @click="search()">重新连接</button><button class="text-button" @click="tab='settings'">下载源与访问设置</button></div>
     <div class="discovery-results" :aria-busy="searching">
      <div v-if="searching&&!results.length" class="search-skeleton"><div v-for="n in 5" :key="n"></div></div>
      <div v-else-if="!results.length" class="empty-panel"><Search/><h3>{{catalogError?'暂时无法取得搜索结果':'没有匹配的模型'}}</h3><p>{{catalogError?'连接恢复后重试，或先浏览内置精选模型。':'试试模型名称或作者，或切换到所有格式。'}}</p><button class="text-button" @click="search('')">浏览模型目录 <ArrowRight/></button></div>
      <div class="model-results"><button v-for="item in results" :key="item.id" class="discovery-card" :class="{selected:selected?.id===item.id}" :aria-pressed="selected?.id===item.id" @click="detailsOpen=true;selectRepo(item)">
       <div class="result-avatar" :class="{'avatar-qwen':item.author==='Qwen','avatar-community':item.author!=='Qwen','has-icon':!!modelIcons[item.author]}"><img v-if="modelIcons[item.author]" :src="modelIcons[item.author]" :alt="item.author+' 图标'" loading="lazy" decoding="async" @error="iconFailed(item.author)"/><span v-else>{{item.id.split('/').at(-1)?.slice(0,1).toUpperCase()}}</span></div>
       <div class="result-detail"><div class="catalog-model-title"><strong :title="item.id">{{item.id.split('/').at(-1)?.replace(/-GGUF$/i,'')}}</strong><span v-if="item.tags.includes('gguf')" class="catalog-format">GGUF</span></div><p class="catalog-description" :title="item.description">{{item.description}}</p><div class="result-meta"><span class="catalog-author" :title="item.author">{{item.author}}</span><template v-if="item.metricsKnown"><span><Download/>{{count(item.downloads)}}</span><span>{{count(item.likes)}} 喜欢</span></template><span v-else>精选</span><span v-if="item.parameterCount" class="catalog-params">{{parameterLabel(item.parameterCount)}}</span></div></div>
      </button></div>
     </div>
     <div class="catalog-library-footer"><Cpu/><span v-if="hardware">本机 {{bytes(hardware.totalMemory)}} 内存<small>当前可用 {{bytes(hardware.freeMemory)}} · 运行需求随上下文变化</small></span><span v-else>下载模型，留在本机</span></div>
    </section>
    <aside v-show="!narrow||selected&&detailsOpen" id="studio-details" class="model-details" :role="narrow?'dialog':undefined" :aria-modal="narrow?true:undefined" aria-label="模型详情">
     <template v-if="selected">
      <div class="detail-heading"><button v-if="narrow" class="text-button details-back" aria-label="返回搜索结果" @click="detailsOpen=false"><ArrowRight/>返回结果</button><span class="catalog-repo-heading" :title="selected.id">{{selected.id}}</span><button class="icon-btn" title="复制仓库名称" aria-label="复制仓库名称" @click="copy(selected.id)"><CopyDocument/></button><button class="icon-btn" title="在 Hugging Face 查看" aria-label="在 Hugging Face 查看" @click="openLink('https://huggingface.co/'+selected.id)"><ArrowRight/></button></div>
      <div class="catalog-detail-body">
       <div class="catalog-detail-stats"><span><Download/>{{selected.metricsKnown?count(selected.downloads):'待联网'}} 下载</span><span>{{selected.metricsKnown?count(selected.likes):'待联网'}} 喜欢</span><small>更新于 {{dateLabel(selected.lastModified)}}</small></div>
       <section class="catalog-model-summary"><div class="catalog-publisher">{{selected.author}} <span>{{selected.metricsKnown?'Hugging Face 仓库':'内置精选 · 非实时统计'}}</span></div><h2>{{selected.id.split('/').at(-1)?.replace(/-GGUF$/i,'')}}</h2><p>{{selected.description}}</p><dl class="catalog-specs"><div><dt>参数量</dt><dd>{{parameterLabel(selected.parameterCount)}}</dd></div><div><dt>架构</dt><dd>{{selected.architecture||'未公开'}}</dd></div><div><dt>格式</dt><dd><span v-for="kind in modelFormats.length?modelFormats:selected.tags.includes('gguf')?['GGUF']:[]" :key="kind" class="format-chip">{{kind}}</span><span v-if="!modelFormats.length&&!selected.tags.includes('gguf')">待读取</span></dd></div><div v-if="details?.contextLength"><dt>上下文</dt><dd>{{details.contextLength.toLocaleString()}} tokens</dd></div><div v-if="selected.license"><dt>许可</dt><dd>{{selected.license}}</dd></div></dl><div v-if="selected.capabilities.length" class="catalog-capabilities"><span>能力标签</span><b v-for="capability in selected.capabilities" :key="capability">{{capability}}</b></div></section>
       <section class="catalog-download-section"><div class="detail-file-head"><h3>下载选项</h3><label><input v-model="ggufOnly" type="checkbox"/>仅 GGUF</label></div><p v-if="details?.gated" class="catalog-warning">此仓库受访问限制。请在 Hugging Face 接受许可，并在设置中填写有权限的 Token。</p>
        <div class="catalog-download-card"><label class="compact-search"><Search/><input v-model="fileFilter" placeholder="筛选量化版本或文件名" aria-label="筛选模型文件"/></label><p v-if="filesBusy" class="quiet">正在读取量化版本、大小与校验信息…</p><div v-else-if="detailsError" class="catalog-inline-error" role="status"><p>{{detailsError}}</p><button class="text-button" @click="selectRepo(selected)"><Refresh/>重试加载文件</button></div><p v-else-if="!downloadChoices.length" class="quiet">没有匹配的文件，试试清空筛选或取消“仅 GGUF”。</p>
         <template v-if="selectedDownload"><div class="catalog-quant-label">选择文件 / 量化版本 <span>{{downloadChoices.length}} 个选项 · 可滚动比较</span></div><div id="catalog-quantization" class="catalog-version-list" role="group" aria-label="选择量化版本"><button v-for="file in downloadChoices" :key="file.file" type="button" :aria-pressed="selectedDownload.file===file.file" :class="{active:selectedDownload.file===file.file}" :title="file.file" @click="selectedFileName=file.file"><span><strong>{{versionLabel(file)}}</strong><small>{{file.file}}</small></span><span>{{file.size?bytes(file.size):'大小未知'}}<small v-if="/-00001-of-/.test(file.file)">首个分片</small></span><Check v-if="selectedDownload.file===file.file"/></button></div><p class="catalog-selected-file">{{selectedDownload.file}}</p><div class="catalog-download-bottom"><div class="catalog-fit"><span class="format-chip">{{selectedDownload.quantization||selectedDownload.format}}</span><small>{{selectedDownload.format==='GGUF'?fit(downloadSize):'需要支持此格式的外部运行时'}}</small><small v-if="downloadParts.length>1">包含 {{downloadParts.length}} 个文件（含分片或配套组件），总计 {{downloadSize?bytes(downloadSize):'大小未知'}}</small><small v-if="selectedDownload.sha256">下载后校验 SHA-256</small><small v-if="settings.downloadDirectory" class="download-destination" :title="settings.downloadDirectory">保存到：{{settings.downloadDirectory}}</small></div><button class="download-file" :disabled="!!enqueueBusy" @click="downloadSelection"><Download v-if="selectedDownloadState==='download'"/><ArrowRight v-else/>{{enqueueBusy?'加入队列中':downloadActionLabel}}<strong v-if="selectedDownloadState==='download'">{{downloadSize?bytes(downloadSize):'大小未知'}}</strong></button></div></template>
        </div><p class="file-footnote">分片 GGUF 自动下载所有分片。内存提示仅按文件体积粗估，不代表显存检测或运行保证；视觉模型可能还需要配套投影文件。</p>
       </section>
       <details class="catalog-readme"><summary>模型介绍与使用说明</summary><header><h3>README</h3><button class="text-button" @click="openLink('https://huggingface.co/'+selected.id)">查看原文 <ArrowRight/></button></header><div v-if="readmeBusy" class="catalog-readme-loading"><div class="loading-orbit"></div><p>正在读取模型卡…</p></div><div v-else-if="readmeError" class="catalog-inline-error"><p>{{readmeError}}</p><button class="text-button" @click="loadReadme"><Refresh/>重试读取</button></div><div v-else-if="readme" class="catalog-readme-content"><ModelReadme :text="readme" :repo-id="selected.id" :revision="details?.revision"/></div><div v-else class="catalog-readme-empty"><Document/><p>{{filesBusy?'文件信息加载后显示模型卡。':detailsError?'联网后可查看模型作者的完整介绍。':'仓库未提供 README，可前往 Hugging Face 查看详情。'}}</p></div></details>
      </div>
     </template>
     <div v-else class="details-placeholder"><Document/><h3>选择模型，探索细节</h3><p>这里会显示模型介绍、量化版本、下载选项与 README。</p></div>
    </aside>
   </main>

   <main v-else-if="tab==='models'" class="scroll-page"><header class="page-intro with-actions"><div><span class="eyebrow">YOUR MODEL LIBRARY</span><h1>我的模型</h1><p>管理下载和导入的文件，选择主模型后启动并使用。</p></div><div class="button-row"><button class="secondary-button" :disabled="!!busy" @click="importModels"><Plus/>导入 GGUF</button><button class="primary-button" @click="tab='discover'"><Search/>发现模型</button></div></header><div class="library-stats"><article><FolderOpened/><div><strong>{{storedModels.length}}</strong><span>本机主模型</span></div></article><article><Document/><div><strong>{{bytes(totalSize)}}</strong><span>本地文件总大小</span></div></article><article><Cpu/><div><strong>{{runtime?.state==='running'?'1':'0'}}</strong><span>本机服务运行中</span></div></article></div><div class="model-flow-callout"><div><strong>{{runtime?.state==='running'?'本机模型服务已启动':settings.runtimePath?'下一步：选择主模型启动':'下一步：配置本机运行时'}}</strong><p>{{runtime?.state==='running'?(settings.source==='managed'?'当前用于对话：'+runtime.modelName:'本机服务已运行，当前对话仍使用外部 API。'):'GGUF 主模型可以在本机运行；视觉组件和后续分片会随主模型读取。'}}</p></div><button v-if="runtime?.state==='running'&&settings.source==='managed'" class="primary-button" @click="returnToChat">开始对话 <ArrowRight/></button><button class="secondary-button" @click="openLocalService">{{settings.runtimePath?'管理本机服务':'配置运行时'}}</button></div><div class="library-toolbar"><label class="compact-search"><Search/><input v-model="modelFilter" placeholder="搜索本地模型" aria-label="搜索本地模型"/></label><select v-model="libraryView" aria-label="筛选模型文件类型"><option value="all">全部文件</option><option value="models">主模型</option><option value="components">分片与视觉组件</option></select><label class="checkbox-label"><input v-model="showMissing" type="checkbox"/>显示缺失文件</label><button class="icon-btn" :disabled="modelsBusy||!ready" aria-label="刷新模型库" @click="refreshModels().catch(e=>error=String(e))"><Refresh/></button></div>
    <p v-if="modelsBusy" role="status" aria-live="polite">正在扫描已保存的模型目录，加载模型列表…</p><div v-if="!modelsBusy&&!(data?.models.length)" class="empty-panel large"><FolderOpened/><h2>给你的工作区添一个模型</h2><p>打开此页面会扫描设置中保存的下载目录。也可从 Hugging Face 下载 GGUF，或导入已有模型。<br/>导入会保留原文件位置，不会复制大型模型文件。</p><button class="primary-button" @click="tab='discover'">浏览模型</button></div><div v-else-if="!modelsBusy&&!libraryFiles.length" class="empty-panel large"><Search/><h2>没有匹配的模型文件</h2><p>试试其他名称，或重置文件类型和缺失文件筛选。</p><button class="secondary-button" @click="modelFilter='';libraryView='all';showMissing=true">清空筛选</button></div><div v-else-if="libraryFiles.length" class="library-table" :aria-busy="modelsBusy"><div class="library-table-head"><span>模型 / 文件</span><span>大小</span><span>状态</span><span>操作</span></div><article v-for="item in libraryFiles" :key="item.id" class="library-row" :class="{projector:isVisionProjector(item)}"><div class="library-model"><span class="library-icon"><Cpu/></span><div><strong :title="item.file">{{item.file}}</strong><small class="library-model-tags"><span>{{item.repoId}}</span><b :class="{vision:isVisionProjector(item)}">{{localModelKind(item)}}</b><b v-if="item.quantization">{{item.quantization}}</b></small><small class="model-path" :title="item.localPath">{{item.localPath}}</small></div></div><span class="model-size">{{bytes(item.size)}}</span><span class="state-tag" :class="{loaded:runtime?.modelId===item.id&&runtime.state==='running',missing:!item.exists,projector:isVisionProjector(item)}">{{localModelState(item)}}</span><div class="library-actions"><button v-if="runtime?.modelId===item.id&&['starting','running'].includes(runtime.state)" class="secondary-button" :disabled="!!busy||anySending" @click="stopModel">停止服务</button><button v-else class="secondary-button" :disabled="!!busy||!canStartLocalModel(item)" :title="item.format!=='GGUF'?'此格式需要支持它的外部运行时，可在模型服务连接外部 API':modelFileRole(item.file)!=='model'?'配套文件会随主模型读取，请选择主模型启动':runtime?.state==='running'?'请先停止当前本机服务，再启动其他模型':'启动本机服务并用于对话'" @click="loadLocalModel(item)"><VideoPlay/>{{item.format!=='GGUF'?'需外部运行时':modelFileRole(item.file)!=='model'?'配套文件':'启动并使用'}}</button><button class="icon-btn" aria-label="在文件夹中显示" :disabled="!item.exists" @click="reveal(item)"><FolderOpened/></button><details data-floating-menu class="model-menu"><summary title="更多操作">···</summary><div><button :disabled="!!busy||anySending" @click="removeModel(item)">移除记录，保留文件</button><button class="danger-text" :disabled="!!busy||anySending" @click="removeModel(item,true)">删除磁盘文件</button></div></details></div></article></div><div class="page-note"><span class="format-chip">GGUF</span><p>本机托管运行使用 llama.cpp。Safetensors / MLX 等格式需连接相应外部服务。分片 GGUF 请加载第一个分片；视觉组件会随同目录主模型自动使用，不能单独加载。</p></div>
   </main>

   <main v-else-if="tab==='server'" class="service-workspace">
    <header class="service-toolbar">
     <nav class="service-mode-switch" aria-label="模型服务切换">
      <button :class="{active:serviceMode==='local'}" :aria-current="serviceMode==='local'?'page':undefined" title="由应用启动本机模型" @click="selectServiceMode('local')"><Cpu/>本机托管</button>
      <button :class="{active:serviceMode==='remote'}" :aria-current="serviceMode==='remote'?'page':undefined" title="连接云端、LM Studio 或 Ollama" @click="selectServiceMode('remote')"><Connection/>外部 API</button>
     </nav>
     <div class="service-toolbar-actions">
      <span class="service-toolbar-status" :class="{online:viewedServiceActive&&selectedServiceOnline}" role="status"><i></i>{{viewedServiceState}}</span>
      <button v-if="!viewedServiceActive&&serviceMode==='local'" class="primary-button" :disabled="!canActivateViewedService||!!busy||sending||connecting" @click="activateViewedService">切换到本机托管</button>
      <button v-if="online&&viewedServiceActive" class="secondary-button" @click="returnToChat">开始对话 <ArrowRight/></button>
     </div>
    </header>
    <section class="service-workspace-content">
     <section v-if="serviceMode==='local'" class="service-local-panel"><LocalAiDeveloper service-mode="managed" :tasks-running="anySending" :settings="settings" :runtime="runtime" :models="data?.models||[]" :connection="connection" :connecting="connecting" @settings="Object.assign(settings,$event)" @runtime="data&&(data.runtime=$event)" @connect="connect()" @models-page="tab='models'" @import-models="importModels" @discover="tab='discover'" @settings-page="selectServiceMode('remote')"/></section>
    <section v-else class="service-remote-panel"><div class="service-remote-grid">
     <section class="content-card remote-connection-card">
      <fieldset :disabled="!!busy||connecting">
       <div class="remote-form-body">
        <section class="remote-profile-section">
         <div class="remote-section-title"><h2>连接配置</h2><span>{{profileId?'编辑已保存配置':'新配置 · 尚未保存'}}</span></div>
         <div class="remote-profile-choice">
          <label><span>已保存的连接</span><select :value="profileId||''" :disabled="!remoteProfiles.length" aria-label="选择已保存的外部 API" @change="selectRemoteProfile"><option value="" disabled>{{remoteProfiles.length?'选择连接配置':'暂无已保存连接'}}</option><option v-for="profile in remoteProfiles" :key="profile.id" :value="profile.id">{{profileLabel(profile)}} · {{profile.model||'未指定模型'}}</option></select></label>
         </div>
         <p class="remote-help">{{settings.source==='external'?'选择已保存连接会立即切换并测试。':'选择连接可载入配置，保存并切换后才会用于对话。'}}</p>
        </section>
        <section class="remote-details-section">
      <div class="remote-format-heading"><strong>接口格式</strong></div>
      <div class="remote-api-formats" role="radiogroup" aria-label="远程 API 格式">
       <button :class="{active:settings.apiFormat==='openai'}" :aria-checked="settings.apiFormat==='openai'" role="radio" @click="selectRemoteApiFormat('openai')"><span><strong>OpenAI 兼容</strong></span><Check/></button>
       <button :class="{active:settings.apiFormat==='anthropic'}" :aria-checked="settings.apiFormat==='anthropic'" role="radio" @click="selectRemoteApiFormat('anthropic')"><span><strong>Anthropic</strong></span><Check/></button>
      </div>
      <label v-if="settings.apiFormat==='openai'" class="remote-preset-select"><span>快捷填充</span><select aria-label="快捷填充 API 配置" @change="fillRemotePreset"><option value="">选择服务提供方…</option><option value="deepseek">DeepSeek</option><option value="lmstudio">LM Studio</option><option value="ollama">Ollama</option><option value="llamacpp">llama.cpp</option></select></label>
       <div class="remote-field-grid">
        <label class="field">配置名称<input v-model="profileName" maxlength="80" :placeholder="'自动生成：'+suggestedProfileName" @input="profileNameEdited=true"/></label>
        <label class="field">默认模型 ID<input v-model="settings.model" list="settings-models" placeholder="填写或选择服务提供的模型 ID"/><datalist id="settings-models"><option v-for="id in (settings.apiFormat==='openai'&&isDeepSeek(settings.endpoint)?deepseekModels:[])" :key="id" :value="id"></option><option v-for="item in serverModels" :key="item.id" :value="item.instanceId||item.id"></option></datalist></label>
        <label class="field remote-endpoint-field">API 服务地址<input v-model="settings.endpoint" :placeholder="settings.apiFormat==='anthropic'?'https://api.anthropic.com/v1':'https://api.example.com/v1'" type="url"/></label>
        <label class="field remote-key-field">API Key <span class="remote-optional">服务要求鉴权时填写</span><input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="settings.hasApiKey?'已安全保存，留空保留原密钥':'输入 API Key'"/></label>
       </div>
       <p class="remote-help remote-key-status"><Check/>{{settings.hasApiKey?'密钥已加密保存在本机':'密钥保存后会加密存储在本机'}}</p>
       <details class="remote-advanced"><summary>高级设置</summary><label class="field">Agent 上下文预算<input v-model.number="remoteContextLength" type="number" min="512" :max="settings.apiFormat==='openai'&&isDeepSeek(settings.endpoint)?DEEPSEEK_CONTEXT_TOKENS:131072" step="512"/></label><div class="remote-maintenance"><button v-if="profileId" type="button" class="remote-secondary-action" title="以当前内容创建一份新配置，保存后生效" @click="newProfile">复制为新配置</button><button v-if="settings.hasApiKey" type="button" class="remote-danger-action" :disabled="anySending" @click="clearKey('api')">移除已保存密钥</button><button v-if="profileId" type="button" class="remote-danger-action" :disabled="anySending" @click="deleteProfile">删除当前配置</button></div></details>
       </section>
       </div>
       <footer class="remote-connect-actions">
        <div class="remote-action-status" role="status"><span v-if="connecting">正在测试连接…</span><span v-else-if="busy==='profile-save'">正在保存配置…</span><span v-else-if="connection?.ok&&settings.source==='external'" class="remote-connected"><i></i>已连接 · {{connection.models.length}} 个模型</span><span v-else-if="anySending">运行中的任务继续使用原连接。</span><span v-else></span></div>
        <div class="remote-action-buttons"><button type="button" class="remote-secondary-action" aria-label="保存配置（不测试）" title="保存配置，不发送测试请求" @click="saveProfile()">仅保存</button><button type="button" class="primary-button remote-connect-button" @click="saveRemoteConnection"><Refresh v-if="connecting" class="remote-action-spinner"/><Connection v-else/>{{connecting?'正在测试…':busy==='profile-save'?'正在保存…':settings.source==='external'?'保存并连接':'保存并使用'}}</button></div>
       </footer>
      </fieldset>
     </section>
     </div></section>
    </section>
   </main>
   <AgentSkillManager v-else-if="tab==='skills'" ref="agentSkillManager"/>
   <AbilityModuleManager v-else-if="tab==='abilities'"/>

   <AppPreferences v-else-if="tab==='settings'" :settings="settings" v-model:hf-token="hfToken" :busy="!!busy||sending" :saving="busy==='save'" @save="saveSettings()" @directory="chooseDirectory" @clear-token="clearKey('hf')" @service="tab='server'"/>
   <ApplicationLogOutput v-if="settingsMode&&logOutputOpen" @close="logOutputOpen=false"/>
   <footer v-if="settingsMode" class="status-bar"><div><span class="status-dot" :class="{online}"></span><span>{{settings.source==='managed'?'本地 llama.cpp':'远程 API'}}</span><span class="footer-model">{{model||'未选择模型'}}</span></div><div><button :class="{active:logOutputOpen}" aria-label="切换日志输出" @click="logOutputOpen=!logOutputOpen">日志</button><span v-if="hardware">RAM {{bytes(hardware.totalMemory-hardware.freeMemory)}} / {{bytes(hardware.totalMemory)}}</span><button @click="drawer=!drawer"><Download/>{{activeDownloads.length?activeDownloads.length+' 个下载任务':'下载队列'}}<span v-if="downloads.length" class="count-badge">{{downloads.length}}</span></button></div></footer>
  </div>
  <button v-if="drawer" class="download-backdrop" aria-label="关闭下载队列遮罩" @click="drawer=false"></button>
  <aside v-if="drawer" id="studio-downloads" class="downloads-drawer" role="dialog" aria-modal="true" aria-label="下载队列"><header><div><Download/><h3>下载队列</h3><span class="count-badge">{{downloads.length}}</span></div><button class="icon-btn" aria-label="关闭下载队列" @click="drawer=false"><Close/></button></header><p class="drawer-note">顺序下载 · 支持断点续传 · 下载完成后自动加入模型库</p><div class="download-items"><div v-if="!downloads.length" class="empty-panel"><Download/><h3>还没有下载任务</h3><button class="text-button" @click="tab='discover';drawer=false">去发现模型 <ArrowRight/></button></div><article v-for="item in [...downloads].reverse()" :key="item.id" class="download-item"><div class="download-item-head"><span class="format-chip">{{item.file.split('.').at(-1)?.toUpperCase()}}</span><span class="download-state" :class="item.status">{{downloadLabel(item.status)}}</span></div><strong :title="item.file">{{item.file}}</strong><small>{{item.repoId}}</small><div class="progress-track" :class="{indeterminate:item.status==='verifying'||!item.total&&item.status==='downloading'}"><span :style="{width:percent(item)+'%'}"></span></div><div class="download-progress-label"><span>{{bytes(item.received)}} / {{item.total?bytes(item.total):'未知大小'}}</span><span v-if="item.status==='downloading'">{{bytes(item.speed)}}/s · {{percent(item)}}%</span><span v-else-if="item.status==='completed'">{{item.sha256?'SHA-256 已校验':'已完成'}}</span></div><p v-if="item.error" class="download-error">{{item.error}}</p><div class="download-actions"><button v-if="['downloading','queued'].includes(item.status)" class="text-button" @click="downloadAction(item,'pause')"><VideoPause/>暂停</button><button v-if="['paused','failed'].includes(item.status)" class="text-button" @click="downloadAction(item,'resume')"><VideoPlay/>{{item.status==='failed'?'重试':'继续'}}</button><button v-if="!['completed','cancelled'].includes(item.status)" class="text-button" @click="downloadAction(item,'cancel')"><Close/>取消</button><button v-if="['completed','cancelled','failed'].includes(item.status)" class="text-button" @click="downloadAction(item,'remove')">清除记录</button><button v-if="item.status==='completed'" class="text-button" @click="tab='models';drawer=false">查看模型 <ArrowRight/></button></div></article></div></aside>
 </section>
</template>

<style scoped src="./local-ai/studio-layout.css"></style>
<style scoped src="./local-ai/studio-discovery.css"></style>
<style scoped src="./local-ai/model-pages.css"></style>

<style scoped src="./local-ai/studio-workbench.css"></style>

<style scoped>
.settings-navigation{position:relative;z-index:30;width:var(--s-rail-width);flex:none;display:flex;flex-direction:column;padding:14px 6px;background:var(--s-rail);border-right:1px solid var(--s-border);min-height:0}
.settings-feature-list{display:flex;flex-direction:column;align-items:center;gap:5px;min-height:0}
.settings-rail-button{position:relative;display:grid;place-items:center;width:42px;height:42px;flex:none;border:0;background:transparent;border-radius:9px;padding:0;color:var(--s-dim);cursor:pointer}
.settings-feature-list>.settings-rail-button:first-child{margin-bottom:12px}
.settings-feature-list>.settings-rail-button:first-child::after{content:'';position:absolute;bottom:-9px;left:7px;width:28px;height:1px;background:var(--s-border)}
.settings-rail-button:hover{background:var(--s-muted);color:var(--s-text)}
.settings-rail-button.active{background:var(--s-accent-soft);color:var(--s-text)}
.settings-rail-button:focus-visible,.settings-more-menu button:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.settings-rail-button svg{width:20px;height:20px}
.settings-more{position:relative;flex:none}
.settings-more-trigger{font-size:23px;line-height:1;letter-spacing:-2px;padding-right:3px;padding-bottom:10px}
.settings-more-menu{position:absolute;top:0;left:calc(100% + 10px);width:176px;max-height:calc(100vh - 230px);min-height:100px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:7px;background:var(--s-panel);border:1px solid var(--s-border);border-radius:10px;box-shadow:var(--s-shadow,0 12px 36px #0002)}
.settings-more-menu button{display:flex;align-items:center;gap:11px;flex:none;width:100%;min-height:38px;padding:7px 10px;border:0;border-radius:7px;background:transparent;color:var(--s-text);font-size:13px;text-align:left;white-space:nowrap;cursor:pointer}
.settings-more-menu button:hover,.settings-more-menu button.active{background:var(--s-accent-soft)}
.settings-more-menu svg{width:17px;height:17px;color:var(--s-dim)}
.chat-view>.studio-main{padding-bottom:0}
.settings-view .studio-topbar{display:flex}
.topbar-return-chat{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-accent-soft);color:var(--s-accent);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s ease;margin-right:12px;flex:none}
.topbar-return-chat:hover{background:color-mix(in srgb,var(--s-accent) 20%,var(--s-panel));border-color:var(--s-accent)}
.topbar-return-chat svg{width:15px;height:15px}
@media(max-width:900px){.settings-view .privacy-label{display:none}.settings-view .studio-topbar{padding:0 14px;gap:10px}}
</style>

<style scoped>
.local-ai-studio.has-background::before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:var(--app-background);background-size:cover;background-position:center;opacity:var(--app-background-opacity,.15)}
.local-ai-studio.has-background :deep(.studio-main),.local-ai-studio.has-background :deep(.agent-workspace),.local-ai-studio.has-background :deep(.agent-main),.local-ai-studio.has-background :deep(.service-workspace),.local-ai-studio.has-background :deep(.scroll-page){background:transparent}
.local-ai-studio.has-background :deep(.settings-navigation),.local-ai-studio.has-background :deep(.agent-history){background:color-mix(in srgb,var(--s-rail) 80%,transparent)}
.local-ai-studio.has-background :deep(.content-card),.local-ai-studio.has-background :deep(.studio-topbar),.local-ai-studio.has-background :deep(.service-toolbar),.local-ai-studio.has-background :deep(.dev-main-model){background:color-mix(in srgb,var(--s-panel) 88%,transparent)}
.local-ai-studio.has-background :deep(.agent-main>.agent-composer-wrap){background:transparent}
.local-ai-studio.has-background :deep(.agent-prompt.composer){background:color-mix(in srgb,var(--s-panel) 68%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-color:color-mix(in srgb,var(--s-border) 75%,transparent);box-shadow:0 4px 20px #00000008}
.local-ai-studio.has-background :deep(.agent-prompt.composer:focus-within){border-color:var(--s-dim);box-shadow:0 0 0 1px var(--s-border),0 4px 20px #00000008}
.local-ai-studio.has-background :deep(.agent-composer-wrap>.context-usage){padding-inline:8px;text-shadow:0 1px 4px var(--s-bg)}
</style>

<style scoped>
.local-ai-studio.custom-font-size :deep(:is(button,input,textarea,select,p,li,dt,dd,label)){font-size:var(--app-font-size)}
.local-ai-studio.reduce-motion :deep(*),.local-ai-studio.reduce-motion::before,.local-ai-studio.reduce-motion :deep(*::before),.local-ai-studio.reduce-motion :deep(*::after){animation:none!important;transition:none!important;scroll-behavior:auto!important}
@media(prefers-reduced-motion:reduce){.local-ai-studio :deep(*),.local-ai-studio::before,.local-ai-studio :deep(*::before),.local-ai-studio :deep(*::after){animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
