<script setup lang="ts">
import {ref} from 'vue'
withDefaults(defineProps<{minimal?:boolean}>(),{minimal:false})
const error=ref('')
async function open(label:string,event:MouseEvent){
 const button=event.currentTarget as HTMLElement
 try{error.value='';await window.myplane.showTitleMenu(label,button.getBoundingClientRect().left)}catch(cause){error.value=String(cause)}
}
</script>
<template>
 <header class="desktop-titlebar" :class="{'is-minimal':minimal}" aria-label="窗口标题栏">
  <img src="/myplane-icon.png" alt="" draggable="false" />
  <nav v-if="!minimal" aria-label="应用菜单"><button v-for="label in ['文件','编辑','视图','窗体','帮助']" :key="label" aria-haspopup="menu" @click="open(label,$event)">{{label}}</button></nav>
  <span class="window-title">MyPlaneAgent</span><span v-if="error" role="alert">{{error}}</span>
 </header>
</template>
<style scoped>
.desktop-titlebar{position:fixed;inset:0 0 auto 0;height:36px;display:flex;align-items:center;gap:8px;padding:0 150px 0 10px;background:var(--s-rail,#f5f5f5);color:var(--s-text,#555);z-index:10000;-webkit-app-region:drag;font:13px/1.4 'Segoe UI','Microsoft YaHei',sans-serif;user-select:none}.desktop-titlebar img{width:18px;height:18px}.desktop-titlebar nav{display:flex;height:100%;align-items:center;gap:2px;-webkit-app-region:no-drag}.desktop-titlebar button{height:28px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:default}.desktop-titlebar button:hover,.desktop-titlebar button:focus-visible{background:var(--s-accent-soft,#e4e4e4);outline:none}.window-title{font-size:12px;color:var(--s-dim,#888);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-left:12px}.desktop-titlebar [role=alert]{font-size:11px;color:var(--s-danger,#a22)}@media(max-width:680px){.window-title{display:none}.desktop-titlebar button{padding:0 6px}}
</style>
<style scoped>
.desktop-titlebar.is-minimal{gap:8px;padding-left:16px;background:var(--s-rail,#f5f5f5)}.desktop-titlebar.is-minimal img{width:15px;height:15px;opacity:.8}.desktop-titlebar.is-minimal .window-title{display:block;margin-left:0;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--s-dim,#888)}
</style>
