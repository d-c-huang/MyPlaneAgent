// Run after build:app: electron tests/agent-task-completion.electron.mjs
// The model is local and deterministic; every command, preview and browser result is real.
import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
import {InternalBrowser} from '../dist-electron/main/internal-browser.js'
import {configureBrowserPlugin,registerBrowserPlugin} from '../dist-electron/main/browser-plugin.js'
import {protectedHandle} from '../dist-electron/main/auth.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-task-completion-'))
const workspace=path.join(root,'workspace'),profile=path.join(root,'profile'),skillsDir=path.join(root,'skills'),dataDir=path.join(root,'data')
for(const directory of [workspace,profile,skillsDir,dataDir])fs.mkdirSync(directory,{recursive:true})
app.setPath('userData',profile);app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
fs.cpSync(path.resolve('skills/agent-tools'),path.join(skillsDir,'agent-tools'),{recursive:true})
fs.writeFileSync(path.join(profile,'browser-plugin.json'),JSON.stringify({enabled:true}))
fs.writeFileSync(path.join(dataDir,'static-preview-plugin.json'),JSON.stringify({enabled:true}))
fs.writeFileSync(path.join(workspace,'index.html'),'<!doctype html><meta charset="utf-8"><title>计分小游戏</title><button id="score">点击得分</button><p id="status">得分：0</p><script src="game.js"></script>')
fs.writeFileSync(path.join(workspace,'game.js'),'let score=0;document.querySelector("#score").addEventListener("click",event=>{if(event.isTrusted)document.querySelector("#status").textContent="得分："+(++score)});')
const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(workspace,file))).digest('hex')
const originalHashes=['index.html','game.js'].map(hash),planFile=path.join(root,'saved-plan.json')
const oldEdit={id:'saved-edit',title:'创建小游戏',kind:'edit',kindSource:'explicit',mode:'write',fileScope:['index.html','game.js'],status:'complete',attempts:1,summary:'已保存小游戏文件',evidenceIds:['saved-edit-evidence'],dependsOn:[]}
fs.writeFileSync(planFile,JSON.stringify({taskId:'completion-fixture',workspace,graphVersion:1,updatedAt:new Date().toISOString(),items:[oldEdit,
 {id:'syntax',title:'验证 game.js 语法',kind:'verify',kindSource:'explicit',mode:'verify',fileScope:[],acceptance:'真实执行 node --check game.js，退出码为 0',status:'blocked',attempts:1,summary:'此前范围错误，等待继续',evidenceIds:[],dependsOn:['saved-edit']},
 {id:'preview',title:'打开小游戏并点击得分按钮',kind:'preview',kindSource:'explicit',mode:'verify',fileScope:[],acceptance:'启动本地预览，用浏览器打开，真实点击点击得分按钮，读取页面确认得分：1；不要求截图视觉验收',status:'pending',attempts:0,summary:'',evidenceIds:[],dependsOn:['syntax']}
]}))

let service,server,phase=0,step=0,requests=0,outcome,saved,modelFailure
const activities=new Map(),answers=[]
const successful=name=>[...activities.values()].filter(a=>a.capability===name&&a.status==='complete').at(-1)
const output=name=>{const activity=successful(name);assert.ok(activity,'missing real '+name+' result');return typeof activity.output==='string'?JSON.parse(activity.output):activity.output}
const reply=content=>({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]})
function modelAnswer(body){
 assert.ok(++requests<=24,'unexpected model loop')
 if(!body.tools?.length){
  const completed=phase===0?successful('agent.run_command'):successful('browser.read_page')
  assert.ok(completed,'review must follow real tool evidence')
  if(phase===0)assert.equal(output('agent.run_command').exitCode,0)
  else assert.match(output('browser.read_page').text,/得分：1/)
  phase++;step=0
  return reply(JSON.stringify({status:'complete',reason:'已根据本项真实工具结果核验',nextStep:'',missingEvidence:[],actions:[],optionalChecks:[]}))
 }
 let action
 if(phase===0){
  if(step++===0)action=['agent.run_command',{command:'node --check game.js',timeoutSeconds:15}]
  else return reply('已实际执行 node --check game.js，退出码为 0。')
 }else if(phase===1){
  switch(step++){
   case 0:action=['preview.start',{}];break
   case 1:action=['browser.open',{url:output('preview.start').url}];break
   case 2:action=['browser.read_page',{}];break
   case 3:{const page=output('browser.read_page'),button=page.elements.find(element=>element.label==='点击得分');assert.ok(button);action=['browser.click',{url:page.url,snapshot:page.snapshot,ref:button.ref,label:button.label}];break}
   case 4:action=['browser.read_page',{}];break
   default:return reply('已打开真实本地预览并点击得分按钮，重新读取页面确认得分：1。')
  }
 }else throw Error('completed nodes were unexpectedly scheduled again')
 const tool=body.tools.find(tool=>tool.function.description.startsWith(action[0]+':'))
 assert.ok(tool,'current worker did not receive '+action[0])
 return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-'+requests,type:'function',function:{name:tool.function.name,arguments:JSON.stringify(action[1])}}]}}]}
}
async function main(){
 const watchdog=setTimeout(()=>{console.error('Task completion regression timed out',root);app.exit(1)},120000)
 try{
  await app.whenReady()
  server=createServer(async(request,response)=>{
   try{let raw='';for await(const chunk of request)raw+=chunk;assert.equal(request.headers.authorization,undefined);response.setHeader('content-type','application/json');response.end(JSON.stringify(modelAnswer(JSON.parse(raw))))}
   catch(error){modelFailure=error;response.writeHead(400);response.end(JSON.stringify({error:{message:String(error)}}))}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const connection={endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',contextLength:100000,maxTokens:4096}
  const browser=new InternalBrowser(path.resolve('dist-electron/main'))
  configureBrowserPlugin(browser)
  protectedHandle('browser:action',(event,action,value)=>browser.action(event.sender,action,value))
  service=new AgentCoreService({dataDir,skillsDir,getConnection:()=>connection})
  await service.initialize();registerBrowserPlugin(service.getCapabilityRegistry())
  assert.equal(service.getCapabilityRegistry().get('agent.run_command').runtime,'python-native')
  const options={connection,model:'local-regression',workspace,filesEnabled:true,webEnabled:true,approvalMode:'full',imageCapability:'unsupported',signal:AbortSignal.timeout(90000),
   messages:[{role:'user',content:'继续已保存任务，只检查 game.js 语法，打开小游戏并点击得分按钮确认得分：1；不要重复修改文件。'}],
   onActivity:activity=>activities.set(activity.id,structuredClone(activity)),onContent:text=>answers.push(text),onOutcome:value=>{outcome=value},onRequest(){},onUsage(){},onReasoning(){},approve:async()=>true,
   planExecution:{taskId:'completion-fixture',resume:true,plan:JSON.parse(fs.readFileSync(planFile,'utf8')),save:plan=>{saved=structuredClone(plan);fs.writeFileSync(planFile,JSON.stringify(plan))}}}
  await service.runConversation(options)
  if(modelFailure)throw modelFailure
  assert.equal(outcome,'complete',answers.join('\n'))
  assert.ok(saved.items.every(item=>item.status==='complete'),JSON.stringify(saved.items.map(item=>({title:item.title,status:item.status,summary:item.summary}))))
  const edit=saved.items.find(item=>item.id==='saved-edit')
  assert.equal(edit.attempts,1);assert.deepEqual(edit.evidenceIds,['saved-edit-evidence']);assert.equal(edit.worker,undefined)
  assert.deepEqual(['index.html','game.js'].map(hash),originalHashes,'completed implementation must not be rewritten')
  assert.ok(![...activities.values()].some(a=>['agent.write_file','agent.replace_text','agent.apply_patch'].includes(a.capability)))
  assert.equal([...activities.values()].filter(a=>a.capability==='agent.run_command'&&a.status==='complete').length,1)
  assert.equal(output('agent.run_command').exitCode,0)
  const url=output('preview.start').url;assert.equal(new URL(url).hostname,'127.0.0.1')
  assert.match(await(await fetch(url)).text(),/计分小游戏/)
  assert.match(output('browser.read_page').text,/得分：1/)
  assert.equal([...activities.values()].filter(a=>a.capability==='browser.click'&&a.status==='complete').length,1)
  assert.equal(phase,2)
  const settledActivities=activities.size
  await service.runConversation({...options,planExecution:{...options.planExecution,plan:JSON.parse(fs.readFileSync(planFile,'utf8'))}})
  assert.equal(outcome,'complete');assert.equal(activities.size,settledActivities,'completed plan must not replay tools');assert.equal(phase,2)
  console.log('Agent task completion passed: saved edits preserved, real Python/Node syntax check, loopback preview, trusted browser click, persisted plan complete, no replay.')
 }catch(error){console.error(error);process.exitCode=1}
 finally{
  clearTimeout(watchdog)
  for(const window of BrowserWindow.getAllWindows())window.destroy()
  await service?.dispose();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve))
  // root comes only from this test's mkdtemp; never remove user profiles/workspaces.
  try{fs.rmSync(root,{recursive:true,force:true})}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error}
  app.exit(process.exitCode||0)
 }
}
void main()
