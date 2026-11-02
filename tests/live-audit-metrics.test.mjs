import test from 'node:test'
import assert from 'node:assert/strict'
import {recordAuditUsage,phaseMetrics,combinedMetrics,auditPassed} from '../scripts/lib/live-audit-metrics.mjs'

test('live audit counts each logical request once and preserves missing usage fields',()=>{
 const report={requests:3,startedAt:'2026-11-02T00:00:00Z',finishedAt:'2026-11-02T00:00:02Z',wireRequests:[{kind:'task'},{kind:'summary'},{kind:'review'},{kind:'task'}]}
 recordAuditUsage(report,1,{inputTokens:100,outputTokens:2,totalTokens:102})
 recordAuditUsage(report,1,{outputTokens:5,totalTokens:105})
 recordAuditUsage(report,2,{totalTokens:40})
 recordAuditUsage(report,2,{totalTokens:40,inputTokens:-1,other:123})
 const metrics=phaseMetrics(report)
 assert.equal(metrics.durationMs,2000);assert.equal(metrics.wireRequests,4);assert.equal(metrics.summaryRequests,1);assert.equal(metrics.reviewRequests,1)
 assert.deepEqual(metrics.usage,{requests:3,inputTokens:100,outputTokens:5,totalTokens:145,inputReports:1,outputReports:1,totalReports:2})
 assert.throws(()=>recordAuditUsage(report,0,{}),/started request/)
})

test('live audit combines interrupted phases and retries without counting absent usage as reported zero',()=>{
 const a={requests:1,requestUsages:{1:{totalTokens:30}},startedAt:'2026-11-02T00:00:00Z',finishedAt:'2026-11-02T00:00:01Z',wireRequests:[{kind:'summary'}]}
 const b={...a,requests:2,requestUsages:{2:{totalTokens:10}},wireRequests:[{kind:'task'},{kind:'review'}]}
 const metrics=combinedMetrics([a,b])
 assert.equal(metrics.durationMs,2000);assert.equal(metrics.logicalRequests,3);assert.equal(metrics.wireRequests,3)
 assert.equal(metrics.usage.totalTokens,40);assert.equal(metrics.usage.totalReports,2);assert.equal(metrics.usage.inputReports,0)
 assert.equal(phaseMetrics({requests:1}).usage,undefined)
 assert.equal(combinedMetrics([{requests:2}]).usage.totalReports,0)
})

test('an empty or partial non-boolean check set cannot pass a live audit',()=>{
 assert.equal(auditPassed({}),false);assert.equal(auditPassed({a:true}),true)
 assert.equal(auditPassed({a:true,b:false}),false);assert.equal(auditPassed({a:'passed'}),false)
})
