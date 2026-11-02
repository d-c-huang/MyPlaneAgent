<script setup lang="ts">
import {computed} from 'vue'
import type {TokenUsageTotals} from '../../electron/shared/local-ai-usage'
const props=withDefaults(defineProps<{usage?:TokenUsageTotals;pending?:boolean;compact?:boolean;label?:string;requestsKnown?:boolean}>(),{label:'Tokens',requestsKnown:true})
const available=computed(()=>!!props.usage&&(props.usage.inputReports>0||props.usage.outputReports>0||props.usage.totalReports>0))
const partial=computed(()=>!!props.usage&&(props.usage.incompleteHistory||[props.usage.inputReports,props.usage.outputReports,props.usage.totalReports].some(reports=>reports<props.usage!.requests)))
const value=(kind:'input'|'output'|'total')=>props.usage?.[`${kind}Reports`]?props.usage[`${kind}Tokens`].toLocaleString():'—'
const description=computed(()=>!available.value?(props.pending?'模型服务尚未返回 Token 用量，通常在本轮生成结束后更新。':props.usage?.requests?'服务未返回 Token 用量，未使用字符数估算。':'开始生成后显示模型服务返回的 Token 用量。'):`${props.label}：输入 ${value('input')}，输出 ${value('output')}，合计 ${value('total')}。${props.requestsKnown?`${props.usage!.requests} 次模型请求。`:'此历史记录未保存请求次数。'}${partial.value?'仅汇总已返回的用量，部分请求或历史记录未统计。':'包括重复发送的上下文和工具调用。'}`)
</script>
<template>
 <div class="token-usage" :class="{compact,partial}" :title="description" :aria-label="description">
  <span class="token-label">{{label}}</span>
  <template v-if="available"><span class="token-breakdown">输入 <b>{{value('input')}}</b></span><span class="token-breakdown">输出 <b>{{value('output')}}</b></span><span class="token-total"><span class="token-breakdown">合计 </span><b>{{value('total')}}</b><sup v-if="partial">*</sup></span></template>
  <span v-else class="token-unavailable">{{pending?'统计中':usage?.requests?'未返回':'—'}}</span>
 </div>
</template>
<style scoped>
.token-usage{display:flex;align-items:center;gap:10px;min-width:0;color:var(--s-dim);font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums;white-space:nowrap}
.token-usage b{font-weight:550;color:var(--s-text)}.token-total sup{color:var(--s-dim);margin-left:2px}.token-label{font-weight:500}.token-unavailable{color:var(--s-dim)}.compact>.token-breakdown,.compact .token-total>.token-breakdown{display:none}
@container studio (max-width:1100px){.token-usage{gap:7px}}
@container studio (max-width:850px){.token-usage>.token-breakdown,.token-usage .token-total>.token-breakdown{display:none}.token-usage{gap:6px}}
</style>
