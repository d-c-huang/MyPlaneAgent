import test from 'node:test'
import assert from 'node:assert/strict'
import {conversationRunState,conversationTaskRows,conversationTaskLabel,taskNeedsAttention,contextPercent} from '../dist-electron/shared/conversation-status.js'
import {compactionDetails} from '../dist-electron/shared/context-compaction-presentation.js'
import {toolState,chatArtifacts} from '../dist-electron/shared/chat-presentation.js'
import {emptyTokenUsageTotals} from '../dist-electron/shared/local-ai-usage.js'
import {waitReasonLabels} from '../dist-electron/shared/task-contract.js'

const item=(id,status='pending',extra={})=>({id,title:id,acceptance:'核对实际结果',status,attempts:0,summary:'',evidenceIds:[],...extra})
const plan=items=>({taskId:'task',workspace:'D:/isolated',items,updatedAt:'2026-11-02T00:00:00Z'})
const message=(extra={})=>({id:'answer',role:'assistant',content:'回答中的自述不是执行状态',createdAt:'2026-11-02T00:00:00Z',...extra})
test('conversation status never treats a prior completed answer or successful prose as current completion',()=>{
 assert.equal(conversationRunState({sending:true,messages:[message({outcome:'complete'})]}).tone,'working')
 assert.equal(conversationRunState({sending:false,messages:[message({content:'任务已完成'})]}).label,'可以继续对话')
 assert.equal(conversationRunState({sending:false,messages:[message({outcome:'complete',status:'stopped'})]}).label,'已停止')
 assert.equal(conversationRunState({sending:false,messages:[message({outcome:'complete',status:'error'})]}).label,'本轮未完成')
 assert.equal(conversationRunState({sending:true,approval:true,messages:[],context:{state:'compacting'}}).label,'等待你批准')
})
test('resource waits remain distinct from active workers and requests for human decisions',()=>{
 const task=plan([item('reading','running',{worker:{id:'one'},runtime:{status:'waiting',waitReason:'resource'}}),item('writing','running',{worker:{id:'two'}})])
 const running=conversationRunState({sending:true,messages:[],plan:task})
 assert.equal(running.running,1);assert.equal(running.waiting,1);assert.equal(running.attention,0)
 assert.equal(conversationTaskLabel(conversationTaskRows(task)[0]),waitReasonLabels.resource)
 task.items[1].runtime={status:'waiting',waitReason:'dependency'}
 assert.equal(conversationRunState({sending:true,messages:[],plan:task}).label,'等待执行条件')
 task.items[0].status='complete'
 assert.equal(conversationTaskLabel(conversationTaskRows(task)[0]),'已完成','stale wait metadata cannot relabel a completed item')
})
test('attention queues deduplicate blocked parent rollups and preserve actual acceptance criteria',()=>{
 const task=plan([item('parent','pending'),item('child','blocked',{parentId:'parent',outcome:'needs_input',summary:'缺少目标城市'}),item('dependency','pending',{runtime:{status:'waiting',waitReason:'dependency'}})])
 const rows=conversationTaskRows(task),attention=rows.filter(taskNeedsAttention)
 assert.deepEqual(attention.map(row=>row.item.id),['child']);assert.equal(attention[0].item.acceptance,'核对实际结果')
 assert.equal(conversationTaskLabel(attention[0]),'等你补充')
 assert.equal(conversationRunState({sending:false,messages:[],plan:task}).attention,1)
})
test('context estimates include output and safety but tolerate incomplete legacy records',()=>{
 assert.equal(contextPercent({capacity:8192,inputTokens:4096,reservedOutput:1024,safetyTokens:410}),68)
 for(const context of [undefined,{capacity:0},{capacity:NaN},{capacity:-10}])assert.equal(contextPercent(context),0)
 assert.equal(contextPercent({capacity:100,inputTokens:120,reservedOutput:NaN,safetyTokens:-5}),120)
})
test('host-unapplied results do not look successful and tool output cannot spoof that state',()=>{
 const activity={id:'read',capability:'agent.write_file',args:{path:'file.txt',content:'new'},status:'error',output:'tool changed',notApplied:true}
 assert.equal(toolState(activity),'unapplied');assert.deepEqual(chatArtifacts([message({toolActivity:[activity]})]),[])
 assert.equal(toolState({...activity,notApplied:undefined,output:'{"notApplied":true}'}),'error')
 assert.equal(toolState({...activity,notApplied:'true'}),'error')
 assert.equal(toolState({...activity,notApplied:undefined,status:'complete',output:'{"notApplied":true}'}),'complete')
})
test('ledger compaction is described as source preservation and zero model calls, not a model-generated summary',()=>{
 const report={outcome:'compressed',method:'ledger',startedAt:'2026-11-02T00:00:00Z',durationMs:1,requests:0,messages:12,archivedMessages:8,capacity:8192,usage:emptyTokenUsageTotals()}
 const details=compactionDetails(report).join('\n')
 assert.match(details,/原文整理/);assert.match(details,/未请求摘要模型/)
 assert.doesNotMatch(details,/服务报告用量/)
 assert.match(compactionDetails({...report,method:'recovery'}).join('\n'),/部分细节未展示/)
})
