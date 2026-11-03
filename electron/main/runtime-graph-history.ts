import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {readIntegrationJson,writeIntegrationJson} from './integration-store.js'
import type {RuntimeGraphSnapshot} from '../shared/runtime-graph.js'
import type {RuntimeHistoryFrame,RuntimeHistoryIndex} from '../shared/runtime-workbench.js'
type History={version:1;truncated:boolean;frames:RuntimeHistoryFrame[]}
/** Event-driven, bounded snapshots. Never reconstruct historical state from today's configuration. */
export class RuntimeGraphHistory{
 private readonly cache=new Map<string,History>()
 private readonly timers=new Map<string,ReturnType<typeof setTimeout>>()
 private readonly writeErrors=new Map<string,string>()
 constructor(private readonly directory:string){}
 private file(sessionId:string){
  if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(sessionId))throw new Error('会话 ID 无效')
  return path.join(this.directory,sessionId+'.json')
 }
 private read(sessionId:string){
  let value=this.cache.get(sessionId)
  if(!value){value=readIntegrationJson<History>(this.file(sessionId),{version:1,truncated:false,frames:[]});if(value.version!==1||!Array.isArray(value.frames))throw new Error('运行历史格式无效');this.cache.set(sessionId,value)}
  if(this.cache.size>4)for(const id of this.cache.keys()){if(id===sessionId)continue;this.flush(id);this.cache.delete(id);break}
  return value
 }
 index(sessionId:string):RuntimeHistoryIndex{const value=this.read(sessionId);const error=this.writeErrors.get(sessionId);if(error)throw new Error(error);return {entries:value.frames.map(({snapshot,...entry})=>({...entry})),truncated:value.truncated}}
 frame(sessionId:string,id:string):RuntimeHistoryFrame{
  const frame=this.read(sessionId).frames.find(row=>row.id===id)
  if(!frame)throw new Error('此历史帧已不在保留范围内，请刷新时间线')
  return structuredClone(frame)
 }
 capture(snapshot:RuntimeGraphSnapshot,runId:string,label:string){
  if(!snapshot.sessionId)return
  const sessionId=snapshot.sessionId,value=this.read(sessionId),copy=structuredClone(snapshot)
  copy.sessions=[]
  copy.nodes=copy.nodes.map(node=>({...node,detail:node.detail.slice(0,240),metrics:node.metrics.slice(0,6).map(metric=>({...metric,value:metric.value.slice(0,180)}))}))
  copy.events=copy.events.slice(0,20).map(event=>({...event,detail:event.detail?.slice(0,180)}))
  const previous=value.frames.at(-1)
  const signature=(graph:RuntimeGraphSnapshot)=>JSON.stringify([graph.title,graph.active,graph.nodes,graph.edges,graph.events])
  if(previous?.runId===runId&&signature(previous.snapshot)===signature(copy))return
  value.frames.push({id:randomUUID(),runId,at:new Date().toISOString(),label:label.slice(0,120),snapshot:copy})
  while(value.frames.length>120||Buffer.byteLength(JSON.stringify(value))>6_000_000){value.frames.shift();value.truncated=true}
  if(!this.timers.has(sessionId)){const timer=setTimeout(()=>{try{this.flush(sessionId)}catch(error){console.error('运行历史保存失败',error)}},750);timer.unref();this.timers.set(sessionId,timer)}
 }
 flush(sessionId:string){clearTimeout(this.timers.get(sessionId));this.timers.delete(sessionId);const value=this.cache.get(sessionId);if(value)try{writeIntegrationJson(this.file(sessionId),value);this.writeErrors.delete(sessionId)}catch(error){this.writeErrors.set(sessionId,'运行历史无法写入磁盘：'+String(error));throw error}}
 remove(sessionId:string){clearTimeout(this.timers.get(sessionId));this.timers.delete(sessionId);this.cache.delete(sessionId);this.writeErrors.delete(sessionId);fs.rmSync(this.file(sessionId),{force:true})}
 dispose(){for(const id of this.cache.keys())this.flush(id);this.cache.clear()}
}
