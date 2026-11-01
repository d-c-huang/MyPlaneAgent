import fs from 'node:fs'
import path from 'node:path'
import {RuntimeStore} from '../../dist-electron/main/agent/core/runtime-store.js'
import {WorkerContextSession} from '../../dist-electron/main/agent/core/worker-context.js'
import {pinnedContext,createContextCheckpoint} from '../../dist-electron/main/local-ai-context.js'
import {operationKey} from '../../dist-electron/main/agent/core/operation-journal.js'

const [root,phase]=process.argv.slice(2),workspace=path.join(root,'workspace')
fs.mkdirSync(workspace,{recursive:true})
const scope={taskId:'task',workspace,workerId:'worker',itemId:'item'},store=new RuntimeStore(path.join(root,'runtime'))
const history=[{role:'user',content:'只写一次，保留数据'},{role:'assistant',content:null,tool_calls:[{id:'call',function:{name:'write',arguments:'{"path":"result.txt","content":"done"}'}}]}]
const state=pinnedContext(history,{taskId:'task',workerId:'worker'}),session=new WorkerContextSession(store,scope,{goal:'test'},history,state)
const checkpoint=createContextCheckpoint(history,1,'未写入',undefined,state)
const activity={id:'operation',capability:'agent.write_file',args:{path:'result.txt',content:'done'},status:'running'}
session.beginTool('call',activity,history,checkpoint)
fs.writeFileSync(path.join(workspace,'result.txt'),'done')
fs.writeFileSync(path.join(workspace,'writes.txt'),'1')
if(phase!=='intent'){
 const operation={id:activity.id,...scope,capability:activity.capability,args:activity.args,createdAt:new Date().toISOString(),revision:0,effectKey:operationKey(scope.taskId,workspace,activity.capability,activity.args)}
 store.begin(operation);store.finish(operation,{success:true,outcome:'succeeded',output:{path:'result.txt',content:'done'},elapsedMs:1},true)
 if(phase==='history'){
  const complete={...activity,status:'complete',output:'done'}
  history.push({role:'tool',tool_call_id:'call',content:JSON.stringify({activityId:activity.id,status:'complete',output:'done'})})
  session.finishTool(complete,history,checkpoint)
 }
}
// Deliberately exit without a session finish or database close.
process.exit(23)
