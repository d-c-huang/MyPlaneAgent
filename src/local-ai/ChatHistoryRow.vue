<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { MoreFilled } from '@element-plus/icons-vue'
import type { StudioSessionSummary } from '../../electron/shared/local-ai-studio'
import type { AgentProject } from '../../electron/shared/local-ai-agent'
const props=defineProps<{item:StudioSessionSummary;selected:boolean;disabled:boolean;projects:AgentProject[];runState?:{requestId:string;status:'running'|'approval';approvalCount:number}}>()
defineEmits<{open:[id:string];pin:[item:StudioSessionSummary];move:[item:StudioSessionSummary,projectId:string];rename:[item:StudioSessionSummary];delete:[item:StudioSessionSummary]}>()
const mutationDisabled=computed(()=>props.disabled||!!props.runState)
const runLabel=computed(()=>props.runState?.status==='approval'?`待审批${props.runState.approvalCount>1?` ${props.runState.approvalCount}`:''}`:props.runState?'运行中':'')
const menuRef=ref<HTMLDetailsElement>()
const panelRef=ref<HTMLDivElement>()
let scrollContainer:HTMLElement|null=null
function closeMenu(event:Event){(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')}
function positionMenu(){
 const anchor=menuRef.value?.querySelector('summary'),panel=panelRef.value
 if(!anchor||!panel)return
 const rect=anchor.getBoundingClientRect(),width=panel.offsetWidth,height=panel.offsetHeight,margin=8
 const below=window.innerHeight-rect.bottom-margin,above=rect.top-margin
 const preferredTop=below>=height||below>=above?rect.bottom+4:rect.top-height-4
 panel.style.left=`${Math.max(margin,Math.min(rect.right-width,window.innerWidth-width-margin))}px`
 panel.style.top=`${Math.max(margin,Math.min(preferredTop,window.innerHeight-height-margin))}px`
}
function toggleMenu(){
 const menu=menuRef.value,panel=panelRef.value
 if(!menu||!panel)return
 if(menu.open){
  panel.showPopover()
  positionMenu()
  scrollContainer=menu.closest<HTMLElement>('.chat-history-sections')
  scrollContainer?.addEventListener('scroll',positionMenu,{passive:true})
  window.addEventListener('resize',positionMenu)
 }else{
  if(panel.matches(':popover-open'))panel.hidePopover()
  scrollContainer?.removeEventListener('scroll',positionMenu)
  scrollContainer=null
  window.removeEventListener('resize',positionMenu)
 }
}
onBeforeUnmount(()=>{
 if(panelRef.value?.matches(':popover-open'))panelRef.value.hidePopover()
 scrollContainer?.removeEventListener('scroll',positionMenu)
 window.removeEventListener('resize',positionMenu)
})
</script>
<template>
 <div class="history-row" :class="{selected}" :data-run-state="runState?.status">
  <button class="session-button" :disabled="disabled" :title="item.title" :aria-current="selected?'page':undefined" @click="$emit('open',item.id)"><span class="session-title">{{item.title}}</span><span v-if="runState" class="session-run-state" :class="{approval:runState.status==='approval'}"><i aria-hidden="true"/>{{runLabel}}</span></button>
  <details ref="menuRef" data-floating-menu class="row-menu" @toggle="toggleMenu"><summary :aria-label="`${item.title}的会话操作`"><MoreFilled/></summary><div ref="panelRef" popover="manual" class="menu-panel">
   <p v-if="runState" class="running-menu-hint">任务结束后可编辑此会话</p>
   <button :disabled="mutationDisabled" @click="$emit('pin',item);closeMenu($event)">{{item.pinned?'取消置顶':'置顶'}}</button>
   <button :disabled="mutationDisabled" @click="$emit('rename',item);closeMenu($event)">重命名</button>
   <label>移至项目<select :value="item.projectId||''" :disabled="mutationDisabled" aria-label="会话所属项目" @change="$emit('move',item,($event.target as HTMLSelectElement).value);closeMenu($event)"><option value="">无项目（最近）</option><option v-for="project in projects" :key="project.id" :value="project.id">{{project.name}}</option></select></label>
   <button class="danger" :disabled="mutationDisabled" @click="$emit('delete',item);closeMenu($event)">删除会话</button>
  </div></details>
 </div>
</template>
<style scoped>
.history-row{display:flex;align-items:center;position:relative;min-width:0;border-radius:7px;margin:0;color:var(--s-text)}
.history-row:hover,.history-row.selected{background:var(--s-accent-soft)}
button,select{font:inherit;color:inherit}button{cursor:pointer}button:disabled,select:disabled{cursor:not-allowed;opacity:.5}
.session-button{display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:4px 32px 4px 10px;border:0;background:transparent;text-align:left;color:var(--s-text);font-size:13px;line-height:18px;white-space:nowrap;border-radius:7px}
.session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.session-run-state{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--s-accent);font-size:10px;font-weight:500}.session-run-state i{width:5px;height:5px;border-radius:50%;background:currentColor}.session-run-state.approval{color:light-dark(#946300,#e7b452)}
.row-menu{position:absolute;right:4px;top:1px;opacity:0}.history-row:hover .row-menu,.row-menu:focus-within,.row-menu[open]{opacity:1}
.row-menu summary{display:grid;place-items:center;width:24px;height:24px;cursor:pointer;list-style:none;border-radius:5px;background:var(--s-rail)}.row-menu summary::-webkit-details-marker{display:none}.row-menu svg{width:15px;height:15px}
.menu-panel{position:fixed;inset:auto;margin:0;width:175px;max-height:calc(100vh - 16px);overflow-y:auto;padding:5px;border:1px solid var(--s-border);border-radius:9px;background:var(--s-panel);box-shadow:0 5px 15px #0002;font-size:12px}
.menu-panel button{display:block;width:100%;border:0;background:transparent;padding:7px;text-align:left;border-radius:5px}.menu-panel button:hover{background:var(--s-muted)}
.running-menu-hint{margin:3px 7px 5px;color:var(--s-dim);font-size:11px;line-height:1.5}
.menu-panel label{display:flex;flex-direction:column;gap:6px;padding:7px;color:var(--s-dim)}.menu-panel select{width:100%;min-width:0;border:1px solid var(--s-border);background:var(--s-panel);border-radius:5px;padding:5px}.danger{color:var(--s-danger)!important}
button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--s-accent);outline-offset:1px}
</style>
