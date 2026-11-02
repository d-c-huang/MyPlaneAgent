<script setup lang="ts">
import {conversationTaskRows,conversationTaskLabel,taskNeedsAttention} from '../../electron/shared/conversation-status'
import ConversationRunStatus from './ConversationRunStatus.vue'
import VisualReviewCard from './VisualReviewCard.vue'
import {visualReviewCard,visualDecisionText,type VisualDecision} from '../../electron/shared/visual-review'
import ConversationOutline from './ConversationOutline.vue'
import SessionExportMenu from './SessionExportMenu.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowRight, ArrowUp, Close, Compass, Connection, DataLine, Files, FolderOpened, Download, EditPen, Grid, MagicStick, Operation, Search, Setting, VideoPause } from '@element-plus/icons-vue'
import { ElDialog } from 'element-plus'
import { LOCAL_AI_MAX_OUTPUT_TOKENS } from '../../electron/shared/local-ai'
import type { useLocalAiStudio } from './useLocalAiStudio'
import ChatArtifactPanel from './ChatArtifactPanel.vue'
import {chatArtifacts,type ChatArtifact} from '../../electron/shared/chat-presentation'
import ChatHistorySidebar from './ChatHistorySidebar.vue'
import WorkspaceChatMessages from './WorkspaceChatMessages.vue'
import TokenUsageDisplay from './TokenUsageDisplay.vue'
import ContextUsageDisplay from './ContextUsageDisplay.vue'
import ChatComposerSelect from './ChatComposerSelect.vue'
import ChatPermissionSelect from './ChatPermissionSelect.vue'
import ChatApprovalButton from './ChatApprovalButton.vue'
import {visibleTaskPlan} from '../../electron/shared/task-plan-presentation'

const props = defineProps<{studio: ReturnType<typeof useLocalAiStudio>;showPerformanceLauncher:boolean;showInspectorLauncher:boolean}>()
const emit = defineEmits<{models: [];performance: [];inspector: []}>()
const ch = reactive(props.studio)
const visualItem=computed(()=>{const item=ch.session?.taskPlan?.items.find(item=>item.status!=='complete');return item&&visualReviewCard(item,ch.messages)?item:undefined})
async function decideVisual(value:VisualDecision){
 if(locked.value||!visualItem.value)return
 await ch.send(false,{text:visualDecisionText(visualItem.value,value),images:[],visualDecision:value})
}
const locked = computed(() => ch.sending || ch.sessionBusy || ch.selectingChatModel)
const hasConversation = computed(() => ch.messages.length > 0)
const historyOpen = ref(false)
const selectedArtifact = ref<ChatArtifact>()
const artifacts = computed(()=>chatArtifacts(ch.messages))
const taskList=computed(()=>ch.session?.taskPlan?visibleTaskPlan(ch.session.taskPlan):undefined)
const taskRows=computed(()=>conversationTaskRows(ch.session?.taskPlan))
const attentionRows=computed(()=>taskRows.value.filter(taskNeedsAttention))
const taskFilter=ref<'all'|'attention'>('all')
const visibleTaskRows=computed(()=>taskFilter.value==='attention'?attentionRows.value:taskRows.value)
const taskPanelOpen=ref(true)
const workspaceRoot=ref<HTMLElement>(),taskPanel=ref<HTMLElement>(),taskTrigger=ref<HTMLButtonElement>()
const compactLayout=ref(false)
const taskDrawerOpen=computed(()=>compactLayout.value&&taskPanelOpen.value&&!!taskList.value)
function toggleTaskPanel(){taskPanelOpen.value=!taskPanelOpen.value;if(taskPanelOpen.value)selectedArtifact.value=undefined}
function openTasks(){selectedArtifact.value=undefined;taskFilter.value=attentionRows.value.length?'attention':'all';taskPanelOpen.value=true}
async function closeTasks(){taskPanelOpen.value=false;await nextTick();taskTrigger.value?.focus()}
function taskPanelKey(event:KeyboardEvent){
 if(event.key==='Escape'){event.stopPropagation();closeTasks();return}
 if(event.key!=='Tab'||!taskDrawerOpen.value)return
 const elements=[...taskPanel.value?.querySelectorAll<HTMLElement>('button,summary,a[href],input,select,textarea,[tabindex="0"]')||[]].filter(element=>element.offsetParent!==null&&!element.hasAttribute('disabled'))
 const first=elements[0],last=elements.at(-1)
 if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
}
watch(taskDrawerOpen,async open=>{await nextTick();if(open)taskPanel.value?.querySelector<HTMLButtonElement>('.task-panel-close')?.focus();else taskTrigger.value?.focus()})
watch(selectedArtifact,value=>{if(value)taskPanelOpen.value=false})
watch(artifacts,values=>{
 const selected=selectedArtifact.value
 if(!selected)return
 const messagePrefix=selected.id.slice(0,selected.id.indexOf(':')+1)
 const latest=values.find(item=>item.path===selected.path&&item.id.startsWith(messagePrefix))
 if(latest)selectedArtifact.value=latest
})
watch(()=>ch.session?.id,()=>{selectedArtifact.value=undefined;taskPanelOpen.value=!compactLayout.value;taskFilter.value='all'})
const scroller = ref<HTMLElement>()
const composerElement = ref<HTMLElement>()
const composerHeight = ref(180)
const settingsOpen = ref(false)
const settingsTrigger = ref<HTMLButtonElement>()
const settingsTheme = ref<Record<string, string>>({})
let composerObserver: ResizeObserver | undefined
let layoutObserver:ResizeObserver|undefined
let composerResizeFrame=0,layoutResizeFrame=0
watch(scroller, value => { ch.scroller = value })
watch(() => ch.tab, value => { if (value !== 'chat') { historyOpen.value = false; settingsOpen.value = false } })
onMounted(() => {
  composerObserver = new ResizeObserver(() => {
    const height = composerElement.value?.getBoundingClientRect().height
    if(height&&Math.ceil(height)!==composerHeight.value){cancelAnimationFrame(composerResizeFrame);composerResizeFrame=requestAnimationFrame(()=>{composerHeight.value=Math.ceil(height)})}
  })
  if (composerElement.value) composerObserver.observe(composerElement.value)
  layoutObserver=new ResizeObserver(([entry])=>{const compact=entry.contentRect.width<=760;if(compact===compactLayout.value)return;cancelAnimationFrame(layoutResizeFrame);layoutResizeFrame=requestAnimationFrame(()=>{if(compact&&!compactLayout.value)taskPanelOpen.value=false;compactLayout.value=compact})})
  if(workspaceRoot.value)layoutObserver.observe(workspaceRoot.value)
})
onBeforeUnmount(() => {composerObserver?.disconnect();layoutObserver?.disconnect();cancelAnimationFrame(composerResizeFrame);cancelAnimationFrame(layoutResizeFrame)})
async function useStarter(text:string){ch.input=text;await nextTick();composerElement.value?.querySelector('textarea')?.focus()}
async function selectSession(id?: string) {
  if (id) await ch.openSession(id)
  else await ch.newSession()
  historyOpen.value = false
}
function openConversationSettings() {
  const source = settingsTrigger.value && getComputedStyle(settingsTrigger.value)
  settingsTheme.value = Object.fromEntries(['--s-bg', '--s-panel', '--s-muted', '--s-border', '--s-text', '--s-dim', '--s-accent', '--s-accent-soft', '--s-on-accent', '--s-danger'].map(name => [name, source?.getPropertyValue(name).trim() || '']))
  settingsOpen.value = true
}
async function openBrowser(){try{await window.myplane.browser('open')}catch(error){ch.error=String(error)}}
async function focusSettingsTrigger() { await nextTick(); settingsTrigger.value?.focus() }
</script>

<template>
  <main ref="workspaceRoot" class="agent-workspace unified-workspace chat-workbench" aria-label="会话工作区" :class="{'task-panel-visible':!!taskList&&taskPanelOpen,'artifact-panel-visible':!!selectedArtifact}" :style="{'--composer-height':composerHeight+'px'}" @keydown.esc="historyOpen=false;selectedArtifact=undefined">
    <button v-if="historyOpen" class="agent-history-backdrop" aria-label="收起会话导航" @click="historyOpen=false"></button>
    <aside class="agent-history" :class="{expanded:historyOpen}">
      <header><div class="conversation-brand"><span class="conversation-brand-mark" aria-hidden="true">M</span><div><strong>MyPlaneAgent</strong><small>会话与工作</small></div></div><button class="agent-icon agent-history-close" aria-label="收起会话导航" @click="historyOpen=false"><Close/></button></header>
      <button class="agent-new new-conversation-button" :disabled="locked" aria-label="新建会话" @click="selectSession()"><EditPen/><span>新建会话</span><span aria-hidden="true">＋</span></button>
      <label class="workspace-search"><Search/><input v-model="ch.sessionFilter" placeholder="搜索会话" aria-label="搜索会话"/><button v-if="ch.sessionFilter" class="agent-icon" aria-label="清除搜索" @click="ch.sessionFilter=''"><Close/></button></label>
      <ChatHistorySidebar :studio="studio" @open="selectSession"/>
    </aside>
    <section class="agent-main" :inert="taskDrawerOpen" :class="{'is-welcome':!hasConversation,'has-message-outline':ch.messages.filter(message=>message.role==='user').length>1}">
      <header class="agent-toolbar">
        <button class="agent-icon agent-history-toggle" aria-label="展开会话导航" :aria-expanded="historyOpen" @click="historyOpen=!historyOpen"><Grid/></button>
        <div class="workspace-heading"><strong>{{hasConversation?ch.session?.title:'新会话'}}</strong><button type="button" class="agent-workspace-picker" :disabled="locked" :title="ch.chatWorkspacePath||'选择工作目录，启用文件与命令工具'" aria-label="选择聊天工作目录" @click="ch.chooseChatWorkspace"><FolderOpened/><span>{{ch.chatWorkspacePath.split(/[\\/]/).filter(Boolean).pop()||'选择工作目录'}}</span></button></div>
        <TokenUsageDisplay v-if="hasConversation" class="agent-token-usage" :usage="ch.session?.usage" :pending="ch.sending" label="Tokens" compact/>
        <button v-if="showPerformanceLauncher" type="button" class="agent-icon window-launcher" title="显示性能窗口" aria-label="显示性能窗口" @click="emit('performance')"><DataLine/><span>性能</span></button>
        <button v-if="showInspectorLauncher" type="button" class="agent-icon window-launcher" title="显示执行检查器" aria-label="显示执行检查器" @click="emit('inspector')"><Operation/><span>检查器</span></button>
        <button type="button" class="agent-icon" title="内置浏览器" aria-label="打开内置浏览器" @click="openBrowser"><Connection/></button>
        <SessionExportMenu v-if="ch.session?.messages.length" :disabled="locked" @select="ch.exportSession"/>
<button v-if="artifacts.length" class="artifact-toggle" @click="selectedArtifact=selectedArtifact?undefined:artifacts[artifacts.length-1]">产物 {{artifacts.length}}</button>
        <button v-if="taskList" ref="taskTrigger" type="button" class="task-list-toggle" aria-controls="floating-task-list" :aria-expanded="taskPanelOpen" @click="toggleTaskPanel">任务 {{taskList.completed}}/{{taskList.total}}<i v-if="attentionRows.length" class="task-attention-dot" aria-label="有待处理事项"></i></button>
        <span class="workspace-local"><i :class="{online:ch.online}"/>{{ch.online?'已连接':'未连接'}}</span>
      </header>
      <ConversationRunStatus v-if="hasConversation" :messages="ch.messages" :sending="ch.sending" :loading="ch.sessionBusy" :approval="!!ch.chatApproval" :plan="ch.session?.taskPlan" :context="ch.session?.context" @open-tasks="openTasks"/>
      <div ref="scroller" class="agent-scroll message-scroll" :class="{'is-empty':!hasConversation}" @scroll="ch.trackScroll">
        <section v-if="!hasConversation" class="agent-welcome">
          <div class="welcome-intro">
            <div class="welcome-copy"><div class="agent-welcome-label"><MagicStick aria-hidden="true"/><span>从一个目标开始</span></div><h1>让每个想法，<br/><span>都成为下一步。</span></h1><p>一起探索、创造，把值得做的事向前推进。</p></div>
            <svg class="welcome-illustration" viewBox="0 0 220 200" fill="none" aria-hidden="true">
              <defs><linearGradient id="welcome-plane" x1="45" y1="33" x2="174" y2="170" gradientUnits="userSpaceOnUse"><stop stop-color="#a78bfa"/><stop offset=".5" stop-color="#7261e8"/><stop offset="1" stop-color="#3c8de8"/></linearGradient><linearGradient id="welcome-trail" x1="14" y1="154" x2="204" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#36cbb0"/><stop offset=".5" stop-color="#8b73ef"/><stop offset="1" stop-color="#f5aa79"/></linearGradient></defs>
              <ellipse cx="112" cy="105" rx="91" ry="55" transform="rotate(-29 112 105)" stroke="url(#welcome-trail)" stroke-opacity=".45" stroke-dasharray="4 6"/>
              <rect x="60" y="46" width="112" height="112" rx="30" transform="rotate(12 60 46)" fill="url(#welcome-plane)" fill-opacity=".12"/>
              <rect x="64" y="35" width="108" height="118" rx="28" transform="rotate(12 64 35)" fill="url(#welcome-plane)"/>
              <path d="m81 85 62-13-28 55-7-28-27-14Z" fill="white" fill-opacity=".95"/><path d="m108 99 35-27" stroke="#7964dc" stroke-width="2.5" stroke-linecap="round"/>
              <rect x="10" y="118" width="55" height="48" rx="15" fill="#39bfa7"/><path d="m26 142 8 7 15-16" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
              <rect x="158" y="33" width="44" height="44" rx="14" fill="#f6ae75"/><path d="m180 43 3 9 9 3-9 3-3 9-3-9-9-3 9-3 3-9Z" fill="white"/>
              <circle cx="47" cy="55" r="5" fill="#7cbce9"/><circle cx="173" cy="159" r="7" fill="#c0a2f7"/><circle cx="100" cy="178" r="3" fill="#f1aa7b"/>
            </svg>
          </div>
          <div class="conversation-starters">
            <button type="button" @click="useStarter('分析当前项目的结构，说明主要模块与下一步建议，先不修改代码。')"><span class="starter-icon"><Compass aria-hidden="true"/></span><span class="starter-number" aria-hidden="true">01</span><strong>探索一个项目</strong><small>理清脉络，发现下一步</small><ArrowRight class="starter-arrow" aria-hidden="true"/></button>
            <button type="button" @click="useStarter('帮我定位并修复这个问题，先核对原因，修改后验证结果：')"><span class="starter-icon"><EditPen aria-hidden="true"/></span><span class="starter-number" aria-hidden="true">02</span><strong>解决一个问题</strong><small>从定位到修改与验证</small><ArrowRight class="starter-arrow" aria-hidden="true"/></button>
            <button type="button" @click="useStarter('帮我整理以下资料，归纳重点与待确认的问题：')"><span class="starter-icon"><Files aria-hidden="true"/></span><span class="starter-number" aria-hidden="true">03</span><strong>整理一些灵感</strong><small>提炼重点，让思路清晰</small><ArrowRight class="starter-arrow" aria-hidden="true"/></button>
          </div>
        </section>
        <WorkspaceChatMessages v-else :messages="ch.messages" :sending="ch.sending" @copy="ch.copy" @regenerate="ch.send(true)" @open-artifact="selectedArtifact=$event" @open-link="ch.openLink"/>
      </div>
      <ConversationOutline :messages="ch.messages" :scroller="scroller" :session-id="ch.session?.id"/>
      <div ref="composerElement" class="agent-composer-wrap">
        <VisualReviewCard v-if="visualItem" :item="visualItem" :messages="ch.messages" :disabled="locked" @decide="decideVisual" @open="ch.openLink"/>
        <section v-if="ch.chatModelLoading" class="chat-model-loading" aria-label="模型切换进度" :aria-busy="true">
          <div class="chat-model-loading-heading"><strong :title="ch.chatModelLoading.name">{{ch.chatModelLoading.name}}</strong><span role="status">{{ch.chatModelLoading.stage}}</span></div>
          <div class="chat-model-loading-track" role="progressbar" aria-label="模型切换进度" :aria-valuetext="ch.chatModelLoading.stage"><span/></div>
        </section>
        <section v-if="ch.chatApproval" class="chat-approval" aria-label="操作批准请求" role="region">
          <header><strong>请求批准 · {{ch.chatApproval.activity.capability}}</strong><span>本次操作的完整参数</span></header>
          <pre>{{JSON.stringify(ch.chatApproval.activity.args,null,2)}}</pre>
          <footer><button type="button" class="agent-secondary" :disabled="ch.approvingChat" @click="ch.approveChat(false)">拒绝</button><ChatApprovalButton :disabled="ch.approvingChat" @approve="ch.approveChat(true,$event)"/></footer>
        </section>
        <ContextUsageDisplay v-if="hasConversation" :context="ch.session?.context" :checkpoint="ch.session?.checkpoint" :has-history="hasConversation" :disabled="locked" :shortcut="ch.sending?'可先记录补充要求，当前执行结束后发送':`Enter 发送 · Shift + Enter 换行${ch.attaching?' · 正在读取图片…':''}`" @compact="ch.compactSession"/>
        <form class="agent-prompt composer" @submit.prevent="ch.send()">
          <div v-if="ch.images.length" class="composer-images"><figure v-for="(image,index) in ch.images" :key="index"><img :src="image.dataUrl" :alt="image.name"/><figcaption>{{image.name}}</figcaption><button type="button" :aria-label="'移除图片 '+(index+1)" :disabled="ch.attaching" @click="ch.removeImage(index)">×</button></figure></div>
          <textarea v-model="ch.input" aria-label="消息" :disabled="ch.sessionBusy" maxlength="100000" :placeholder="ch.sending?'先记下补充要求，当前执行结束后发送…':hasConversation?'补充要求，继续这段对话…':'询问任何问题，或描述你想完成的工作…'" @paste="ch.pasteImages" @keydown="ch.composerKey"></textarea>
          <footer><div class="agent-prompt-options">
            <ChatPermissionSelect v-model="ch.approvalMode" :disabled="locked"/>
            <button ref="settingsTrigger" type="button" class="agent-settings-trigger" title="会话设置" aria-label="会话设置" @click="openConversationSettings"><Setting/></button>
            <ChatComposerSelect :model-value="ch.chatModel" class="conversation-model-select" :models="ch.chatModels" :disabled="locked||!!ch.busy||ch.connecting" @update:model-value="ch.selectChatModel" @manage="emit('models')"/>
          </div><button v-if="ch.sending" type="button" class="agent-primary stop-button" title="停止" aria-label="停止生成" @click="ch.stop"><VideoPause/></button><button v-else class="agent-primary send-button" title="发送" aria-label="发送消息" :disabled="!ch.canSend"><ArrowUp/></button></footer>
        </form>
      </div>
    </section>
    <button v-if="taskDrawerOpen" type="button" class="task-panel-backdrop" aria-label="收起任务清单" tabindex="-1" @click="closeTasks"></button>
    <aside v-if="taskList&&taskPanelOpen" ref="taskPanel" id="floating-task-list" class="floating-task-list" :role="taskDrawerOpen?'dialog':undefined" :aria-modal="taskDrawerOpen||undefined" aria-label="当前任务清单" @keydown="taskPanelKey">
      <header><div><span class="task-panel-eyebrow">当前任务</span><strong>目标与进度</strong><small>{{taskList.completed}} / {{taskList.total}} 个阶段已完成</small></div><button type="button" class="agent-icon task-panel-close" aria-label="收起任务清单" @click="closeTasks"><Close/></button></header>
      <div class="task-list-progress" role="progressbar" aria-label="任务完成进度" :aria-valuenow="taskList.completed" aria-valuemin="0" :aria-valuemax="taskList.total"><span :style="{width:`${taskList.total?taskList.completed/taskList.total*100:0}%`}"/></div>
      <p v-if="ch.session?.taskPlan?.scope?.goal" class="task-list-goal" :title="ch.session.taskPlan.scope.goal"><span>当前目标</span>{{ch.session.taskPlan.scope.goal}}</p>
      <div class="task-panel-filters" aria-label="筛选任务"><button type="button" :aria-pressed="taskFilter==='all'" @click="taskFilter='all'">全部阶段 <span>{{taskList.total}}</span></button><button type="button" :aria-pressed="taskFilter==='attention'" @click="taskFilter='attention'">待处理 <span>{{attentionRows.length}}</span></button></div>
      <p v-if="!visibleTaskRows.length" class="task-panel-empty">目前没有需要你处理的事项。</p>
      <ol v-else><li v-for="entry in visibleTaskRows" :key="entry.item.id" :class="'task-'+entry.status" :style="{'--task-depth':taskFilter==='all'?entry.depth:0}">
        <span class="task-list-mark" aria-hidden="true">{{entry.status==='complete'?'✓':entry.status==='blocked'?'!':entry.status==='running'||entry.status==='verifying'?'…':'○'}}</span>
        <div><strong :title="entry.item.title">{{entry.item.title}}</strong><small class="task-state-label">{{conversationTaskLabel(entry)}}<template v-if="entry.item.worker"> · {{({read:'读取',write:'修改',verify:'验收'})[entry.item.worker.mode]}}</template></small>
          <p v-if="entry.status==='blocked'" :title="entry.attention?.completionReview?.reason||entry.attention?.summary">{{entry.attention?.completionReview?.reason||entry.attention?.summary||'请查看执行记录'}}</p>
          <details v-if="entry.item.acceptance" class="task-acceptance"><summary>完成条件</summary><span>{{entry.item.acceptance}}</span></details>
        </div>
      </li></ol><footer class="task-panel-footer">执行记录保留在对话中，完成状态以实际核验为准。</footer>
    </aside>
    <ChatArtifactPanel v-if="selectedArtifact" :artifact="selectedArtifact" @close="selectedArtifact=undefined" @copy="ch.copy"/>
    <ElDialog v-model="settingsOpen" class="agent-settings agent-settings-dialog" modal-class="agent-settings-overlay" width="min(500px, calc(100vw - 32px))" :style="settingsTheme" :show-close="false" append-to-body align-center @closed="focusSettingsTrigger">
      <template #header><div class="agent-settings-header"><div><strong>会话设置</strong><small>调整联网与生成参数</small></div><button type="button" class="agent-icon" aria-label="关闭会话设置" @click="settingsOpen=false"><Close/></button></div></template>
      <div class="agent-settings-panel"><section class="agent-settings-group"><label class="conversation-web-setting"><span><strong>联网搜索</strong><small>{{ch.approvalMode==='full'?'完全访问模式下，联网始终开启。':'允许搜索和访问网页，调用时遵循任务权限。'}}</small></span><input v-model="ch.webEnabled" type="checkbox" role="switch" aria-label="联网搜索" :disabled="locked||ch.approvalMode==='full'"/></label></section><section class="agent-settings-group"><header><strong>生成参数</strong><small>控制回答风格和输出长度</small></header><div class="agent-settings-grid">
        <label class="agent-setting-field full"><span>系统提示词</span><textarea v-model="ch.systemPrompt" :disabled="locked" maxlength="12000" rows="3" aria-label="系统提示词"/></label>
        <label class="agent-setting-field"><span>最大输出 Tokens</span><input v-model.number="ch.settings.maxTokens" type="number" min="128" :max="LOCAL_AI_MAX_OUTPUT_TOKENS" step="128" :disabled="locked"/></label>
        <label class="agent-setting-field"><span>Temperature</span><input v-model.number="ch.settings.temperature" type="number" min="0" max="2" step="any" :disabled="locked"/></label>
        <label class="agent-setting-field"><span>Top P</span><input v-model.number="ch.settings.topP" type="number" min="0.01" max="1" step="any" :disabled="locked"/></label>
        <label class="agent-setting-field"><span>重复惩罚</span><input v-model.number="ch.settings.repeatPenalty" type="number" min="0.1" max="2" step="any" :disabled="locked"/></label>
      </div></section><footer><button type="button" class="agent-primary" @click="settingsOpen=false">完成</button></footer></div>
    </ElDialog>
  </main>
</template>

<style scoped src="./studio-agent.css"></style>
<style scoped src="./studio-workspace.css"></style>
<style scoped>
.chat-model-loading{margin-bottom:10px;padding:12px 14px;border:1px solid var(--s-border);border-radius:12px;background:var(--s-panel)}
.chat-model-loading-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:5px 12px;margin-bottom:9px;font-size:12px}
.chat-model-loading-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--s-text);font-weight:500}
.chat-model-loading-heading>span{color:var(--s-dim);font-size:11px}
.chat-model-loading-track{height:4px;border-radius:4px;overflow:hidden;background:var(--s-muted)}
.chat-model-loading-track>span{display:block;width:35%;height:100%;border-radius:inherit;background:var(--s-accent);animation:chat-model-loading 1.4s ease-in-out infinite}
@keyframes chat-model-loading{from{transform:translateX(-100%)}to{transform:translateX(386%)}}
@media(prefers-reduced-motion:reduce){.chat-model-loading-track>span{animation:none;width:100%;opacity:.65}}
.agent-prompt-options>.conversation-model-select{margin-left:auto;flex:0 1 220px;min-width:0}.conversation-model-select{max-width:220px}@container studio (max-width:650px){.conversation-model-select{max-width:150px}}
.artifact-toggle{border:1px solid var(--s-border);border-radius:7px;background:var(--s-panel);color:var(--s-text);font-size:12px;padding:5px 9px;white-space:nowrap}
.agent-prompt .agent-prompt-options{flex:1;min-width:0}.agent-prompt-options>.agent-model-select{margin-left:auto;flex:0 1 220px;text-align:right}.conversation-web-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer}.conversation-web-setting>span{display:flex;flex-direction:column;gap:5px}.conversation-web-setting strong{font-size:13px;font-weight:500}.conversation-web-setting small{font-size:11px;line-height:1.6;color:var(--s-dim)}.conversation-web-setting input{appearance:none;flex:none;width:34px;height:20px;border:1px solid var(--s-border);border-radius:12px;background:var(--s-muted);cursor:pointer;position:relative}.conversation-web-setting input::after{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;border-radius:50%;background:var(--s-dim);transition:transform .15s}.conversation-web-setting input:checked{background:var(--s-accent);border-color:var(--s-accent)}.conversation-web-setting input:checked::after{transform:translateX(14px);background:var(--s-on-accent)}.conversation-web-setting input:disabled{opacity:.5;cursor:default}.conversation-web-setting input:focus-visible{outline:2px solid var(--s-accent);outline-offset:3px}
.has-message-outline :deep(.messages){padding-left:48px}
.danger-text{color:var(--s-danger)}
.chat-approval{padding:12px 14px;margin-bottom:10px;border:1px solid var(--s-border);border-radius:12px;background:var(--s-panel);max-height:35vh;overflow:visible}
.approval-scope-hint{font-size:12px;color:var(--s-dim);margin:8px 0}.approval-scope{max-width:100%;min-width:0;border:1px solid var(--s-border);border-radius:8px;padding:6px 8px;background:var(--s-panel);color:var(--s-text);font:inherit}.chat-approval footer{flex-wrap:wrap}
.chat-approval header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:12px}.chat-approval header span{color:var(--s-dim)}
.chat-approval pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:18vh;overflow:auto;margin:8px 0}.chat-approval footer{display:flex;justify-content:flex-end;gap:8px}
@container studio (max-width:650px){.agent-prompt-options{flex-wrap:wrap}.agent-model-select{max-width:130px}}

</style>

<style scoped src="./conversation-workspace.css"></style>
<style scoped src="./conversation-palette.css"></style>
