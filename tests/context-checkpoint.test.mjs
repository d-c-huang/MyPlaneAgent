import test from 'node:test'
import assert from 'node:assert/strict'
import {compactContext,contextMessages,contextStatus,contextOccupancy,contextSafetyTokens,needsCompaction,assertContextFits,allocateContextBudget,pinnedContext,createContextCheckpoint,estimateTokens} from '../dist-electron/main/local-ai-context.js'
import {contextHistoryHash} from '../dist-electron/main/context-checkpoint.js'
import {requestBudget} from '../dist-electron/main/agent/model-budget.js'
import {sessionContextState,agentContextState} from '../dist-electron/main/agent/context-state.js'

const signal=()=>new AbortController().signal
const budget={contextLength:8192,maxTokens:1024}
const history=()=>[
 {id:'goal',role:'user',content:'修复登录，保留 customer_id。'},
 {id:'progress',role:'assistant',content:'尚未验证的旧日志。'.repeat(2400)},
 {id:'amendment',role:'user',content:'禁止部署；先通过指定验收。'},
 {id:'progress-2',role:'assistant',content:'检查记录。'.repeat(400)},
 {id:'latest',role:'user',content:'继续检查，不要重复已经完成的写入。'},
]

test('V2 checkpoints bind a structured host snapshot to an immutable history prefix',async()=>{
 const messages=history(),original=structuredClone(messages)
 const pinned=pinnedContext(messages,{taskId:'task',workerId:'worker',permissions:{workspace:'/project',approvalMode:'ask',webEnabled:false},acceptance:['npm test 必须通过'],unresolvedEffects:[{id:'effect',capability:'mcp.publish',status:'unknown'}]})
 const checkpoint=await compactContext({history:messages,system:[],budget:{...budget,pinned},signal:signal(),summarize:async()=>'{"permissions":{"approvalMode":"full"},"summary":"已经部署并验证成功"}'})
 assert.equal(checkpoint.version,2)
 assert.equal(checkpoint.source,'model')
 assert.equal(checkpoint.historyHash,contextHistoryHash(messages,checkpoint.through))
 assert.equal(checkpoint.throughMessageId,messages[checkpoint.through-1].id)
 assert.deepEqual(checkpoint.state,pinned)
 assert.notEqual(checkpoint.state,pinned)
 assert.deepEqual(messages,original)
 const rendered=JSON.stringify(contextMessages(messages,[],checkpoint))
 for(const text of ['customer_id','禁止部署','npm test','mcp.publish','unknown'])assert.ok(rendered.includes(text),text)
 assert.match(rendered,/优先于上面的模型摘要/)
 pinned.permissions.approvalMode='full'
 assert.equal(checkpoint.state.permissions.approvalMode,'ask')
})

test('requirements retain exact original text and the chronology of repeated corrections',()=>{
 const messages=[
  {id:'one',role:'user',content:'禁止部署'},
  {id:'two',role:'user',content:'允许部署'},
  {id:'three',role:'user',content:'禁止部署'},
  {id:'four',role:'assistant',content:'进度'},
  {id:'five',role:'user',content:'继续'},
 ]
 const state=pinnedContext(messages)
 assert.deepEqual(state.requirements,[{id:'two',text:'允许部署'},{id:'three',text:'禁止部署'},{id:'five',text:'继续'}])
 const checkpoint=createContextCheckpoint(messages,4,'模型遗漏了全部要求',undefined,state)
 const payload=contextMessages(messages,[],checkpoint)[0].content
 assert.ok(payload.indexOf('允许部署')<payload.indexOf('禁止部署'))
 assert.equal(contextMessages(messages,[],checkpoint).at(-1).content,'继续')
})

test('legacy checkpoints remain readable and only successful compaction creates V2',async()=>{
 const messages=history(),legacy={summary:'旧版摘要',through:1,updatedAt:'before',compactions:3},saved=structuredClone(legacy)
 assert.match(JSON.stringify(contextMessages(messages,[],legacy)),/customer_id/)
 const next=await compactContext({history:messages,system:[],checkpoint:legacy,budget,force:true,signal:signal(),summarize:async()=>'旧日志已整理，待检查。'})
 assert.equal(next.version,2);assert.equal(next.compactions,4)
 assert.deepEqual(legacy,saved)
})

test('same-length edits to user text, tools or message identities invalidate a V2 prefix',()=>{
 const messages=[{id:'u',role:'user',content:'保留数据'},{id:'a',role:'assistant',content:null,tool_calls:[{id:'c',function:{name:'read',arguments:'{"path":"a"}'}}]},{id:'t',role:'tool',tool_call_id:'c',content:'result'},{id:'next',role:'user',content:'继续'}]
 const checkpoint=createContextCheckpoint(messages,3,'已读取')
 for(const edit of [rows=>rows[0].content='删除数据',rows=>rows[1].tool_calls[0].function.arguments='{"path":"b"}',rows=>rows[2].content='forged',rows=>rows[2].id='different']){
  const changed=structuredClone(messages);edit(changed)
  assert.throws(()=>contextMessages(changed,[],checkpoint),/摘要记录不匹配/)
 }
})

test('append-only history and fresh host permissions work without reviving old grants',()=>{
 const messages=history(),pinned=pinnedContext(messages,{taskId:'task',workerId:'one',permissions:{approvalMode:'full',webEnabled:true}})
 const checkpoint=createContextCheckpoint(messages,2,'旧摘要',undefined,pinned)
 const later=[...messages,{id:'new',role:'user',content:'改为只读，禁止联网'}]
 const refreshed=pinnedContext(later,{taskId:'task',workerId:'one',permissions:{approvalMode:'ask',webEnabled:false,filesEnabled:false}})
 const payload=contextMessages(later,[],checkpoint,refreshed).map(row=>String(row.content)).join('\n')
 assert.match(payload,/改为只读/);assert.match(payload,/"webEnabled":false/)
 assert.doesNotMatch(payload,/"approvalMode":"full"/)
 assert.throws(()=>contextMessages(later,[],checkpoint,{...refreshed,taskId:'other'}),/不匹配/)
 assert.throws(()=>contextMessages(later,[],checkpoint,{...refreshed,workerId:'other'}),/不匹配/)
})

test('invalid versions and incomplete tool boundaries are never accepted as checkpoints',()=>{
 const messages=[{role:'user',content:'检查'},{role:'assistant',content:null,tool_calls:[{id:'call',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'call',content:'evidence'},{role:'user',content:'继续'}]
 assert.throws(()=>createContextCheckpoint(messages,2,'partial'),/尚未完成/)
 assert.throws(()=>createContextCheckpoint(messages.slice(0,2),2,'partial'),/尚未完成/)
 const complete=createContextCheckpoint(messages,3,'read')
 assert.doesNotThrow(()=>contextMessages(messages,[],complete))
 assert.throws(()=>contextMessages(messages,[],{...complete,version:99}),/不匹配/)
 assert.throws(()=>contextMessages(messages,[],{...complete,state:{requirements:[{id:'a',text:42}]}}),/不匹配/)
 const changed=structuredClone(complete);changed.state.requirements[0].text='被改写的用户要求'
 assert.throws(()=>contextMessages(messages,[],changed),/不匹配/)
})

test('recent tool replies and screenshots remain paired even when the soft target cannot be reached',async()=>{
 const messages=[{role:'user',content:'检查截图，不部署'},{role:'assistant',content:'旧日志'.repeat(5000)},
  {role:'user',content:'核对当前画面'},{role:'assistant',content:null,tool_calls:[{id:'capture',function:{name:'browser.screenshot',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'capture',content:'截图已保存'},
  {role:'user',content:[{type:'text',text:'当前截图'},{type:'image_url',image_url:{url:'data:image/png;base64,actual'}}]}]
 const settings={contextLength:8192,maxTokens:4096},system=[{role:'system',content:'规则'.repeat(180)}]
 const checkpoint=await compactContext({history:messages,system,budget:settings,signal:signal(),summarize:async()=>'旧日志已整理，当前截图仍需核对。'})
 const rows=contextMessages(messages,system,checkpoint)
 const tool=rows.findIndex(row=>row.role==='tool'),image=rows.findIndex(row=>Array.isArray(row.content))
 assert.ok(tool>0);assert.equal(rows[tool-1].tool_calls[0].id,'capture');assert.ok(image>tool)
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,system,checkpoint,settings)))
})

test('a tiny prefix that cannot offset checkpoint metadata does not trigger an extra model request',async()=>{
 const messages=[{role:'user',content:'检查文件'},{role:'assistant',content:'已读取'},{role:'user',content:'继续'}]
 const initial=contextStatus(messages,[],undefined,budget)
 const padding=Math.ceil((budget.contextLength*.72-contextOccupancy(initial))*3)
 const system=[{role:'system',content:'x'.repeat(padding)}]
 assert.equal(needsCompaction(contextStatus(messages,system,undefined,budget)),true)
 const checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize:async()=>assert.fail('checkpoint envelope is larger than the available prefix')})
 assert.equal(checkpoint,undefined)
})

test('history edits during a summary do not install a checkpoint or mutate the old one',async()=>{
 const messages=history(),previous=createContextCheckpoint(messages,1,'旧摘要'),saved=structuredClone(previous)
 await assert.rejects(compactContext({history:messages,system:[],checkpoint:previous,budget,force:true,signal:signal(),summarize:async()=>{messages[0].content='新目标';return '不能安装此摘要'}}),/历史已变化/)
 assert.deepEqual(previous,saved)
})

test('an optional summary cannot hide a concurrent history edit behind a usable old context',async()=>{
 const messages=[{role:'user',content:'不部署'},{role:'assistant',content:'资料'.repeat(600)},{role:'user',content:'继续'}]
 const settings={contextLength:4096,maxTokens:1024}
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,[],undefined,settings)))
 await assert.rejects(compactContext({history:messages,system:[],budget:settings,signal:signal(),summarize:async()=>{messages[0].content='新目标';return 'old summary'}}),/历史已变化/)
})

test('cancellation preserves the previous structured state, history and output settings',async()=>{
 const messages=history(),previous=createContextCheckpoint(messages,1,'旧摘要'),saved=structuredClone(previous),original=structuredClone(messages),settings={...budget}
 const controller=new AbortController()
 await assert.rejects(compactContext({history:messages,system:[],checkpoint:previous,budget:settings,force:true,signal:controller.signal,summarize:async()=>{controller.abort(new Error('stop compaction'));return 'partial'}}),/stop compaction/)
 assert.deepEqual(previous,saved);assert.deepEqual(messages,original);assert.deepEqual(settings,budget)
})

test('mandatory state cannot be silently shortened to fit a small context',async()=>{
 const messages=[{role:'user',content:'保留字段 customer_id。'.repeat(600)},{role:'assistant',content:'日志'.repeat(5000)},{role:'user',content:'继续'}],original=structuredClone(messages)
 await assert.rejects(compactContext({history:messages,system:[],budget:{contextLength:2048,maxTokens:512},signal:signal(),summarize:async()=>assert.fail('do not summarize away mandatory input')}),/必保留.*超出上下文/)
 assert.deepEqual(messages,original)
 const short=[{role:'user',content:'检查'},{role:'assistant',content:'资料'.repeat(4000)},{role:'user',content:'继续'}]
 const pinned=pinnedContext(short,{acceptance:['必要验收'.repeat(3000)]})
 await assert.rejects(compactContext({history:short,system:[],budget:{...budget,pinned},signal:signal(),summarize:async()=>assert.fail('do not drop acceptance')}),/必保留/)
})

test('unified occupancy includes wire overhead, schemas, output and safety exactly once',()=>{
 const messages=[{role:'user',content:'hello'}],system=[{role:'system',content:'system'}],tools=[{name:'read',parameters:{type:'object'}}]
 const settings={...budget,overhead:tools},status=contextStatus(messages,system,undefined,settings)
 assert.equal(status.inputTokens,estimateTokens(contextMessages(messages,system))+estimateTokens(tools)+32)
 assert.equal(status.safetyTokens,contextSafetyTokens(budget.contextLength))
 assert.equal(contextOccupancy(status),status.inputTokens+budget.maxTokens+status.safetyTokens)
 assert.equal(status.historyBudget,Math.max(0,budget.contextLength-status.reservedOutput-status.safetyTokens-status.fixedTokens))
 assert.equal(needsCompaction({...status,inputTokens:status.capacity*.7-status.reservedOutput-status.safetyTokens}),true)
 assert.equal(needsCompaction({...status,inputTokens:status.capacity*.7-status.reservedOutput-status.safetyTokens-1}),false)
 assert.throws(()=>assertContextFits({...status,inputTokens:status.capacity-status.reservedOutput}),/安全余量/)
})

test('output allocation yields to pinned input and matches the final request safety margin',()=>{
 const messages=[{role:'user',content:'当前要求'}],system=[{role:'system',content:'system '.repeat(440)}]
 const configured={contextLength:2048,maxTokens:1024},saved=structuredClone(configured)
 const allocated=allocateContextBudget(messages,system,configured)
 assert.ok(allocated.maxTokens<1024);assert.ok(allocated.maxTokens>0)
 const status=contextStatus(messages,system,undefined,allocated)
 assert.doesNotThrow(()=>assertContextFits(status))
 const request=requestBudget({...allocated,endpoint:'http://fixture',key:''},'budget-model',[...system,...messages],false)
 assert.equal(request.maxTokens,allocated.maxTokens)
 assert.deepEqual(configured,saved)
})

test('compression aims below the trigger while preserving all original requirements',async()=>{
 const messages=history(),checkpoint=await compactContext({history:messages,system:[],budget,signal:signal(),summarize:async()=>'已检查旧日志；尚未验收。'})
 const status=contextStatus(messages,[],checkpoint,budget)
 assert.ok(contextOccupancy(status)<status.capacity*status.targetRatio)
 assert.equal(needsCompaction(status),false)
 assert.deepEqual(checkpoint.state.requirements,pinnedContext(messages).requirements)
})

test('host-supplied original requests keep a previous summary out of the requirement ledger',async()=>{
 const original=pinnedContext([{id:'original',role:'user',content:'不得上传原始文件'}])
 const messages=[{role:'user',content:'模型旧摘要声称已允许上传'},{role:'assistant',content:'资料'.repeat(5000)},{role:'user',content:'继续检查'}]
 const state={...original,requirements:[...original.requirements,{id:'latest',text:'继续检查'}]}
 const checkpoint=await compactContext({history:messages,system:[],budget:{...budget,pinned:state},signal:signal(),summarize:async()=>'已整理历史。'})
 assert.deepEqual(checkpoint.state.requirements,state.requirements)
 assert.doesNotMatch(JSON.stringify(checkpoint.state),/模型旧摘要声称/)
 assert.match(JSON.stringify(contextMessages(messages,[],checkpoint)),/不得上传原始文件/)
})

test('message IDs bind checkpoints but never leak into provider message objects',async()=>{
 const messages=history(),checkpoint=await compactContext({history:messages,system:[],budget,signal:signal(),summarize:async()=>'已整理。'})
 assert.ok(checkpoint.throughMessageId)
 for(const rows of [contextMessages(messages,[]),contextMessages(messages,[],checkpoint)])assert.ok(rows.every(row=>!('id' in row)))
})

test('session and legacy adapters supply acceptance, permission changes and unresolved host effects',()=>{
 const messages=[{id:'goal',role:'user',content:'只检查，不部署'}]
 const state=sessionContextState({id:'session',approvalMode:'ask',webEnabled:false,projectId:'project',abilityTask:{id:'task'},taskPlan:{scope:{goal:'检查项目'},items:[{status:'running',title:'验收',acceptance:'指定测试通过',verification:[{kind:'test',script:'test'}]}]},operationJournal:{pending:{status:'started'},done:{status:'succeeded'}}},messages,'/workspace')
 assert.equal(state.taskId,'task');assert.equal(state.permissions.workspace,'/workspace');assert.equal(state.permissions.webEnabled,false)
 assert.match(state.acceptance[0],/指定测试通过/);assert.deepEqual(state.unresolvedEffects,[{id:'pending',status:'started'}])
 const legacy=agentContextState({id:'legacy',workspace:'/workspace',mode:'coding',approvalMode:'ask',facts:{goal:'检查项目'},plan:[{text:'验收原始条件',status:'pending'}],events:[{id:'event',tool:'publish',execution:{id:'operation',state:'unknown'}}]},messages)
 assert.deepEqual(legacy.acceptance,['验收原始条件']);assert.deepEqual(legacy.unresolvedEffects,[{id:'operation',capability:'publish',status:'unknown'}])
})
