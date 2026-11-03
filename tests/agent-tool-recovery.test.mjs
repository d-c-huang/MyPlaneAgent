import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFileSync,writeFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import {runCoreChat} from '../dist-electron/main/agent/core/chat-runner.js'
import {policyContracts} from '../dist-electron/main/ability-modules/policies.js'
import {AbilityModuleManager} from '../dist-electron/main/ability-modules/manager.js'
import {isolatedGitWorkspace} from './helpers/workspace.mjs'

const completion=policyContracts.find(contract=>contract.id==='completion-review')
const bundledPolicies={invoke:async(id,data,text='')=>{
 const contract=policyContracts.find(contract=>contract.id===id)
 const input={data,messages:text?[{id:'current',text}]:[]}
 contract.validateInput(input)
 // Only the checked-in bundled source runs here; production uses its sandbox.
 return contract.validateOutput(new Function(contract.baseline+'; return process')()(input),input).result
}}
const capability=(name,properties,required=Object.keys(properties),risk='read')=>({name,category:'agent',description:name,parameters:{type:'object',properties,required},source:{type:'skill',skillId:'agent-tools'},runtime:'python-native',permissions:['filesystem'],tags:risk==='read'?[]:['requires-approval','risk:high']})
const string={type:'string'}
const read=capability('agent.read_file',{path:string})
const replace=capability('agent.replace_text',{path:string,oldText:string,newText:string},undefined,'high')
const write=capability('agent.write_file',{path:string,content:string},undefined,'high')
const patch=capability('agent.apply_patch',{changes:{type:'array',items:{type:'object',properties:{path:string,original:string,content:string},required:['path','original','content']}}},undefined,'high')
const review=status=>({content:JSON.stringify({status,reason:status==='complete'?'已由实际结果核验':'读取失败仍有可用的同文件读取方式',nextStep:status==='continue'?'读取 index.html 核对内容':''})})
const options=(connection,workspace,overrides={})=>({connection,model:'test-model',messages:[{role:'user',content:'处理指定文件并核对实际结果'}],workspace,filesEnabled:true,webEnabled:true,approvalMode:'full',signal:new AbortController().signal,abilityPolicies:bundledPolicies,onRequest(){},onUsage(){},onContent(){},onReasoning(){},onActivity(){},approve:async()=>true,...overrides})
function workspace(t){
 const directory=isolatedGitWorkspace('myplane-tool-recovery-')
 t.after(()=>rmSync(directory,{recursive:true,force:true}))
 return directory
}
let callId=0
function toolCall(input,name,args,canonical=false){
 const alias=input.tools.find(tool=>tool.function.description.startsWith(name+':'))?.function.name
 assert.ok(alias,'Expected advertised tool '+name)
 return {content:null,tool_calls:[{id:'recovery-'+(++callId),type:'function',function:{name:canonical?name:alias,arguments:JSON.stringify(args)}}]}
}
async function withModel(call,work,reviewCall=()=>review('complete')){
 const requests=[];let modelError
 const server=createServer(async(request,response)=>{
  try{
   let body='';for await(const part of request)body+=part
   const input=JSON.parse(body);requests.push(input)
   const isReview=input.messages.some(message=>message.role==='system'&&String(message.content).includes('你是任务完成检查器'))
   const message=await (isReview?reviewCall(input):call(input))
   response.setHeader('content-type','application/json')
   response.end(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:30,completion_tokens:5}}))
  }catch(error){modelError??=error;response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:String(error)}}))}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  await work({endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:32768},requests)
  if(modelError)throw modelError
 }catch(error){throw modelError??error}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}

test('completion policy preserves actionable recovery and clarification without allowing false success or denied execution',async()=>{
 for(const sample of completion.cases){
  const result=await bundledPolicies.invoke('completion-review',sample.input.data)
  assert.deepEqual(result,sample.expected.result,sample.name)
 }
 const data={status:'continue',reason:'读取失败',nextStep:'读取同文件',candidate:'继续读取',unresolvedFailures:1,denied:false}
 assert.equal((await bundledPolicies.invoke('completion-review',data)).status,'continue')
 assert.equal((await bundledPolicies.invoke('completion-review',{...data,status:'needs_input'})).status,'needs_input')
 assert.equal((await bundledPolicies.invoke('completion-review',{...data,status:'complete'})).status,'blocked')
 assert.equal((await bundledPolicies.invoke('completion-review',{...data,denied:true})).status,'blocked')
 assert.doesNotThrow(()=>completion.validateOutput({result:{status:'blocked',reason:'自定义策略要求检查路径',nextStep:'先核对路径授权范围'}},{messages:[],data}))
})

test('installed premature-blocking baseline falls back through the contract and preserves its archived source',async t=>{
 const directory=workspace(t),legacyCode="function process(input){const d=input.data;return {result:d.unresolvedFailures?{status:'blocked',reason:'仍有未解决的工具错误或被拒绝的操作',nextStep:''}:{status:d.status,reason:d.reason,nextStep:d.nextStep}}}"
 const legacy=new AbilityModuleManager(directory,undefined,{...completion,baseline:legacyCode})
 legacy.setPolicy({...legacy.snapshot().policy,autoOptimize:false});legacy.dispose()
 const manager=new AbilityModuleManager(directory,undefined,completion);t.after(()=>manager.dispose())
 const result=await manager.execute({messages:[],data:{status:'continue',reason:'旧读取失败',nextStep:'读取同一文件',candidate:'尚有替代方法',unresolvedFailures:1,denied:false}})
 assert.equal(result.output.result.status,'continue')
 assert.notEqual(result.versionId,'bundled-v1')
 assert.equal(manager.version('bundled-v1').code,legacyCode)
 assert.equal(manager.snapshot().versions.find(version=>version.id==='bundled-v1').quarantined,true)
})

test('a recoverable read failure survives the review boundary, switches tools, and does not replay successful work',async t=>{
 const directory=workspace(t),outline=capability('agent.code_outline',{path:string}),executed=[]
 let turn=0,outcome,reviewCount=0
 await withModel(input=>{
  turn++
  if(turn===1)return toolCall(input,'agent.read_file',{path:'ready.txt'})
  if(turn===2)return toolCall(input,'agent.code_outline',{path:'index.html'})
  if(turn===3)return {content:'结构读取不支持 HTML，需要读取原文。'}
  if(turn===4)return toolCall(input,'agent.read_file',{path:'index.html'})
  return {content:'入口已核对，前一步读取结果已保留。'}
 },async(connection,requests)=>{
  await runCoreChat({list:()=>[read,outline],execute:async request=>{
   executed.push([request.capability,request.args.path])
   return request.capability==='agent.code_outline'?{success:false,error:'请选择支持的代码文件'}:{success:true,output:{path:request.args.path,text:'<html>实际读取内容</html>',truncated:false}}
  }},options(connection,directory,{onOutcome:value=>outcome=value}))
  const results=requests.flatMap(request=>request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content)))
  const failure=results.find(result=>result.capability==='agent.code_outline'&&result.status==='error')
  assert.ok(failure?.activityId)
  assert.ok(results.some(result=>result.capability==='agent.read_file'&&result.status==='complete'&&result.resolvedFailureIds?.includes(failure.activityId)))
 },()=>{reviewCount++;return review(reviewCount===1?'continue':'complete')})
 assert.equal(outcome,'complete')
 assert.equal(reviewCount,2)
 assert.deepEqual(executed,[['agent.read_file','ready.txt'],['agent.code_outline','index.html'],['agent.read_file','index.html']])
})

for(const scenario of ['corrected-selector','cross-tool','unrelated-file','no-change','same-args-no-change','permission-error','unknown-effect']){
 test(`edit recovery requires verified same-target effects: ${scenario}`,async t=>{
  const directory=workspace(t);writeFileSync(path.join(directory,'target.txt'),'before');writeFileSync(path.join(directory,'other.txt'),'before')
  const activities=[],executed=[];let turn=0,outcome
  await withModel(input=>{
   turn++
   if(turn===1)return toolCall(input,'agent.replace_text',{path:'target.txt',oldText:scenario==='unknown-effect'?'before':'stale',newText:'after'})
   if(turn===2)return toolCall(input,'agent.read_file',{path:'target.txt'})
   if(turn===3){
    if(['corrected-selector','unknown-effect','same-args-no-change'].includes(scenario))return toolCall(input,'agent.replace_text',{path:scenario==='corrected-selector'?'./target.txt':'target.txt',oldText:scenario==='same-args-no-change'?'stale':'before',newText:'after'})
    return toolCall(input,'agent.write_file',{path:scenario==='unrelated-file'?'other.txt':'target.txt',content:scenario==='no-change'?'before':'after'})
   }
   return {content:'已完成文件操作并核对。'}
  },async(connection,requests)=>{
   await runCoreChat({list:()=>[read,replace,write],execute:async request=>{
    executed.push(request.capability)
    if(executed.length===1)return {success:false,outcome:scenario==='unknown-effect'?'unknown':'failed',error:scenario==='permission-error'?'PermissionError: access denied':'待替换片段必须在文件中唯一匹配；请重新读取目标行并核对 oldText'}
    if(request.capability==='agent.read_file')return {success:true,output:{text:readFileSync(path.join(directory,request.args.path),'utf8')}}
    if(scenario!=='same-args-no-change')writeFileSync(path.join(directory,request.args.path),request.args.content??request.args.newText)
    return {success:true,output:{changed:!['no-change','same-args-no-change'].includes(scenario)}}
   }},options(connection,directory,{onActivity:activity=>{if(activity.status!=='running')activities.push(activity)},onOutcome:value=>outcome=value}))
   const results=requests.flatMap(request=>request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content)))
   const resolved=results.some(result=>result.resolvedFailureIds?.includes(activities[0].id))
   assert.equal(resolved,['corrected-selector','cross-tool'].includes(scenario),'Only proven recovery is reported to the model as resolved')
  })
  assert.equal(outcome,['corrected-selector','cross-tool'].includes(scenario)?'complete':'blocked')
  assert.equal(executed.length,3)
  assert.equal(activities[0].status,'error','Keep the original failed attempt in the execution log')
  assert.equal(activities.at(-1).fileChanges?.length,['no-change','same-args-no-change'].includes(scenario)?0:1)
 })
}

test('a failed multi-file patch is resolved only after all targets have observed edits',async t=>{
 for(const repairBoth of [false,true]){
  const directory=workspace(t);for(const file of ['one.txt','two.txt'])writeFileSync(path.join(directory,file),'before')
  let turn=0,outcome
  await withModel(input=>{
   turn++
   if(turn===1)return toolCall(input,'agent.apply_patch',{changes:['one.txt','two.txt'].map(file=>({path:file,original:'stale',content:'after'}))})
   if(turn===2)return toolCall(input,'agent.write_file',{path:'one.txt',content:'after'})
   if(turn===3&&repairBoth)return toolCall(input,'agent.write_file',{path:'two.txt',content:'after'})
   return {content:'已修改文件。'}
  },async connection=>{
   await runCoreChat({list:()=>[patch,write],execute:async request=>{
    if(request.capability==='agent.apply_patch')return {success:false,error:'补丁基线不匹配，请重新读取 one.txt'}
    writeFileSync(path.join(directory,request.args.path),request.args.content);return {success:true,output:{changed:true}}
   }},options(connection,directory,{onOutcome:value=>outcome=value}))
  })
  assert.equal(outcome,repairBoth?'complete':'blocked')
 }
})

test('exact advertised canonical names retain approvals and persist the real API alias',async t=>{
 for(const allowed of [true,false]){
  const directory=workspace(t),restricted={...read,tags:['requires-approval','risk:high']}
  let turn=0,approvals=0,executions=0,outcome
  await withModel(input=>++turn===1?toolCall(input,'agent.read_file',{path:'target.txt'},true):{content:allowed?'已读取目标':'操作已被拒绝。'},async(connection,requests)=>{
   await runCoreChat({list:()=>[restricted],execute:async()=>{executions++;return {success:true,output:{text:'verified'}}}},options(connection,directory,{approvalMode:'ask',approve:async()=>{approvals++;return allowed},onOutcome:value=>outcome=value}))
   if(allowed)assert.ok(requests.some(request=>request.messages.some(message=>message.tool_calls?.some(call=>call.function.name.startsWith('cap_agent_read_file_')))))
   assert.ok(!requests.some(request=>request.messages.some(message=>message.tool_calls?.some(call=>call.function.name==='agent.read_file'))))
  })
  assert.equal(approvals,1);assert.equal(executions,allowed?1:0);assert.equal(outcome,allowed?'complete':'blocked')
 }
})

test('unknown or disabled names stay unexecuted with bounded retries and accurate advertised alternatives',async t=>{
 const directory=workspace(t),web={...read,name:'agent.web_search',permissions:['network']}
 for(const missing of ['agent.web_search','cap_agent_web_search_632141521a1c']){
  let turns=0,executions=0
  await withModel(input=>{
   turns++
   if(turns===1){const valid=toolCall(input,'agent.read_file',{path:'target.txt'});valid.tool_calls.push({id:'unknown-1',type:'function',function:{name:missing,arguments:'{}'}});return valid}
   const rejection=input.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content)).find(result=>result.notApplied)
   assert.ok(rejection)
   assert.deepEqual(rejection.availableTools.map(tool=>tool.capability),['agent.read_file'])
   return {content:null,tool_calls:[{id:'unknown-'+turns,type:'function',function:{name:missing,arguments:'{}'}}]}
  },async connection=>{
   await assert.rejects(runCoreChat({list:()=>[read,web],execute:async()=>{executions++;return {success:true,output:{text:'saved result'}}}},options(connection,directory,{webEnabled:false})),/连续请求不存在或未授权的工具/)
  })
  assert.equal(executions,1);assert.equal(turns,3)
 }
})

test('the host cannot accept unresolved tool failures even when no policy module is installed',async t=>{
 const directory=workspace(t);let executed=false,outcome
 await withModel(input=>executed?{content:'全部完成'}:toolCall(input,'agent.read_file',{path:'missing.txt'}),async connection=>{
  await runCoreChat({list:()=>[read],execute:async()=>{executed=true;return {success:false,error:'PermissionError: access denied'}}},options(connection,directory,{abilityPolicies:undefined,onOutcome:value=>outcome=value}))
 })
 assert.equal(outcome,'blocked')
})
