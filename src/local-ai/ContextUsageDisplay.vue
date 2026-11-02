<script setup lang="ts">
import {computed} from 'vue'
import type {ContextCheckpoint,ContextStatus} from '../../electron/shared/local-ai-context'
import {compactionDetails} from '../../electron/shared/context-compaction-presentation'
import {contextPercent} from '../../electron/shared/conversation-status'
const props=defineProps<{context?:ContextStatus;checkpoint?:ContextCheckpoint;disabled?:boolean;hasHistory?:boolean;shortcut?:string}>()
defineEmits<{compact:[]}>()
const percent=computed(()=>contextPercent(props.context))
const trigger=computed(()=>Math.round((props.context?.triggerRatio??.7)*100))
const count=(value:number)=>value.toLocaleString('zh-CN')
const report=computed(()=>props.context?.lastCompaction??props.checkpoint?.compaction)
const details=computed(()=>report.value?compactionDetails(report.value):[])
const compactions=computed(()=>props.context?.compactions??props.checkpoint?.compactions??0)
const method=computed(()=>report.value?.method??(!report.value?props.checkpoint?.source:undefined))
const methodLabel=computed(()=>method.value==='ledger'?'原文整理':method.value==='model'?'模型摘要':method.value==='recovery'?'恢复摘录':'上下文整理')
const matchingCheckpoint=computed(()=>props.checkpoint&&(!report.value||props.checkpoint.compaction?.startedAt===report.value.startedAt))
</script>
<template>
 <div class="context-usage" :class="{warning:percent>=trigger}" aria-label="上下文管理">
  <span v-if="shortcut" class="context-shortcut">{{shortcut}}</span>
  <span v-if="context?.state==='error'" class="context-note" role="status">整理未完成，原记录已保留</span>
  <div class="context-actions">
   <details data-floating-menu>
    <summary aria-label="查看上下文整理信息"><span class="context-dot"></span>{{context?.state==='compacting'?'正在整理上下文…':context?`上下文约 ${percent}%`:'上下文自动管理'}}<span v-if="compactions&&context?.state!=='compacting'" class="context-saved">整理 {{compactions}} 次</span><span class="context-chevron" aria-hidden="true">⌃</span></summary>
    <div class="context-panel">
     <header><strong>本步上下文</strong><span v-if="context">约 {{percent}}%</span></header>
     <div v-if="context" class="context-meter" role="meter" aria-label="本步上下文占用估算" :aria-valuenow="Math.min(percent,100)" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="`约 ${percent}%`"><i :style="{width:Math.min(percent,100)+'%'}"/></div>
     <dl v-if="context" class="context-budget"><div><dt>预计输入</dt><dd>{{count(context.inputTokens)}}</dd></div><div><dt>预留输出</dt><dd>{{count(context.reservedOutput)}}</dd></div><div><dt>安全余量</dt><dd>{{count(context.safetyTokens||0)}}</dd></div><div><dt>配置容量</dt><dd>{{count(context.capacity)}}</dd></div></dl>
     <p>以上为最近执行步骤的估算，包含消息和工具定义，与累计 Tokens 用量不同。约 {{trigger}}% 时按需整理，原始对话和执行记录继续保留。</p>
     <section v-if="context?.recovery" class="context-recovery"><strong>已从保存记录接续</strong><p>已恢复 {{count(context.recovery.messages)}} 条历史记录。{{context.recovery.unconfirmedEffects?`${count(context.recovery.unconfirmedEffects)} 项操作的结果仍需核对，不会自动重放。`:'已有执行结果可继续使用。'}}</p></section>
     <p v-if="context?.message" role="status">{{context.message}}</p>
     <section v-if="report" class="context-last-run"><header><strong>最近一次整理</strong><span class="context-method" :data-method="method">{{methodLabel}}</span></header><p v-for="line in details" :key="line">{{line}}</p></section>
     <details v-if="matchingCheckpoint&&checkpoint?.source!=='ledger'&&checkpoint?.source!=='recovery'" class="context-summary"><summary>查看进度摘要</summary><pre>{{checkpoint?.summary}}</pre></details>
     <p v-else-if="method==='ledger'" class="context-source-note">实际工具状态与原文引用由程序保留，这次整理没有调用摘要模型。</p>
    </div>
   </details>
   <button type="button" title="按需请求模型整理较早的对话，原始记录保留" :disabled="disabled||!hasHistory||context?.state==='compacting'" @click="$emit('compact')">手动整理</button>
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
.context-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:20;width:min(420px,100%);max-height:min(480px,calc(100vh - 220px));overflow:auto;border:1px solid var(--s-border);border-radius:14px;padding:18px;background:var(--s-panel);box-shadow:0 12px 40px #0002;color:var(--s-text);overflow-wrap:anywhere;white-space:normal}
.context-panel p{margin:6px 0 10px;color:var(--s-dim)}.context-panel pre{white-space:pre-wrap;font:inherit;margin:8px 0 0}
summary:focus-visible,button:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.context-panel>header,.context-last-run>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.context-panel>header strong{font-size:14px}.context-panel>header>span{color:var(--s-dim)}.context-meter{height:5px;background:var(--s-muted);border-radius:5px;overflow:hidden;margin:12px 0}.context-meter i{display:block;height:100%;background:var(--s-accent);border-radius:inherit}.warning .context-meter i{background:#bb873c}.context-budget{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}.context-budget>div{padding:9px 11px;background:var(--s-muted);border-radius:8px}.context-budget dt{font-size:10px;color:var(--s-dim)}.context-budget dd{margin:3px 0 0;font-size:13px;font-weight:550;font-variant-numeric:tabular-nums}.context-recovery,.context-last-run{border-top:1px solid var(--s-border);margin-top:14px;padding-top:14px}.context-method{font-size:10px;padding:2px 6px;border-radius:5px;background:var(--s-muted);color:var(--s-dim)}.context-method[data-method=ledger]{background:var(--s-accent-soft);color:var(--s-accent)}.context-summary{margin-top:12px}.context-summary>summary{font-size:11px;color:var(--s-dim)}.context-chevron{font-size:12px;color:var(--s-dim)}.context-source-note{font-size:11px}.context-panel p{font-size:11px;line-height:1.8}
@container studio (max-width:580px){.context-shortcut{font-size:10px}.context-saved{display:none}.context-usage{gap:4px}.context-usage button{padding-inline:4px}}
</style>
