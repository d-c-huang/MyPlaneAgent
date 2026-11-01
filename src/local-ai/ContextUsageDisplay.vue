<script setup lang="ts">
import {computed} from 'vue'
import type {ContextCheckpoint,ContextStatus} from '../../electron/shared/local-ai-context'
import {compactionDetails} from '../../electron/shared/context-compaction-presentation'
const props=defineProps<{context?:ContextStatus;checkpoint?:ContextCheckpoint;disabled?:boolean;hasHistory?:boolean;shortcut?:string}>()
defineEmits<{compact:[]}>()
const percent=computed(()=>props.context?Math.round((props.context.inputTokens+props.context.reservedOutput+(props.context.safetyTokens||0))/props.context.capacity*100):0)
const trigger=computed(()=>Math.round((props.context?.triggerRatio??.7)*100))
const count=(value:number)=>value.toLocaleString('zh-CN')
const report=computed(()=>props.context?.lastCompaction??props.checkpoint?.compaction)
const details=computed(()=>report.value?compactionDetails(report.value):[])
</script>
<template>
 <div class="context-usage" :class="{warning:percent>=trigger}" aria-label="上下文管理">
  <span v-if="shortcut" class="context-shortcut">{{shortcut}}</span>
  <span v-if="context?.state==='error'" class="context-note" role="status">压缩未完成，原记录已保留</span>
  <div class="context-actions">
   <details data-floating-menu>
    <summary><span class="context-dot"></span>{{context?.state==='compacting'?'正在压缩上下文…':context?`上下文约 ${percent}%`:'上下文自动管理'}}<span v-if="checkpoint&&context?.state!=='compacting'" class="context-saved">已压缩 {{checkpoint.compactions}} 次</span></summary>
    <div class="context-panel">
     <strong>当前上下文</strong>
     <p v-if="context">预计输入 {{count(context.inputTokens)}} + 预留输出 {{count(context.reservedOutput)}} + 安全余量 {{count(context.safetyTokens||0)}} / 配置容量 {{count(context.capacity)}} Tokens。</p>
     <p>占用为估算，包含消息和工具定义，图片用量随模型和尺寸变化；与累计使用量不同。约 {{trigger}}% 时自动整理摘要，用户要求与必保留状态单独保存，原始记录保留在本机。</p>
     <p v-if="context?.message" role="status">{{context.message}}</p>
     <template v-if="report"><strong>最近一次压缩</strong><p v-for="line in details" :key="line">{{line}}</p></template>
     <template v-if="checkpoint"><strong>最近进度摘要</strong><pre>{{checkpoint.summary}}</pre></template>
    </div>
   </details>
   <button type="button" :disabled="disabled||!hasHistory||context?.state==='compacting'" @click="$emit('compact')">立即压缩</button>
  </div>
 </div>
</template>
<style scoped>
.context-usage{display:flex;align-items:center;gap:8px;position:relative;margin:0 2px 8px;font-size:12px;color:var(--s-dim);line-height:1.6;min-width:0}.context-shortcut{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context-actions{display:flex;align-items:center;gap:2px;margin-left:auto;min-width:0;white-space:nowrap}
.context-usage details{min-width:0}.context-usage summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none}.context-usage summary::-webkit-details-marker{display:none}
.context-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--s-accent)}.warning .context-dot{background:#bb873c}
.context-saved{opacity:.85}.context-note{color:var(--s-danger);font-size:11px}
.context-usage button{border:0;border-radius:6px;padding:3px 7px;color:var(--s-accent);background:transparent;cursor:pointer;font:inherit;white-space:nowrap}
.context-usage button:hover:not(:disabled){background:var(--s-accent-soft)}.context-usage button:disabled{opacity:.45;cursor:not-allowed}
.context-panel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;width:min(420px,100%);max-height:280px;overflow:auto;border:1px solid var(--s-border);border-radius:10px;padding:14px;background:var(--s-panel);box-shadow:0 6px 24px #0002;color:var(--s-text);overflow-wrap:anywhere;white-space:normal}
.context-panel p{margin:6px 0 10px;color:var(--s-dim)}.context-panel pre{white-space:pre-wrap;font:inherit;margin:8px 0 0}
summary:focus-visible,button:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
@container studio (max-width:580px){.context-shortcut{font-size:10px}.context-saved{display:none}.context-usage{gap:4px}.context-usage button{padding-inline:4px}}
</style>
