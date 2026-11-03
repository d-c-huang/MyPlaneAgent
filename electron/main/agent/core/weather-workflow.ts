import {experienceFailure} from './experience-failure.js'
import {randomUUID} from 'node:crypto'
import {publicJson} from '../web-access.js'
import type {ChatRunOptions} from './chat-runner.js'
import type {ExperienceStore} from './experience-store.js'
import type {StudioToolActivity} from '../../../shared/local-ai-studio.js'
import type {Capability} from '../../../shared/types/capability.js'
import {validateToolArguments} from './execution-guards.js'

// Conservative routing: compound requests and unrecognised locations stay with the general agent.
const cities:Record<string,string>={北京:'Beijing',上海:'Shanghai',广州:'Guangzhou',深圳:'Shenzhen',杭州:'Hangzhou',南京:'Nanjing',成都:'Chengdu',重庆:'Chongqing',武汉:'Wuhan',西安:"Xi'an",天津:'Tianjin',苏州:'Suzhou',郑州:'Zhengzhou',长沙:'Changsha',青岛:'Qingdao',厦门:'Xiamen',济南:'Jinan',合肥:'Hefei',福州:'Fuzhou',昆明:'Kunming'}
export type WeatherRequest={city:string;day:string}
export function parseWeatherRequest(query:string):WeatherRequest|undefined{
 const text=query.trim().replace(/[，。？！?,!\s]/g,'').replace(new RegExp('('+Object.keys(cities).join('|')+')市','g'),'$1')
 const match=text.match(new RegExp(`^(?:请|帮我|请帮我)?(?:查询|查一下|查查|看看|查|告诉我)?(${Object.keys(cities).join('|')})?(今天|明天|后天|\\d{4}-\\d{2}-\\d{2})?(${Object.keys(cities).join('|')})?(?:的)?(?:天气(?:预报)?(?:怎么样|如何)?|会不会下雨|是否下雨|会下雨吗|下雨吗|要带伞吗|需要带伞吗|需不需要带伞|用不用带伞|要不要带伞)(?:吗)?$`))
 if(!match||match[1]&&match[3])return
 return {city:match[1]||match[3]||'',day:match[2]||''}
}
type Forecast={city:string;date:string;timezone:string;low:number;high:number;rain:number;code:number;retrievedAt:string;source:string;cached:boolean}
type JsonReader=(url:string,signal:AbortSignal,options?:{allowSyntheticIp?:boolean})=>Promise<unknown>
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{}
function localDate(now:Date,timezone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
export function weatherDate(day:string,timezone:string,now:Date){
 const today=localDate(now,timezone),offset=['今天','明天','后天'].indexOf(day)
 const date=offset>=0?new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10):day
 const stamp=Date.parse(date+'T00:00:00Z'),distance=(stamp-Date.parse(today+'T00:00:00Z'))/86400000
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==date||distance<0||distance>15)throw new Error('日期需在目标城市的今天至未来 15 天内')
 return date
}
const conditions:Record<number,string>={0:'晴',1:'大部晴朗',2:'局部多云',3:'阴',45:'雾',48:'雾凇',51:'小毛毛雨',53:'毛毛雨',55:'强毛毛雨',56:'冻毛毛雨',57:'强冻毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'冻雨',67:'强冻雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'小阵雨',81:'阵雨',82:'强阵雨',85:'小阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴冰雹',99:'强雷暴伴冰雹'}
export class WeatherWorkflow {
 private cache=new Map<string,{expires:number;result:Forecast}>()
 constructor(private read:JsonReader=publicJson,private now:()=>Date=()=>new Date()){}
 clearCache(){this.cache.clear()}
 async forecast(request:WeatherRequest,signal:AbortSignal,allowSyntheticIp=false):Promise<Forecast>{
  signal.throwIfAborted()
  const name=cities[request.city];if(!name||!request.day)throw new Error('请提供支持的城市和目标日期')
  const geoUrl='https://geocoding-api.open-meteo.com/v1/search?'+new URLSearchParams({name,count:'10',language:'zh',format:'json',countryCode:'CN'})
  const geocoding=object(await this.read(geoUrl,signal,{allowSyntheticIp}))
  signal.throwIfAborted()
  const matches=Array.isArray(geocoding.results)?geocoding.results.filter((row:any)=>row?.country_code==='CN'&&typeof row.name==='string'&&row.name.replace(/市$/,'')===request.city&&/^PPL(?:A\d*|C)$/.test(row.feature_code)):[]
  if(matches.length!==1)throw new Error('城市定位不唯一或没有准确匹配，需进一步确认地点')
  const place=matches[0]
  if(!Number.isFinite(place.latitude)||!Number.isFinite(place.longitude)||Math.abs(place.latitude)>90||Math.abs(place.longitude)>180||typeof place.timezone!=='string')throw new Error('城市坐标或时区无效')
  const now=this.now(),date=weatherDate(request.day,place.timezone,now),key=JSON.stringify([place.latitude,place.longitude,place.timezone,date])
  const cached=this.cache.get(key)
  if(cached&&cached.expires>now.getTime())return {...cached.result,cached:true}
  const source='https://api.open-meteo.com/v1/forecast?'+new URLSearchParams({latitude:String(place.latitude),longitude:String(place.longitude),timezone:place.timezone,start_date:date,end_date:date,daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',temperature_unit:'celsius'})
  const data=object(await this.read(source,signal,{allowSyntheticIp}));signal.throwIfAborted()
  const daily=object(data.daily),units=object(data.daily_units)
  const index=Array.isArray(daily.time)?daily.time.indexOf(date):-1
  const low=daily.temperature_2m_min?.[index],high=daily.temperature_2m_max?.[index],rain=daily.precipitation_probability_max?.[index],code=daily.weather_code?.[index]
  if(index<0||data.timezone!==place.timezone||!Number.isFinite(data.latitude)||!Number.isFinite(data.longitude)||Math.abs(data.latitude-place.latitude)>.5||Math.abs(data.longitude-place.longitude)>.5||units.temperature_2m_min!=='°C'||units.temperature_2m_max!=='°C'||units.precipitation_probability_max!=='%'||![low,high,rain,code].every(Number.isFinite)||low>high||low< -100||high>70||rain<0||rain>100||!conditions[code])throw new Error('预报未通过地点、日期、单位或数值校验，不能作为正确答案保存')
  const result:Forecast={city:request.city,date,timezone:place.timezone,low,high,rain,code,source,retrievedAt:this.now().toISOString(),cached:false}
  for(const [id,item] of this.cache)if(item.expires<=now.getTime())this.cache.delete(id)
  if(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value!)
  this.cache.set(key,{expires:now.getTime()+10*60*1000,result})
  return result
 }
 async run(query:string,options:ChatRunOptions,store:ExperienceStore):Promise<boolean>{
  let request=parseWeatherRequest(query)
  if(!request||options.currentStep||options.planExecution)return false
  options.signal.throwIfAborted()
  if(!request.city||!request.day){options.onOutcome?.('needs_input');options.onContent(`请补充${!request.city?'城市':''}${!request.city&&!request.day?'和':''}${!request.day?'日期（例如今天或明天）':''}，我会查询对应的天气预报。`);return true}
  if(!options.webEnabled){options.onOutcome?.('blocked');options.onContent('查询最新天气需要开启本会话的联网开关。');return true}
  const cap:Capability={name:'weather.forecast',description:'向 Open-Meteo 发送城市名称与坐标，查询并校验目标日期的天气预报',category:'weather',source:{type:'builtin'},runtime:'builtin',permissions:['network'],tags:['requires-approval'],parameters:{type:'object',properties:{city:{type:'string',enum:Object.keys(cities)},day:{type:'string',minLength:1,maxLength:10}},required:['city','day'],additionalProperties:false}}
  const activity:StudioToolActivity={id:randomUUID(),capability:cap.name,args:request,status:'waiting'}
  if(options.inspectTool){request=await options.inspectTool(cap,request,activity.id,options.executionContext,options.signal) as WeatherRequest;options.signal.throwIfAborted();activity.args=request}
  validateToolArguments(cap.parameters,request)
  if((options.getApprovalMode?.()??options.approvalMode)==='ask'&&options.approvalGranted?.(activity)!==true){options.onActivity({...activity});const approved=await options.approve({...activity});options.signal.throwIfAborted();if(!approved){activity.status='denied';activity.output='天气查询被拒绝，已停止。';options.onActivity({...activity});options.onOutcome?.('blocked');options.onContent(activity.output);return true}}
  const block=options.beforeExecution?.(cap,request)
  if(block){options.onOutcome?.('blocked');options.onContent(block);return true}
  activity.status='running';options.onActivity({...activity});options.onProgress?.('正在执行天气流程：定位城市、解析日期并校验最新预报','working')
  let result:Forecast
  try{options.workbench?.assertAllowed(options.executionContext?.itemId||'main',cap.name);result=await this.forecast(request,options.signal,options.webAllowSyntheticIp===true)}catch(error){
   options.signal.throwIfAborted();options.afterExecution?.(cap,request,false)
   activity.status='error';activity.output=String(error);options.onActivity({...activity})
   try{store.record(query,options.workspace,['weather.forecast'],false,undefined,experienceFailure(error))}catch{options.onProgress?.('知识库写入失败，本次查询记录仍保留在会话中','working')}
   options.onProgress?.('天气接口未取得有效预报，转交通用查询流程核对其他来源','working')
   return false
  }
  options.afterExecution?.(cap,request,true)
  activity.status='complete';activity.output=JSON.stringify(result);options.onActivity({...activity})
  try{store.record(query,options.workspace,['weather.forecast'],true,'weather-v1')}catch{options.onProgress?.('预报已验证，但知识库写入失败','working')}
  options.onContent(`${result.city} ${result.date}（${result.timezone}）：${conditions[result.code]}，${result.low}–${result.high}°C，全天最高降水概率 ${result.rain}%。${/伞|雨/.test(query)?result.rain>=40?'建议带伞。':'降水概率较低，仍不能保证全天无雨。':''}\n\n来源：[Open-Meteo](${result.source})；查询时间：${result.retrievedAt}${result.cached?'（复用 10 分钟内已校验的缓存）':''}。`)
  options.onOutcome?.('complete');return true
 }
}


