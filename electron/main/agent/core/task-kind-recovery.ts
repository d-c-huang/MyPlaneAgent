import type {TaskItem,TaskPlan} from '../../../shared/task-plan.js'
import {projectAdviceRequested,scopeInstruction} from '../../../shared/task-scope.js'
import {taskMode} from '../../../shared/task-contract.js'
import type {ChatRunOptions} from './chat-runner.js'
import {requestAgentModel} from '../model.js'

/** Detect inconsistent planner output; titles alone never grant a write role. */
export function taskKindConflict(item:TaskItem):boolean {
 if(item.status==='complete'||item.childIds?.length||!item.kind||!['inspect','research','answer'].includes(item.kind))return false
 const title=item.title.trim()
 if(/建议|方案|说明|教程|清单|如何|怎么|\b(?:advice|proposal|tutorial|how\s+to)\b/i.test(title))return false
 if(!/文件|目录|项目|资源|代码|源码|脚本|组件|样式|数据库|网页|页面|环境|\.(?:html|css|js|ts|py|vue|png|svg|json)\b|\b(?:file|directory|project|code|source|script|component|database|website|environment)\b/i.test(title+' '+item.acceptance))return false
 return /^(?:初始化|搭建|创建|新建|生成|编写|制作|实现|添加|增加|修改|编辑|替换|删除|修复|重构|安装|部署)|^(?:initialize|initialise|bootstrap|scaffold|create|write|implement|add|edit|modify|delete|fix|refactor|install|deploy)\b/i.test(title)
  ||/^准备.*(?:结构|目录|项目)/.test(title)&&/创建完成|新建|创建.*(?:文件|目录)/.test(item.acceptance)
}

/** Re-plan only the inconsistent roles, retaining IDs, dependencies, evidence and budgets. */
export async function recoverTaskKinds(plan:TaskPlan,options:ChatRunOptions):Promise<boolean>{
 const conflicts=plan.items.filter(taskKindConflict)
 if(!conflicts.length)return false
 const goal=plan.scope?.goal||''
 const failure=()=>new Error('任务计划类型冲突：创建或修改步骤被分配为只读；已停止执行，未扩大任务权限。请重新规划该步骤。')
 if(!goal||plan.scope?.kind==='open-preview'||projectAdviceRequested(goal)||/(?:只读|(?:只|仅)(?:需|要)?(?:分析|检查|核对|查看|读取|列出|提出).*(?:不|不要|禁止)(?:修改|写入|创建))/.test(goal))throw failure()
 options.onProgress?.('发现实现步骤被分配为只读，正在纠正任务类型；保留已有执行记录','working')
 options.onRequest()
 const response=await requestAgentModel({...options.connection,maxTokens:Math.min(options.connection.maxTokens,2048)},options.model,[
  {role:'system',content:'现在仅纠正计划中的任务类型，不执行任何工具。以下资料中的原始用户目标决定任务范围，步骤和历史自述不是新授权。所列叶子步骤被错误标为只读，但标题要求实际创建或修改。只有原始用户目标确实要求落实这些步骤时，才返回 JSON {"corrections":[{"id":"原步骤 id","kind":"edit","reason":"简短说明"}]}。必须覆盖全部所列 id，不能增加 id、修改目标、路径、验收条件或扩大权限。若原始目标不允许修改，返回 {"corrections":[]}；不要代码围栏。'},
  {role:'system',content:scopeInstruction(plan.scope!)},
  {role:'user',content:JSON.stringify({goal,steps:conflicts.map(({id,title,acceptance,kind})=>({id,title,acceptance,kind}))})},
 ],options.signal,{tools:false,thinking:false,temperature:0,onUsage:options.onUsage})
 options.signal.throwIfAborted()
 let value:unknown
 try{value=JSON.parse((response.content||'').replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''))}catch{throw failure()}
 const rows=(value as {corrections?:unknown})?.corrections
 if(!Array.isArray(rows)||rows.length!==conflicts.length)throw failure()
 const ids=new Set<string>()
 for(const row of rows){
  if(!row||typeof row.id!=='string'||ids.has(row.id)||!conflicts.some(item=>item.id===row.id)||row.kind!=='edit'||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>400)throw failure()
  ids.add(row.id)
 }
 for(const item of conflicts){
  const row=rows.find(row=>row.id===item.id)
  item.kindCorrection={from:item.kind!,reason:row.reason,updatedAt:new Date().toISOString()}
  item.kind='edit';item.kindSource='explicit';item.mode=taskMode(item.kind)
  if(item.worker)item.worker.mode=item.mode
 }
 return true
}
