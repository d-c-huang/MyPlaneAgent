import {app,BrowserWindow,dialog} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

// Real main window and IPC, with a deterministic model fixture that never calls a provider.
// Build the application first, then run with Electron (ELECTRON_RUN_AS_NODE unset).
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-concurrent-chat-'))
const artifacts=path.join(root,'screenshots'),workspaceA=path.join(root,'workspace-A'),workspaceB=path.join(root,'workspace-B')
for(const directory of [artifacts,workspaceA,workspaceB])fs.mkdirSync(directory)
process.env.MYPLANE_AGENT_DATA_DIR=root
process.env.MYPLANE_AGENT_TEST_MODE='1'
delete process.env.VITE_DEV_SERVER_URL
app.setAppPath(path.resolve('.'))
app.disableHardwareAcceleration()

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const runs=new Map(),errors=[],screenshots=[]
let win,service,server,configured=false,networkPosts=0,pickedDirectory=workspaceA,releaseDispatch
const originalBootstrap=LocalAiStudioService.prototype.bootstrap,originalChooseDirectory=dialog.showOpenDialog
LocalAiStudioService.prototype.bootstrap=function(...args){
 service=this
 if(!configured){
  configured=true
  this.saveStudioSettings({source:'external',endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',contextLength:8192,maxTokens:1024,theme:'light',showExecutionInspector:false,showTokenSpeed:false})
 }
 return originalBootstrap.apply(this,args)
}
const js=async code=>{try{return await win.webContents.executeJavaScript(code,true)}catch(cause){throw new Error('Renderer evaluation failed: '+code,{cause})}}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const ipc=(action,payload)=>js(`window.myplane.localAiStudio(${JSON.stringify(action)},${JSON.stringify(payload)??'undefined'})`)
const dispatch=(action,payload,owner=win)=>service.dispatch(action,payload,{sender:owner.webContents})
const chatRuns=(owner=win)=>dispatch('chatRuns',undefined,owner)
const rowSelector=title=>`.session-button[title=${JSON.stringify(title)}]`
const rowState=title=>js(`document.querySelector(${JSON.stringify(rowSelector(title))})?.closest('.history-row')?.dataset.runState||''`)
const draft=()=>js('document.querySelector("textarea[aria-label=消息]").value')
const workspaceLabel=()=>js('document.querySelector("[aria-label=选择聊天工作目录]").textContent')
const visibleMessages=()=>js('document.querySelector(".messages")?.textContent||""')
const approvalText=()=>js('document.querySelector(".chat-approval")?.textContent||""')
async function until(check,label){
 const deadline=Date.now()+15000
 while(!await check()){
  if(Date.now()>deadline)throw Error('Concurrent chat timeout: '+label)
  await delay(40)
 }
}
async function setDraft(text){
 await js(`(()=>{const input=document.querySelector('textarea[aria-label=消息]');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
}
async function selectSession(title){
 await until(()=>js(`!!document.querySelector(${JSON.stringify(rowSelector(title))})`),'history entry '+title)
 assert.equal(await js(`document.querySelector(${JSON.stringify(rowSelector(title))}).disabled`),false,'running sessions remain navigable')
 await click(rowSelector(title))
 await until(()=>js(`document.querySelector(${JSON.stringify(rowSelector(title))})?.getAttribute('aria-current')==='page'`),'selected '+title)
}
async function chooseWorkspace(directory){
 pickedDirectory=directory
 await click('[aria-label="选择聊天工作目录"]')
 await until(async()=>(await workspaceLabel()).includes(path.basename(directory)),'workspace '+directory)
}
async function send(label){
 await setDraft(label)
 await until(()=>js('!document.querySelector("[aria-label=发送消息]")?.disabled'),'send enabled')
 await click('[aria-label="发送消息"]')
 await until(()=>runs.has(label),'fixture started '+label)
 await until(()=>js('!!document.querySelector("[aria-label=停止生成]")'),'current run stop control')
 return runs.get(label)
}
async function capture(name){
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
 const file=path.join(artifacts,name+'.png')
 fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG())
 screenshots.push(file)
 console.log('SCREENSHOT '+file)
}
async function reload(){
 await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()})
 await until(()=>js('!!document.querySelector(".chat-workbench")&&!!document.querySelector("textarea[aria-label=消息]")').catch(()=>false),'main window restored')
}
function pauseDispatch(match,after=false){
 assert.equal(releaseDispatch,undefined,'one IPC delay at a time')
 const original=service.dispatch
 let enter=false,captured=false,release
 const gate=new Promise(resolve=>{release=resolve})
 service.dispatch=async function(action,input,event){
  if(!captured&&match(action,input)){
   captured=true
   const result=after?await original.call(this,action,input,event):undefined
   enter=true
   await gate
   return after?result:original.call(this,action,input,event)
  }
  return original.call(this,action,input,event)
 }
 releaseDispatch=()=>{service.dispatch=original;releaseDispatch=undefined;release()}
 return {entered:()=>enter,release:()=>releaseDispatch?.()}
}
async function stopDuringPreparation(action){
 const beforeRuns=runs.size,beforeMessages=service.sessions().reduce((sum,session)=>sum+session.messageCount,0)
 const held=pauseDispatch(name=>name===action)
 const prompt='取消启动准备 '+action
 try{
  await setDraft(prompt)
  await click('[aria-label="发送消息"]')
  await until(held.entered,'preparation paused at '+action)
  await until(()=>js('!!document.querySelector("[aria-label=停止生成]")'),'preparation can be stopped')
  assert.equal((await chatRuns()).length,0,'preparation has not launched a backend run')
  await click('[aria-label="停止生成"]')
  held.release()
  await until(()=>js('!document.querySelector("[aria-label=停止生成]")'),'cancelled '+action+' preparation settles')
  await until(async()=>(await draft())===prompt,'cancelled preparation restores its draft')
  assert.equal(runs.size,beforeRuns,'stopped '+action+' preparation never invokes inference')
  assert.equal((await chatRuns()).length,0,'stopped preparation cannot resurrect after IPC resolves')
  assert.equal(service.sessions().reduce((sum,session)=>sum+session.messageCount,0),beforeMessages,'cancelled preparation saves no phantom message')
 }finally{held.release()}
}

function installModelFixture(){
 service.generate=async(current,connection,settings,signal,emit,requestId,_compactOnly,options)=>{
  const label=current.messages.filter(message=>message.role==='user').at(-1).content
  let release,finished=false
  const gate=new Promise(resolve=>{release=resolve})
  const answer={id:randomUUID(),role:'assistant',content:'',reasoning:'',createdAt:new Date().toISOString(),model:current.model,toolActivity:[],execution:[]}
  const run={label,session:current,requestId,signal,connection,settings,options,answer,decisions:[],done:gate}
  run.emit=event=>{
   assert.equal(finished,false,'cannot emit after fixture completion')
   if(event.type==='delta'){answer.content+=event.content;answer.reasoning+=event.reasoning||''}
   if(event.type==='context')current.context=structuredClone(event.context)
   if(event.type==='task-plan')current.taskPlan=structuredClone(event.plan)
   if(event.type==='progress')answer.execution.push(structuredClone(event.entry))
   if(event.type==='tool'){
    const index=answer.toolActivity.findIndex(activity=>activity.id===event.activity.id)
    if(index<0){answer.toolActivity.push(structuredClone(event.activity));answer.execution.push({id:event.activity.id,type:'tool',activityId:event.activity.id,createdAt:new Date().toISOString()})}
    else answer.toolActivity[index]=structuredClone(event.activity)
   }
   emit({...event,requestId})
  }
  run.delta=content=>run.emit({type:'delta',content,reasoning:''})
  run.ask=marker=>{
   const activity={id:randomUUID(),capability:'agent.write_file',args:{path:marker+'.txt',text:marker},status:'waiting'}
   run.emit({type:'tool',activity})
   const result=options.approve(activity).then(approved=>{
    run.decisions.push({marker,approved})
    if(!finished)run.emit({type:'tool',activity:{...activity,status:approved?'complete':'denied',output:marker+' '+approved}})
    return approved
   })
   return {activity,result}
  }
  run.finish=(status='complete')=>{
   if(finished)return
   finished=true
   answer.status=status
   answer.outcome=status==='complete'?'complete':'blocked'
   if(current.taskPlan)for(const item of current.taskPlan.items){item.status=status==='complete'?'complete':'blocked';item.summary=status==='complete'?'fixture completed':'fixture stopped'}
   current.messages.push(answer)
   service.saveSession(current)
   emit({type:'finished',requestId,session:current})
   release()
  }
  signal.addEventListener('abort',()=>queueMicrotask(()=>run.finish('stopped')),{once:true})
  runs.set(label,run)
  run.delta(label+' 初始流\n')
  await gate
 }
}
function interleave(run,marker,inputTokens){
 run.delta(marker+'-DELTA\n')
 run.emit({type:'tool',activity:{id:marker+'-TOOL',capability:'agent.read_file',args:{path:marker+'-ONLY.txt'},status:'complete',output:JSON.stringify({text:marker+'-RESULT'})}})
 run.emit({type:'progress',entry:{id:marker+'-PROGRESS',type:'progress',text:marker+'-PROGRESS',phase:'working',createdAt:new Date().toISOString()}})
 run.emit({type:'context',context:{inputTokens,capacity:10000,reservedOutput:0,safetyTokens:0,estimated:true,state:'ready',compactions:0,message:marker+'-CONTEXT'}})
 run.emit({type:'task-plan',plan:{taskId:marker+'-TASK',workspace:run.options.workspace,updatedAt:new Date().toISOString(),scope:{goal:marker+'-GOAL'},items:[{id:marker+'-STEP',title:marker+'-PLAN',kind:'inspect',mode:'read',status:'running',acceptance:marker+'-ACCEPTANCE',attempts:1,summary:marker+'-SUMMARY',evidenceIds:[]}]}})
}
async function assertCurrentRun(run,marker,otherMarker,percent){
 await until(async()=>(await visibleMessages()).includes(marker+'-DELTA'),marker+' output visible')
 const text=await visibleMessages()
 for(const value of [marker+'-DELTA',marker+'-ONLY.txt',marker+'-PROGRESS'])assert.ok(text.includes(value),'active session includes '+value)
 for(const value of [otherMarker+'-DELTA',otherMarker+'-ONLY.txt',otherMarker+'-PROGRESS'])assert.ok(!text.includes(value),'other session excludes '+value)
 assert.match(await js('document.querySelector("[aria-label=查看上下文整理信息]").textContent'),new RegExp(percent+'%'),'context belongs to current session')
 if(!await js('!!document.querySelector(".floating-task-list")'))await click('.task-list-toggle')
 await until(()=>js('!!document.querySelector(".floating-task-list")'),'current task list')
 const plan=await js('document.querySelector(".floating-task-list").textContent')
 assert.ok(plan.includes(marker+'-GOAL')&&plan.includes(marker+'-PLAN'),'plan belongs to current session')
 assert.ok(!plan.includes(otherMarker+'-PLAN'),'plan excludes other session')
 await click('.task-panel-close')
 const snapshot=(await chatRuns()).find(item=>item.requestId===run.requestId)
 assert.equal(snapshot.sessionId,run.session.id)
 assert.match(snapshot.pending.content,new RegExp(marker+'-DELTA'))
 assert.ok(!snapshot.pending.content.includes(otherMarker+'-DELTA'))
 assert.equal(snapshot.session.taskPlan.taskId,marker+'-TASK')
 assert.equal(snapshot.session.context.inputTokens,percent*100)
}

async function main(){
 const watchdog=setTimeout(()=>{console.error('Concurrent chat UI timed out');app.exit(1)},150000)
 try{
  server=createServer((request,response)=>{if(request.method==='POST')networkPosts++;response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'fixture-model'}]}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  await import('../dist-electron/main/index.js')
  await app.whenReady()
  app.removeAllListeners('window-all-closed')
  await until(()=>BrowserWindow.getAllWindows().length,'main window')
  win=BrowserWindow.getAllWindows()[0]
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)})
  await until(()=>service&&js('!!document.querySelector(".conversation-starters")').catch(()=>false),'empty conversation')
  await until(()=>js('document.querySelector("[aria-label=模型与连接设置]")?.textContent.includes("模型已连接")'),'fixture model connected')
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pickedDirectory]})
  installModelFixture()

  await stopDuringPreparation('settings')
  await stopDuringPreparation('updateSession')

  await chooseWorkspace(workspaceA)
  const a=await send('并发任务 A')
  await setDraft('A 的后续草稿')
  interleave(a,'ALPHA',1100)
  assert.equal(await js('document.querySelector(".new-conversation-button").disabled'),false,'can create a conversation while A runs')
  await click('.new-conversation-button')
  await until(()=>js('!!document.querySelector(".conversation-starters")'),'B empty conversation')
  assert.equal(await draft(),'','new session has a separate draft')
  await chooseWorkspace(workspaceB)
  await setDraft('B 的发送前草稿')
  await selectSession('并发任务 A')
  assert.equal(await draft(),'A 的后续草稿','A draft survives navigation')
  assert.ok((await workspaceLabel()).includes('workspace-A'),'A keeps its workspace')
  await selectSession('新对话')
  assert.equal(await draft(),'B 的发送前草稿','B draft survives navigation')
  assert.ok((await workspaceLabel()).includes('workspace-B'),'B keeps its workspace')
  const b=await send('并发任务 B')
  await setDraft('B 的后续草稿')
  assert.equal(a.signal.aborted,false,'starting B keeps A alive')
  assert.equal(b.signal.aborted,false)
  assert.equal(a.options.workspace,workspaceA)
  assert.equal(b.options.workspace,workspaceB)
  assert.equal((await chatRuns()).length,2,'same window owns two simultaneous runs')
  assert.equal((await ipc('chatRuns')).length,2,'real IPC exposes both owner runs')
  interleave(b,'BRAVO',2200)
  a.delta('ALPHA-LATE\n')
  b.delta('BRAVO-LATE\n')
  await assertCurrentRun(b,'BRAVO','ALPHA',22)
  await until(async()=>(await rowState('并发任务 A'))==='running'&&(await rowState('并发任务 B'))==='running','both sidebar indicators')
  assert.match(await js('document.querySelector(".conversation-activity").textContent'),/2/,'activity total reflects both runs')
  await selectSession('并发任务 A')
  await assertCurrentRun(a,'ALPHA','BRAVO',11)
  assert.equal(await draft(),'A 的后续草稿')
  await selectSession('并发任务 B')
  assert.equal(await draft(),'B 的后续草稿')
  await capture('two-running-sessions')

  const beforeDuplicate=fs.readFileSync(service.sessionFile(a.session.id),'utf8')
  await assert.rejects(dispatch('chat',{sessionId:a.session.id,requestId:randomUUID(),text:'duplicate session',model:'fixture-model'}),/当前|生成|运行|执行|会话/,'one session cannot start twice')
  const otherSession=service.newSession()
  await assert.rejects(dispatch('chat',{sessionId:otherSession.id,requestId:a.requestId,text:'duplicate request',model:'fixture-model'}),/请求|生成|运行|执行/,'one request id cannot start twice')
  assert.equal(fs.readFileSync(service.sessionFile(a.session.id),'utf8'),beforeDuplicate,'rejected duplicate adds no message or file mutation')
  assert.equal(runs.size,2,'duplicates never invoke inference')

  const aFirst=a.ask('ALPHA-APPROVAL-1'),aSecond=a.ask('ALPHA-APPROVAL-2'),bFirst=b.ask('BRAVO-APPROVAL-1')
  await until(async()=>(await approvalText()).includes('BRAVO-APPROVAL-1'),'B approval stays in B')
  assert.ok(!(await approvalText()).includes('ALPHA-APPROVAL'))
  await until(async()=>(await rowState('并发任务 A'))==='approval'&&(await rowState('并发任务 B'))==='approval','approval sidebar indicators')
  const waiting=await chatRuns(),aWaiting=waiting.find(run=>run.requestId===a.requestId),bWaiting=waiting.find(run=>run.requestId===b.requestId)
  assert.equal(aWaiting.approvals.length,2,'two approvals in one session are queued')
  assert.equal(bWaiting.approvals.length,1)
  await assert.rejects(dispatch('chatApprove',{requestId:b.requestId,approvalId:aWaiting.approvals[0].approvalId,approved:true}),/失效|不属于/,'approval id cannot be applied to a different run')
  const approvalReply=pauseDispatch((action,input)=>action==='chatApprove'&&input.requestId===b.requestId,true)
  await click('.chat-approval .approval-button>button')
  assert.equal(await bFirst.result,true,'B approval resolves its own action')
  await until(approvalReply.entered,'B approval reply held after backend resolution')
  assert.deepEqual(a.decisions,[],'approving B leaves both A actions pending')
  await selectSession('并发任务 A')
  await until(async()=>(await approvalText()).includes('ALPHA-APPROVAL-1'),'first A approval')
  assert.equal(await js('document.querySelector(".chat-approval .agent-secondary").disabled'),false,'B in-flight approval does not disable A approvals')
  approvalReply.release()
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.match(await approvalText(),/ALPHA-APPROVAL-1/,'late B approval response leaves the active A approval intact')
  assert.deepEqual(a.decisions,[],'late B approval response does not resolve A approvals')
  await click('.chat-approval .agent-secondary')
  assert.equal(await aFirst.result,false,'first A action can be rejected independently')
  await until(async()=>(await approvalText()).includes('ALPHA-APPROVAL-2'),'second A approval is not lost')

  await reload()
  assert.equal(a.signal.aborted,false,'renderer reload does not abort A')
  assert.equal(b.signal.aborted,false,'renderer reload does not abort B')
  const restoredRuns=await ipc('chatRuns'),restoredA=restoredRuns.find(run=>run.requestId===a.requestId),restoredB=restoredRuns.find(run=>run.requestId===b.requestId)
  assert.equal(restoredA.workspace?.path,workspaceA,'A recovery snapshot preserves its chosen workspace')
  assert.equal(restoredB.workspace?.path,workspaceB,'B recovery snapshot preserves its chosen workspace')
  assert.equal(typeof restoredA.workspace?.token,'string','A recovery snapshot includes its owner workspace grant')
  assert.equal(typeof restoredB.workspace?.token,'string','B recovery snapshot includes its owner workspace grant')
  assert.notEqual(restoredA.workspace.token,restoredB.workspace.token,'workspace grants remain separate')
  await selectSession('并发任务 A')
  await until(async()=>(await approvalText()).includes('ALPHA-APPROVAL-2'),'pending approval recovered from chatRuns')
  await assertCurrentRun(a,'ALPHA','BRAVO',11)
  assert.ok((await workspaceLabel()).includes('workspace-A'),'A chosen directory is restored in the composer after reload')
  assert.equal((await chatRuns()).find(run=>run.requestId===a.requestId).approvals.length,1,'reload restores only unresolved approvals')
  await capture('restored-running-approval')
  await click('.chat-approval .approval-button>button')
  assert.equal(await aSecond.result,true)
  await until(async()=>(await approvalText())==='','all A approvals resolved')
  await selectSession('并发任务 B')
  await assertCurrentRun(b,'BRAVO','ALPHA',22)
  assert.ok((await workspaceLabel()).includes('workspace-B'),'B chosen directory is restored in the composer after reload')
  assert.equal(await approvalText(),'','resolved B approval does not reappear after reload')

  await selectSession('并发任务 A')
  await click('[aria-label="停止生成"]')
  await until(()=>a.signal.aborted&&!service.chats.has(a.requestId),'only A stopped')
  assert.equal(b.signal.aborted,false,'stopping A leaves B alive')
  await until(async()=>(await rowState('并发任务 A'))==='','A sidebar running state clears')
  assert.equal(await rowState('并发任务 B'),'running','B remains visibly running in background')
  b.delta('BRAVO-BACKGROUND-FINISH\n')
  b.finish()
  await until(()=>!service.chats.has(b.requestId),'B completed in background')
  await until(async()=>(await rowState('并发任务 B'))==='','B sidebar running state clears in background')
  assert.equal((await chatRuns()).length,0,'finished runs are removed from recovery snapshots')
  assert.ok(!(await visibleMessages()).includes('BRAVO-BACKGROUND-FINISH'),'background finish does not replace active A')
  const savedA=JSON.parse(fs.readFileSync(service.sessionFile(a.session.id),'utf8'))
  const savedB=JSON.parse(fs.readFileSync(service.sessionFile(b.session.id),'utf8'))
  assert.equal(savedA.messages.at(-1).status,'stopped')
  assert.equal(savedB.messages.at(-1).status,'complete')
  assert.match(savedB.messages.at(-1).content,/BRAVO-BACKGROUND-FINISH/,'background answer persisted to disk')
  assert.ok(!savedA.messages.at(-1).content.includes('BRAVO'))
  assert.ok(!savedB.messages.at(-1).content.includes('ALPHA'))
  await selectSession('并发任务 B')
  await until(async()=>(await visibleMessages()).includes('BRAVO-BACKGROUND-FINISH'),'completed B restores on navigation')
  assert.equal(await js('!!document.querySelector("[aria-label=停止生成]")'),false,'completed B has no stop control')
  assert.ok((await workspaceLabel()).includes('workspace-B'),'B keeps its recovered directory after background completion')
  const bFollowup=await send('并发任务 B 目录恢复后续')
  assert.equal(bFollowup.session.id,b.session.id,'follow-up uses the completed B conversation')
  assert.equal(bFollowup.options.workspace,workspaceB,'follow-up uses the recovered authorized directory')
  assert.equal((await chatRuns()).find(run=>run.requestId===bFollowup.requestId).workspace?.token,restoredB.workspace.token,'follow-up retains the live owner grant recovered through chatRuns')
  bFollowup.finish()
  await until(()=>!service.chats.has(bFollowup.requestId),'B directory recovery follow-up completed')
  await selectSession('并发任务 A')
  assert.match(await visibleMessages(),/已停止生成/,'stopped A restores on navigation')

  // A hidden, separate WebContents gives the real owner lifecycle without stealing focus.
  const secondOwner=new BrowserWindow({show:false,webPreferences:{sandbox:true}})
  const cSession=service.newSession(),dSession=service.newSession(),eSession=service.newSession()
  await dispatch('chat',{sessionId:cSession.id,requestId:randomUUID(),text:'owner-main C',model:'fixture-model'})
  await dispatch('chat',{sessionId:dSession.id,requestId:randomUUID(),text:'owner-other D',model:'fixture-model'},secondOwner)
  await dispatch('chat',{sessionId:eSession.id,requestId:randomUUID(),text:'owner-other E',model:'fixture-model'},secondOwner)
  const c=runs.get('owner-main C'),d=runs.get('owner-other D'),e=runs.get('owner-other E')
  assert.equal((await chatRuns()).length,1,'main owner sees only its own run')
  assert.equal((await chatRuns(secondOwner)).length,2,'second owner sees only its own runs')
  const foreignApproval=d.ask('OTHER-OWNER-APPROVAL')
  const foreignSnapshot=(await chatRuns(secondOwner)).find(run=>run.requestId===d.requestId)
  await dispatch('stopChat',{requestId:d.requestId})
  assert.equal(d.signal.aborted,false,'foreign owner cannot stop a run')
  await assert.rejects(dispatch('chatApprove',{requestId:d.requestId,approvalId:foreignSnapshot.approvals[0].approvalId,approved:true}),/失效|不属于/,'foreign owner cannot approve a run')
  await assert.rejects(dispatch('chatInspect',{requestId:d.requestId,action:'state'}),/不属于/,'foreign owner cannot inspect a run')
  const detached=await chatRuns(secondOwner)
  detached[0].pending.content='mutated snapshot'
  assert.notEqual((await chatRuns(secondOwner))[0].pending.content,'mutated snapshot','recovery snapshots are detached copies')
  secondOwner.destroy()
  await until(()=>d.signal.aborted&&e.signal.aborted&&!service.chats.has(d.requestId)&&!service.chats.has(e.requestId),'closing owner stops all of its runs')
  assert.equal(await foreignApproval.result,false,'owner close resolves its pending approval')
  assert.equal(c.signal.aborted,false,'closing another owner leaves main run alive')
  assert.equal((await chatRuns()).length,1)
  c.finish()
  await until(()=>service.chats.size===0,'all fixtures finished')
  assert.equal(networkPosts,0,'test sends no inference request to a provider')
  assert.deepEqual(errors,[],'renderer has no console errors')
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,screenshots,checks:['cancellation during settings/updateSession preparation','same-window concurrent runs','per-session drafts and workspaces','interleaved delta/tool/progress/context/plan isolation','queued approvals and correct attribution','late approval reply after switching sessions','renderer reload recovery','workspace grant recovery and reuse after completion','same-session and request-id duplicate rejection','independent stop','background completion persistence','sidebar status lifecycle','owner stop/approval/inspection isolation','window-close owner lifecycle']},null,2))
  console.log('PASS: concurrent AI conversations, isolated events/drafts/workspaces/approvals, reload recovery, independent stop, background persistence and owner lifecycle')
 }catch(error){
  console.error(error)
  if(win&&!win.isDestroyed()){console.error(await js('document.body.innerText').catch(()=>''));await capture('failure').catch(()=>{})}
  process.exitCode=1
 }finally{
  clearTimeout(watchdog)
  releaseDispatch?.()
  LocalAiStudioService.prototype.bootstrap=originalBootstrap
  dialog.showOpenDialog=originalChooseDirectory
  app.removeAllListeners('window-all-closed')
  for(const window of BrowserWindow.getAllWindows())window.destroy()
  await service?.dispose()
  server?.closeAllConnections()
  if(server)await new Promise(resolve=>server.close(resolve))
  app.exit(process.exitCode||0)
 }
}
void main()
