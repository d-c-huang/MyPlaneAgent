<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue'
import {Aim,ArrowDown,Close,Connection,FullScreen,Menu,Operation,Refresh,Search,VideoPause,VideoPlay} from '@element-plus/icons-vue'
import {runtimeNodeLabels,runtimeStatusColors,runtimeStatusLabels,type RuntimeNodeKind,type RuntimeGraphSnapshot} from '../../electron/shared/runtime-graph'
import {RuntimeGraphScene} from './runtimeGraphScene'
import RuntimeNodeEditor from './RuntimeNodeEditor.vue'
import type {RuntimeHistoryIndex} from '../../electron/shared/runtime-workbench'

const graph=ref<RuntimeGraphSnapshot>({version:1,title:'正在读取运行记录',active:false,updatedAt:'',sessions:[],nodes:[],edges:[],events:[],truncated:false})
const host=ref<HTMLElement>(),chosenSession=ref(''),selectedId=ref('task:root'),query=ref(''),paused=ref(false),error=ref(''),graphicsError=ref('')
const sidebarOpen=ref(true),detailsOpen=ref(true),eventsOpen=ref(false),relatedOnly=ref(false),objectFilter=ref<'all'|'active'|'attention'>('all')
const replay=ref(false),history=ref<RuntimeHistoryIndex>({entries:[],truncated:false}),frameIndex=ref(0),playing=ref(false),historyBusy=ref(false),historyNotice=ref(''),workflowBusy=ref(false),workflowId=ref('')
let playTimer:ReturnType<typeof setTimeout>|undefined,frameRevision=0
const currentFrame=computed(()=>history.value.entries[frameIndex.value])
const kinds:RuntimeNodeKind[]=['task','agent','worker','tool'],enabled=reactive<Record<RuntimeNodeKind,boolean>>({task:true,agent:true,worker:true,tool:true}),dependencies=ref(true)
const visibleNodes=computed(()=>graph.value.nodes.filter(node=>enabled[node.kind]))
const visibleEdges=computed(()=>{const ids=new Set(visibleNodes.value.map(node=>node.id));return graph.value.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)&&(dependencies.value||edge.kind!=='dependency'))})
const listedNodes=computed(()=>visibleNodes.value.filter(node=>(objectFilter.value==='all'||objectFilter.value==='active'&&node.status==='running'||objectFilter.value==='attention'&&['waiting','paused','error'].includes(node.status))&&(node.label+' '+node.sourceId).toLowerCase().includes(query.value.trim().toLowerCase())))
const selected=computed(()=>graph.value.nodes.find(node=>node.id===selectedId.value))
const connections=computed(()=>graph.value.edges.filter(edge=>edge.source===selectedId.value||edge.target===selectedId.value))
const activeCount=computed(()=>graph.value.nodes.filter(node=>node.kind==='worker'&&node.status==='running').length)
const waitCount=computed(()=>graph.value.nodes.filter(node=>node.kind==='task'&&node.status==='waiting').length)
const events=computed(()=>graph.value.events.slice(0,35))
let scene:RuntimeGraphScene|undefined,timer:ReturnType<typeof setTimeout>|undefined,disposed=false,revision=0,unsubscribe:(()=>void)|undefined,previousSignature='',previousSession=''
const time=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleTimeString('zh-CN',{hour12:false})}
const count=(kind:RuntimeNodeKind)=>graph.value.nodes.filter(node=>node.kind===kind).length
function select(id:string,focus=false){const node=graph.value.nodes.find(item=>item.id===id);if(node)enabled[node.kind]=true;selectedId.value=id;scene?.setSelected(id);if(focus)void nextTick(()=>scene?.focus(id))}
function showOverview(){relatedOnly.value=false;scene?.setRelatedOnly(false);scene?.fit()}
function toggleRelated(){relatedOnly.value=!relatedOnly.value;scene?.setRelatedOnly(relatedOnly.value);scene?.fit()}
function shortcut(event:KeyboardEvent){
 if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return
 const target=event.target as HTMLElement|null
 if(target?.closest('input,textarea,select,[contenteditable="true"],.node-editor,dialog,[role="dialog"],.el-overlay')||[...document.querySelectorAll<HTMLElement>('dialog[open],.el-message-box,[role="dialog"]')].some(element=>element.checkVisibility()))return
 if(event.key.toLowerCase()==='f'||event.key==='Escape'){event.preventDefault();showOverview()}
 else if(event.key==='Enter'&&(!target?.closest('button,a,summary')||target?.classList.contains('runtime-node-label'))&&selected.value){event.preventDefault();if(target?.dataset.nodeId)select(target.dataset.nodeId,true);else scene?.focus(selectedId.value)}
}
function syncScene(){
 const hiddenAnchor=relatedOnly.value&&!visibleNodes.value.some(node=>node.id===selectedId.value)
 if(hiddenAnchor)relatedOnly.value=false
 if(!scene)return
 const signature=JSON.stringify([visibleNodes.value,visibleEdges.value,graph.value.nodes.map(node=>[node.id,node.kind,node.lane,node.order]),graph.value.edges.map(edge=>[edge.id,edge.source,edge.target])])
 if(signature!==previousSignature){scene.update(visibleNodes.value,visibleEdges.value,graph.value);previousSignature=signature}
 scene.setSelected(selectedId.value)
 scene.setRelatedOnly(relatedOnly.value)
 if(hiddenAnchor||previousSession!==graph.value.sessionId){previousSession=graph.value.sessionId||'';scene.fit()}
}
async function initializeScene(){
 await nextTick();if(!host.value||disposed)return
 scene?.dispose();scene=undefined;previousSignature='';previousSession='';graphicsError.value=''
 try{scene=new RuntimeGraphScene(host.value,id=>select(id),message=>{graphicsError.value=message});scene.setPaused(paused.value||replay.value);syncScene()}catch(cause){graphicsError.value='无法启用 3D 图形，请检查显卡加速。仍可使用对象列表和交互记录。'+String(cause).slice(0,180)}
}
async function refresh(){
 clearTimeout(timer);if(disposed||replay.value||paused.value||document.hidden)return
 const current=++revision,requested=chosenSession.value
 try{
  const next=await window.myplane.runtimeGraphSnapshot(requested||undefined)
  if(disposed||replay.value||paused.value||current!==revision)return
  graph.value=next;error.value=''
  if(!requested&&next.sessionId)chosenSession.value=next.sessionId
  if(!next.nodes.some(node=>node.id===selectedId.value))selectedId.value=next.nodes[0]?.id||''
 }catch(cause){if(!disposed&&current===revision)error.value='运行记录更新失败：'+String(cause)}
 finally{if(!disposed&&!paused.value&&current===revision)timer=setTimeout(refresh,1000)}
}
function stopPlayback(){playing.value=false;clearTimeout(playTimer)}
async function seekFrame(index:number){
 const requested=chosenSession.value,frame=history.value.entries[index],generation=++frameRevision
 if(!frame||!replay.value)return
 historyBusy.value=true
 try{const value=await window.myplane.runtimeGraphFrame(requested,frame.id);if(disposed||generation!==frameRevision||!replay.value||requested!==chosenSession.value)return;frameIndex.value=index;graph.value={...value.snapshot,sessions:graph.value.sessions};if(!graph.value.nodes.some(node=>node.id===selectedId.value))selectedId.value='task:root';historyNotice.value='';return true}
 catch(cause){if(generation===frameRevision){historyNotice.value=String(cause);stopPlayback()}}
 finally{if(generation===frameRevision)historyBusy.value=false}
}
async function enterReplay(){
 if(!graph.value.sessionId)return
 const requested=graph.value.sessionId,generation=++frameRevision;historyBusy.value=true;historyNotice.value=''
 try{const value=await window.myplane.runtimeGraphHistory(requested);if(disposed||generation!==frameRevision||requested!==graph.value.sessionId)return;history.value=value;if(!value.entries.length){historyNotice.value='此会话暂无可回放快照。新执行产生状态变化后会自动记录。';return}replay.value=true;paused.value=false;revision++;clearTimeout(timer);scene?.setPaused(true);const loaded=await seekFrame(value.entries.length-1);if(!loaded&&requested===chosenSession.value&&replay.value){const message=historyNotice.value;returnLive();historyNotice.value=message}}
 catch(cause){if(generation===frameRevision)historyNotice.value=String(cause)}
 finally{if(!disposed)historyBusy.value=false}
}
function returnLive(){stopPlayback();frameRevision++;historyBusy.value=false;replay.value=false;paused.value=false;historyNotice.value='';scene?.setPaused(false);void refresh()}
function togglePlayback(){if(playing.value){stopPlayback();return}playing.value=true;const next=async()=>{if(!playing.value||!replay.value||disposed)return;if(frameIndex.value>=history.value.entries.length-1){stopPlayback();return}await seekFrame(frameIndex.value+1);if(playing.value)playTimer=setTimeout(next,1000)};if(frameIndex.value===history.value.entries.length-1){void seekFrame(0).then(()=>{if(playing.value)playTimer=setTimeout(next,1000)})}else void next()}
async function createWorkflow(){if(!graph.value.sessionId)return;workflowBusy.value=true;error.value='';try{workflowId.value=await window.myplane.runtimeGraphWorkflow(graph.value.sessionId);await window.myplane.openWorkflowEditor(workflowId.value)}catch(cause){error.value=String(cause)}finally{workflowBusy.value=false}}
async function openSavedWorkflow(){try{await window.myplane.openWorkflowEditor(workflowId.value)}catch(cause){error.value=String(cause)}}
function changeSession(){revision++;frameRevision++;stopPlayback();historyBusy.value=false;replay.value=false;history.value={entries:[],truncated:false};historyNotice.value='';workflowId.value='';previousSession='';selectedId.value='task:root';relatedOnly.value=false;query.value='';objectFilter.value='all';paused.value=false;scene?.setPaused(false);void refresh()}
function togglePause(){paused.value=!paused.value;scene?.setPaused(paused.value);revision++;clearTimeout(timer);if(!paused.value)void refresh()}
function visibility(){revision++;clearTimeout(timer);if(document.hidden)stopPlayback();else void refresh()}
watch([visibleNodes,visibleEdges],()=>syncScene(),{flush:'post'})
watch(selectedId,id=>scene?.setSelected(id))
onMounted(()=>{
 void initializeScene();void refresh()
 unsubscribe=window.myplane.onRuntimeGraphSelection(id=>{chosenSession.value=id;changeSession()})
 document.addEventListener('visibilitychange',visibility)
 document.addEventListener('keydown',shortcut)
})
onBeforeUnmount(()=>{disposed=true;revision++;frameRevision++;stopPlayback();clearTimeout(timer);unsubscribe?.();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('keydown',shortcut);scene?.dispose()})
</script>

<template>
 <main class="runtime-graph-window">
  <header class="graph-topbar">
   <div class="graph-brand"><span class="graph-brand-icon"><Connection/></span><div><h1>3D 智能体工作台</h1></div></div>
   <label class="graph-session"><span>观察会话</span><select v-model="chosenSession" aria-label="选择运行会话" @change="changeSession"><option v-if="!graph.sessions.length" value="">暂无会话</option><option v-for="session in graph.sessions" :key="session.id" :value="session.id">{{session.active?'● ':''}}{{session.title}}</option></select></label>
   <div class="graph-live" :class="{active:graph.active&&!paused&&!replay}"><i/>{{replay?'历史回放 · 只读':paused?'画面已冻结':graph.active?'实时运行':'已保存状态'}}</div>
   <button class="graph-button" :disabled="historyBusy||!graph.sessionId" data-graph-action="history" title="回放此会话最近保留的 120 帧状态；不影响任务执行" @click="replay?returnLive():enterReplay()">{{replay?'返回实时':'历史回放'}}</button>
   <button v-if="!replay" class="graph-button" :aria-pressed="paused" :title="paused?'恢复刷新与动画':'暂停视图更新，不影响任务执行'" @click="togglePause"><VideoPlay v-if="paused"/><VideoPause v-else/>{{paused?'继续刷新':'暂停刷新'}}</button>
  </header>
  <div v-if="error" class="graph-error" role="alert">{{error}}<button @click="refresh">重试</button></div>
  <p v-if="historyNotice" class="graph-history-notice" role="status">{{historyNotice}}</p>
  <section v-if="replay" class="graph-replay-bar" aria-label="历史回放控制">
   <button class="graph-button" :disabled="historyBusy||!frameIndex" @click="stopPlayback();seekFrame(frameIndex-1)">上一帧</button><button class="graph-button" :disabled="historyBusy||history.entries.length<2" @click="togglePlayback">{{playing?'暂停播放':'播放'}}</button><input :value="frameIndex" type="range" min="0" :max="history.entries.length-1" aria-label="历史时间线" @input="stopPlayback();seekFrame(Number(($event.target as HTMLInputElement).value))"/><button class="graph-button" :disabled="historyBusy||frameIndex>=history.entries.length-1" @click="stopPlayback();seekFrame(frameIndex+1)">下一帧</button><div><strong>{{currentFrame?.label}}</strong><span>{{currentFrame?new Date(currentFrame.at).toLocaleString('zh-CN',{hour12:false}):''}} · {{frameIndex+1}} / {{history.entries.length}}{{history.truncated?' · 较早快照已清理':''}}</span></div>
  </section>
  <section class="graph-body" :class="{'objects-hidden':!sidebarOpen,'details-hidden':!detailsOpen}">
   <aside v-show="sidebarOpen" id="graph-object-panel" class="graph-sidebar">
    <div class="graph-section-heading"><h2>运行对象</h2><span>{{graph.nodes.length}}</span></div>
    <label class="graph-search"><Search/><input v-model="query" aria-label="搜索对象" placeholder="搜索名称或 ID"/><button v-if="query" aria-label="清除对象搜索" @click="query=''"><Close/></button></label>
    <div class="graph-kind-filters"><label v-for="kind in kinds" :key="kind"><input v-model="enabled[kind]" type="checkbox" :aria-label="'显示'+runtimeNodeLabels[kind]"/><span class="graph-shape" :class="kind"/>{{runtimeNodeLabels[kind]}}<em>{{count(kind)}}</em></label></div>
    <label class="graph-dependencies"><input v-model="dependencies" type="checkbox"/>显示任务依赖 <span>虚线</span></label>
    <div class="graph-object-filters" role="group" aria-label="筛选对象状态"><button v-for="filter in (['all','active','attention'] as const)" :key="filter" :data-object-filter="filter" :aria-pressed="objectFilter===filter" @click="objectFilter=filter">{{{all:'全部',active:'运行中',attention:'待处理'}[filter]}}</button></div>
    <p v-if="query||objectFilter!=='all'" class="graph-filter-result">列表匹配 {{listedNodes.length}} 个对象 <button @click="query='';objectFilter='all'">清除</button></p>
    <nav class="graph-object-list" aria-label="运行对象列表">
     <button v-for="node in listedNodes" :key="node.id" :data-object-id="node.id" :data-status="node.status" :class="{selected:node.id===selectedId}" :aria-pressed="node.id===selectedId" :title="node.label+' · '+runtimeStatusLabels[node.status]" @click="select(node.id)" @dblclick="select(node.id,true)"><span class="graph-shape" :class="node.kind" :style="{color:runtimeStatusColors[node.status]}"/><span><strong>{{node.label}}</strong><small>{{runtimeNodeLabels[node.kind]}} · {{runtimeStatusLabels[node.status]}}</small></span><i class="graph-row-state" :style="{background:runtimeStatusColors[node.status]}"/></button>
     <p v-if="!listedNodes.length" class="graph-hint">{{graph.nodes.length?'没有匹配的对象':'运行任务后，这里会出现实际对象。'}}</p>
    </nav>
    <button v-if="!replay" class="graph-button graph-workflow-button" :disabled="workflowBusy||paused||!graph.sessionId" title="把已应用的节点配置和依赖生成独立流程草稿" @click="createWorkflow">{{workflowBusy?'正在生成…':'生成工作流草稿 ↗'}}</button>
    <button v-if="workflowId&&!replay" class="graph-button graph-workflow-button" @click="openSavedWorkflow">打开已生成的流程</button>
    <p class="graph-source-note">来自本机会话的运行记录<br/>最近 {{graph.sessions.length}} 个会话</p>
   </aside>
   <div class="graph-stage">
    <div class="graph-panel-controls"><button class="graph-button graph-icon-button" data-graph-action="objects" :aria-expanded="sidebarOpen" aria-controls="graph-object-panel" :aria-pressed="sidebarOpen" :aria-label="sidebarOpen?'隐藏对象列表':'显示对象列表'" :title="sidebarOpen?'收起对象列表':'展开对象列表'" @click="sidebarOpen=!sidebarOpen"><Menu/></button><span>执行视图</span><button class="graph-button graph-icon-button" data-graph-action="details" :aria-expanded="detailsOpen" aria-controls="graph-detail-panel" :aria-pressed="detailsOpen" :aria-label="detailsOpen?'隐藏节点详情':'显示节点详情'" :title="detailsOpen?'收起节点详情':'展开节点详情'" @click="detailsOpen=!detailsOpen"><Operation/></button></div>
    <div class="graph-stage-heading"><h2 :title="graph.title">{{graph.title}}</h2><div class="graph-stats"><span><b>{{activeCount}}</b> Worker 运行中</span><span><b>{{visibleNodes.length}}</b> 个对象</span><span><b>{{visibleEdges.length}}</b> 条关联</span><span v-if="waitCount" class="needs-attention"><b>{{waitCount}}</b> 项待处理</span></div></div>
    <div ref="host" class="graph-canvas" data-testid="runtime-graph-scene"/>
    <div class="graph-detail-view-label">模型近景<span>点击“全景”返回关联图</span></div>
    <div v-if="graphicsError" class="graph-empty graphics-error" role="alert"><Connection/><strong>3D 视图暂不可用</strong><p>{{graphicsError}}</p><button class="graph-button" @click="initializeScene"><Refresh/>重试 3D</button></div>
    <div v-else-if="!graph.nodes.length" class="graph-empty"><Connection/><strong>等待第一条运行记录</strong><p>在主窗口发起任务，即可观察任务分解与工具交互。</p></div>
    <div v-else-if="!visibleNodes.length" class="graph-empty"><strong>对象已隐藏</strong><p>勾选左侧对象类型恢复显示。</p></div>
    <div class="graph-scene-controls"><button class="graph-button" data-graph-action="fit" title="显示全部对象 · F / Esc" @click="showOverview"><FullScreen/>全景</button><button class="graph-button" data-graph-action="focus" :disabled="!selected||!enabled[selected.kind]" title="查看选中对象近景 · Enter" @click="scene?.focus(selectedId)"><Aim/>聚焦</button><span class="graph-control-divider"/><button class="graph-button" data-graph-action="related" :disabled="!selected||!enabled[selected.kind]" :aria-pressed="relatedOnly" title="只显示选中对象及其直接关联" @click="toggleRelated"><Connection/>仅相关</button></div>
    <div class="graph-legend"><span v-for="status in (['running','complete','waiting','paused','error','queued'] as const)" :key="status"><i :style="{background:runtimeStatusColors[status]}"/>{{runtimeStatusLabels[status]}}</span></div>
    <p class="graph-gesture-hint">拖动旋转 · 右键平移 · 滚轮缩放 <span>F 全景 · Enter 聚焦</span></p>
   </div>
   <aside v-show="detailsOpen" id="graph-detail-panel" class="graph-details">
    <section class="graph-selection">
     <div class="graph-section-heading"><h2>对象详情</h2><span v-if="selected">{{runtimeNodeLabels[selected.kind]}}</span></div>
     <template v-if="selected"><div class="graph-node-status" :style="{color:runtimeStatusColors[selected.status]}"><i/>{{runtimeStatusLabels[selected.status]}}</div><h3>{{selected.label}}</h3><p v-if="selected.activity" class="graph-current-action">{{selected.activity}}</p><p class="graph-detail-text">{{selected.detail||'暂无详细记录。'}}</p><details class="graph-node-metadata"><summary>执行指标与关联 · {{connections.length}} 条</summary><dl><template v-for="metric in selected.metrics" :key="metric.label"><dt>{{metric.label}}</dt><dd>{{metric.value}}</dd></template></dl><div v-if="connections.length" class="graph-relations"><h4>相关关联 <span>{{connections.length}}</span></h4><button v-for="edge in connections" :key="edge.id" @click="select(edge.source===selectedId?edge.target:edge.source,true)"><small>{{edge.label}}</small><span>{{graph.nodes.find(node=>node.id===(edge.source===selectedId?edge.target:edge.source))?.label}} ↗</span></button></div></details></template>
     <p v-else class="graph-hint">选择一个对象，查看状态、执行指标与关联。</p>
    </section>
    <RuntimeNodeEditor v-if="!replay&&graph.sessionId&&selected" :session-id="graph.sessionId" :node-id="selectedId" :frozen="paused" @changed="refresh" @select="select"/>
    <section v-else-if="replay" class="graph-replay-detail"><strong>当时的执行状态</strong><p>这里只展示所选时刻的记录。返回实时视图后可编辑节点或控制当前任务。</p><dl><dt>记录时间</dt><dd>{{currentFrame?new Date(currentFrame.at).toLocaleString():''}}</dd><dt>运行实例</dt><dd>{{currentFrame?.runId}}</dd><dt>配置版本</dt><dd>{{selected?.configRevision===undefined?'当时未记录':'v'+selected.configRevision}}</dd><dt>已使用版本</dt><dd>{{selected?.appliedRevision===undefined?'当时未记录':'v'+selected.appliedRevision}}</dd></dl><button class="graph-button" @click="returnLive">返回实时视图</button></section>

   </aside>
  </section>
    <section class="graph-events graph-event-strip" :class="{expanded:eventsOpen}"><button class="graph-events-toggle" data-graph-action="events" :aria-expanded="eventsOpen" aria-controls="graph-event-list" @click="eventsOpen=!eventsOpen"><ArrowDown/><strong>交互记录</strong><span>{{events.length}}</span></button><span v-if="!eventsOpen" class="graph-event-preview">{{events[0]?time(events[0].at)+' · '+events[0].label:'尚无工具调用或执行进度'}}</span><ol v-show="eventsOpen" id="graph-event-list"><li v-for="event in events" :key="event.id"><button @click="select(event.nodeId)"><i :style="{background:runtimeStatusColors[event.status]}"/><time>{{time(event.at)}}</time><strong>{{event.label}}</strong><span>{{runtimeStatusLabels[event.status]}}</span></button></li></ol><p v-if="eventsOpen&&!events.length" class="graph-hint">尚无工具调用或执行进度。</p></section>
  <footer class="graph-footer"><span><i/>{{replay?'只读回放 · 当前任务继续执行':paused?'视图已暂停，任务继续执行':graph.active?'每秒同步运行状态':'已保存的执行状态'}}<template v-if="graph.updatedAt"> · {{time(graph.updatedAt)}}</template></span><span v-if="graph.truncated">仅显示最近 80 次工具调用和 64 个任务</span><span v-else>实线：归属与调用　虚线：任务依赖　流光：调用 / 返回</span></footer>
 </main>
</template>

<style>
.runtime-graph-window{
 --g-bg:#0a111c;--g-panel:#101b2a;--g-line:#b9d7ff12;--g-text:#dae7f5;--g-dim:#8196af;--g-accent:#79d9df;
 box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;
 background:var(--g-bg);color:var(--g-text);font:12px/1.5 var(--app-font-family,"Segoe UI","Microsoft YaHei",sans-serif);color-scheme:dark;
}
.runtime-graph-window *{box-sizing:border-box}
.runtime-graph-window button,.runtime-graph-window input,.runtime-graph-window select{font:inherit}
.runtime-graph-window button{cursor:pointer}
.runtime-graph-window button:disabled{opacity:.4;cursor:default}
.runtime-graph-window :focus-visible{outline:2px solid var(--g-accent);outline-offset:3px}
.runtime-graph-window h1,.runtime-graph-window h2,.runtime-graph-window h3,.runtime-graph-window p{margin:0}
.runtime-graph-window ::-webkit-scrollbar{width:5px;height:5px}
.runtime-graph-window ::-webkit-scrollbar-thumb{background:#ffffff18;border-radius:5px}
.graph-topbar{height:60px;flex:none;display:flex;align-items:center;gap:18px;padding:0 20px;border-bottom:1px solid var(--g-line);background:#101a28}
.graph-brand{display:flex;align-items:center;gap:10px;flex:none}
.graph-brand-icon{width:30px;height:30px;display:grid;place-items:center;background:#79d9df0b;color:var(--g-accent);border:1px solid #79d9df24;border-radius:8px}
.graph-brand-icon svg{width:17px}
.graph-brand h1{font-size:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.graph-session{display:flex;align-items:center;gap:10px;max-width:330px;min-width:140px;flex:1;border-left:1px solid var(--g-line);padding-left:18px}
.graph-session>span{font-size:10px;color:var(--g-dim);white-space:nowrap}
.graph-session select{width:100%;min-width:0;padding:6px 22px 6px 0;border:0;background:transparent;color:var(--g-text);text-overflow:ellipsis;outline-offset:0}
.graph-session option{background:var(--g-panel)}
.graph-live{margin-left:auto;white-space:nowrap;display:flex;align-items:center;gap:7px;color:var(--g-dim);font-size:11px}
.graph-live i,.graph-footer i,.graph-node-status i{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.graph-live.active{color:#8cd4bb}.graph-live.active i{box-shadow:0 0 0 3px #69dbb012}
.graph-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #c4dcff20;background:#172538;color:var(--g-text);padding:7px 10px;border-radius:7px;white-space:nowrap;font-size:11px}
.graph-button svg{width:14px;height:14px;flex:none}
.graph-button:hover:not(:disabled){border-color:#79d9df66;background:#203448}
.graph-button[aria-pressed=true]{color:#bdf6f5;border-color:#79d9df60;background:#79d9df13}
.graph-topbar>.graph-button{padding:6px 9px;font-size:11px;background:transparent}
.graph-body{--g-left:190px;--g-right:320px;display:grid;grid-template-columns:var(--g-left) minmax(0,1fr) var(--g-right);flex:1;min-height:0}
.graph-body.objects-hidden{--g-left:0px}.graph-body.details-hidden{--g-right:0px}
.graph-sidebar{grid-column:1;grid-row:1;display:flex;flex-direction:column;min-height:0;padding:17px 12px 11px;border-right:1px solid var(--g-line);background:#0e1826}
.graph-section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:13px;gap:12px}
.graph-section-heading h2{font-size:11px;font-weight:600;letter-spacing:.04em}
.graph-section-heading>span{font-size:10px;color:var(--g-dim);white-space:nowrap}
.graph-search{display:flex;align-items:center;gap:7px;border:1px solid #b6d4ff18;border-radius:7px;padding:7px;background:#0a1422}
.graph-search:focus-within{border-color:#79d9df66}.graph-search svg{width:13px;color:var(--g-dim);flex:none}
.graph-search input{background:none;border:0;color:var(--g-text);width:100%;min-width:0;outline:none!important;font-size:11px}
.graph-search input::placeholder{color:#71859e}
.graph-search button{display:grid;place-items:center;flex:none;border:0;background:transparent;padding:0;color:var(--g-dim)}
.graph-kind-filters{display:grid;grid-template-columns:1fr 1fr;gap:10px 8px;padding:15px 0 12px}
.graph-kind-filters label{display:flex;align-items:center;gap:5px;color:#adbed1;font-size:10px;cursor:pointer}
.graph-kind-filters input{margin:0;accent-color:var(--g-accent);width:12px;height:12px}
.graph-kind-filters em{font-style:normal;color:var(--g-dim);margin-left:auto;font-size:10px;font-variant-numeric:tabular-nums}
.graph-shape{display:block;width:9px;height:9px;border:1.5px solid currentColor;color:#a0b9e7;flex:none}
.graph-shape.agent{border-radius:50%}.graph-shape.worker{clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);background:currentColor;border:0}.graph-shape.tool{transform:rotate(45deg);width:7px;height:7px;margin:1px}
.graph-dependencies{display:flex;align-items:center;gap:7px;color:var(--g-dim);font-size:10px;padding-bottom:13px;border-bottom:1px solid var(--g-line)}
.graph-dependencies input{accent-color:var(--g-accent);margin:0}.graph-dependencies span{margin-left:auto;color:#637d96}
.graph-object-filters{display:flex;gap:2px;padding:3px;background:#09121e;border:1px solid var(--g-line);border-radius:7px;margin-top:12px}
.graph-object-filters button{flex:1;border:0;border-radius:4px;background:transparent;color:var(--g-dim);padding:4px 3px;font-size:10px;white-space:nowrap}
.graph-object-filters button[aria-pressed=true]{background:#1b2b3c;color:#d2edf2}
.graph-filter-result{display:flex;justify-content:space-between;font-size:10px;color:var(--g-dim);padding:9px 1px 0}
.graph-filter-result button{background:none;border:0;padding:0;color:var(--g-accent);font-size:10px}
.graph-object-list{flex:1;min-height:0;overflow:auto;padding:9px 0 12px;scrollbar-gutter:stable}
.graph-object-list button{display:flex;align-items:center;gap:9px;width:100%;padding:8px 7px;margin-bottom:3px;text-align:left;border:1px solid transparent;border-radius:7px;color:var(--g-text);background:transparent}
.graph-object-list button.selected{background:#79d9df0d;border-color:#79d9df38;box-shadow:inset 2px 0 #79d9df}
.graph-object-list button:hover{background:#d0e6ff08}.graph-object-list button>span:nth-child(2){flex:1;min-width:0}
.graph-object-list strong{display:block;font-size:11px;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.graph-object-list small{display:block;color:var(--g-dim);font-size:9px;margin-top:3px}
.graph-row-state{width:4px;height:4px;border-radius:50%;flex:none;opacity:.85}
.graph-object-list [data-status=running] .graph-row-state{box-shadow:0 0 0 3px #50d9ef12}
.graph-source-note{border-top:1px solid var(--g-line);padding-top:10px;color:#71849c;font-size:9px;line-height:1.8}
.graph-stage{grid-column:2;grid-row:1;position:relative;min-width:0;overflow:hidden;background:radial-gradient(ellipse at 48% 42%,#1a2a3e 0,#101c2c 48%,#0b1421 100%)}
.graph-canvas{position:absolute;inset:0;isolation:isolate}.graph-canvas>canvas{display:block;width:100%;height:100%;touch-action:none}
.graph-panel-controls{position:absolute;top:12px;left:14px;right:14px;z-index:3;display:flex;align-items:center;gap:9px;pointer-events:none}
.graph-panel-controls>span{font-size:9px;letter-spacing:.12em;color:#809bb6}
.graph-panel-controls .graph-button{pointer-events:auto;width:28px;height:27px;padding:0;background:#102033d9;border-color:#b6d4ff1c;backdrop-filter:blur(8px)}
.graph-panel-controls .graph-button:last-child{margin-left:auto}.graph-panel-controls .graph-button[aria-pressed=false]{color:var(--g-dim)}
.graph-stage-heading{position:absolute;top:51px;left:18px;right:18px;z-index:2;pointer-events:none}
.graph-stage-heading h2{font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;color:#e0eaf5}
.graph-stats{display:flex;gap:14px;margin-top:7px;font-size:10px;color:var(--g-dim);flex-wrap:wrap}
.graph-stats b{font-weight:500;color:#b3cddd;font-size:11px;margin-right:3px;font-variant-numeric:tabular-nums}
.graph-stats .needs-attention,.graph-stats .needs-attention b{color:#dbb97d}
.runtime-node-label{pointer-events:auto;background:#101f30ed;border:1px solid #c3dfff24;border-radius:7px;max-width:142px;min-width:70px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;color:#c3d4e7;padding:5px 9px;font-size:10px;line-height:1.5;cursor:pointer;box-shadow:0 3px 14px #0003;backdrop-filter:blur(7px)}
.runtime-node-label:hover,.runtime-node-label.hovered,.runtime-node-label.selected{color:#efffff;border-color:var(--node-color);background:#1b3244ed;box-shadow:0 4px 18px #0004}
.runtime-node-label.selected,.runtime-node-label.hovered{max-width:150px}
.runtime-node-label.related{border-color:color-mix(in srgb,var(--node-color) 48%,transparent);color:#d4e5f2}
.runtime-node-label.muted{opacity:.75}
.runtime-node-label strong{font-size:10px;display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis}
.runtime-node-label small{display:block;font-size:9px;color:var(--node-color);opacity:.9;max-width:132px;overflow:hidden;text-overflow:ellipsis}
.runtime-node-label .runtime-node-activity{color:#9fb6ce;display:none}
.runtime-node-label.selected .runtime-node-activity,.runtime-node-label.hovered .runtime-node-activity{display:block}
.graph-canvas[data-label-density=compact] .runtime-node-label:not(.selected):not(.hovered){max-width:130px;min-width:0;padding:4px 7px}
.graph-canvas[data-label-density=compact] .runtime-node-label:not(.selected):not(.hovered) strong{font-size:9px}
.runtime-node-label[data-status=paused]{border-color:#b3a1ef55}.runtime-node-label[data-status=error]{border-color:#ff829c55}
.graph-scene-controls{position:absolute;bottom:64px;left:17px;z-index:3;display:flex;align-items:center;gap:3px;padding:4px;background:#0d1a2be8;border:1px solid #b4d8ff20;border-radius:9px;box-shadow:0 5px 18px #0002;backdrop-filter:blur(10px)}
.graph-scene-controls .graph-button{font-size:10px;background:transparent;padding:6px 9px;border-color:transparent;border-radius:5px}
.graph-scene-controls .graph-button:hover:not(:disabled){background:#ffffff0a;border-color:#b4d8ff28}
.graph-scene-controls .graph-button[aria-pressed=true]{background:#79d9df19;color:#bdf6f5;border-color:#79d9df3d}
.graph-control-divider{height:15px;border-left:1px solid #b4d8ff20;margin:0 3px}
.graph-legend{position:absolute;bottom:33px;left:19px;right:14px;display:flex;gap:11px;flex-wrap:wrap;pointer-events:none}
.graph-legend span{display:flex;align-items:center;gap:5px;color:#91a8c0;font-size:9px}.graph-legend i{width:4px;height:4px;border-radius:50%}
.graph-gesture-hint{position:absolute;bottom:12px;left:19px;right:14px;font-size:9px;color:#6f89a3;pointer-events:none;white-space:nowrap}
.graph-gesture-hint span{margin-left:10px;color:#58738d}
.graph-detail-view-label{display:none;position:absolute;top:111px;left:18px;z-index:2;color:#b8cfdf;font-size:10px;pointer-events:none}
.graph-detail-view-label span{display:block;margin-top:3px;color:#7892aa;font-size:9px}
.graph-canvas[data-view=detail]~.graph-detail-view-label{display:block}
.graph-details{grid-column:3;grid-row:1;overflow:auto;background:#101a29;border-left:1px solid var(--g-line);min-height:0;display:flex;flex-direction:column;scrollbar-gutter:stable}
.graph-selection{padding:18px 16px 15px;flex:none;min-height:0;overflow:visible}
.graph-node-status{display:flex;align-items:center;gap:6px;font-size:10px;margin:2px 0 7px}
.graph-selection h3{font-size:14px;font-weight:500;line-height:1.6;overflow-wrap:anywhere}
.graph-current-action{margin-top:7px!important;color:#a4dfe3;font-size:11px;line-height:1.7}
.graph-detail-text{font-size:10px;line-height:1.8;color:#8fa4bc;white-space:pre-wrap;overflow-wrap:anywhere;max-height:58px;overflow:auto;margin-top:8px!important;user-select:text}
.graph-node-metadata{margin-top:11px;color:#829bb8;font-size:10px}.graph-node-metadata summary{cursor:pointer}
.graph-selection dl{display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px 9px;font-size:10px;margin:15px 0 0;max-height:145px;overflow:auto}
.graph-selection dt{color:#7e95af}.graph-selection dd{margin:0;color:#b9cbe2;overflow-wrap:anywhere;white-space:pre-wrap;user-select:text}
.graph-relations{margin-top:15px;border-top:1px solid var(--g-line);padding-top:10px;max-height:125px;overflow:auto}
.graph-relations h4{font-size:10px;font-weight:500;margin:0 0 8px}.graph-relations h4 span{color:var(--g-dim);margin-left:6px}
.graph-relations button{display:flex;flex-direction:column;gap:3px;max-width:100%;background:transparent;border:0;color:#a8c4df;text-align:left;padding:5px 0;font-size:10px}
.graph-relations button span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.graph-relations small{color:#7490aa;font-size:9px}
.graph-details .node-editor{flex:none;padding:15px 16px}
.graph-event-strip{display:flex;align-items:center;gap:18px;flex:none;height:34px;padding:0 18px;border-top:1px solid var(--g-line);background:#0d1724;min-height:0;overflow:hidden}
.graph-event-strip.expanded{height:76px}
.graph-events-toggle{display:flex;align-items:center;gap:8px;flex:none;padding:4px 0;color:#a5b9ce;border:0;background:none}
.graph-events-toggle svg{width:11px;height:11px;transform:rotate(-90deg)}.graph-event-strip.expanded .graph-events-toggle svg{transform:rotate(0)}
.graph-events-toggle strong{font-size:10px;font-weight:500}.graph-events-toggle>span{font-size:9px;color:#7c94ac;padding:0 5px;background:#b5d7ff0b;border-radius:4px}
.graph-event-preview{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#6e87a0;font-size:10px}
.graph-event-strip ol{display:flex;gap:18px;overflow:auto;margin:0;padding:4px;min-width:0;align-items:center;list-style:none}
.graph-event-strip li{flex:none;border-left:1px solid #b4d8ff17;padding-left:13px;max-width:270px}
.graph-event-strip li button{display:grid;grid-template-columns:5px 52px 1fr;gap:3px 7px;width:100%;border:0;background:none;color:#aabed2;text-align:left;padding:4px 0}
.graph-event-strip li i{width:4px;height:4px;border-radius:50%;margin-top:4px}
.graph-event-strip li time{font-size:9px;color:#6f8ba4;grid-column:2/4;font-variant-numeric:tabular-nums}
.graph-event-strip li strong{grid-column:2/4;max-width:225px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:10px;font-weight:400;line-height:1.7}
.graph-event-strip li button>span{display:none}.graph-event-strip li button:hover strong{color:var(--g-accent)}
.graph-footer{height:26px;flex:none;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 18px;font-size:9px;color:#6d859e;background:#0b1420;border-top:1px solid var(--g-line)}
.graph-footer>span:first-child{display:flex;align-items:center;gap:6px}.graph-footer i{width:4px;height:4px;color:#72aeb8}
.graph-empty{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:50px;gap:12px;background:#0b1423a6}
.graph-empty>svg{width:34px;color:#62839f}.graph-empty strong{font-size:15px;font-weight:500}.graph-empty p{font-size:11px;color:var(--g-dim);line-height:1.9;max-width:350px}
.graph-hint{font-size:11px;line-height:1.8;color:var(--g-dim);padding:10px 0}
.graph-error{padding:8px 20px;background:#462835;color:#ffb5c2;font-size:11px}.graph-error button{color:inherit;background:transparent;border:0;text-decoration:underline;margin-left:10px}
.graph-replay-bar{display:flex;align-items:center;gap:10px;flex:none;padding:10px 18px;background:#191e31;border-bottom:1px solid #b3a1ef26}
.graph-replay-bar input{flex:1;min-width:60px;accent-color:#b3a1ef}.graph-replay-bar>div{min-width:190px;max-width:300px}
.graph-replay-bar strong,.graph-replay-bar span{display:block;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.graph-replay-bar span{color:#9fabc4;margin-top:3px}
.graph-replay-bar .graph-button{padding:5px 8px;font-size:10px}
.graph-history-notice{padding:8px 18px!important;background:#24233a;color:#c4bce8}
.graph-replay-detail{padding:18px 16px;border-top:1px solid var(--g-line);color:#b3a1ef}.graph-replay-detail p{margin:12px 0;color:#9bacc6;line-height:1.9}
.graph-replay-detail dl{display:grid;grid-template-columns:75px 1fr;gap:10px;font-size:11px;margin:18px 0}.graph-replay-detail dd{margin:0;overflow-wrap:anywhere;color:#c0cfe3}.graph-replay-detail dt{color:#8192ad}
.graph-workflow-button{margin:6px 0 10px;font-size:10px;padding:6px 8px}
@media(min-width:1600px){.graph-body{--g-left:210px;--g-right:350px}}
@media(max-width:1150px){
 .graph-body{--g-left:170px;--g-right:310px}.graph-topbar{gap:10px;padding:0 14px}.graph-brand{gap:8px}.graph-brand h1{font-size:12px}.graph-session{padding-left:10px}.graph-session>span{display:none}.graph-topbar .graph-live{font-size:10px}.graph-topbar>.graph-button{font-size:10px;padding:6px 7px}
 .graph-sidebar{padding:15px 10px 10px}.graph-kind-filters{gap:10px 7px}.graph-kind-filters .graph-shape{display:none}.graph-stats{gap:10px}.graph-gesture-hint span{display:none}
}
@media(max-width:980px){.graph-body{--g-left:155px;--g-right:300px}.graph-brand-icon{display:none}.graph-stage-heading{left:14px;right:14px}.graph-stage-heading h2{font-size:13px}.graph-stats{gap:7px;font-size:9px}.graph-legend{gap:8px}.graph-footer>span:last-child{display:none}}
@media(max-height:680px){.graph-topbar{height:54px}.graph-stage-heading{top:46px}.graph-selection{padding:14px}.graph-detail-text{max-height:40px}.graph-event-strip.expanded{height:64px}}
.graph-body.objects-hidden{--g-left:0px}.graph-body.details-hidden{--g-right:0px}
@media(prefers-reduced-motion:reduce){.runtime-graph-window *{scroll-behavior:auto!important}}
</style>
