import {sumTokenUsage} from '../../dist-electron/shared/local-ai-usage.js'

// Provider frames are cumulative within one logical request. Missing fields stay unknown.
export function recordAuditUsage(report,request,usage){
 if(!Number.isSafeInteger(request)||request<1)throw Error('Usage must belong to a started request')
 const safe=Object.fromEntries(Object.entries(usage).filter(([key,value])=>['inputTokens','outputTokens','totalTokens'].includes(key)&&Number.isSafeInteger(value)&&value>=0))
 report.requestUsages??={}
 report.requestUsages[request]={...report.requestUsages[request],...safe}
}

export function phaseMetrics(report){
 const usage=report.requestUsages?sumTokenUsage(Array.from({length:report.requests},(_,i)=>report.requestUsages[i+1])):undefined
 const durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt)
 return {durationMs:Number.isFinite(durationMs)&&durationMs>=0?durationMs:undefined,logicalRequests:report.requests,wireRequests:report.wireRequests?.length,
  summaryRequests:report.wireRequests?.filter(row=>row.kind==='summary').length,
  reviewRequests:report.wireRequests?.filter(row=>row.kind==='review').length,usage}
}

export function combinedMetrics(reports){
 const phases=reports.map(phaseMetrics),usages=reports.flatMap(report=>report.requestUsages?Array.from({length:report.requests},(_,i)=>report.requestUsages[i+1]):Array(report.requests).fill(undefined))
 return {durationMs:phases.every(row=>row.durationMs!==undefined)?phases.reduce((sum,row)=>sum+row.durationMs,0):undefined,
  logicalRequests:phases.reduce((sum,row)=>sum+row.logicalRequests,0),
  wireRequests:phases.every(row=>row.wireRequests!==undefined)?phases.reduce((sum,row)=>sum+row.wireRequests,0):undefined,
  summaryRequests:phases.every(row=>row.summaryRequests!==undefined)?phases.reduce((sum,row)=>sum+row.summaryRequests,0):undefined,
  usage:sumTokenUsage(usages)}
}

export function auditPassed(checks){return Object.keys(checks).length>0&&Object.values(checks).every(value=>value===true)}
