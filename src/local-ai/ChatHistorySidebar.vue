<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ArrowRight, FolderOpened, MoreFilled, Plus } from '@element-plus/icons-vue'
import type { useLocalAiStudio } from './useLocalAiStudio'
import ChatHistoryRow from './ChatHistoryRow.vue'
const props=defineProps<{studio:ReturnType<typeof useLocalAiStudio>}>()
const emit=defineEmits<{open:[id:string]}>()
const ch=reactive(props.studio)
const locked=computed(()=>ch.sessionBusy||ch.selectingChatModel)
const storageKey='myplane.chat-sidebar.sections'
function savedSections(){try{return JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{return {}}}
const saved=savedSections()
const expanded=reactive({pinned:saved?.pinned!==false,projects:saved?.projects!==false,recent:saved?.recent!==false})
const projectOpen=reactive<Record<string,boolean>>({})
watch(expanded,value=>{try{localStorage.setItem(storageKey,JSON.stringify(value))}catch{/* Session navigation remains usable without local storage. */}})
const query=computed(()=>ch.sessionFilter.trim().toLowerCase())
const matches=(title:string)=>title.toLowerCase().includes(query.value)
const pinned=computed(()=>ch.sessions.filter(item=>item.pinned&&matches(item.title)))
const recent=computed(()=>ch.sessions.filter(item=>!item.pinned&&(!item.projectId||!ch.chatProjects.some(project=>project.id===item.projectId))&&matches(item.title)))
const projects=computed(()=>ch.chatProjects.map(project=>({...project, sessions:ch.sessions.filter(item=>!item.pinned&&item.projectId===project.id&&(matches(project.name)||matches(item.title)))})).filter(project=>matches(project.name)||project.sessions.length))
const visible=(key:keyof typeof expanded)=>expanded[key]||!!query.value
function toggle(key:keyof typeof expanded){expanded[key]=!expanded[key]}
async function createProject(){expanded.projects=true;await ch.createChatProject();if(ch.session?.projectId)projectOpen[ch.session.projectId]=true}
async function newProjectSession(projectId:string){projectOpen[projectId]=true;await ch.newSession(projectId);if(ch.session)emit('open',ch.session.id)}
</script>
<template>
 <nav class="chat-history-sections" aria-label="聊天记录">
  <section class="history-section">
   <header><button class="section-toggle" :aria-expanded="visible('pinned')" aria-controls="pinned-chats" @click="toggle('pinned')"><span>置顶</span><ArrowRight :class="{expanded:visible('pinned')}"/></button></header>
   <div v-show="visible('pinned')" id="pinned-chats">
    <ChatHistoryRow v-for="item in pinned" :key="item.id" :item="item" :selected="item.id===ch.session?.id" :disabled="locked" :run-state="ch.sessionRunState(item.id)" :projects="ch.chatProjects" @open="emit('open',$event)" @pin="ch.organizeSession($event,{pinned:!$event.pinned})" @move="(item,projectId)=>ch.organizeSession(item,{projectId})" @rename="ch.renameSession" @delete="ch.deleteSession"/>
    <p v-if="!pinned.length" class="section-empty">{{query?'没有匹配的置顶会话':'暂无置顶会话'}}</p>
   </div>
  </section>
  <section class="history-section">
   <header><button class="section-toggle" :aria-expanded="visible('projects')" aria-controls="project-chats" @click="toggle('projects')"><span>项目</span><ArrowRight :class="{expanded:visible('projects')}"/></button><details data-floating-menu class="section-menu"><summary aria-label="项目列表操作"><MoreFilled/></summary><div><button @click="ch.refreshChatProjects()">刷新项目</button><button @click="ch.chatProjects.forEach(project=>projectOpen[project.id]=true)">展开所有项目</button><button @click="ch.chatProjects.forEach(project=>projectOpen[project.id]=false)">收起所有项目</button></div></details><button class="icon-button" aria-label="添加项目" title="添加项目" :disabled="locked" @click="createProject"><Plus/></button></header>
   <div v-show="visible('projects')" id="project-chats">
    <div v-for="project in projects" :key="project.id" class="project-group">
     <div class="project-heading"><button class="project-toggle" :title="project.workspace" :aria-expanded="projectOpen[project.id]!==false||!!query" @click="projectOpen[project.id]=projectOpen[project.id]===false"><FolderOpened/><span>{{project.name}}</span><ArrowRight class="project-chevron" :class="{expanded:projectOpen[project.id]!==false||!!query}"/></button><button class="icon-button project-new" :aria-label="`在${project.name}中新建会话`" title="新建项目会话" :disabled="locked" @click="newProjectSession(project.id)"><Plus/></button></div>
     <div v-show="projectOpen[project.id]!==false||!!query" class="project-sessions">
      <ChatHistoryRow v-for="item in project.sessions" :key="item.id" :item="item" :selected="item.id===ch.session?.id" :disabled="locked" :run-state="ch.sessionRunState(item.id)" :projects="ch.chatProjects" @open="emit('open',$event)" @pin="ch.organizeSession($event,{pinned:!$event.pinned})" @move="(item,projectId)=>ch.organizeSession(item,{projectId})" @rename="ch.renameSession" @delete="ch.deleteSession"/>
      <p v-if="!project.sessions.length" class="section-empty">暂无会话</p>
     </div>
    </div>
    <p v-if="!projects.length" class="section-empty">{{query?'没有匹配的项目':'点击 + 添加项目'}}</p>
   </div>
  </section>
  <section class="history-section">
   <header><button class="section-toggle" :aria-expanded="visible('recent')" aria-controls="recent-chats" @click="toggle('recent')"><span>最近</span><ArrowRight :class="{expanded:visible('recent')}"/></button></header>
   <div v-show="visible('recent')" id="recent-chats">
    <ChatHistoryRow v-for="item in recent" :key="item.id" :item="item" :selected="item.id===ch.session?.id" :disabled="locked" :run-state="ch.sessionRunState(item.id)" :projects="ch.chatProjects" @open="emit('open',$event)" @pin="ch.organizeSession($event,{pinned:!$event.pinned})" @move="(item,projectId)=>ch.organizeSession(item,{projectId})" @rename="ch.renameSession" @delete="ch.deleteSession"/>
    <p v-if="!recent.length" class="section-empty">{{query?'没有匹配的会话':'暂无最近会话'}}</p>
   </div>
  </section>
 </nav>
</template>
<style scoped>
.chat-history-sections{flex:1;min-height:0;overflow:auto;padding:8px 2px 160px;scrollbar-width:thin;overscroll-behavior:contain}
.history-section{margin-bottom:6px}.history-section>header{display:flex;align-items:center;gap:3px;min-height:30px;margin:0 3px 2px}
.history-section>header>.section-menu,.history-section>header>.icon-button{opacity:0;pointer-events:none}
.history-section>header:is(:hover,:focus-within,:has(.section-menu[open]))>.section-menu{opacity:1;pointer-events:auto}
.history-section>header:is(:hover,:focus-within,:has(.section-menu[open]))>.icon-button{opacity:1;pointer-events:auto}
.history-section>header:is(:hover,:focus-within,:has(.section-menu[open]))>.icon-button:disabled{opacity:.45}
button,summary{font:inherit;color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}svg{width:16px;height:16px;flex:none}
.section-toggle{display:flex;align-items:center;gap:7px;flex:1;min-width:0;border:0;background:transparent;padding:6px 5px;color:color-mix(in srgb,var(--s-dim) 80%,var(--s-rail));font-size:13px;font-weight:500;text-align:left}.section-toggle svg{width:12px;height:12px;transition:transform .15s}.expanded{transform:rotate(90deg)}
.icon-button,.section-menu>summary{display:grid;place-items:center;width:25px;height:25px;padding:4px;border:0;border-radius:5px;background:transparent;color:var(--s-dim);list-style:none}.icon-button:hover,.section-menu>summary:hover{background:var(--s-accent-soft)}
.section-menu{position:relative}.section-menu>summary::-webkit-details-marker{display:none}.section-menu>div{position:absolute;right:0;top:28px;z-index:25;width:140px;padding:5px;border:1px solid var(--s-border);border-radius:8px;background:var(--s-panel);box-shadow:0 5px 15px #0002}.section-menu button{display:block;width:100%;border:0;border-radius:5px;background:transparent;padding:7px;text-align:left;font-size:12px}.section-menu button:hover{background:var(--s-muted)}
.project-heading{display:flex;align-items:center;border-radius:7px}.project-heading:hover{background:var(--s-accent-soft)}.project-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:7px;border:0;background:transparent;padding:4px 8px;color:var(--s-text);font-size:13px;line-height:18px;text-align:left}.project-toggle span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-chevron{width:10px;height:10px;margin-left:auto;transition:transform .15s}.project-new{flex:none}.project-sessions{margin-left:12px}
.project-heading>.project-new{opacity:0;pointer-events:none}
.project-heading:is(:hover,:focus-within)>.project-new{opacity:1;pointer-events:auto}
.project-heading:is(:hover,:focus-within)>.project-new:disabled{opacity:.45}
.section-empty{margin:3px 10px 5px;font-size:11px;line-height:1.5;color:var(--s-dim);opacity:.8}
button:focus-visible,summary:focus-visible{outline:2px solid var(--s-accent);outline-offset:1px}
</style>
