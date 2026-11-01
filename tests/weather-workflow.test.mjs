import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {WeatherWorkflow,parseWeatherRequest,weatherDate} from '../dist-electron/main/agent/core/weather-workflow.js'
import {ExperienceStore} from '../dist-electron/main/agent/core/experience-store.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
import {workspaceCleanup} from './helpers/workspace.mjs'

const geo={results:[{name:'上海',country_code:'CN',feature_code:'PPLA',latitude:31.22,longitude:121.46,timezone:'Asia/Shanghai'}]}
const forecast={latitude:31.25,longitude:121.5,timezone:'Asia/Shanghai',daily_units:{temperature_2m_min:'°C',temperature_2m_max:'°C',precipitation_probability_max:'%'},daily:{time:['2026-09-28'],temperature_2m_min:[21],temperature_2m_max:[28],precipitation_probability_max:[65],weather_code:[61]}}
const signal=()=>new AbortController().signal
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weather-flow-')),track=workspaceCleanup(t,directory);return {directory,store:new ExperienceStore(directory),track}}
function options(extra={}){return {workspace:'.',model:'unused',connection:{},messages:[{role:'user',content:'上海明天要带伞吗'}],webEnabled:true,filesEnabled:false,approvalMode:'auto',signal:signal(),approve:async()=>true,onActivity:()=>{},onContent:()=>{},onReasoning:()=>{},onRequest:()=>{throw new Error('simple weather must not require a model')},onUsage:()=>{},...extra}}
function workflow(reader){return new WeatherWorkflow(reader??(async url=>url.includes('geocoding')?structuredClone(geo):structuredClone(forecast)),()=>new Date('2026-09-27T06:00:00Z'))}

test('weather intent matching stays conservative and detects missing parameters',()=>{
 assert.deepEqual(parseWeatherRequest('请帮我查一下明天上海的天气怎么样？'),{city:'上海',day:'明天'})
 assert.deepEqual(parseWeatherRequest('上海明天要带伞吗'),{city:'上海',day:'明天'})
 assert.deepEqual(parseWeatherRequest('北京市明天下雨吗'),{city:'北京',day:'明天'})
 assert.deepEqual(parseWeatherRequest('成都市明天下雨吗'),{city:'成都',day:'明天'})
 assert.deepEqual(parseWeatherRequest('明天天气'),{city:'',day:'明天'})
 assert.deepEqual(parseWeatherRequest('上海天气'),{city:'上海',day:''})
 for(const text of ['编写上海天气查询程序','上海明天天气，然后发送邮件','北京和上海明天天气','上海明天每小时天气','美国上海明天天气','不查上海明天天气','上海明天天气请用中国天气网'])assert.equal(parseWeatherRequest(text),undefined)
})
test('relative dates use destination timezone and reject invalid or out-of-range dates',()=>{
 const now=new Date('2026-09-27T18:00:00Z')
 assert.equal(weatherDate('明天','Asia/Shanghai',now),'2026-09-29')
 assert.equal(weatherDate('明天','America/Los_Angeles',now),'2026-09-28')
 for(const day of ['2026-02-30','2026-09-27','2026-10-14','invalid'])assert.throws(()=>weatherDate(day,'Asia/Shanghai',now))
})
test('validated forecasts cache for ten minutes and separate dates',async()=>{
 let now=new Date('2026-09-27T06:00:00Z'),calls=0
 const flow=new WeatherWorkflow(async url=>{if(url.includes('geocoding'))return geo;calls++;return {...forecast,daily:{...forecast.daily,time:[new URL(url).searchParams.get('start_date')]}}},()=>now)
 const req={city:'上海',day:'明天'}
 assert.equal((await flow.forecast(req,signal())).cached,false)
 assert.equal((await flow.forecast(req,signal())).cached,true);assert.equal(calls,1)
 await flow.forecast({...req,day:'后天'},signal());assert.equal(calls,2)
 now=new Date(now.getTime()+600001)
 assert.equal((await flow.forecast(req,signal())).cached,false);assert.equal(calls,3)
 flow.clearCache();await flow.forecast(req,signal());assert.equal(calls,4)
})
test('wrong date, units, coordinates, missing values and ambiguous cities are never validated',async()=>{
 const changes=[f=>{f.daily.time=['2026-09-29']},f=>{f.daily.precipitation_probability_max=[null]},f=>{f.daily.temperature_2m_min=[30]},f=>{f.daily.precipitation_probability_max=[101]},f=>{f.daily_units.temperature_2m_max='°F'},f=>{f.latitude=40},f=>{f.timezone='UTC'}]
 for(const change of changes){const bad=structuredClone(forecast);change(bad);await assert.rejects(workflow(async url=>url.includes('geocoding')?geo:bad).forecast({city:'上海',day:'明天'},signal()),/未通过/)}
 await assert.rejects(workflow(async()=>({results:[...geo.results,...geo.results]})).forecast({city:'上海',day:'明天'},signal()),/不唯一/)
})
test('city routing excludes same-name villages and romanisation collisions',async()=>{
 const villages={results:[...geo.results,{...geo.results[0],feature_code:'PPL',latitude:27}]}
 assert.equal((await workflow(async url=>url.includes('geocoding')?villages:forecast).forecast({city:'上海',day:'明天'},signal())).city,'上海')
 const collision={results:[{...geo.results[0],name:'宿州市'},{...geo.results[0],name:'苏州'}]}
 assert.equal((await workflow(async url=>url.includes('geocoding')?collision:forecast).forecast({city:'苏州',day:'明天'},signal())).city,'苏州')
})
test('fixed workflow formats verified data without a model and persists experience',async t=>{
 const {store}=fixture(t);let text='',outcome,activities=[]
 assert.equal(await workflow().run('上海明天要带伞吗',options({onContent:v=>text+=v,onOutcome:v=>outcome=v,onActivity:a=>activities.push(a)}),store),true)
 assert.equal(outcome,'complete');assert.match(text,/65%.*建议带伞/s);assert.match(text,/2026-09-28/);assert.match(text,/Open-Meteo/)
 assert.deepEqual(activities.map(a=>a.status),['running','complete'])
 assert.equal(store.state().entries[0].status,'verified')
})
test('missing parameters, offline mode and denied permission never execute network',async t=>{
 const {store}=fixture(t),flow=workflow(async()=>{throw new Error('unexpected network')})
 for(const [query,extra,expected] of [['明天天气',{},'needs_input'],['上海天气',{},'needs_input'],['上海明天天气',{webEnabled:false},'blocked'],['上海明天天气',{approvalMode:'ask',approve:async()=>false},'blocked']]){
  let outcome;assert.equal(await flow.run(query,options({...extra,onOutcome:v=>outcome=v}),store),true);assert.equal(outcome,expected)
 }
 assert.equal(store.state().entries.length,0)
})
test('network failure records only a candidate and returns to general tools; cancellation propagates',async t=>{
 const {store}=fixture(t),flow=workflow(async()=>{throw new Error('network down')})
 assert.equal(await flow.run('上海明天天气',options(),store),false)
 assert.equal(store.state().entries[0].status,'candidate');assert.equal(store.state().entries[0].failures,0);assert.equal(store.state().entries[0].interruptions,1)
 const controller=new AbortController();controller.abort()
 await assert.rejects(flow.run('上海明天天气',options({signal:controller.signal}),store),{name:'AbortError'})
 assert.equal(store.state().entries[0].failures,0);assert.equal(store.state().entries[0].interruptions,1)
})
test('conversation service routes simple weather before model planning and saves actual evidence',async t=>{
 const {directory,track}=fixture(t)
 const service=track(new AgentCoreService({dataDir:directory,skillsDir:path.join(directory,'skills'),getConnection:()=>({})}))
 service.initialized=true;service.weather=workflow();let saved,outcome,text=''
 const query='上海明天要带伞吗'
 await service.runConversation(options({planExecution:{taskId:'weather-task',goal:query,save:value=>saved=value},onOutcome:v=>outcome=v,onContent:v=>text+=v}))
 assert.equal(outcome,'complete');assert.equal(saved.items[0].status,'complete');assert.equal(saved.items[0].evidenceIds.length,1);assert.match(text,/65%/)
 assert.equal(service.experienceState().entries[0].status,'verified')
 service.configureExperiences(false);assert.equal(service.experienceState().enabled,false)
})


test('previously verified weather remains enabled during a temporary network outage',async t=>{
 const {store}=fixture(t)
 store.record('上海明天天气','.', ['weather.forecast'],true,'weather-v1')
 const before=store.state().entries[0].verification
 assert.equal(await workflow(async()=>{throw new Error('network timeout')}).run('上海明天天气',options(),store),false)
 const entry=store.state().entries[0]
 assert.equal(entry.enabled,true);assert.equal(entry.status,'verified');assert.deepEqual(entry.verification,before);assert.equal(entry.failures,0);assert.equal(entry.lastIssue.kind,'temporary')
})
