import {createHash} from 'node:crypto'
import type {Capability,CapabilityAdmission} from '../../../shared/types/capability.js'

export function retainReadbackTools(selected:Capability[],available:Capability[]):Capability[]{
 return [...selected,...available.filter(cap=>['runtime.read_history','runtime.read_evidence'].includes(cap.name)&&!selected.some(row=>row.name===cap.name))]
}

function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]))
 return value
}
export function capabilityFingerprint(capability:Capability):string{
 return createHash('sha256').update(JSON.stringify(canonical(capability))).digest('hex')
}
/** Names survive registration order, selection changes and process restarts. */
export function capabilityAlias(name:string):string{
 return `cap_${name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,40)}_${createHash('sha256').update(name).digest('hex').slice(0,12)}`
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value)}
 return value
}
/** A step owns its immutable definitions; live registration cannot rewrite an approved request. */
export function createToolSurface(capabilities:Capability[],admit?:((capability:Capability)=>CapabilityAdmission|undefined)){
 const aliases=new Map<string,Capability>(),admissions=new Map<string,CapabilityAdmission>(),selected:Capability[]=[]
 for(const original of capabilities){
  const admission=admit?.(original)
  if(admit&&!admission)continue
  const capability=freeze(structuredClone(original)),alias=capabilityAlias(capability.name)
  if(aliases.has(alias))throw new Error('工具名称重复或别名冲突：'+capability.name)
  aliases.set(alias,capability);selected.push(capability)
  if(admission)admissions.set(capability.name,freeze({...admission}))
 }
 const tools=freeze([...aliases].map(([name,capability])=>({type:'function' as const,function:{name,description:`${capability.name}: ${capability.description}`,parameters:capability.parameters}})))
 const fingerprint=createHash('sha256').update(JSON.stringify(selected.map(cap=>[cap.name,capabilityFingerprint(cap),admissions.get(cap.name)?.revision]))).digest('hex')
 return {capabilities:selected,aliases,admissions,tools,fingerprint}
}
