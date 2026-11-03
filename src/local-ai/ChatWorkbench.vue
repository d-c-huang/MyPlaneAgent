<script setup lang="ts">
import {conversationTaskRows,conversationTaskLabel,taskNeedsAttention} from '../../electron/shared/conversation-status'
import ConversationRunStatus from './ConversationRunStatus.vue'
import VisualReviewCard from './VisualReviewCard.vue'
import {visualReviewCard,visualDecisionText,type VisualDecision} from '../../electron/shared/visual-review'
import ConversationOutline from './ConversationOutline.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowRight, ArrowUp, Close, Compass, Connection, DataLine, Download, Files, FolderOpened, EditPen, Grid, MoreFilled, Operation, Search, Setting, VideoPause, Share } from '@element-plus/icons-vue'
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
const emit = defineEmits<{models: []; menu: []; performance: []; inspector: []; runtimeGraph: []}>()
const ch = reactive(props.studio)
const visualItem=computed(()=>{const item=ch.session?.taskPlan?.items.find(item=>item.status!=='complete');return item&&visualReviewCard(item,ch.messages)?item:undefined})
async function decideVisual(value:VisualDecision){
 if(locked.value||!visualItem.value)return
 await ch.send(false,{text:visualDecisionText(visualItem.value,value),images:[],visualDecision:value})
}
const locked = computed(() => ch.sending || ch.sessionBusy || ch.selectingChatModel)
const navigationLocked = computed(() => ch.sessionBusy || ch.selectingChatModel)
const hasConversation = computed(() => ch.messages.length > 0)
const historyOpen = ref(false)
const selectedArtifact = ref<ChatArtifact>()
const artifacts = computed(()=>chatArtifacts(ch.messages))
const taskList=computed(()=>ch.session?.taskPlan?visibleTaskPlan(ch.session.taskPlan):undefined)
const taskRows=computed(()=>conversationTaskRows(ch.session?.taskPlan))
const attentionRows=computed(()=>taskRows.value.filter(taskNeedsAttention))
const taskFilter=ref<'all'|'attention'>('all')
const visibleTaskRows=computed(()=>taskFilter.value==='attention'?attentionRows.value:taskRows.value)
const taskPanelOpen=ref(false)
const toolsMenu=ref<HTMLDetailsElement>()
function closeTools(){if(toolsMenu.value){toolsMenu.value.open=false;toolsMenu.value.querySelector('summary')?.focus()}}
function toolsKey(event:KeyboardEvent){
 if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!toolsMenu.value)return
 event.preventDefault();toolsMenu.value.open=true
 const trigger=toolsMenu.value.querySelector(':scope > summary')
 const buttons=[...toolsMenu.value.querySelectorAll<HTMLElement>('button:not(:disabled),details > summary')].filter(element=>{
  const collapsed=element.closest('details:not([open])')
  return element!==trigger&&(!collapsed||collapsed.querySelector(':scope > summary')===element)&&element.checkVisibility()
 }),current=buttons.indexOf(document.activeElement as HTMLElement)
 const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:current<0?buttons.length-1:(current-1+buttons.length)%buttons.length
 buttons[index]?.focus()
}
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
watch(()=>ch.session?.id,()=>{selectedArtifact.value=undefined;taskPanelOpen.value=false;taskFilter.value='all';if(toolsMenu.value)toolsMenu.value.open=false})
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
      <header><div class="conversation-brand"><span class="conversation-brand-mark" aria-hidden="true">M</span><div><strong>MyPlaneAgent</strong><small class="conversation-activity" :class="{active:ch.activeRunCount>0}" role="status" aria-live="polite"><i v-if="ch.activeRunCount" aria-hidden="true"/>{{ch.activeRunCount?`${ch.activeRunCount} 个任务进行中`:'会话与工作'}}</small></div></div><button class="agent-icon agent-history-close" aria-label="收起会话导航" @click="historyOpen=false"><Close/></button></header>
      <button class="agent-new new-conversation-button" :disabled="navigationLocked" aria-label="新建会话" @click="selectSession()"><EditPen/><span>新建会话</span><span aria-hidden="true">＋</span></button>
      <label class="workspace-search"><Search/><input v-model="ch.sessionFilter" placeholder="搜索会话" aria-label="搜索会话"/><button v-if="ch.sessionFilter" class="agent-icon" aria-label="清除搜索" @click="ch.sessionFilter=''"><Close/></button></label>
      <ChatHistorySidebar :studio="studio" @open="selectSession"/>
      <footer class="conversation-navigation-footer">
        <button type="button" class="workspace-menu-button" title="打开工作区控制台与应用设置" aria-label="打开工作区菜单" @click="historyOpen=false;emit('menu')"><Grid/><span>工作区与设置</span><ArrowRight/></button>
        <button type="button" class="conversation-connection" aria-label="模型与连接设置" @click="historyOpen=false;emit('models')"><span class="connection-indicator" :class="{online:ch.online}"/><span>{{ch.online?'模型已连接':'连接模型'}}<small>模型与服务</small></span><Setting/></button>
      </footer>
    </aside>
    <section class="agent-main" :inert="taskDrawerOpen" :class="{'is-welcome':!hasConversation,'has-message-outline':ch.messages.filter(message=>message.role==='user').length>1}">
      <header class="agent-toolbar">
        <button class="agent-icon agent-history-toggle" :aria-label="ch.activeRunCount?`展开会话导航，${ch.activeRunCount} 个任务进行中`:'展开会话导航'" :aria-expanded="historyOpen" @click="historyOpen=!historyOpen"><Grid/><span v-if="ch.activeRunCount" class="navigation-run-count" aria-hidden="true">{{ch.activeRunCount}}</span></button>
        <div class="workspace-heading">
          <strong>{{hasConversation?ch.session?.title:'新会话'}}</strong>
          <button type="button" class="agent-workspace-picker" :disabled="locked" :title="ch.chatWorkspacePath||'选择工作目录，启用文件与命令工具'" aria-label="选择聊天工作目录" @click="ch.chooseChatWorkspace">
            <FolderOpened/>
            <span>{{ch.chatWorkspaceLabel}}</span>
          </button>
        </div>
        <div class="toolbar-actions">
          <button v-if="artifacts.length" class="artifact-toggle" @click="selectedArtifact=selectedArtifact?undefined:artifacts[artifacts.length-1]">产物 {{artifacts.length}}</button>
          <button v-if="taskList" ref="taskTrigger" type="button" class="task-list-toggle" aria-controls="floating-task-list" :aria-expanded="taskPanelOpen" @click="toggleTaskPanel">任务 {{taskList.completed}}/{{taskList.total}}<i v-if="attentionRows.length" class="task-attention-dot" aria-label="有待处理事项"></i></button>
          <details ref="toolsMenu" data-floating-menu class="conversation-tools-menu" @keydown="toolsKey">
            <summary class="agent-icon" aria-label="会话工具" title="会话工具"><MoreFilled/></summary>
            <div class="conversation-tools-popover">
              <span class="conversation-tools-heading">会话工具</span>
              <button type="button" aria-label="打开 3D 运行视图" @click="closeTools();emit('runtimeGraph')"><Share/><span>3D 运行视图</span><small>↗</small></button>
              <button v-if="showPerformanceLauncher" type="button" aria-label="显示性能窗口" @click="closeTools();emit('performance')"><DataLine/><span>性能窗口</span><small>↗</small></button>
              <button v-if="showInspectorLauncher" type="button" aria-label="显示执行检查器" @click="closeTools();emit('inspector')"><Operation/><span>执行检查器</span><small>↗</small></button>
              <button type="button" aria-label="打开内置浏览器" @click="closeTools();openBrowser()"><Connection/><span>内置浏览器</span><small>↗</small></button>
              <details v-if="ch.session?.messages.length" class="conversation-export-options"><summary aria-label="导出会话"><Download/><span>导出会话</span><ArrowRight/></summary><div><button v-for="format in (['pdf','md','json'] as const)" :key="format" type="button" :disabled="locked" @click="closeTools();ch.exportSession(format)">{{({pdf:'PDF 文档',md:'Markdown',json:'JSON 数据'})[format]}}</button></div></details>
              <div v-if="hasConversation" class="conversation-tools-usage"><TokenUsageDisplay :usage="ch.session?.usage" :pending="ch.sending" label="累计 Tokens" compact/></div>
            </div>
          </details>
        </div>
      </header>
      <ConversationRunStatus v-if="hasConversation" :messages="ch.messages" :sending="ch.sending" :loading="ch.sessionBusy" :approval="!!ch.chatApproval" :plan="ch.session?.taskPlan" :context="ch.session?.context" @open-tasks="openTasks"/>
      <div ref="scroller" class="agent-scroll message-scroll" :class="{'is-empty':!hasConversation}" @scroll="ch.trackScroll">
        <section v-if="!hasConversation" class="agent-welcome">
          <div class="welcome-intro">
            <div class="welcome-copy">
              <div class="agent-welcome-label" aria-hidden="true"><span>M</span></div>
              <h1>有什么可以帮你？</h1>
              <p>提问、梳理思路，或一起完成一项工作。</p>
            </div>
          </div>
          <div class="conversation-starters">
            <button type="button" @click="useStarter('分析当前项目的结构，说明主要模块与下一步建议，先不修改代码。')">
              <span class="starter-icon"><Compass aria-hidden="true"/></span>
              <strong>探索项目</strong>
              <small>读懂结构与思路</small>
            </button>
            <button type="button" @click="useStarter('帮我定位并修复这个问题，先核对原因，修改后验证结果：')">
              <span class="starter-icon"><EditPen aria-hidden="true"/></span>
              <strong>解决问题</strong>
              <small>定位原因并验证</small>
            </button>
            <button type="button" @click="useStarter('帮我整理以下资料，归纳重点与待确认的问题：')">
              <span class="starter-icon"><Files aria-hidden="true"/></span>
              <strong>整理资料</strong>
              <small>提炼重点与待办</small>
            </button>
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
        <p v-if="!hasConversation" class="conversation-composer-note">Enter 发送<span>·</span>Shift + Enter 换行</p>
      </div>
    </section>
    <button v-if="taskDrawerOpen" type="button" class="task-panel-backdrop" aria-label="收起任务清单" tabindex="-1" @click="closeTasks"></button>
    <aside v-if="taskList&&taskPanelOpen" ref="taskPanel" id="floating-task-list" class="floating-task-list" :role="taskDrawerOpen?'dialog':undefined" :aria-modal="taskDrawerOpen||undefined" aria-label="当前任务清单" @keydown="taskPanelKey">
      <header class="task-panel-header">
        <div class="task-panel-title">
          <strong>目标与进度</strong>
          <span class="task-progress-badge">{{taskList.completed}}/{{taskList.total}}</span>
        </div>
        <button type="button" class="agent-icon task-panel-close" aria-label="收起任务清单" @click="closeTasks"><Close/></button>
      </header>
      <div class="task-list-progress" role="progressbar" aria-label="任务完成进度" :aria-valuenow="taskList.completed" aria-valuemin="0" :aria-valuemax="taskList.total"><span :style="{width:`${taskList.total?taskList.completed/taskList.total*100:0}%`}"/></div>

      <div v-if="ch.session?.taskPlan?.scope?.goal" class="task-panel-goal" :title="ch.session.taskPlan.scope.goal">
        <p>{{ch.session.taskPlan.scope.goal}}</p>
      </div>

      <div v-if="attentionRows.length" class="task-panel-filters" aria-label="筛选任务">
        <button type="button" :aria-pressed="taskFilter==='all'" @click="taskFilter='all'">全部 ({{taskList.total}})</button>
        <button type="button" :aria-pressed="taskFilter==='attention'" @click="taskFilter='attention'">待处理 ({{attentionRows.length}})</button>
      </div>

      <p v-if="!visibleTaskRows.length" class="task-panel-empty">无处理事项</p>
      <ol v-else class="task-panel-list">
        <li v-for="entry in visibleTaskRows" :key="entry.item.id" :class="'task-'+entry.status" :style="{'--task-depth':taskFilter==='all'?entry.depth:0}">
          <span class="task-status-icon" aria-hidden="true">{{entry.status==='complete'?'✓':entry.status==='blocked'?'!':entry.status==='running'||entry.status==='verifying'?'•':'○'}}</span>
          <div class="task-content">
            <div class="task-title" :title="entry.item.title">{{entry.item.title}}</div>
            <div class="task-meta">{{conversationTaskLabel(entry)}}<template v-if="entry.item.worker"> · {{({read:'读取',write:'修改',verify:'验收'})[entry.item.worker.mode]}}</template></div>
            <p v-if="entry.status==='blocked'" class="task-blocked-msg" :title="entry.attention?.completionReview?.reason||entry.attention?.summary">{{entry.attention?.completionReview?.reason||entry.attention?.summary||'请查看执行记录'}}</p>
            <details v-if="entry.item.acceptance" class="task-acceptance"><summary>完成条件</summary><span>{{entry.item.acceptance}}</span></details>
          </div>
        </li>
      </ol>
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
