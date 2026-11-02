<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import ChatToolCard from './ChatToolCard.vue'
import ChatArtifactList from './ChatArtifactList.vue'
import {chatArtifacts,executionEntries,toolLabel,formatElapsedTime,type ChatArtifact} from '../../electron/shared/chat-presentation'
import AiMarkdown from '../AiMarkdown.vue'
import TokenUsageDisplay from './TokenUsageDisplay.vue'
import {CopyDocument,Refresh} from '@element-plus/icons-vue'
import {readTokenUsage,sumTokenUsage} from '../../electron/shared/local-ai-usage'
import type {StudioMessage} from '../../electron/shared/local-ai-studio'
const props=defineProps<{messages:StudioMessage[];sending:boolean}>()
const rows=computed(()=>props.messages.map(message=>({message,entries:executionEntries(message),artifacts:chatArtifacts([message])})))
const active=(index:number)=>props.sending&&index===props.messages.length-1
const now=ref(Date.now())
let timer:ReturnType<typeof setInterval>|undefined
watch(()=>props.sending,sending=>{clearInterval(timer);now.value=Date.now();if(sending)timer=setInterval(()=>{now.value=Date.now()},1000)},{immediate:true})
onBeforeUnmount(()=>clearInterval(timer))
const liveElapsed=(message:StudioMessage)=>formatElapsedTime(now.value-Date.parse(message.createdAt))
const outcomeLabel=(message:StudioMessage)=>message.outcome==='needs_input'?'需要补充信息':message.outcome==='blocked'?'执行受阻':message.outcome==='complete'?'最终回复':'回复'
function liveLabel(message:StudioMessage){
 const waiting=message.toolActivity?.find(item=>item.status==='waiting');if(waiting)return '等待你批准操作'
 const running=message.toolActivity?.find(item=>item.status==='running');if(running)return toolLabel(running)+'…'
 const last=message.execution?.at(-1);return last?.type==='progress'&&last.phase==='reviewing'?'正在核对任务结果…':last?.type==='progress'&&last.phase==='context'?'正在整理上下文…':'正在分析任务…'
}
defineEmits<{copy:[text:string];regenerate:[];'open-artifact':[artifact:ChatArtifact];'open-link':[url:string]}>()
const messageUsage=(message:StudioMessage)=>message.usage||readTokenUsage({usage:{completion_tokens:message.tokens}})
</script>
<template>
 <div class="messages">
  <article v-for="({message,entries,artifacts},index) in rows" :key="message.id" :data-message-id="message.id" class="message" :class="message.role">
   <div class="message-body">
    <header v-if="message.role==='assistant'" class="message-author"><span class="assistant-monogram" aria-hidden="true">M</span><strong>MyPlaneAgent</strong><span v-if="message.outcome==='needs_input'||message.outcome==='blocked'" class="message-attention">{{message.outcome==='needs_input'?'等待补充':'需要处理'}}</span></header>
    <div v-if="message.images?.length" class="message-images"><img v-for="(image,imageIndex) in message.images" :key="imageIndex" :src="image.dataUrl" :alt="image.name" loading="lazy"/></div>
    <template v-if="message.role==='assistant'">
     <details v-if="entries.length" class="execution-flow" :open="active(index)">
      <summary><span class="flow-indicator" :class="{running:active(index)}"></span><strong>{{active(index)?'已处理 '+liveElapsed(message):message.status==='error'?'执行遇到问题':message.status==='stopped'?'执行已停止':'执行过程'}}</strong><span v-if="message.toolActivity?.length">{{message.toolActivity.length}} 项操作</span><span v-if="!active(index)&&message.elapsedMs!==undefined">{{formatElapsedTime(message.elapsedMs)}}</span><span class="flow-chevron">›</span></summary>
      <div class="flow-entries">
       <template v-for="entry in entries" :key="entry.id">
        <div v-if="entry.type==='progress'" class="progress-entry"><span class="progress-mark" aria-hidden="true"></span><AiMarkdown :text="entry.text"/></div>
        <ChatToolCard v-else-if="entry.activity" :activity="entry.activity" @open-link="$emit('open-link',$event)"/>
       </template>
      </div>
     </details>
     <div v-if="active(index)" class="live-status" role="status"><span class="flow-indicator running"></span>{{liveLabel(message)}}<span v-if="!entries.length">已处理 {{liveElapsed(message)}}</span></div>
     <ChatArtifactList v-if="artifacts.length" :artifacts="artifacts" @open="$emit('open-artifact',$event)"/>
     <section v-if="message.content" class="final-answer"><h3 v-if="entries.length">{{outcomeLabel(message)}}</h3><AiMarkdown :text="message.content"/></section>
     <div v-if="message.status==='error'" class="execution-error" role="alert"><strong>本次执行未完成</strong><p>{{message.error||'生成未完成，可以重试。'}}</p></div>
     <p v-else-if="message.status==='stopped'" class="quiet">已停止生成，已执行的操作记录保留。</p>
     <footer v-if="!active(index)" class="answer-meta"><span v-if="!entries.length&&message.elapsedMs!==undefined">{{formatElapsedTime(message.elapsedMs)}}</span><TokenUsageDisplay :usage="message.usageTotals??sumTokenUsage([messageUsage(message)])" :requests-known="!!message.usageTotals" label="本次 Tokens" compact/></footer>
    </template>
    <AiMarkdown v-else-if="message.content" :text="message.content"/>
    <div v-if="!active(index)" class="message-actions"><button v-if="message.content" class="text-button" @click="$emit('copy',message.content)"><CopyDocument/>复制</button><button v-if="!sending&&message.role==='assistant'&&index===messages.length-1" class="text-button" @click="$emit('regenerate')"><Refresh/>重新生成</button></div>
   </div>
  </article>
 </div>
</template>
<style scoped>
.message-body>.message-author{justify-content:flex-start;gap:9px;margin:0 0 15px;color:var(--s-text)}.message-author strong{font-size:11px;font-weight:600}.assistant-monogram{display:grid;place-items:center;width:23px;height:23px;border:1px solid var(--s-border);border-radius:7px;color:var(--s-accent);font-size:11px;font-weight:600;background:var(--s-panel)}.message-attention{margin-left:auto;font-size:10px;color:#a6752b;padding:2px 6px;border-radius:5px;background:color-mix(in srgb,#b58234 8%,var(--s-panel))}
.messages{width:100%;max-width:800px;margin:auto;padding:24px}.message{margin-bottom:26px;display:flex;min-width:0}.message-body{min-width:0;flex:1}.message-body>header{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--s-dim);margin-bottom:8px}.message.user .message-body{position:relative;background:var(--s-muted);padding:8px 14px;border-radius:12px;max-width:85%;margin-left:auto;flex:0 1 auto}.message :deep(.ai-markdown){font-size:15px;line-height:1.85}.message-images{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.message-images img{max-width:min(240px,100%);max-height:200px;border-radius:10px;object-fit:contain}.message-actions{display:flex;gap:12px;margin-top:10px}.text-button{display:flex;gap:5px;align-items:center;border:0;background:transparent;color:var(--s-dim);font:inherit;font-size:11px;cursor:pointer;padding:2px 0}.text-button svg{width:13px;height:13px}.reasoning{margin:8px 0 12px;color:var(--s-dim);font-size:12px}.reasoning summary{cursor:pointer}.generating{font-size:12px;color:var(--s-dim)}.quiet,.message-error{font-size:12px;color:var(--s-dim)}.message-error{color:var(--s-danger)}
.chat-tools{margin:10px 0;font-size:12px}.chat-tools details{border:1px solid var(--s-border);border-radius:9px;margin:6px 0;padding:8px 12px}.chat-tools summary{display:flex;gap:10px;cursor:pointer}.chat-tools summary span{color:var(--s-dim)}.chat-tools pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto;font-size:11px;color:var(--s-dim)}
.message.user .message-actions{position:absolute;top:100%;right:0;margin-top:0;padding-top:4px;white-space:nowrap;opacity:0;pointer-events:none}
.message.user .message-body:is(:hover,:focus-within) .message-actions{opacity:1;pointer-events:auto}
.execution-flow{margin:0 0 18px;color:var(--s-dim);font-size:12px}.execution-flow>summary{display:flex;align-items:center;gap:9px;cursor:pointer;list-style:none;padding:6px 0}.execution-flow>summary::-webkit-details-marker{display:none}.execution-flow>summary strong{color:var(--s-text);font-weight:500}.flow-chevron{margin-left:auto;font-size:18px}.execution-flow[open] .flow-chevron{transform:rotate(90deg)}.flow-indicator{width:6px;height:6px;border-radius:50%;background:var(--s-dim);flex:none}.flow-indicator.running{background:var(--s-accent);animation:flow-pulse 1.3s ease-in-out infinite}.flow-entries{margin:8px 0 0 3px;border-left:1px solid var(--s-border);padding-left:17px}.progress-entry{position:relative;margin:12px 0;color:var(--s-dim)}.progress-mark{position:absolute;left:-21px;top:9px;width:6px;height:6px;border-radius:50%;background:var(--s-border)}.progress-entry :deep(.ai-markdown){font-size:12px;line-height:1.7}.live-status{display:flex;align-items:center;gap:9px;margin:12px 0;color:var(--s-dim);font-size:12px}.final-answer h3{font-size:12px;font-weight:500;color:var(--s-dim);margin:20px 0 10px}.answer-meta{display:flex;gap:10px;align-items:center;margin-top:14px;color:var(--s-dim);font-size:11px}.message-artifacts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.message-artifacts button{display:flex;gap:8px;align-items:center;max-width:100%;border:1px solid var(--s-border);background:var(--s-panel);border-radius:8px;padding:9px 12px;color:var(--s-text);cursor:pointer}.message-artifacts strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.message-artifacts small{font-size:11px;color:var(--s-dim);white-space:nowrap}.execution-error{padding:12px 14px;border-left:2px solid var(--s-danger);background:color-mix(in srgb,var(--s-danger) 5%,var(--s-panel));border-radius:5px;font-size:12px;color:var(--s-danger);margin-top:14px}.execution-error p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;max-height:160px;overflow:auto}@keyframes flow-pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.flow-indicator.running{animation:none}}
</style>
