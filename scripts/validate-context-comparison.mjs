// Opt-in real-model ablation: identical runtime, prompts and fixture files; only tool-result projection differs.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {isolatedGitWorkspace} from '../tests/helpers/workspace.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const output=process.env.MYPLANE_COMPARISON_OUTPUT||isolatedGitWorkspace('myplane-architecture-live-')
fs.mkdirSync(output,{recursive:true})
const baseline=path.join(output,'baseline'),optimized=path.join(output,'optimized'),copy=path.join(output,'baseline-runtime')
if(fs.existsSync(copy)||fs.existsSync(baseline)||fs.existsSync(optimized))throw Error('Comparison output must be fresh; previous evidence is never overwritten')
fs.mkdirSync(copy)
fs.copyFileSync(path.join(root,'package.json'),path.join(copy,'package.json'))
fs.cpSync(path.join(root,'dist-electron'),path.join(copy,'dist-electron'),{recursive:true})
fs.cpSync(path.join(root,'scripts'),path.join(copy,'scripts'),{recursive:true})
fs.mkdirSync(path.join(copy,'tests'));fs.cpSync(path.join(root,'tests','helpers'),path.join(copy,'tests','helpers'),{recursive:true})
fs.symlinkSync(path.join(root,'node_modules'),path.join(copy,'node_modules'),process.platform==='win32'?'junction':'dir')
const projector=path.join(copy,'dist-electron','main','model-context-projection.js')
const body=fs.readFileSync(projector,'utf8'),needle='function projectResult(message, capacity) {'
if(body.split(needle).length!==2)throw Error('Compiled projector shape changed; refusing an ambiguous baseline patch')
fs.writeFileSync(projector,body.replace(needle,needle+'\n    return message; // Isolated audit ablation; identity reconciliation remains active.'))
const digest=value=>createHash('sha256').update(value).digest('hex')
const config={output,baseline:'Current architecture with tool-result projection disabled in a private compiled copy (its preview-based compaction paths are inactive)',optimized:'Current architecture',projectorHash:digest(body),baselineProjectorHash:digest(fs.readFileSync(projector)),compactorHash:digest(fs.readFileSync(path.join(root,'dist-electron','main','local-ai-context.js'))),ledgerHash:digest(fs.readFileSync(path.join(root,'dist-electron','main','context-tool-ledger.js'))),order:['baseline','optimized'],scope:'One paired synthetic task; elapsed time is observational, not a statistically established speedup',startedAt:new Date().toISOString()}
fs.writeFileSync(path.join(output,'comparison-config.json'),JSON.stringify(config,null,2))
console.log(JSON.stringify(config))

async function run(directory,destination){
 fs.mkdirSync(destination,{recursive:true})
 return await new Promise((resolve,reject)=>{
  const proc=spawn(process.execPath,[path.join(directory,'scripts','validate-context-live.mjs'),'all'],{cwd:directory,windowsHide:true,env:{...process.env,MYPLANE_LIVE_OUTPUT:destination},stdio:['ignore','pipe','pipe']})
  proc.stdout.on('data',data=>{fs.appendFileSync(path.join(destination,'driver.log'),data);process.stdout.write(data)})
  proc.stderr.on('data',data=>fs.appendFileSync(path.join(destination,'driver.log'),data))
  proc.once('error',reject);proc.once('exit',resolve)
 })
}
let error
const exitCodes={}
function cloneFixtures(source,destination){
 fs.mkdirSync(path.join(destination,'workspace'),{recursive:true})
 const fixture=JSON.parse(fs.readFileSync(path.join(source,'fixture.json'),'utf8'))
 if(!Array.isArray(fixture.batches)||fixture.batches.some(row=>!/^batch-\d{2}\.txt$/.test(row.path)))throw Error('Unexpected fixture path')
 fs.copyFileSync(path.join(source,'fixture.json'),path.join(destination,'fixture.json'))
 fs.writeFileSync(path.join(destination,'bench-state.json'),JSON.stringify({reads:[],writes:0}))
 for(const batch of fixture.batches)fs.copyFileSync(path.join(source,'workspace',batch.path),path.join(destination,'workspace',batch.path))
}
try{
 if(process.env.MYPLANE_COMPARISON_FIXTURES)cloneFixtures(process.env.MYPLANE_COMPARISON_FIXTURES,baseline)
 exitCodes.baseline=await run(copy,baseline)
 cloneFixtures(baseline,optimized)
 exitCodes.optimized=await run(root,optimized)
 if(Object.values(exitCodes).some(code=>code!==0))error='At least one live audit failed; inspect its checks and driver log'
}catch(caught){error=caught.message}
const load=directory=>{const file=path.join(directory,'report.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):undefined}
const a=load(baseline),b=load(optimized)
const report={...config,finishedAt:new Date().toISOString(),error,exitCodes,baseline:a,optimized:b,passed:!error&&a?.passed===true&&b?.passed===true}
const fixtureFile=path.join(baseline,'fixture.json')
if(fs.existsSync(fixtureFile))report.fixtureHash=digest(fs.readFileSync(fixtureFile))
if(a?.longTask?.metrics&&b?.longTask?.metrics){
 const first=a.longTask.metrics,second=b.longTask.metrics
 report.longTaskDelta={sameAcceptance:a.checks.completed===true&&b.checks.completed===true&&a.checks.allCodesReported===true&&b.checks.allCodesReported===true,
  durationMs:second.durationMs-first.durationMs,logicalRequests:second.logicalRequests-first.logicalRequests,summaryRequests:second.summaryRequests-first.summaryRequests,
  totalTokens:first.usage.totalReports===first.usage.requests&&second.usage.totalReports===second.usage.requests?second.usage.totalTokens-first.usage.totalTokens:undefined,
  redundantBatchReads:b.longTask.redundantBatchReads-a.longTask.redundantBatchReads}
}
fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,error,delta:report.longTaskDelta}))
if(!report.passed)process.exitCode=1
