<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue'
import {ElMessage} from 'element-plus'
import {AppMessageBox as ElMessageBox} from './message-box'
import {Connection,Document,Setting,Cpu,Refresh,Download,FolderOpened,CopyDocument,VideoPlay,VideoPause,Delete,ArrowRight,Plus,Close} from '@element-plus/icons-vue'
import type {StudioCommands,StudioConnection,StudioLocalModel,StudioRuntime,StudioSettings} from '../../electron/shared/local-ai-studio'
import {developerProtocols,developerRoutes,type DeveloperProtocol,type DeveloperPreferences,type DeveloperResponse,type DeveloperRoute,type DeveloperState,type RuntimeCandidate,type RuntimePackage} from '../../electron/shared/local-ai-developer'
import {LOCAL_AI_MAX_OUTPUT_TOKENS} from '../../electron/shared/local-ai'

import {modelFileRole} from '../../electron/shared/model-library'
import {developerExample} from './developer-api-examples'
import {serviceErrorText,showServiceStartError} from './service-error-dialog'

const props=defineProps<{settings:StudioSettings;runtime?:StudioRuntime;models:StudioLocalModel[];connection?:StudioConnection;connecting:boolean;tasksRunning?:boolean;serviceMode?:'managed'|'external'}>()
const emit=defineEmits<{settings:[Partial<StudioSettings>];runtime:[StudioRuntime];connect:[];importModels:[];discover:[];settingsPage:[];modelsPage:[]}>()
const api=<K extends keyof StudioCommands>(action:K,payload?:StudioCommands[K]['input'])=>window.myplane.localAiStudio(action,payload)
const inspectorOpen=ref(false)
const page=ref<'server'|'docs'|'runtime'|'config'>('server'),inspectorTab=ref<'info'|'load'|'inference'>('info'),state=ref<DeveloperState>(),error=ref(''),busy=ref('')
const candidates=ref<RuntimeCandidate[]>([]),packages=ref<RuntimePackage[]>([]),selectedId=ref(''),externalId=ref(''),secret=ref(''),clearSecret=ref(false)
const preferences=reactive<DeveloperPreferences>({host:'127.0.0.1',parallel:1,embedding:false,metrics:true,hasApiKey:false})
const load=reactive({runtimePort:props.settings.runtimePort,contextLength:props.settings.managedContextLength??props.settings.contextLength,gpuLayers:props.settings.gpuLayers,threads:props.settings.threads,temperature:props.settings.temperature,topP:props.settings.topP,maxTokens:props.settings.maxTokens,repeatPenalty:props.settings.repeatPenalty})
const protocol=ref<DeveloperProtocol>('lmstudio'),downloadJobId=ref('')
const route=ref<DeveloperRoute>('lmModels'),requestBody=ref(''),response=ref<DeveloperResponse>(),requestBusy=ref(false),exampleLanguage=ref<'curl'|'python'|'javascript'|'powershell'>('powershell')
const logFilter=ref(''),logLevel=ref('all'),followLogs=ref(true),logPanel=ref<HTMLElement>()
let timer:ReturnType<typeof setTimeout>|undefined,disposed=false,initialized=false,shownRuntimeError=props.runtime?.error||''
const managed=computed(()=>props.serviceMode?props.serviceMode==='managed':props.settings.source==='managed')
const active=computed(()=>!!props.runtime?.pid||['starting','running','stopping'].includes(props.runtime?.state||''))
const stopBlocked=computed(()=>managed.value&&active.value&&props.tasksRunning)
const serverActive=computed(()=>active.value||state.value?.serverRunning===true)
const online=computed(()=>managed.value?props.runtime?.state==='running':props.connection?.ok===true)
const statusLabel=computed(()=>!managed.value?online.value?'外部服务已连接':'外部服务未连接':state.value?.serverRunning&&!active.value?'API 运行中 · 未加载模型':({stopped:'已停止',starting:'模型加载中',running:'运行中',stopping:'正在停止',error:'运行异常'}[props.runtime?.state||'stopped']))
const apiBase=computed(()=>managed.value?props.runtime?.endpoint||`http://127.0.0.1:${props.settings.runtimePort}/v1`:props.settings.endpoint)
const serverBase=computed(()=>apiBase.value.replace(/\/v1\/?$/,''))
const localModels=computed(()=>props.models.filter(item=>item.exists&&item.format==='GGUF'&&modelFileRole(item.file)==='model'))
const selected=computed(()=>localModels.value.find(item=>item.id===selectedId.value)||props.models.find(item=>item.id===props.runtime?.modelId))
const loaded=computed(()=>props.models.find(item=>item.id===props.runtime?.modelId))
const remoteModels=computed(()=>props.connection?.models||[])
const modelIdentifier=computed(()=>managed.value?active.value?props.runtime?.modelName||'loaded-model':'loaded-model':externalId.value||remoteModels.value[0]?.instanceId||remoteModels.value[0]?.id||props.settings.model||'loaded-model')
const installation=computed(()=>state.value?.installation)
const installing=computed(()=>['downloading','extracting'].includes(installation.value?.status||''))
const installPercent=computed(()=>installation.value?.total?Math.min(100,Math.round(installation.value.received/installation.value.total*100)):0)
const endpoint=computed(()=>developerRoutes[route.value])
const requestUrl=computed(()=>{const path=endpoint.value.path.replace(':job_id',encodeURIComponent(downloadJobId.value||':job_id'));return path.startsWith('/v1/')?apiBase.value.replace(/\/$/,'')+path.slice(3):serverBase.value+path})
const logLines=computed(()=>[...(props.runtime?.logs||[]),...(state.value?.requestLogs||[])].filter(line=>(!logFilter.value||line.toLowerCase().includes(logFilter.value.toLowerCase()))&&(logLevel.value==='all'||logLevel.value==='error'&&/error|failed|失败|异常/i.test(line)||logLevel.value==='warn'&&/warn|警告/i.test(line)||logLevel.value==='api'&&line.includes('[API]'))))
const formattedResponse=computed(()=>{if(!response.value)return '';try{return JSON.stringify(JSON.parse(response.value.body),null,2)}catch{return response.value.body}})
const byteLabel=(value:number)=>value>1024**3?`${(value/1024**3).toFixed(2)} GB`:value>1024**2?`${(value/1024**2).toFixed(1)} MB`:`${Math.round(value/1024)} KB`
const nav=[{id:'server',label:'服务控制',icon:VideoPlay},{id:'docs',label:'API 文档与调试',icon:Document},{id:'runtime',label:'运行时',icon:Cpu},{id:'config',label:'服务设置',icon:Setting}] as const
const protocolKeys=Object.keys(developerProtocols) as DeveloperProtocol[]
const protocolRoutes=computed(()=>developerProtocols[protocol.value].routes)
const routeKeys=computed(()=>[...protocolRoutes.value,...(['health','properties','slots','metrics'] as DeveloperRoute[])])
function selectProtocol(value:DeveloperProtocol){if(requestBusy.value)return;protocol.value=value;route.value=developerProtocols[value].routes[0]}
async function toggleApiOnly(){const starting=!state.value?.serverRunning;if(!starting&&props.tasksRunning)return;await run('api-server',async()=>{emit('runtime',await api(starting?'startApiServer':'stopRuntime'));emit('settings',{source:'managed'});await refreshState()},starting?showServiceStartError:undefined)}
async function unloadApiModel(){if(props.tasksRunning)return;await run('unload',async()=>{emit('runtime',await api('unloadRuntime'));await refreshState()})}

function report(cause:unknown){error.value=serviceErrorText(cause)}
async function run(name:string,work:()=>Promise<void>,onError?:(cause:unknown)=>Promise<unknown>){if(busy.value)return;busy.value=name;error.value='';try{await work()}catch(cause){if(cause!=='cancel'&&cause!=='close'){if(onError){shownRuntimeError=serviceErrorText(cause);await onError(cause)}else report(cause)}}finally{busy.value=''}}
async function copy(text:string){try{await navigator.clipboard.writeText(text);ElMessage.success('已复制')}catch(cause){report(cause)}}
async function open(url:string){try{await window.myplane.openAiLink(url)}catch(cause){report(cause)}}
async function refreshState(){
 const next=await api('developerState');if(disposed)return
 const before=state.value?.installation.path;state.value=next
 if(!initialized){Object.assign(preferences,next.preferences);initialized=true}
 if(next.installation.status==='ready'&&next.installation.path&&next.installation.path!==before&&!next.installation.error)emit('settings',{runtimePath:next.installation.path})
}
async function poll(){try{await refreshState()}catch(cause){if(!disposed)report(cause)}finally{if(!disposed)timer=setTimeout(()=>void poll(),2000)}}
async function detect(){await run('detect',async()=>{candidates.value=await api('runtimeDetect');await refreshState();if(!candidates.value.length)ElMessage.info('未找到运行文件，可以直接安装下方官方运行包')})}
async function choose(file?:string){await run('choose',async()=>{const picked=file||await api('chooseRuntime');if(picked){emit('settings',await api('settings',{runtimePath:picked}));await refreshState();ElMessage.success('已配置运行时，配套动态库请保留在原目录')}})}
async function releases(){await run('releases',async()=>{packages.value=await api('runtimePackages')})}
async function install(item:RuntimePackage){await run('install',async()=>{
 await ElMessageBox.confirm(`从 ggml-org/llama.cpp 官方发布下载 ${item.name}（${byteLabel(item.size)}），解压到应用专用目录并配置。${item.sha256?'将验证官方 SHA-256。':'此资源未提供 SHA-256，仅依赖官方 HTTPS 来源。'}安装不会自动启动模型或修改系统 PATH。`,'安装 llama.cpp 运行时',{type:'info',confirmButtonText:'下载并安装',cancelButtonText:'取消'})
 await api('runtimeInstall',{id:item.id});await refreshState()
})}
async function cancelInstall(){await run('cancel-install',async()=>{await api('runtimeInstallCancel');await refreshState()})}
async function toggleServer(){
 if(!managed.value){emit('connect');return}
 if(stopBlocked.value)return
 const starting=!active.value
 await run('server',async()=>{
  if(active.value){emit('runtime',await api('stopRuntime'));return}
  const model=localModels.value.find(item=>item.id===selectedId.value)||localModels.value[0]
  if(!model){emit('runtime',await api('startApiServer'));await refreshState();return}
  if(!state.value?.runtimeFound){candidates.value=await api('runtimeDetect');if(!candidates.value.length){page.value='runtime';throw new Error('未找到 llama-server，请安装官方运行包或手动选择运行文件')};emit('settings',await api('settings',{runtimePath:candidates.value[0].path}))}
  selectedId.value=model.id;emit('runtime',await api('startRuntime',{id:model.id}));emit('settings',{source:'managed'});page.value='server'
 },starting?showServiceStartError:undefined)
}
async function externalModel(id:string,unload=false){if(unload&&props.tasksRunning)return;await run('external-model',async()=>{await api('loadExternal',{id,unload});emit('connect')})}
async function saveConfiguration(){await run('save',async()=>{
 if(serverActive.value)throw new Error('请先停止托管服务再修改加载配置')
 if(preferences.host==='0.0.0.0'&&state.value?.preferences.host!=='0.0.0.0')await ElMessageBox.confirm('允许局域网设备访问模型服务。HTTP 不加密，请只在可信网络中使用并妥善保存 API Key；程序不会自动开放防火墙端口。','启用局域网监听',{type:'warning',confirmButtonText:'允许局域网访问',cancelButtonText:'取消'})
 emit('settings',await api('settings',{runtimePort:load.runtimePort,managedContextLength:load.contextLength,gpuLayers:load.gpuLayers,threads:load.threads}))
 Object.assign(preferences,await api('developerSettings',{host:preferences.host,parallel:preferences.parallel,embedding:preferences.embedding,metrics:preferences.metrics,...(secret.value?{apiKey:secret.value}:{}),...(clearSecret.value?{clearApiKey:true}:{})}));secret.value='';clearSecret.value=false;await refreshState();ElMessage.success('服务配置已保存，下次启动时应用')
})}
async function saveInference(){await run('inference',async()=>{emit('settings',await api('settings',{temperature:load.temperature,topP:load.topP,maxTokens:load.maxTokens,repeatPenalty:load.repeatPenalty}));ElMessage.success('工作区默认推理参数已保存')})}
async function copyKey(){await run('key',async()=>{await copy(await api('developerKey'))})}
async function clearLogs(){await run('logs',async()=>{await api('developerClearLogs');emit('runtime',{...props.runtime!,logs:[]});await refreshState()})}
async function exportLogs(){await run('export',async()=>{if(await api('developerExportLogs'))ElMessage.success('日志已导出')})}
function template(kind:'default'|'json'|'tools'='default'){
 const model=modelIdentifier.value
 const localKey=selected.value?.id||localModels.value[0]?.id||'model-key-from-list'
 let value:Record<string,unknown>={model,messages:[{role:'user',content:'请用一句话介绍你自己。'}],temperature:load.temperature,max_tokens:256,stream:false}
 if(route.value==='lmChat')value={model:active.value?model:localKey,input:'请用一句话介绍你自己。',max_output_tokens:256,store:true,stream:false}
 if(route.value==='lmLoad')value={model:localKey,context_length:Math.floor(load.contextLength/preferences.parallel),echo_load_config:true}
 if(route.value==='lmUnload')value={instance_id:model}
 if(route.value==='lmDownload')value={model:selected.value?.repoId.includes('/')?selected.value.repoId:'https://huggingface.co/owner/model-GGUF',quantization:selected.value?.quantization||'Q4_K_M'}
 if(route.value==='countTokens')value={model,messages:[{role:'user',content:'请统计这句话的 tokens。'}]}
 if(route.value==='completions')value={model,prompt:'Explain local AI in one sentence:',max_tokens:128,stream:false}
 if(route.value==='embeddings')value={model,input:['本地 AI 工作区']}
 if(route.value==='responses')value={model,input:'请介绍本地推理。',max_output_tokens:256,stream:false}
 if(route.value==='messages')value={model,messages:[{role:'user',content:'你好'}],max_tokens:256,stream:false}
 if(kind==='json')value.response_format={type:'json_object'}
 if(kind==='tools'){value.messages=[{role:'user',content:'查看上海的天气。'}];value.tools=[{type:'function',function:{name:'get_weather',description:'由调用方查询指定城市的天气',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];value.tool_choice='auto'}
 requestBody.value=endpoint.value.method==='POST'?JSON.stringify(value,null,2):'';response.value=undefined
}
function showRoute(value:DeveloperRoute){if(requestBusy.value)return;const family=protocolKeys.find(key=>developerProtocols[key].routes.includes(value));if(family)protocol.value=family;route.value=value;page.value='docs'}
async function sendRequest(){if(requestBusy.value)return;requestBusy.value=true;error.value='';response.value=undefined;try{response.value=await api('developerRequest',{route:route.value,body:requestBody.value,jobId:downloadJobId.value})}catch(cause){report(cause)}finally{requestBusy.value=false}}
async function cancelRequest(){try{await api('developerCancelRequest')}catch(cause){report(cause)}}
const example=computed(()=>developerExample(route.value,requestUrl.value,requestBody.value,exampleLanguage.value))
watch(response,value=>{if(!value||route.value!=='lmDownload')return;try{const body=JSON.parse(value.body);if(typeof body.job_id==='string')downloadJobId.value=body.job_id}catch{}})
watch(()=>props.settings,settings=>Object.assign(load,{runtimePort:settings.runtimePort,contextLength:settings.managedContextLength??settings.contextLength,gpuLayers:settings.gpuLayers,threads:settings.threads,temperature:settings.temperature,topP:settings.topP,maxTokens:settings.maxTokens,repeatPenalty:settings.repeatPenalty}),{deep:true})
watch(()=>props.runtime?.error,value=>{if(managed.value&&value&&value!==shownRuntimeError){shownRuntimeError=value;void showServiceStartError(value)}else if(!value)shownRuntimeError=''})
watch(localModels,models=>{if(!models.some(item=>item.id===selectedId.value))selectedId.value=models.find(item=>item.id===props.runtime?.modelId)?.id||models[0]?.id||''},{immediate:true})
watch([route,modelIdentifier],()=>template(),{immediate:true})
watch(()=>logLines.value.join('\n'),async()=>{if(followLogs.value){await nextTick();if(logPanel.value)logPanel.value.scrollTop=logPanel.value.scrollHeight}})
onMounted(()=>{void poll()})
onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);if(requestBusy.value)void api('developerCancelRequest').catch(()=>{})})
</script>

<template>
 <section class="developer-workspace" :class="{'show-inspector':page==='server'&&inspectorOpen,'simple-server':page==='server'}">
  <nav class="dev-nav" role="tablist" aria-label="本地服务功能"><button v-for="item in nav" :key="item.id" role="tab" :class="{active:page===item.id}" :aria-selected="page===item.id" @click="page=item.id"><component :is="item.icon"/>{{item.label}}<b v-if="item.id==='runtime'&&state&&!state.runtimeFound">!</b></button></nav>
  <main class="dev-content">
   <div v-if="error" class="dev-alert" role="alert"><span>{{error}}</span><button class="icon-btn" aria-label="关闭本地服务错误" @click="error=''"><Close/></button></div>
   <header v-if="page!=='server'" class="dev-toolbar"><span class="dev-status" :class="{online}"><i></i>{{statusLabel}}</span><button class="dev-button" :disabled="!!busy||connecting||stopBlocked" :title="stopBlocked?'请先停止正在执行的会话任务':undefined" @click="toggleServer"><VideoPause v-if="managed&&active"/><VideoPlay v-else/>{{managed?active?'停止服务':'启动服务':'刷新连接'}}</button><button class="dev-button" @click="page='config'"><Setting/>服务设置</button><button class="dev-url" :title="apiBase" @click="copy(apiBase)"><code>{{apiBase}}</code><CopyDocument/></button></header>

   <template v-if="page==='server'">
    <div v-if="managed&&state&&!state.runtimeFound" class="dev-runtime-callout"><Cpu/><div><strong>需要配置运行时</strong><p>配置一次，即可启动本机模型。</p></div><button class="dev-button" @click="page='runtime'">配置运行时 <ArrowRight/></button></div>
    <section class="dev-section dev-main-model"><header><div class="dev-model-heading"><h2>{{managed?'运行模型':connection?.provider==='lmstudio'?'LM Studio 模型':'服务报告的模型'}}</h2><span class="dev-status" :class="{online}"><i></i>{{statusLabel}}</span></div><button class="dev-button" @click="emit('modelsPage')"><FolderOpened/>管理模型文件</button></header>
     <div v-if="managed&&!active&&localModels.length" class="dev-load-row"><select v-model="selectedId" aria-label="选择服务模型" :disabled="active||!!busy"><option value="" disabled>选择本地 GGUF 模型</option><option v-for="item in localModels" :key="item.id" :value="item.id">{{item.file}}</option></select></div>
     <article v-if="managed&&active" class="dev-running-model"><strong>{{loaded?.file||runtime?.modelName||'正在加载模型'}}</strong><div class="dev-model-meta"><span v-if="loaded">{{byteLabel(loaded.size)}}</span><span>{{runtime?.embedding?'向量模式':'文本推理'}}</span><span>并发 {{runtime?.parallel||1}}</span></div></article>
     <template v-else-if="managed">
      <div v-if="!localModels.length" class="dev-empty"><h3>还没有本地模型</h3><p>下载或导入 GGUF 主模型后即可启动。</p><div class="dev-empty-actions"><button class="dev-button primary" @click="emit('discover')"><Download/>下载模型</button><button class="dev-button" @click="emit('importModels')"><FolderOpened/>导入模型</button></div></div>
      <p v-else class="dev-selection-hint">{{selected?byteLabel(selected.size)+' · GGUF':'选择模型后，点击“启动并使用”。'}}</p>
     </template>
     <template v-else><div class="dev-load-row"><select v-model="externalId" aria-label="外部服务模型"><option value="">选择服务模型</option><option v-for="item in remoteModels" :key="item.id" :value="item.instanceId||item.id">{{item.name}}</option></select><button class="dev-button" :disabled="connecting" @click="emit('connect')"><Refresh/>刷新模型</button></div><article v-for="item in remoteModels" :key="item.id" class="dev-model-card"><header><span class="dev-model-state">{{item.loaded===true?'READY':item.loaded===false?'NOT LOADED':'AVAILABLE'}}</span></header><strong>{{item.name}}</strong><div class="dev-model-meta"><code>{{item.instanceId||item.id}}</code><button v-if="connection?.provider==='lmstudio'" class="dev-button" :disabled="!!busy||!!(tasksRunning&&item.loaded)" @click="externalModel(item.loaded?item.instanceId||item.id:item.id,!!item.loaded)">{{item.loaded?'卸载':'加载'}}</button></div></article><p v-if="!remoteModels.length" class="dev-note">外部服务尚未报告模型，请启动服务后刷新连接。</p></template>
     <div v-if="managed" class="dev-service-address"><span>服务地址</span><button :title="'复制服务地址：'+apiBase" @click="copy(apiBase)"><code>{{apiBase}}</code><CopyDocument/></button><small v-if="!serverActive">启动后可用</small></div>
     <p v-else class="dev-note">MyPlane 不会启动或终止外部应用。</p>
    </section>
    <details class="dev-section dev-endpoints"><summary>接口与高级操作</summary><header><h2>支持的端点</h2><span class="dev-api-badge">REST API v1</span><button class="dev-inline" @click="page='docs'">文档与调试 <ArrowRight/></button></header><div class="dev-protocol-tabs" role="tablist" aria-label="接口兼容格式"><button v-for="key in protocolKeys" :key="key" role="tab" :aria-selected="protocol===key" :class="{active:protocol===key}" :disabled="requestBusy" @click="selectProtocol(key)">{{developerProtocols[key].label}}</button></div><button v-for="key in protocolRoutes" :key="key" class="dev-endpoint-row" @click="showRoute(key)"><span class="dev-method" :class="developerRoutes[key].method.toLowerCase()">{{developerRoutes[key].method}}</span><code>{{developerRoutes[key].path}}</code><small>{{developerRoutes[key].title}}</small><ArrowRight/></button><p class="dev-note">{{managed?'三个协议共用服务地址和 API Key。API 可独立运行；加载推理模型仍需要 llama-server。':'外部服务的接口能力由该服务实现；本页使用对应协议的真实路径和请求格式。'}}</p><div v-if="managed" class="dev-actions"><button class="dev-button" :disabled="!!busy||!!(tasksRunning&&state?.serverRunning)" @click="toggleApiOnly">{{state?.serverRunning?'停止 API 服务':'仅启动 API 服务'}}</button><button class="dev-button" :disabled="!state?.serverRunning||!!busy" @click="copyKey"><CopyDocument/>复制 API Key</button><button v-if="active" class="dev-button" :disabled="!!busy||tasksRunning" @click="unloadApiModel">卸载模型，保留 API</button></div></details>
    <details class="dev-section dev-logs"><summary>服务日志</summary><header><h2>服务日志</h2><div class="dev-actions"><button class="icon-btn" aria-label="复制服务日志" title="复制" @click="copy(logLines.join('\n'))"><CopyDocument/></button><button class="icon-btn" aria-label="导出服务日志" title="导出" :disabled="!!busy" @click="exportLogs"><Download/></button><button class="icon-btn" aria-label="清空服务日志" title="清空" :disabled="!!busy" @click="clearLogs"><Delete/></button></div></header><div class="dev-log-filters"><input v-model="logFilter" placeholder="筛选日志内容" aria-label="筛选服务日志"/><select v-model="logLevel" aria-label="日志等级"><option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="api">API 调试</option></select><label><input v-model="followLogs" type="checkbox"/>跟随</label></div><pre ref="logPanel" class="dev-log-console"><span v-for="(line,index) in logLines" :key="index" :class="{'log-error':/error|failed|失败|异常/i.test(line),'log-api':line.includes('[API]')}">{{line}}{{'\n'}}</span><span v-if="!logLines.length">{{managed?'运行日志将在模型启动后显示。':'外部进程日志由外部应用管理；此处仅显示 MyPlane 的 API 调试日志。'}}</span></pre></details>
   </template>

   <template v-else-if="page==='runtime'">
    <div class="dev-page-heading"><span class="dev-eyebrow">INFERENCE RUNTIME</span><h1>找到并配置 llama-server</h1><p>模型权重负责知识，llama.cpp 负责推理。安装完整运行包，请保留配套动态库，不要选择 Source code。</p></div>
    <section class="dev-section"><header><h2>当前运行文件</h2><span class="dev-model-state">{{state?.runtimeFound?'已找到':'未配置 / 文件不存在'}}</span></header><code class="dev-path">{{settings.runtimePath||'尚未选择 llama-server'}}</code><div class="dev-actions"><button class="dev-button" :disabled="!!busy" @click="detect"><Refresh/>自动查找</button><button class="dev-button" :disabled="!!busy||active" @click="choose()"><FolderOpened/>手动选择</button><button class="dev-inline" @click="open('https://github.com/ggml-org/llama.cpp/releases')">官方发布页 <ArrowRight/></button></div><p class="dev-note">查找 PATH、常用安装目录、MyPlane 运行包和下载目录中的 llama 文件夹，不扫描整个磁盘。</p><div v-for="item in candidates" :key="item.path" class="dev-candidate"><div><small>{{item.source}}</small><code>{{item.path}}</code></div><button class="dev-button" :disabled="!!busy||active" @click="choose(item.path)">使用此运行时</button></div></section>
    <section class="dev-section"><header><h2>安装官方运行包</h2><button class="dev-button" :disabled="!!busy||installing" @click="releases"><Refresh/>{{busy==='releases'?'读取中':'获取可用版本'}}</button></header><p class="dev-note">本机：{{state?.platform||'未知'}} / {{state?.arch||'未知'}}。<template v-if="state?.platform==='darwin'">macOS 运行包按本机架构匹配，支持 CPU 与 Metal。Apple Silicon 使用统一内存；将 GPU 卸载层数设为 -1 可尝试 Metal 加速。</template><template v-else>CPU 版无需 GPU 驱动；Vulkan 版需要支持 Vulkan 的显卡与驱动。CUDA 包请在官方发布页下载并保留对应 CUDA 运行库。</template></p><div v-for="item in packages" :key="item.id" class="dev-package"><Cpu/><div><strong>{{item.flavor==='metal'?'macOS Metal 版':item.flavor==='cpu'?'CPU 通用版':'Vulkan GPU 版'}} <small>{{item.version}}</small></strong><code>{{item.name}}</code><small>{{byteLabel(item.size)}} · {{item.sha256?'包含官方 SHA-256':'官方未提供 SHA-256'}}</small></div><button class="dev-button primary" :disabled="!!busy||installing" @click="install(item)"><Download/>安装</button></div><p v-if="!packages.length" class="dev-note">点击“获取可用版本”，从官方发布列表读取适合本机的安装包。</p>
     <div v-if="installation&&installation.status!=='idle'" class="dev-install-progress"><div><strong>{{({downloading:'正在下载',extracting:'正在解压并保留动态库',ready:'运行包已安装',error:'安装失败',cancelled:'已取消'} as Record<string,string>)[installation.status]}}</strong><button v-if="installing" class="dev-inline" @click="cancelInstall">取消安装</button></div><code>{{installation.name}}</code><progress :value="installPercent" max="100"></progress><small>{{byteLabel(installation.received)}} / {{byteLabel(installation.total)}}{{installation.verified?' · SHA-256 已验证':''}}</small><p v-if="installation.error" class="dev-note danger">{{installation.error}}</p><code v-if="installation.path" class="dev-path">{{installation.path}}</code><button v-if="installation.status==='ready'" class="dev-button primary" @click="page='server'">返回服务并加载模型 <ArrowRight/></button></div>
    </section><section class="dev-section"><h2>仍然无法启动？</h2><p class="dev-note">缺少动态库（DLL / dylib）：重新安装完整二进制运行包。macOS 提示无执行权限时，可重新安装运行包；如被系统拦截，请在“系统设置 > 隐私与安全性”中查看提示。提示不支持模型架构：更新运行包。显存或内存不足：先将 GPU 层数设为 0、降低上下文，再尝试加载较小的 GGUF。程序不自动安装系统驱动或修改防火墙。</p></section>
   </template>

   <template v-else-if="page==='config'">
    <div class="dev-page-heading"><span class="dev-eyebrow">SERVER SETTINGS</span><h1>服务设置</h1><p>监听、并发和模型加载设置在下次启动时生效。对外 API 始终启用密钥认证。</p></div>
    <section class="dev-section"><header><h2>本地托管服务</h2></header><p class="dev-note">MyPlaneAgent 直接管理 llama-server 进程，加载本机 GGUF 模型并提供仅本机使用的兼容 API。远程地址与密钥在上方“远程服务”选项卡中配置。</p><button class="dev-inline" @click="emit('settingsPage')">前往远程服务配置 <ArrowRight/></button></section>
    <form class="dev-section" @submit.prevent="saveConfiguration"><header><h2>托管服务配置</h2><button class="dev-button primary" :disabled="!!busy||active">保存配置</button></header><p v-if="active" class="dev-note">请先停止托管服务再修改以下设置。</p><fieldset :disabled="active"><div class="dev-fields"><label>监听范围<select v-model="preferences.host"><option value="127.0.0.1">仅本机（推荐）</option><option value="0.0.0.0">局域网 / 所有网卡</option></select></label><label>端口<input v-model.number="load.runtimePort" type="number" min="1024" max="65535" required/></label><label>并发槽数量<input v-model.number="preferences.parallel" type="number" min="1" max="16" required/></label><label>总上下文预算<input v-model.number="load.contextLength" type="number" min="512" max="131072" step="512" required/></label><label>GPU 卸载层数<input v-model.number="load.gpuLayers" type="number" min="-1" max="999" required/></label><label>CPU 线程<input v-model.number="load.threads" type="number" min="1" max="256" required/></label></div><p class="dev-note">GPU 层数 0 使用 CPU，-1 尝试全部卸载。并发槽共享上下文预算；增加上下文和并发通常需要更多内存。</p><div class="dev-checks"><label><input v-model="preferences.metrics" type="checkbox"/>启用 Prometheus 指标</label><label><input v-model="preferences.embedding" type="checkbox"/>专用向量嵌入模式（不能聊天）</label></div><label class="dev-field">固定服务 API Key<input v-model="secret" type="password" autocomplete="new-password" minlength="16" maxlength="512" :placeholder="preferences.hasApiKey?'已加密保存，留空不修改':'留空则每次启动生成随机密钥'"/></label><label v-if="preferences.hasApiKey" class="dev-checkbox"><input v-model="clearSecret" type="checkbox"/>移除固定密钥，下次启动使用随机密钥</label><p class="dev-note">这里的密钥仅用于 MyPlane 托管 API，与外部服务 API Key 和 Hugging Face Token 分开保存。启动后可复制当前密钥给客户端。</p></fieldset></form>
    <section v-if="preferences.host==='0.0.0.0'" class="dev-section"><h2>局域网访问</h2><p class="dev-note">需启动服务并自行确认防火墙规则；HTTP 不加密，不建议直接暴露到互联网。</p><button v-for="address in state?.lanAddresses||[]" :key="address" class="dev-inline" @click="copy(`http://${address}:${load.runtimePort}/v1`)"><code>http://{{address}}:{{load.runtimePort}}/v1</code><CopyDocument/></button></section>
   </template>

   <template v-else>
    <div class="dev-page-heading"><span class="dev-eyebrow">API WORKBENCH</span><h1>文档、示例与真实请求</h1><p>使用实际服务地址和模型标识。接口可用性以当前运行时响应为准，不模拟成功结果。</p></div>
    <section class="dev-section"><div class="dev-protocol-tabs" role="tablist" aria-label="接口兼容格式"><button v-for="key in protocolKeys" :key="key" role="tab" :aria-selected="protocol===key" :class="{active:protocol===key}" :disabled="requestBusy" @click="selectProtocol(key)">{{developerProtocols[key].label}}</button></div><div class="dev-api-picker"><select v-model="route" aria-label="选择调试接口" :disabled="requestBusy"><option v-for="key in routeKeys" :key="key" :value="key">{{developerRoutes[key].method}} {{developerRoutes[key].path}} · {{developerRoutes[key].title}}</option></select><span class="dev-method" :class="endpoint.method.toLowerCase()">{{endpoint.method}}</span></div><label v-if="route===`lmDownloadStatus`" class="dev-field">下载任务 job_id<input v-model.trim="downloadJobId" placeholder="job_...（下载后自动填入）" :disabled="requestBusy"/></label><code class="dev-path">{{requestUrl}}</code><p class="dev-note">{{endpoint.note}}</p><div class="dev-actions"><button class="dev-inline" @click="copy(apiBase)"><CopyDocument/>复制 API Base URL</button><button v-if="managed" class="dev-inline" :disabled="!(managed?state?.serverRunning:online)||!!busy" @click="copyKey"><CopyDocument/>复制当前 API Key</button><button class="dev-inline" @click="copy(modelIdentifier)"><CopyDocument/>复制模型 ID</button></div><p class="dev-note">示例从环境变量 MYPLANE_API_KEY 读取密钥。界面调试会自动使用所配置服务的密钥，响应和导出日志会隐藏它。</p>
     <template v-if="endpoint.method==='POST'"><div class="dev-actions"><button class="dev-button" :disabled="requestBusy" @click="template()">重置示例</button><button v-if="route==='chat'" class="dev-button" :disabled="requestBusy" @click="template('json')">JSON 输出示例</button><button v-if="route==='chat'" class="dev-button" :disabled="requestBusy" @click="template('tools')">工具调用示例</button></div><label class="dev-field">JSON 请求体<textarea v-model="requestBody" rows="12" maxlength="40000" spellcheck="false" :disabled="requestBusy"></textarea></label></template>
     <div class="dev-actions"><button v-if="!requestBusy" class="dev-button primary" @click="sendRequest"><VideoPlay/>发送真实请求</button><button v-else class="dev-button" @click="cancelRequest"><VideoPause/>取消请求</button><span class="dev-note">支持 JSON / SSE 原文；普通请求限时 90 秒，LM 加载与对话限时 310 秒。</span></div><div v-if="response" class="dev-api-response"><header><strong :class="{danger:response.status>=400}">HTTP {{response.status}}</strong><span>{{response.elapsedMs}} ms</span><button class="dev-inline" @click="copy(formattedResponse)">复制响应</button></header><pre>{{formattedResponse}}</pre><p v-if="response.truncated" class="dev-note">响应较长，只显示前 120,000 字符。</p></div>
    </section>
    <section class="dev-section"><header><h2>客户端示例</h2><select v-model="exampleLanguage" aria-label="示例语言"><option value="powershell">PowerShell</option><option value="curl">cURL</option><option value="python">Python</option><option value="javascript">JavaScript / Node.js</option></select><button class="dev-inline" @click="copy(example)"><CopyDocument/>复制</button></header><pre class="dev-code">{{example}}</pre><p class="dev-note">工具调用只返回调用描述，由你的客户端决定是否执行。MyPlane 不自动执行 README 或工具调用中的命令。LM Studio 风格的模型管理由本地 API 层实现，MCP integrations 暂不支持；OpenAI / Anthropic 推理由 llama.cpp 原生处理，旧版缺失接口会提示升级。</p></section>
    <section class="dev-section"><h2>官方文档</h2><div class="dev-actions"><button class="dev-inline" @click="open('https://github.com/ggml-org/llama.cpp/tree/master/tools/server')">llama.cpp Server <ArrowRight/></button><button class="dev-inline" @click="open('https://lmstudio.ai/docs/developer')">LM Studio 开发者文档 <ArrowRight/></button></div></section>
   </template>
  </main>

  <footer v-if="page==='server'" class="dev-main-actions"><span>{{stopBlocked?'请先停止正在执行的会话任务，再停止模型服务。':managed?(active?'停止服务会释放模型占用，文件仍保留。':'一次运行一个主模型。'):'使用外部服务提供的模型。'}}</span><div><button class="dev-button" :aria-expanded="inspectorOpen" @click="inspectorOpen=!inspectorOpen"><Setting/>{{inspectorOpen?'收起参数':'模型参数'}}</button><button class="dev-button" :class="{primary:!active}" :disabled="!!busy||connecting||stopBlocked||['starting','stopping'].includes(runtime?.state||'')||(managed&&!active&&!selectedId&&!!state?.runtimeFound)" @click="managed&&!active&&!state?.runtimeFound?page='runtime':toggleServer()"><VideoPause v-if="managed&&active"/><VideoPlay v-else/>{{busy?'处理中…':runtime?.state==='starting'?'正在启动…':runtime?.state==='stopping'?'正在停止…':managed?active?'停止服务':!state?.runtimeFound?'配置运行时':'启动并使用':'刷新连接'}}</button></div></footer>
  <aside v-if="page==='server'&&inspectorOpen" class="dev-inspector"><header><Cpu/><strong>{{managed?selected?.file||'模型与 API 信息':externalId||'外部服务'}}</strong></header><div class="dev-inspector-tabs"><button v-for="item in [{id:'info',label:'信息'},{id:'load',label:'加载'},{id:'inference',label:'推理'}] as const" :key="item.id" :class="{active:inspectorTab===item.id}" @click="inspectorTab=item.id">{{item.label}}</button></div>
   <template v-if="inspectorTab==='info'"><section><h3>模型信息</h3><dl v-if="managed&&selected" class="dev-info"><div><dt>仓库</dt><dd>{{selected.repoId}}</dd></div><div><dt>文件</dt><dd>{{selected.file}}</dd></div><div><dt>格式</dt><dd>{{selected.format}}</dd></div><div><dt>量化</dt><dd>{{selected.quantization||'未报告'}}</dd></div><div><dt>磁盘大小</dt><dd>{{byteLabel(selected.size)}}</dd></div><div><dt>本机路径</dt><dd>{{selected.localPath}}</dd></div><div v-if="active"><dt>已分配上下文</dt><dd>{{runtime?.contextLength}}</dd></div><div v-if="active"><dt>并发槽</dt><dd>{{runtime?.parallel||1}}</dd></div></dl><p v-else class="dev-note">{{managed?'选择一个本地模型以查看信息。':'模型加载状态和能力由外部服务提供。'}}</p><button v-if="managed&&online" class="dev-inline" @click="showRoute('properties')">读取实际运行属性 <ArrowRight/></button></section><section><h3>API 使用</h3><label class="dev-field">模型标识<button class="dev-copy-field" @click="copy(modelIdentifier)"><code>{{modelIdentifier}}</code><CopyDocument/></button></label><label class="dev-field">API Base URL<button class="dev-copy-field" @click="copy(apiBase)"><code>{{apiBase}}</code><CopyDocument/></button></label><button v-if="managed" class="dev-button" :disabled="!(managed?state?.serverRunning:online)||!!busy" @click="copyKey"><CopyDocument/>复制当前 API Key</button><p class="dev-note">不要把 API Key 放到公开仓库或聊天内容中。</p></section></template>
   <section v-else-if="inspectorTab==='load'"><h3>模型加载参数</h3><fieldset :disabled="active"><label class="dev-field">总上下文预算<input v-model.number="load.contextLength" type="number" min="512" max="131072" step="512"/></label><label class="dev-field">GPU 卸载层数<input v-model.number="load.gpuLayers" type="number" min="-1" max="999"/></label><label class="dev-field">CPU 线程<input v-model.number="load.threads" type="number" min="1" max="256"/></label><label class="dev-field">并发槽<input v-model.number="preferences.parallel" type="number" min="1" max="16"/></label><button class="dev-button primary" :disabled="!!busy" @click="saveConfiguration">保存加载配置</button></fieldset><p class="dev-note">加载后修改这些参数需要先停止服务。GPU 支持还取决于运行包和驱动。</p><button class="dev-inline" @click="page='runtime'">管理运行时 <ArrowRight/></button></section>
   <section v-else><h3>工作区推理默认值</h3><label class="dev-field">Temperature · {{load.temperature}}<input v-model.number="load.temperature" type="range" min="0" max="2" step="0.05"/></label><label class="dev-field">Top P · {{load.topP}}<input v-model.number="load.topP" type="range" min="0.01" max="1" step="0.01"/></label><label class="dev-field">最大输出 tokens<input v-model.number="load.maxTokens" type="number" min="128" :max="LOCAL_AI_MAX_OUTPUT_TOKENS" step="128"/></label><label class="dev-field">重复惩罚<input v-model.number="load.repeatPenalty" type="number" min="0.1" max="2" step="0.05"/></label><button class="dev-button primary" :disabled="!!busy" @click="saveInference">保存默认值</button><p class="dev-note">最高可配置 {{LOCAL_AI_MAX_OUTPUT_TOKENS.toLocaleString()}} tokens，实际上限不会超过当前有效上下文的一半。外部客户端应在各自请求中传入参数。</p></section>
  </aside>
 </section>
</template>

<style scoped src="./studio-developer.css"></style>

<style scoped>
.developer-workspace.simple-server{grid-template-rows:auto minmax(0,1fr) auto}.dev-main-actions{grid-row:3;grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;background:var(--s-panel);border-top:1px solid var(--s-border)}.dev-main-actions>span{font-size:11px;color:var(--s-dim);line-height:1.6}.dev-main-actions>div{display:flex;gap:8px;flex:none}.dev-main-actions .dev-button{height:36px;padding:8px 14px;min-width:106px}.simple-server .dev-content{padding:20px 24px;gap:14px}.simple-server:not(.show-inspector) .dev-content>*{width:100%;max-width:940px;margin-left:auto;margin-right:auto}.dev-model-heading{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.dev-main-model .dev-load-row{margin:14px 0}.dev-main-model .dev-load-row select{flex:1;width:100%;height:38px}.simple-server .dev-empty{padding:22px 16px}.simple-server .dev-empty>svg{display:none}.simple-server .dev-empty h3{font-size:14px}.simple-server .dev-empty p{font-size:12px}.simple-server .dev-section{border-radius:10px}.simple-server .dev-inspector{grid-row:2;min-height:0}.dev-main-model>header>.dev-button{background:transparent;border-color:transparent;color:var(--s-dim)}.simple-server .dev-model-card{box-shadow:none}.simple-server .dev-section>summary{font-weight:400}.simple-server .dev-runtime-callout{padding:12px 16px}.simple-server .dev-runtime-callout p{font-size:12px}
@media(max-width:1000px){.dev-main-actions{flex-wrap:wrap;padding:12px 16px}.dev-main-actions>span{flex-basis:100%}.dev-main-actions>div{margin-left:auto}.simple-server .dev-content{padding:16px}}
@container studio (max-width:1180px){.developer-workspace.simple-server.show-inspector{grid-template-rows:auto minmax(80px,1fr) minmax(0,auto) auto}.simple-server.show-inspector .dev-inspector{grid-row:3;max-height:32vh}.simple-server.show-inspector .dev-main-actions{grid-row:4}}
</style>

<style scoped>
.dev-running-model{padding:4px 0 14px}.dev-running-model>strong{font-size:15px;line-height:1.6;overflow-wrap:anywhere}.dev-running-model .dev-model-meta{margin-top:8px;color:var(--s-dim);font-size:12px}.dev-selection-hint{margin:0 0 14px;color:var(--s-dim);font-size:12px}.dev-service-address{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--s-border);padding-top:12px;color:var(--s-dim);font-size:11px}.dev-service-address>button{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;border:0;background:transparent;padding:4px 0;text-align:left}.dev-service-address code{overflow-wrap:anywhere}.dev-service-address small{margin-left:auto}.dev-empty-actions{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}.simple-server .dev-main-model{background:var(--s-panel)}.simple-server .dev-content>details{padding:12px 16px;background:transparent}.simple-server .dev-content>details[open]{background:var(--s-panel)}.simple-server .dev-main-model>header{margin-bottom:10px}.simple-server .dev-nav{padding-top:5px;padding-bottom:5px}
.dev-section>summary{cursor:pointer;color:var(--s-dim);font-size:13px;font-weight:500}.dev-section[open]>summary{margin-bottom:16px}
</style>
