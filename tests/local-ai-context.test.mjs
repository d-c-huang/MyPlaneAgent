import test from 'node:test'
import assert from 'node:assert/strict'
import {compactContext,contextMessages,contextStatus,estimateTokens,needsCompaction,isContextOverflow,inferenceBudget,assertContextFits} from '../dist-electron/main/local-ai-context.js'
import {ModelOutputLimitError} from '../dist-electron/main/local-ai-model-error.js'
const budget={contextLength:8192,maxTokens:1024}
const system=[{role:'system',content:'遵守用户要求；修改前确认。'}]
// User requirements remain verbatim; verbose assistant progress is the compressible history.
const history=()=>[{role:'user',content:'修复 web 中的登录问题，保留用户数据。'},...Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',content:i%2?`记录 ${i} `+'项目进展和验证结果。'.repeat(200):`继续检查第 ${i} 项。`})),{role:'user',content:'请继续验证，不要部署。'}]
const imageHistory=()=>[{role:'user',content:[{type:'text',text:'修复登录，保留数据。'},{type:'image_url',image_url:{url:'data:image/png;base64,source'}}]},...history().slice(1)]
const summarize=async()=>'目标：修复 web 登录，保留用户数据。已检查代码；尚未部署。下一步验证。'
const signal=()=>new AbortController().signal

test('a first message fits when configured output equals the entire context',async()=>{
 const configured={contextLength:2048,maxTokens:2048},effective=inferenceBudget(configured)
 const messages=[{role:'user',content:'你好'}]
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,system,undefined,effective)))
 await compactContext({history:messages,system,budget:effective,signal:signal(),summarize:async()=>assert.fail('A first short message needs no summary')})
 assert.equal(effective.maxTokens,1024)
 assert.equal(configured.maxTokens,2048)
 assert.equal(inferenceBudget({contextLength:8192,maxTokens:1024}).maxTokens,1024)
 assert.equal(inferenceBudget({contextLength:512,maxTokens:2048}).maxTokens,256)
})

test('large contexts allow provider output budgets while preserving half for input',()=>{
 assert.equal(inferenceBudget({contextLength:131072,maxTokens:65536}).maxTokens,65536)
 assert.equal(inferenceBudget({contextLength:32768,maxTokens:65536}).maxTokens,16384)
 assert.equal(inferenceBudget({contextLength:1_000_000,maxTokens:393216}).maxTokens,393216)
})

test('genuinely oversized input still fails with actionable token counts',()=>{
 const status=contextStatus([{role:'user',content:'字'.repeat(3000)}],system,undefined,inferenceBudget({contextLength:2048,maxTokens:2048}))
 assert.throws(()=>assertContextFits(status),/预留输出 1024 \+ 安全余量 \d+ > 容量 2048 tokens/)
})

test('compaction preserves full history, newest request and system constraints; summaries survive subsequent rounds',async()=>{
 const messages=history(),original=structuredClone(messages),checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize})
 assert.ok(checkpoint);assert.deepEqual(messages,original)
 const compacted=contextMessages(messages,system,checkpoint)
 assert.equal(compacted[0],system[0]);assert.equal(compacted.at(-1),messages.at(-1));assert.match(compacted[1].content,/保留用户数据/)
 assert.ok(contextStatus(messages,system,checkpoint,budget).inputTokens<contextStatus(messages,system,undefined,budget).inputTokens)
 const later=[...messages,{role:'assistant',content:'继续验证。'.repeat(800)},{role:'user',content:'验证结束后总结'}]
 const next=await compactContext({history:later,system,checkpoint,budget,force:true,signal:signal(),summarize:async rows=>{assert.match(rows[1].content,/保留用户数据/);return summarize()}})
 assert.equal(next.compactions,2);assert.ok(next.through>checkpoint.through)
})
test('tool results remain attached to their assistant call; latest user request remains pinned',async()=>{
 const messages=[{role:'user',content:'只检查，不部署'},...Array.from({length:5},(_,i)=>[{role:'assistant',content:null,tool_calls:[{id:'call'+i,function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'call'+i,content:'文件内容'.repeat(1200)}]).flat()]
 const checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize})
 assert.notEqual(messages[checkpoint.through]?.role,'tool')
 const rows=contextMessages(messages,system,checkpoint);assert.ok(rows.some(row=>row.content==='只检查，不部署'))
 for(let i=0;i<rows.length;i++)if(rows[i].role==='tool')assert.ok(rows[i-1].tool_calls)
})
test('summary calls are bounded even for one huge tool result; image data never enters summary text',async()=>{
 const messages=[{role:'user',content:[{type:'text',text:'分析这张图'},{type:'image_url',image_url:{url:'data:image/png;base64,SECRETBINARY'}}]},{role:'assistant',content:'历史'.repeat(10000)},...history().slice(-2)]
 let calls=0
 const checkpoint=await compactContext({history:messages,system,budget,force:true,signal:signal(),summarize:async(rows,maxTokens)=>{calls++;assert.ok(estimateTokens(rows)+maxTokens<budget.contextLength);assert.doesNotMatch(JSON.stringify(rows),/SECRETBINARY/);return summarize()}})
 assert.ok(checkpoint);assert.ok(calls>1)
})
test('failure or cancellation cannot change previous checkpoint or original history',async()=>{
 const messages=history(),original=structuredClone(messages),previous={summary:'旧摘要',through:1,compactions:1,updatedAt:'before'},saved=structuredClone(previous)
 await assert.rejects(compactContext({history:messages,system,checkpoint:previous,budget,force:true,signal:signal(),summarize:async()=>{throw new Error('offline')}}),/offline/)
 const controller=new AbortController()
 await assert.rejects(compactContext({history:messages,system,checkpoint:previous,budget,force:true,signal:controller.signal,summarize:async()=>{controller.abort();return summarize()}}))
 assert.deepEqual(previous,saved);assert.deepEqual(messages,original)
})
test('small conversations skip model calls; oversized latest input yields actionable error',async()=>{
 let calls=0;const run=messages=>compactContext({history:messages,system,budget,signal:signal(),summarize:async()=>{calls++;return summarize()}})
 assert.equal(await run([{role:'user',content:'你好'}]),undefined);assert.equal(calls,0)
 await assert.rejects(run([{role:'user',content:'超长要求'.repeat(10000)}]),/缩短最新要求/)
 assert.equal(calls,0)
})
test('occupancy includes output reservation and tool schemas, separate from cumulative usage',()=>{
 const status=contextStatus([{role:'user',content:'abc'}],system,undefined,{contextLength:4096,maxTokens:3000,overhead:'工具'.repeat(300)})
 assert.ok(status.inputTokens>1000);assert.equal(status.reservedOutput,3000);assert.equal(status.estimated,true);assert.equal(needsCompaction(status),true)
 assert.equal(isContextOverflow('maximum context length exceeded'),true);assert.equal(isContextOverflow('network timeout'),false)
})


test('summary truncation retries with bounded extra generation room and never uses partial output',async()=>{
 const messages=history(),original=structuredClone(messages);let calls=0,lastLimit=0
 const settings={contextLength:8192,maxTokens:2048}
 const checkpoint=await compactContext({history:messages,system,budget:settings,force:true,signal:signal(),summarize:async(rows,maxTokens)=>{
  calls++;assert.ok(estimateTokens(rows)+maxTokens<settings.contextLength);assert.ok(maxTokens<=settings.maxTokens)
  if(calls===1){lastLimit=maxTokens;throw new ModelOutputLimitError(maxTokens)}
  if(calls===2){assert.ok(maxTokens>lastLimit);assert.match(rows[0].content,/上一轮摘要被截断/)}
  return summarize()
 }})
 assert.ok(checkpoint);assert.ok(calls>=2);assert.deepEqual(messages,original)
})

test('large local contexts can finish reasoning summaries beyond the fixed 2048-token retry limit',async()=>{
 const messages=[{role:'user',content:'检查项目，不要部署。'},{role:'assistant',content:'已检查的原始记录。'.repeat(5000)},{role:'user',content:'继续验证'}]
 const original=structuredClone(messages),limits=[]
 const settings={contextLength:32768,maxTokens:8192}
 const checkpoint=await compactContext({history:messages,system,budget:settings,signal:signal(),summarize:async(rows,limit)=>{
  limits.push(limit)
  assert.ok(estimateTokens(rows)+limit<settings.contextLength)
  assert.ok(limit<=settings.maxTokens)
  assert.match(rows[0].content,/摘要最多 436 字/)
  if(limit<=2048)throw new ModelOutputLimitError(limit)
  return '<think>模型仍然进行了内部分析</think>检查项目，不要部署。已检查代码，待验证。'
 }})
 assert.deepEqual(limits.slice(0,2),[2048,8192])
 assert.doesNotMatch(checkpoint.summary,/<think>|内部分析/)
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,system,checkpoint,settings)))
 assert.deepEqual(messages,original)
})

test('summary input excludes thinking traces but keeps complete tool evidence and stored history',async()=>{
 const call={id:'write1',type:'function',function:{name:'write_file',arguments:'{"path":"report.txt","content":"report"}'}}
 const messages=[{role:'user',content:'生成报告，不要删除文件'},
  {role:'assistant',content:'准备写入',reasoning_content:'PRIVATE_TRACE'.repeat(10000),tool_calls:[call]},
  {role:'tool',tool_call_id:'write1',content:'已成功写入'},
  {role:'assistant',content:'报告已写入'}, {role:'user',content:'验证结果'}]
 const original=structuredClone(messages)
 const checkpoint=await compactContext({history:messages,system,budget,force:true,signal:signal(),summarize:async rows=>{
  assert.doesNotMatch(rows[1].content,/PRIVATE_TRACE|reasoning_content/)
  assert.ok(rows[1].content.includes(JSON.stringify(call)))
  assert.match(rows[1].content,/已成功写入|write1/)
  return '已写入 report.txt；不要删除文件；待验证。'
 }})
 assert.ok(checkpoint);assert.deepEqual(messages,original)
})

test('summary exhaustion reports its own budget and recovery failure without task-output advice',async()=>{
 await assert.rejects(compactContext({history:imageHistory(),system,budget,signal:signal(),summarize:async(_rows,limit)=>{throw new ModelOutputLimitError(limit)}}),error=>{
  assert.ok(error instanceof ModelOutputLimitError)
  assert.match(error.message,/历史摘要达到本次 1024 Token/)
  assert.match(error.message,/包含图片/)
  assert.doesNotMatch(error.message,/本轮工具未执行|Error:|工作区默认值/)
  return true
 })
})

test('repeated summary truncation pauses after one retry without replacing checkpoint',async()=>{
 const messages=imageHistory(),previous={summary:'旧摘要',through:1,compactions:1,updatedAt:'before'},saved=structuredClone(previous);let calls=0
 await assert.rejects(compactContext({history:messages,system,checkpoint:previous,budget,force:true,signal:signal(),summarize:async(_rows,limit)=>{calls++;throw new ModelOutputLimitError(limit)}}),/截断/)
 assert.equal(calls,2);assert.deepEqual(previous,saved)
})

test('2048-token context can retry a compact summary above the old 614-token ceiling',async()=>{
 const messages=[{role:'user',content:'检查文件，保留数据。'},{role:'assistant',content:'历史检查记录。'.repeat(300)},{role:'user',content:'继续'}]
 let calls=0
 const settings=inferenceBudget({contextLength:2048,maxTokens:2048})
 const checkpoint=await compactContext({history:messages,system:[],budget:settings,force:true,signal:signal(),summarize:async(rows,limit)=>{
  calls++;assert.ok(estimateTokens(rows)+limit<2048)
  if(calls===1)throw new ModelOutputLimitError(limit)
  assert.ok(limit>614||calls>2)
  return '保留数据；尚未检查文件，待继续。'
 }})
 assert.ok(checkpoint);assert.ok(calls>=2)
})

test('summary truncation retry obeys configured output cap and cancellation',async()=>{
 for(const cancel of [false,true]){
  let calls=0;const controller=new AbortController()
  const run=compactContext({history:history(),system,budget:{contextLength:8192,maxTokens:256},force:true,signal:controller.signal,summarize:async(_rows,limit)=>{
   calls++;assert.equal(limit,256)
   if(calls===1){if(cancel)controller.abort(new Error('cancel summary'));throw new ModelOutputLimitError(limit)}
   return '目标：修复登录。未部署；待验证。'
  }})
  if(cancel){await assert.rejects(run,/cancel summary/);assert.equal(calls,1)}else{assert.ok(await run);assert.ok(calls>=2)}
 }
})

test('a useful summary above the old fixed threshold is accepted if it fits and reduces history',async()=>{
 const messages=[{role:'user',content:'保留数据，不要部署。'},{role:'assistant',content:'历史检查结果。'.repeat(4000)},{role:'user',content:'继续验证'}]
 const next='已检查文件，尚未部署，需要继续验证。'.repeat(45)
 assert.ok(estimateTokens(next)>1024)
 const checkpoint=await compactContext({history:messages,system,budget:{contextLength:65536,maxTokens:32768},force:true,signal:signal(),summarize:async()=>next})
 assert.equal(checkpoint.summary,next)
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,system,checkpoint,{contextLength:65536,maxTokens:32768})))
})

test('empty and oversized summaries retry with the original source and preserve the latest request',async()=>{
 for(const bad of ['', '摘要'.repeat(10000)]){
  let calls=0;const sources=[];const messages=history()
  const checkpoint=await compactContext({history:messages,system,budget,force:true,signal:signal(),summarize:async rows=>{
   sources.push(rows[1].content);return ++calls===1?bad:'保留数据；尚未部署。继续验证。'
  }})
  assert.ok(checkpoint);assert.ok(calls>=2);assert.equal(sources[0],sources[1])
  assert.equal(contextMessages(messages,system,checkpoint).at(-1),messages.at(-1))
 }
})

test('optional summary failure keeps original context usable without installing partial summaries',async()=>{
 const messages=[{role:'user',content:'不要部署'},{role:'assistant',content:'检查记录。'.repeat(80)},{role:'user',content:'继续'}]
 const original=structuredClone(messages);let calls=0
 const result=await compactContext({history:messages,system,budget,force:true,signal:signal(),summarize:async()=>{calls++;return ''}})
 assert.equal(result,undefined);assert.equal(calls,2);assert.deepEqual(messages,original)
})

test('mandatory compaction rejects repeated empty summaries without changing old checkpoint',async()=>{
 const messages=imageHistory(),previous={summary:'保留数据，不部署',through:1,updatedAt:'before',compactions:1},original=structuredClone(previous)
 let calls=0
 await assert.rejects(compactContext({history:messages,system,checkpoint:previous,budget,force:true,signal:signal(),summarize:async()=>{calls++;return ''}}),/已自动重试一次/)
 assert.equal(calls,2);assert.deepEqual(previous,original)
})

test('completed think blocks are excluded from summaries; cancellation does not trigger recovery',async()=>{
 const messages=history()
 const checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize:async()=>'<think>内部分析</think>保留数据，尚未部署，继续验证。'})
 assert.doesNotMatch(checkpoint.summary,/<think>|内部分析/)
 const controller=new AbortController();let calls=0
 await assert.rejects(compactContext({history:messages,system,budget,signal:controller.signal,summarize:async()=>{calls++;controller.abort();return ''}}))
 assert.equal(calls,1)
})

test('repeated truncation recovers from source records without using partial generated output',async()=>{
 const messages=[{role:'user',content:'查询成都天气，必须提供来源。'},{role:'assistant',content:'旧网页内容'.repeat(6000)},{role:'user',content:'继续，别猜测天气。'}]
 const original=structuredClone(messages);let calls=0
 const checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize:async(_rows,limit)=>{calls++;throw new ModelOutputLimitError(limit)}})
 assert.equal(calls,2);assert.equal(checkpoint.source,'recovery');assert.deepEqual(messages,original)
 const rows=contextMessages(messages,system,checkpoint)
 assert.equal(rows.at(-1),messages.at(-1));assert.match(checkpoint.summary,/必须提供来源|省略|不要重放/)
 assert.doesNotThrow(()=>assertContextFits(contextStatus(messages,system,checkpoint,budget)))
})

test('source recovery preserves all tool identities, arguments and statuses with paired remaining turns',async()=>{
 const ledger=[{id:'write1',capability:'agent.write_file',args:{path:'report.txt'},status:'complete',output:'结果'.repeat(4000)},{id:'deny1',capability:'agent.run_command',args:{command:'rm report.txt'},status:'denied',output:'用户拒绝'}]
 const messages=[{role:'user',content:'创建报告，不要删除文件。'},{role:'assistant',content:'执行记录。\\n\\n本轮工具记录（资料）：\\n'.replaceAll('\\n','\n')+JSON.stringify(ledger)},{role:'user',content:'核实报告是否存在'}]
 const checkpoint=await compactContext({history:messages,system,budget,signal:signal(),summarize:async()=>''})
 assert.equal(checkpoint.source,'recovery')
 const recovered=JSON.parse(checkpoint.summary)
 const saved=recovered.records[0].executions
 assert.deepEqual(saved.map(({id,capability,args,status})=>({id,capability,args,status})),ledger.map(({id,capability,args,status})=>({id,capability,args,status})))
 assert.deepEqual(recovered.userRequests,['创建报告，不要删除文件。'])
})

test('source recovery refuses to drop user constraints or replace old images with guessed text',async()=>{
 const {recoverContext}=await import('../dist-electron/main/local-ai-context.js')
 assert.throws(()=>recoverContext([{role:'user',content:'不可省略的约束'.repeat(5000)}],system,undefined,budget,1),/无法安全恢复/)
 assert.throws(()=>recoverContext([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,original'}}]}],system,undefined,budget,1),/包含图片/)
})
