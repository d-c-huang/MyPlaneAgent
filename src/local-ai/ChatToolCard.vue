<script setup lang="ts">
import HighlightedCode from './HighlightedCode.vue'
import {computed} from 'vue'
import type {StudioToolActivity} from '../../electron/shared/local-ai-studio'
import {toolLabel,toolTarget,toolOutput,toolState} from '../../electron/shared/chat-presentation'
const props=defineProps<{activity:StudioToolActivity}>()
defineEmits<{'open-link':[url:string]}>()
const result=computed(()=>toolOutput(props.activity))
const state=computed(()=>toolState(props.activity))
const stateLabel=computed(()=>({waiting:'等待批准',running:'执行中',complete:'已完成',error:'失败',denied:'已拒绝',unapplied:'未执行'})[state.value])
const sources=computed(()=>Array.isArray(result.value?.results)?result.value.results.filter((row):row is {title:string;url:string;snippet?:string}=>!!row&&typeof row==='object'&&typeof row.url==='string'&&/^https?:\/\//.test(row.url)&&typeof row.title==='string'):[])
const codeResult=computed(()=>{
 if(props.activity.capability!=='agent.read_file'||typeof result.value?.text!=='string')return
 const lines=result.value.text.split('\n'),start=result.value.startLine
 const numbered=typeof start==='number'&&lines.every((line,index)=>line.startsWith(`${start+index}: `))
 return {code:numbered?lines.map((line,index)=>line.slice(`${Number(start)+index}: `.length)).join('\n'):result.value.text,
  language:typeof result.value.path==='string'?result.value.path:String(props.activity.args.path||'text')}
})
const output=computed(()=>typeof result.value?.output==='string'?result.value.output:props.activity.output||'')
</script>
<template>
 <details class="tool-card" :class="state">
  <summary><span class="tool-dot" aria-hidden="true"></span><strong>{{toolLabel(activity)}}</strong><span class="tool-target" :title="toolTarget(activity)">{{toolTarget(activity)}}</span><small>{{stateLabel}}</small></summary>
  <div class="tool-detail">
   <p v-if="state==='unapplied'" class="unapplied-note">工具定义已更新，这次调用没有执行。后续操作仍按当前权限处理。</p>
   <div class="tool-meta"><span>{{activity.capability.startsWith('mcp.')||activity.capability.startsWith('mcp:')?'MCP':'插件'}} · {{activity.capability}}</span><span v-if="typeof result?.exitCode==='number'">退出码 {{result.exitCode}}</span></div>
   <figure v-for="(image,index) in activity.images" :key="index" class="tool-image"><img :src="image.dataUrl" :alt="image.name" loading="lazy"/><figcaption>实际网页截图 · {{result?.visualInput?'已作为图片提供给模型':'供人工核验，未作为图片提供给模型'}}</figcaption></figure>
   <ul v-if="sources.length" class="search-results"><li v-for="source in sources" :key="source.url"><a :href="source.url" @click.prevent="$emit('open-link',source.url)">{{source.title}}</a><small>{{source.url}}</small><p v-if="source.snippet">{{source.snippet}}</p></li></ul>
   <HighlightedCode v-else-if="codeResult" :code="codeResult.code" :language="codeResult.language"/>
   <pre v-else-if="output" class="tool-output" :class="{terminal:typeof result?.exitCode==='number'}">{{output}}</pre>
   <p v-else class="tool-note">{{state==='waiting'?'等待你批准本次操作。':state==='running'?'正在等待工具返回结果…':'此操作没有返回文本结果。'}}</p>
   <details class="raw-arguments"><summary>调用参数</summary><HighlightedCode :code="JSON.stringify(activity.args,null,2)" language="json"/></details>
  </div>
 </details>
</template>
<style scoped>
.unapplied .tool-dot{background:var(--s-dim)}.unapplied-note{margin:0 0 10px;color:var(--s-dim);font-size:12px;line-height:1.65}
.tool-image{margin:8px 0}.tool-image img{display:block;max-width:100%;max-height:480px;object-fit:contain;border:1px solid var(--s-border);border-radius:6px}.tool-image figcaption{color:var(--s-dim);margin-top:6px}
.tool-card{margin:5px 0;border:1px solid var(--s-border);border-radius:9px;background:var(--s-panel);overflow:hidden;font-size:12px}.tool-card>summary{display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:pointer;list-style:none}.tool-card>summary::-webkit-details-marker{display:none}.tool-card>summary::after{content:'›';color:var(--s-dim);font-size:16px}.tool-card[open]>summary::after{transform:rotate(90deg)}.tool-card strong{font-weight:500;white-space:nowrap}.tool-target{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--s-dim)}.tool-card small{font-size:11px;color:var(--s-dim);white-space:nowrap}.tool-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--s-dim)}.complete .tool-dot{background:#3f9466}.error .tool-dot,.denied .tool-dot{background:var(--s-danger)}.waiting .tool-dot{background:#c18d3d}.running .tool-dot{background:var(--s-accent);box-shadow:0 0 0 3px var(--s-accent-soft)}.tool-detail{border-top:1px solid var(--s-border);padding:12px}.tool-meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:11px;color:var(--s-dim);overflow-wrap:anywhere;margin-bottom:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,monospace;max-height:260px;overflow:auto;margin:8px 0}.terminal{background:var(--s-muted);padding:12px;border-radius:6px}.raw-arguments{color:var(--s-dim);margin-top:10px}.raw-arguments summary{cursor:pointer}.tool-note{color:var(--s-dim)}.search-results{list-style:none;padding:0;margin:0}.search-results li+li{border-top:1px solid var(--s-border);padding-top:10px;margin-top:10px}.search-results a{color:var(--s-accent);text-decoration:none}.search-results a:hover{text-decoration:underline}.search-results small{display:block;overflow:hidden;text-overflow:ellipsis;margin:3px 0}.search-results p{margin:4px 0;color:var(--s-dim);line-height:1.65}
</style>
