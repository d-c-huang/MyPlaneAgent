import test from 'node:test'
import assert from 'node:assert/strict'
import {parseCompletionReview} from '../dist-electron/main/agent/core/completion-review.js'
test('completion review rejects ambiguous, incomplete and unstructured decisions',()=>{
 for(const text of ['已完成','null','{"status":"complete","reason":""}','{"status":"continue","reason":"未完成"}','{"status":"complete","reason":"done"}{"status":"blocked","reason":"failed"}','<think>{"status":"complete","reason":"thought"}','{"status":"complete","reason":"cut'])assert.equal(parseCompletionReview(text),undefined,text)
})
test('review keeps braces in strings and validates the next step',()=>{
 assert.deepEqual(parseCompletionReview('结果：{"status":"continue","reason":"检查 {} 配置","nextStep":"读取配置"}'),{status:'continue',reason:'检查 {} 配置',nextStep:'读取配置'})
})

test('structured checks are bounded, validated and never parsed from truncated JSON',()=>{
 const action={title:'读取页面',capability:'browser.read_page',args:{},basis:'测试页面',required:true}
 const value={status:'continue',reason:'仍需读取',actions:[action],optionalChecks:['性能测试']}
 const parsed=parseCompletionReview(JSON.stringify(value))
 assert.deepEqual(parsed.actions,[action]);assert.deepEqual(parsed.optionalChecks,['性能测试']);assert.ok(parsed.nextStep)
 for(const actions of [[{...action,args:[]}],[{...action,required:'yes'}],Array(7).fill(action)])assert.equal(parseCompletionReview(JSON.stringify({...value,actions})),undefined)
 assert.equal(parseCompletionReview(JSON.stringify(value).slice(0,-2)),undefined)
})

test('nine historical evidence IDs are rejected; optional implementation remains bounded at eight',()=>{
 const review={status:'complete',reason:'已核对原始记录',implementation:{status:'present',evidenceIds:Array.from({length:9},(_,i)=>'activity-'+i)}}
 assert.equal(parseCompletionReview(JSON.stringify(review)),undefined)
 assert.equal(parseCompletionReview(JSON.stringify({...review,implementation:{...review.implementation,evidenceIds:review.implementation.evidenceIds.slice(0,8)}})).status,'complete')
 assert.equal(parseCompletionReview(JSON.stringify({status:'complete',reason:review.reason})).status,'complete')
})
