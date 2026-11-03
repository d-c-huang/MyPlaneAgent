<script setup lang="ts">
import {ref,type CSSProperties} from 'vue'
import {ElDropdown,ElDropdownMenu,ElDropdownItem} from 'element-plus'
import {EditPen,MoreFilled,Top,Setting,FolderOpened} from '@element-plus/icons-vue'
import type {AgentProject} from '../../electron/shared/local-ai-agent'
const props=defineProps<{project:AgentProject;disabled:boolean}>()
const emit=defineEmits<{command:[command:string]}>()
const anchor=ref<HTMLElement>(),open=ref(false),menuStyle=ref<CSSProperties>({})
const finder=typeof navigator!=='undefined'&&/Mac/.test(navigator.platform)
function visible(value:boolean){open.value=value;if(value&&anchor.value){const style=getComputedStyle(anchor.value);menuStyle.value=Object.fromEntries(['--s-panel','--s-text','--s-dim','--s-border','--s-muted'].map(key=>[key,style.getPropertyValue(key)]))}}
function openMenu(){if(!props.disabled){anchor.value?.querySelector<HTMLButtonElement>('.project-more')?.click()}}
defineExpose({openMenu})
</script>
<template>
 <div ref="anchor" class="project-row-actions" :class="{'menu-open':open}">
  <button class="project-row-action project-new-chat" :disabled="disabled" :aria-label="'在 '+project.name+' 中新建会话'" title="新建会话" @click.stop="emit('command','new')"><EditPen/></button>
  <ElDropdown trigger="click" placement="bottom-start" :disabled="disabled" :show-arrow="false" :popper-style="menuStyle" popper-class="agent-project-popup" @visible-change="visible" @command="command=>emit('command',String(command))">
   <button class="project-row-action project-more" :disabled="disabled" :aria-label="project.name+' 项目菜单'" aria-haspopup="menu" :aria-expanded="open" title="项目菜单" @click.stop><MoreFilled/></button>
   <template #dropdown><ElDropdownMenu>
    <ElDropdownItem command="pin"><Top/><span>{{project.pinned?'取消置顶':'置顶'}}</span></ElDropdownItem>
    <ElDropdownItem command="edit"><Setting/><span>编辑项目</span></ElDropdownItem>
    <ElDropdownItem command="reveal" divided><FolderOpened/><span>{{finder?'在 Finder 中显示':'在文件管理器中显示'}}</span></ElDropdownItem>
   </ElDropdownMenu></template>
  </ElDropdown>
 </div>
</template>
<style>
.project-row-actions{display:flex;align-items:center;gap:1px;flex:none;margin-left:2px}
.project-row-action{display:grid;place-items:center;flex:none;width:25px;height:27px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--s-dim);cursor:pointer}
.project-row-action svg{width:16px;height:16px}.project-row-action:hover,.project-row-actions.menu-open .project-more{color:var(--s-text);background:var(--s-muted)}.project-row-action:focus-visible{outline:2px solid var(--s-text);outline-offset:1px}.project-row-action:disabled{opacity:.35;cursor:default}
.agent-project-popup.el-popper{border:1px solid var(--s-border,#ddd);border-radius:12px;background:var(--s-panel,#fff);box-shadow:0 8px 28px #0002;min-width:190px;overflow:hidden}
.agent-project-popup .el-dropdown-menu{padding:6px;background:var(--s-panel,#fff)}.agent-project-popup .el-dropdown-menu__item{gap:10px;color:var(--s-text,#222);font-size:13px;line-height:22px;padding:8px 10px;border-radius:6px}.agent-project-popup .el-dropdown-menu__item svg{width:17px;height:17px;margin:0;color:var(--s-dim,#777)}.agent-project-popup .el-dropdown-menu__item:not(.is-disabled):focus{color:var(--s-text,#222);background:var(--s-muted,#f3f3f3)}.agent-project-popup .el-dropdown-menu__item--divided{border-top-color:var(--s-border,#ddd);margin-top:5px}.agent-project-popup .el-dropdown-menu__item--divided:before{display:none}
</style>
