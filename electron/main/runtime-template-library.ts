import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {readIntegrationJson,writeIntegrationJson} from './integration-store.js'
import {validateNodeConfiguration} from './agent/core/runtime-workbench.js'
import type {NodeConfiguration,SharedNodeTemplate,TemplateCommand} from '../shared/runtime-workbench.js'

export function portableNodeConfiguration(input:unknown):NodeConfiguration{
 const config=validateNodeConfiguration(input)
 for(const key of ['title','acceptance','kind','dependsOn','fileScope','parallel'] as const)delete config[key]
 return config
}
/** Local, cross-session definitions. Loading a template never changes a running node. */
export class RuntimeTemplateLibrary{
 private readonly file:string
 constructor(directory:string){this.file=path.join(directory,'templates.json')}
 list():SharedNodeTemplate[]{return readIntegrationJson<SharedNodeTemplate[]>(this.file,[])}
 command(command:TemplateCommand){
  if(!command||typeof command!=='object')throw new Error('模板操作无效')
  const rows=this.list()
  if(command.action==='delete'){
   const row=rows.find(row=>row.id===command.id)
   if(!row||row.revision!==command.expectedRevision)throw new Error('模板版本已变化，请刷新')
   writeIntegrationJson(this.file,rows.filter(item=>item.id!==row.id))
   return this.list()
  }
  let name:string,config:NodeConfiguration,id:string|undefined,expectedRevision:number|undefined
  if(command.action==='import'){
   if(typeof command.json!=='string'||command.json.length>100000)throw new Error('模板 JSON 过长')
   let data:unknown;try{data=JSON.parse(command.json)}catch{throw new Error('模板 JSON 格式无效')}
   const value=data as {format?:unknown;version?:unknown;name?:unknown;config?:unknown}
   if(!value||typeof value!=='object'||Array.isArray(value)||value.format!=='myplane-node-template'||value.version!==1||Object.keys(value).some(key=>!['format','version','name','config'].includes(key)))throw new Error('不支持的模板格式或版本')
   name=value.name as string;config=portableNodeConfiguration(value.config)
  }else if(command.action==='save'){
   name=command.name;config=portableNodeConfiguration(command.config);id=command.id;expectedRevision=command.expectedRevision
  }else throw new Error('不支持的模板操作')
  if(typeof name!=='string'||!name.trim()||name.trim().length>80)throw new Error('模板名称须为 1–80 个字符')
  const previous=id?rows.find(row=>row.id===id):undefined
  if(id&&(!previous||previous.revision!==expectedRevision))throw new Error('模板版本已变化，请刷新')
  if(!previous&&rows.length>=100)throw new Error('模板库已满（100 个），请先删除不用的模板')
  const at=new Date().toISOString(),next:SharedNodeTemplate={id:previous?.id||randomUUID(),name:name.trim(),revision:(previous?.revision||0)+1,updatedAt:at,config,history:previous?[...previous.history,{revision:previous.revision,at:previous.updatedAt,config:previous.config,reason:'更新模板'}].slice(-20):[]}
  writeIntegrationJson(this.file,[next,...rows.filter(row=>row.id!==next.id)])
  return this.list()
 }
}
