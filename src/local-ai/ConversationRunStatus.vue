<script setup lang="ts">
import {computed} from 'vue'
import type {StudioMessage} from '../../electron/shared/local-ai-studio'
import type {TaskPlan} from '../../electron/shared/task-plan'
import type {ContextStatus} from '../../electron/shared/local-ai-context'
import {conversationRunState} from '../../electron/shared/conversation-status'
const props=defineProps<{messages:StudioMessage[];sending:boolean;loading?:boolean;approval?:boolean;plan?:TaskPlan;context?:ContextStatus}>()
defineEmits<{'open-tasks':[]}>()
const status=computed(()=>conversationRunState(props))
</script>
<template>
 <section class="conversation-run-status" :class="status.tone" aria-label="会话执行状态">
  <span class="run-status-dot" aria-hidden="true"></span>
  <div class="run-status-copy"><strong role="status" aria-live="polite">{{status.label}}</strong><span>{{status.detail}}</span></div>
  <button v-if="status.attention" type="button" class="attention-link" @click="$emit('open-tasks')">待处理 {{status.attention}}<span aria-hidden="true">↗</span></button>
  <span v-else-if="context?.recovery" class="recovery-chip" :title="`已接续 ${context.recovery.messages} 条历史记录${context.recovery.unconfirmedEffects?'，'+context.recovery.unconfirmedEffects+' 项操作仍需核对':''}`">已接续记录</span>
 </section>
</template>
<style scoped>
.conversation-run-status{display:flex;align-items:center;gap:10px;padding:11px 28px;border-bottom:1px solid var(--s-border);background:color-mix(in srgb,var(--s-panel) 55%,transparent);min-height:54px;flex:none}.run-status-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--s-dim)}.working .run-status-dot{background:var(--s-accent);box-shadow:0 0 0 4px var(--s-accent-soft)}.attention .run-status-dot{background:#b58234}.success .run-status-dot{background:#348663}.error .run-status-dot{background:var(--s-danger)}.run-status-copy{display:flex;align-items:baseline;gap:12px;min-width:0;flex:1}.run-status-copy strong{font-size:12px;white-space:nowrap;font-weight:600}.run-status-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--s-dim)}.attention-link{display:flex;align-items:center;gap:8px;flex:none;border:1px solid color-mix(in srgb,#b58234 28%,var(--s-border));border-radius:7px;background:var(--s-panel);padding:4px 8px;font:inherit;font-size:11px;color:var(--s-text);cursor:pointer}.attention-link:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}.recovery-chip{font-size:10px;white-space:nowrap;color:var(--s-dim);border:1px solid var(--s-border);border-radius:5px;padding:2px 6px}@container studio (max-width:850px){.conversation-run-status{padding:10px 16px}.run-status-copy{display:block}.run-status-copy strong,.run-status-copy>span{display:block}.run-status-copy>span{font-size:10px}.recovery-chip{display:none}}
</style>
