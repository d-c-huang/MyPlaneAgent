import test from 'node:test'
import assert from 'node:assert/strict'
import {fitReadbackPage,fitReadbackList,readbackTokens} from '../dist-electron/main/agent/core/readback-budget.js'

const envelope={activityId:'f1575622-56ba-4f1d-9f5a-a7711f961937',capability:'runtime.read_history'}
test('token-aware history pages reconstruct escaped Unicode without skipping any source characters',()=>{
 const source='原始😀"\n\\value'.repeat(500),snapshot='a'.repeat(64)
 let offset=0,joined='',pages=0
 do{
  const page=fitReadbackPage({text:source.slice(offset),offset,total:source.length,matches:1,through:2,snapshot,truncated:false},'text',384,envelope)
  assert.ok(readbackTokens(page,envelope)<=384);assert.ok(page.text.length>0)
  assert.equal(page.snapshot,snapshot);assert.equal(page.through,2)
  assert.doesNotMatch(page.text,/[\uD800-\uDBFF]$/)
  joined+=page.text;offset=page.nextOffset;pages++
 }while(offset!==undefined)
 assert.equal(joined,source);assert.ok(pages>1)
})

test('evidence uses an explicit nextOffset and list cursors advance only by returned records',()=>{
 const result=fitReadbackPage({output:'long '.repeat(3000),offset:0,total:15000,truncated:true},'output',256,{...envelope,capability:'runtime.read_evidence'})
 assert.equal(result.nextOffset,result.output.length);assert.ok(readbackTokens(result,{...envelope,capability:'runtime.read_evidence'})<=256)
 const rows=Array.from({length:20},(_,i)=>({workerId:'worker-'+i,description:'long description '.repeat(20)}))
 let offset=0,all=[]
 do{const page=fitReadbackList(rows,offset,20,384,envelope);assert.ok(page.workers.length>0);assert.ok(readbackTokens(page,envelope)<=384);all.push(...page.workers);offset=page.nextOffset}while(offset!==undefined)
 assert.deepEqual(all,rows)
})

test('impossible metadata budgets fail instead of producing a successful zero-progress page',()=>{
 assert.throws(()=>fitReadbackPage({text:'source',offset:0,total:6,snapshot:'a'.repeat(64),truncated:false},'text',1,envelope),/预算不足/)
 assert.throws(()=>fitReadbackList([{workerId:'worker'}],0,1,1,envelope),/预算不足/)
 assert.throws(()=>fitReadbackList([],1,1,384,envelope),/偏移无效/)
 const short={text:'original',offset:0,total:8,truncated:false}
 assert.equal(fitReadbackPage(short,'text',undefined),short)
})
