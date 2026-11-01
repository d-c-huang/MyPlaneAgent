import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {ExperienceStore} from '../dist-electron/main/agent/core/experience-store.js'
import {ExperienceFlow,flowInputs} from '../dist-electron/main/agent/core/experience-flow.js'
import {SearchHealth} from '../dist-electron/main/agent/search-health.js'
import {searchOrders} from '../dist-electron/main/agent/search-engines.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
import {workspaceCleanup} from './helpers/workspace.mjs'
function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'experience-flow-')),track=workspaceCleanup(t,directory);let now=Date.now();const store=new ExperienceStore(directory,()=>now);return {directory,store,track,advance:ms=>now+=ms}}
const context=workspace=>({workspace,region:'CN',webEnabled:true,filesEnabled:true,tools:['agent.web_search','agent.web_fetch','agent.read_file']})
function seed(store,workspace,kind='web'){store.record(kind==='web'?'搜索 Vue 文档':'读取 README.md',workspace,kind==='web'?['agent.web_search','agent.web_fetch']:['agent.read_file'],true);return store.state().entries.at(-1)}
test('record conversion preserves identity, history and validation gates across reload and rollback',t=>{
 const {store,directory}=setup(t)
 fs.writeFileSync(path.join(directory,'README.md'),'evidence')
 const traces=[['agent.web_search'],['browser.open','browser.read_page'],['agent.web_search','agent.web_search','agent.web_fetch'],['agent.search_files','agent.read_file','agent.read_file']]
 for(const tools of traces){
  const files=tools.includes('agent.read_file'),query=files?'读取 README.md':'搜索 Vue 文档'
  store.record(query,directory,tools,true)
  const original=store.state().entries.at(-1)
  assert.equal(original.recipe.kind,'unsupported')
  store.convert(original.id,1)
  const entry=store.get(original.id)
  assert.equal(entry.recipe.kind,files?'file-read':'web-research')
  assert.deepEqual(entry.tools,tools);assert.equal(entry.revision,2)
  assert.equal(entry.enabled,false);assert.equal(entry.history[0].recipe.kind,'unsupported')
  assert.throws(()=>store.enable(entry.id,2,true),/试运行/)
  assert.throws(()=>store.convert(entry.id,1),/版本/)
  const flow=new ExperienceFlow(entry,files?{path:'README.md'}:{query:'Vue docs'},directory,'evidence')
  assert.equal(flow.next().capability,files?'agent.read_file':'agent.web_search')
  if(!files){flow.observe({capability:'agent.web_search',status:'complete',output:{results:[{url:'https://vuejs.org/guide',title:'Vue docs'}]}});assert.equal(flow.next().capability,'agent.web_fetch')}
  flow.observe({capability:files?'agent.read_file':'agent.web_fetch',status:'complete',output:files?{path:'README.md',text:'evidence'}:{url:'https://vuejs.org/guide',text:'Vue docs evidence'}})
  assert.equal(flow.passed,true)
  store.verify(entry.id,2,true,flow.checks,'通过');store.enable(entry.id,2,true)
  const loaded=new ExperienceStore(directory)
  assert.equal(loaded.get(entry.id).enabled,true)
  assert.equal(loaded.diagnose(query,context(directory)).find(row=>row.entry.id===entry.id)?.reasons.length,0)
  loaded.rollback(entry.id,2,1)
  assert.equal(new ExperienceStore(directory).get(entry.id).recipe.kind,'unsupported')
  loaded.rollback(entry.id,3,2)
  assert.equal(new ExperienceStore(directory).get(entry.id).recipe.kind,entry.recipe.kind)
  store.record(query,directory,tools,true)
  assert.equal(store.get(entry.id).recipe.kind,entry.recipe.kind)
 }
 store.record('搜索资料',directory,['agent.web_search','agent.read_file'],true)
 const mixed=store.state().entries.at(-1)
 assert.throws(()=>store.convert(mixed.id,1),/不能转换/)
})
test('candidate trial, manual enable, matching, edit, rollback, CAS and expiry',t=>{
 const {store,directory,advance}=setup(t),e=seed(store,directory)
 assert.throws(()=>store.enable(e.id,1,true),/试运行/)
 store.edit(e.id,1,{...e.recipe,keywords:['Vue'],regions:['CN'],sourceHost:'vuejs.org',ttlHours:1})
 store.verify(e.id,2,true,['来源正确'],'通过')
 assert.equal(store.match('搜索 Vue 文档',context(directory)),undefined)
 store.enable(e.id,2,true)
 assert.equal(store.match('搜索 Vue 文档',context(directory)).revision,2)
 for(const ctx of [{region:'KR'},{webEnabled:false},{tools:['agent.web_search']},{workspace:directory+'-other'},{sourceHost:'other.org'}])assert.equal(store.match('搜索 Vue 文档',{...context(directory),...ctx}),undefined)
 assert.equal(store.match('搜索 Python 文档',context(directory)),undefined)
 assert.throws(()=>store.edit(e.id,1,e.recipe),/版本/)
 store.rollback(e.id,2,1)
 assert.equal(store.get(e.id).revision,3);assert.equal(store.get(e.id).enabled,false);assert.equal(store.get(e.id).verification,undefined)
 store.verify(e.id,3,true,[],'通过');store.enable(e.id,3,true)
 advance(25*3600000)
 assert.equal(store.match('搜索 Vue 文档',context(directory)),undefined)
 assert.throws(()=>store.enable(e.id,3,true),/试运行/)
})
test('legacy records migrate to disabled candidates; unknown mutations cannot be learned',t=>{
 const {store,directory}=setup(t);store.record('搜索资料',directory,['agent.web_search','agent.run_command'],true);assert.equal(store.state().entries.length,0)
 const e=seed(store,directory);const file=path.join(directory,'experience-library.json')
 fs.writeFileSync(file,JSON.stringify({enabled:true,entries:[{id:e.id,scope:e.scope,intent:e.intent,status:'verified',tools:e.tools,successes:1,failures:0,updatedAt:e.updatedAt}]}))
 const loaded=new ExperienceStore(directory);assert.equal(loaded.get(e.id).status,'candidate');assert.equal(loaded.get(e.id).enabled,false)
 const state=loaded.state();state.entries[0].verification={passed:true,revision:1,expiresAt:'invalid'}
 fs.writeFileSync(file,JSON.stringify(state));assert.throws(()=>new ExperienceStore(directory),/验证记录/)
})
test('file workflow uses current evidence and rejects outside paths or changed revisions',t=>{
 const {store,directory}=setup(t),entry=seed(store,directory,'file')
 fs.writeFileSync(path.join(directory,'README.md'),'current evidence')
 assert.equal(flowInputs('读取 README.md 然后删除文件',entry.recipe),undefined)
 assert.deepEqual(flowInputs('读取 README.md',entry.recipe),{path:'README.md'})
 assert.throws(()=>new ExperienceFlow(entry,{path:'../secret.txt'},directory,'x').next())
 const flow=new ExperienceFlow(entry,{path:'README.md'},directory,'current')
 const action=flow.next();assert.equal(action.capability,'agent.read_file')
 flow.observe({capability:action.capability,status:'complete',output:{path:'README.md',text:fs.readFileSync(path.join(directory,'README.md'),'utf8')}})
 assert.equal(flow.passed,true)
 const wrong=new ExperienceFlow(entry,{path:'README.md'},directory,'old');wrong.next();wrong.observe({capability:'agent.read_file',status:'complete',output:{path:'README.md',text:'new'}});assert.equal(wrong.passed,false)
 let current=true;const stale=new ExperienceFlow(entry,{path:'README.md'},directory,'current',()=>current);stale.next();current=false;stale.observe({capability:'agent.read_file',status:'complete',output:{path:'README.md',text:'current'}});assert.equal(stale.passed,false)
})
test('web workflow follows returned links, permits checked redirects, rejects off-domain bodies',t=>{
 const {store,directory}=setup(t),entry=seed(store,directory);entry.recipe.sourceHost='vuejs.org'
 const run=finalUrl=>{const flow=new ExperienceFlow(entry,{query:'Vue docs'},directory,'Composition API');assert.equal(flow.next().capability,'agent.web_search');flow.observe({capability:'agent.web_search',status:'complete',output:{results:[{url:'https://vuejs.org/guide',title:'Vue docs'}]}});assert.equal(flow.next().args.url,'https://vuejs.org/guide');flow.observe({capability:'agent.web_fetch',status:'complete',output:{requestedUrl:'https://vuejs.org/guide',url:finalUrl,finalUrl,text:'Vue Composition API'}});return flow}
 assert.equal(run('https://vuejs.org/guide/').passed,true)
 assert.equal(run('https://evil.example/').passed,false)
 const empty=new ExperienceFlow(entry,{query:'Vue docs'},directory,'Vue');empty.next();empty.observe({capability:'agent.web_search',status:'complete',output:{results:[]}});assert.equal(empty.finished,true);assert.equal(empty.passed,false)
})
test('regional health requires repeated failures, recovers and expires without storing queries',t=>{
 const {directory,advance,store}=setup(t);let now=Date.now();const health=new SearchHealth(directory,()=>now),base={region:'CN',basis:'test'}
 const observe=(status,count=0)=>health.observe({region:'CN',query:'private-query',providers:[{name:'Baidu',status,count}],results:[{text:'private-body'}]})
 observe('failed');assert.deepEqual(health.routing(base).order,searchOrders.CN)
 observe('empty');assert.notEqual(health.routing(base).order[0],'baidu');assert.equal(health.state()[0].deprioritized,true)
 assert.deepEqual(health.routing({region:'GLOBAL',basis:'test'}).order,searchOrders.GLOBAL)
 observe('ok',2);assert.equal(health.routing(base).order[0],'baidu')
 observe('failed');observe('failed');store.configure(false);assert.equal(health.routing(base).order[0],'baidu')
 assert.doesNotMatch(fs.readFileSync(path.join(directory,'search-health.json'),'utf8'),/private-query|private-body/)
 now+=86400001;assert.deepEqual(health.state(),[])
})
test('trial service validates actual file and requires explicit network permission',async t=>{
 const {directory,track}=setup(t),service=track(new AgentCoreService({dataDir:directory,skillsDir:path.join(directory,'skills'),getConnection:()=>({})}))
 const e=seed(service.experiences,directory,'file')
 fs.writeFileSync(path.join(directory,'README.md'),'secret test evidence')
 service.capabilityRegistry.registerBuiltin({name:'agent.read_file',category:'agent',source:{type:'skill',skillId:'agent-tools'},runtime:'builtin',permissions:[],parameters:{type:'object',properties:{path:{type:'string'},startLine:{type:'number'},endLine:{type:'number'}}},tags:[]},async args=>({path:args.path,text:fs.readFileSync(path.join(directory,args.path),'utf8')}))
 const input={id:e.id,revision:1,webEnabled:false,values:{path:'README.md',expectedText:'secret test evidence'}}
 await assert.rejects(service.trialExperience(input,directory+'-other',false,false),/原工作目录/)
 const state=await service.trialExperience(input,directory,false,false);assert.equal(state.entries[0].status,'verified');assert.equal(state.entries[0].enabled,false)
 assert.doesNotMatch(fs.readFileSync(path.join(directory,'experience-library.json'),'utf8'),/secret test evidence|README/)
 const web=seed(service.experiences,directory)
 await assert.rejects(service.trialExperience({id:web.id,revision:1,webEnabled:false,values:{query:'Vue',expectedText:'Vue'}},directory,true,false),/允许本次联网/)
})


test('web alternatives are bounded, deduplicated and never continued after denial',t=>{
 const {store,directory}=setup(t),entry=seed(store,directory);entry.recipe.maxResults=2
 const results=[{url:'https://example.org/one',title:'Vue guide'},{url:'https://example.org/one',title:'Vue duplicate'},{url:'https://example.org/two',title:'Vue guide'},{url:'https://example.org/three',title:'Vue guide'}]
 const setupFlow=()=>{const flow=new ExperienceFlow(entry,{query:'Vue'},directory,'API');flow.next();flow.observe({id:'search',capability:'agent.web_search',status:'complete',output:{results}});return flow}
 const flow=setupFlow();assert.equal(flow.next().args.url,results[0].url)
 flow.observe({id:'failed',capability:'agent.web_fetch',status:'error'})
 assert.equal(flow.finished,false);assert.equal(flow.next().args.url,results[2].url)
 flow.observe({id:'read',capability:'agent.web_fetch',status:'complete',output:{url:results[2].url,text:'Vue API'}})
 assert.equal(flow.passed,true);assert.match(flow.reason,/跳过 1/);assert.deepEqual([...flow.failedReadIds],['failed'])
 const limit=setupFlow();limit.next();limit.observe({id:'a',capability:'agent.web_fetch',status:'complete',output:{url:results[0].url,text:'unrelated'}})
 limit.next();limit.observe({id:'b',capability:'agent.web_fetch',status:'complete',output:{url:results[2].url,text:'Vue but missing expectation'}})
 assert.equal(limit.finished,true);assert.equal(limit.passed,false);assert.equal(limit.next(),undefined)
 assert.equal(limit.checks.some(check=>check.includes('已读取')),false)
 const denied=setupFlow();denied.next();denied.observe({id:'deny',capability:'agent.web_fetch',status:'denied'})
 assert.equal(denied.finished,true);assert.equal(denied.next(),undefined);assert.match(denied.reason,/拒绝/)
})
test('trial service tries remaining results before failing and does not persist the samples',async t=>{
 const {directory,track}=setup(t),service=track(new AgentCoreService({dataDir:directory,skillsDir:path.join(directory,'skills'),getConnection:()=>({})})),e=seed(service.experiences,directory)
 const calls=[]
 service.capabilityRegistry.get=name=>({name,source:{type:'skill',skillId:'agent-tools'},runtime:'python-native'})
 service.capabilityRegistry.execute=async action=>{
  calls.push(action)
  if(action.capability==='agent.web_search')return {success:true,output:{results:[1,2,3].map(n=>({url:'https://example.org/'+n,title:'Vue guide'}))}}
  if(action.args.url.endsWith('/1'))return {success:false,error:'offline'}
  return {success:true,output:{url:action.args.url,text:action.args.url.endsWith('/2')?'unrelated':'Vue private expectation'}}
 }
 const result=await service.trialExperience({id:e.id,revision:1,webEnabled:true,values:{query:'Vue',expectedText:'private expectation'}},directory,true,false)
 assert.equal(calls.length,4);assert.equal(result.entries[0].verification.passed,true)
 assert.match(result.entries[0].verification.reason,/跳过 2/)
 assert.doesNotMatch(fs.readFileSync(path.join(directory,'experience-library.json'),'utf8'),/private expectation|example.org/)
})

test('matching explains each gate without storing the query or workspace',t=>{
 const {store,directory}=setup(t),e=seed(store,directory)
 store.edit(e.id,1,{...e.recipe,keywords:['Vue'],regions:['CN'],sourceHost:'vuejs.org'})
 store.verify(e.id,2,true,[],'ok');store.enable(e.id,2,true)
 const base=context(directory)
 for(const [patch,code] of [[{workspace:directory+'other'},'workspace'],[{region:'KR'},'region'],[{webEnabled:false},'network'],[{tools:[]},'tools'],[{sourceHost:'other.org'},'source']]){
  assert.ok(store.diagnose('搜索 Vue 文档',{...base,...patch})[0].reasons.includes(code))
 }
 const miss=store.diagnose('搜索 private-question',base)[0]
 assert.ok(miss.reasons.includes('keywords'));store.noteMatch(e.id,2,miss.reasons)
 const raw=fs.readFileSync(path.join(directory,'experience-library.json'),'utf8')
 assert.doesNotMatch(raw,/private-question/);assert.equal(raw.includes(directory),false)
 assert.deepEqual(new ExperienceStore(directory).get(e.id).lastMatch.reasons,miss.reasons)
 assert.deepEqual(store.diagnose('搜索 Vue 文档',base)[0].reasons,[])
 store.configure(false);assert.ok(store.diagnose('搜索 Vue 文档',base)[0].reasons.includes('library-off'))
})
test('temporary errors and interruptions preserve certification; validation failure suspends reuse',t=>{
 const {store,directory}=setup(t),e=seed(store,directory)
 store.verify(e.id,1,true,[],'ok');store.enable(e.id,1,true)
 const verification=store.get(e.id).verification
 for(const kind of ['temporary','denied','cancelled','unavailable','input','incomplete']){
  store.record('搜索 Vue',directory,e.tools,false,undefined,kind)
  assert.equal(store.get(e.id).enabled,true)
  assert.deepEqual(store.get(e.id).verification,verification)
 }
 assert.equal(store.get(e.id).failures,0);assert.equal(store.get(e.id).interruptions,6)
 store.verify(e.id,1,false,[],'timeout','temporary')
 assert.equal(store.get(e.id).enabled,true);assert.deepEqual(store.get(e.id).verification,verification)
 store.record('搜索 Vue',directory,e.tools,false,undefined,'validation')
 assert.equal(store.get(e.id).enabled,false);assert.equal(store.get(e.id).status,'candidate');assert.equal(store.get(e.id).failures,1)
})
test('flow distinguishes outage, denial, empty search and bad evidence',t=>{
 const {store,directory}=setup(t),e=seed(store,directory)
 const start=()=>{const f=new ExperienceFlow(e,{query:'Vue'},directory);f.next();return f}
 for(const [status,output,expected] of [['error','ETIMEDOUT','temporary'],['denied','no','denied'],['complete',{results:[]},'temporary'],['complete',{results:[{title:'unrelated',url:'https://example.org'}]},'validation']]){
  const f=start();f.observe({id:'s',capability:'agent.web_search',status,output});assert.equal(f.failureKind,expected)
 }
 const f=start();f.observe({id:'s',capability:'agent.web_search',status:'complete',output:{results:[{title:'Vue',url:'https://example.org'}]}});f.next();f.observe({id:'p',capability:'agent.web_fetch',status:'error',output:'Network timeout'});assert.equal(f.failureKind,'temporary')
})

test('a failed network trial retains enabled certification and records only a safe interruption',async t=>{
 const {directory,track}=setup(t),service=track(new AgentCoreService({dataDir:directory,skillsDir:path.join(directory,'skills'),getConnection:()=>({})})),e=seed(service.experiences,directory)
 service.experiences.verify(e.id,1,true,[],'ok');service.enableExperience(e.id,1,true)
 const before=service.experienceState().entries[0].verification
 service.capabilityRegistry.get=name=>({name,source:{type:'skill',skillId:'agent-tools'},runtime:'python-native'})
 service.capabilityRegistry.execute=async()=>({success:false,error:'ETIMEDOUT private-query-and-token'})
 const result=await service.trialExperience({id:e.id,revision:1,webEnabled:true,values:{query:'Vue',expectedText:'Vue'}},directory,true,false)
 const current=result.entries[0]
 assert.equal(current.enabled,true);assert.deepEqual(current.verification,before);assert.equal(current.lastIssue.kind,'temporary');assert.equal(current.interruptions,1)
 assert.doesNotMatch(fs.readFileSync(path.join(directory,'experience-library.json'),'utf8'),/private-query-and-token/)
})

test('alternate research phrasing still enforces explicit keywords, sources and region',t=>{
 const {store,directory}=setup(t),e=seed(store,directory)
 store.edit(e.id,1,{...e.recipe,keywords:['Vue'],sourceHost:'vuejs.org',regions:['CN']})
 store.verify(e.id,2,true,[],'ok');store.enable(e.id,2,true)
 for(const query of ['搜一下 Vue 文档','帮我上网找一下 Vue 文档','please search for Vue 文档']){
  assert.equal(store.match(query,context(directory)).id,e.id)
  assert.equal(store.match(query,{...context(directory),webEnabled:false}),undefined)
  assert.equal(store.match(query,{...context(directory),region:'KR'}),undefined)
  assert.equal(store.match(query,{...context(directory),sourceHost:'other.org'}),undefined)
 }
 assert.equal(store.match('查一下 React 文档',context(directory)),undefined)
})
