import {app,BrowserWindow,ipcMain} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {LocalAiStudioService,registerLocalAiStudio} from '../dist-electron/main/local-ai-studio.js'
import {trackAuthWindow} from '../dist-electron/main/auth.js'
import {emptyTokenUsageTotals} from '../dist-electron/shared/local-ai-usage.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-conversation-ui-')),artifacts=path.resolve('tests/artifacts/conversation-workspace')
fs.mkdirSync(artifacts,{recursive:true});app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),errors=[]
let win,service,server
async function until(check,label){const deadline=Date.now()+20000;while(!await check()){if(Date.now()>deadline)throw Error('Timed out: '+label);await delay(40)}}
const js=async source=>{try{return await win.webContents.executeJavaScript(source,true)}catch(error){throw Error('Renderer script failed: '+source+'\n'+errors.join('\n'),{cause:error})}}
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function capture(name){await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");await delay(100);fs.writeFileSync(path.join(artifacts,name+'.png'),(await win.webContents.capturePage()).toPNG())}
async function reload(){await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()});await until(()=>js("!!document.querySelector('.conversation-run-status')"),'conversation restored')}
const at=new Date().toISOString()
const report={outcome:'compressed',method:'ledger',startedAt:at,durationMs:4,requests:0,messages:24,archivedMessages:14,capacity:8192,beforeInputTokens:6840,afterInputTokens:2630,savedInputTokens:4210,usage:emptyTokenUsageTotals(),quality:{requirements:2,unresolvedEffects:1,completeToolBoundary:true,historyUnchanged:true}}
const context={origin:'worker',model:'fixture-model',inputTokens:2630,reservedOutput:1024,safetyTokens:410,capacity:8192,estimated:true,state:'ready',compactions:5,lastCompaction:report,recovery:{restoredAt:at,messages:24,generation:1,workerId:'worker',checkpointSource:'ledger',unconfirmedEffects:1}}
const item=(id,title,status,extra={})=>({id,title,status,acceptance:'依据原始记录核对完整值，不能把计划当作已执行。',attempts:1,summary:'',evidenceIds:[],...extra})
async function main(){
 const deadline=setTimeout(()=>{console.error('Conversation workspace UI timed out');app.exit(1)},90000)
 try{
  await app.whenReady()
  let posts=0
  server=createServer((request,response)=>{if(request.method==='POST')posts++;response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'fixture-model'}]}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  service=new LocalAiStudioService(path.join(root,'data'));service.saveStudioSettings({source:'external',endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',contextLength:8192,maxTokens:1024,theme:'light'})
  const session=service.newSession();session.title='接续订单核对';session.webEnabled=false
  session.messages=[{id:randomUUID(),role:'user',content:'核对现有订单记录，逐字保留编号。已有写入不要重复执行。',createdAt:at},{id:randomUUID(),role:'assistant',content:'已核对保存的原始记录。仍需确认目标日期，已有修改和执行记录均保留。',outcome:'needs_input',status:'complete',createdAt:at,toolActivity:[
   {id:'old-tool',capability:'agent.read_file',args:{path:'orders.csv'},status:'error',notApplied:true,output:'工具定义已更新，本次未调用新提供者。'},
   {id:'read-tool',capability:'agent.read_file',args:{path:'orders.csv'},status:'complete',output:'{"path":"orders.csv","text":"ORDER-EXACT-2048"}'},
   {id:'fake-flag',capability:'fixture.output',args:{},status:'error',output:'{"notApplied":true,"error":"fixture failure"}'},
  ]}]
  session.context=structuredClone(context)
  session.checkpoint={summary:'这是一份不应被误当成本步摘要的旧记录',through:1,updatedAt:'2026-01-01T00:00:00Z',compactions:1,source:'model'}
  session.taskPlan={taskId:'ui-task',workspace:root,scope:{goal:'核对订单编号与目标日期，使用已有执行记录，避免重复写入。'},updatedAt:at,items:[
   item('read','读取原始订单','complete',{worker:{id:'reader',mode:'read'},runtime:{status:'succeeded',phase:'observe',updatedAt:at}}),
   item('date','确认目标日期','blocked',{outcome:'needs_input',summary:'需要确认这次核对使用哪一天的数据。',worker:{id:'date-worker',mode:'read'},runtime:{status:'waiting',waitReason:'input',phase:'observe',updatedAt:at}}),
   item('check','核对最终清单','pending',{runtime:{status:'waiting',waitReason:'dependency',phase:'verify',updatedAt:at}}),
  ]}
  service.saveSession(session)
  registerLocalAiStudio(()=>service,()=>service.dispose())
  for(const channel of ['performance:window','inspector:window','app:title-colors','inspector:context'])ipcMain.handle(channel,()=>false)
  win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:path.resolve('dist-electron/preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}})
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)})
  trackAuthWindow(win.webContents,true)
  await win.loadFile(path.resolve('dist/index.html'))
  await until(()=>js("!!document.querySelector('.conversation-run-status')&&!!document.querySelector('.task-list-toggle')"),'initial workspace')
  assert.equal(await js("!!document.querySelector('.floating-task-list')"),false,'task dock starts collapsed to keep the conversation focused')
  await click('.task-list-toggle')
  assert.equal(await js("document.querySelector('.conversation-brand strong').textContent"),'MyPlaneAgent')
  assert.doesNotMatch(await js("document.querySelector('.answer-meta .token-usage').getAttribute('aria-label')"),/1 次模型请求/,'legacy aggregate does not invent a request count')
  assert.match(await js("document.querySelector('.conversation-run-status').textContent"),/有事项需要处理/)
  assert.equal(await js("document.querySelector('.floating-task-list').getBoundingClientRect().left>=document.querySelector('.agent-main').getBoundingClientRect().right-1"),true,'desktop task dock does not cover the transcript')
  await click('.attention-link');assert.equal(await js("document.querySelectorAll('.floating-task-list li').length"),1)
  assert.match(await js("document.querySelector('.floating-task-list li').textContent"),/确认目标日期/)
  await click('.task-panel-filters button:first-child')
  await js("document.querySelector('.execution-flow').open=true")
  assert.equal(await js("document.querySelector('.tool-card.unapplied small').textContent"),'未执行')
  assert.equal(await js("document.querySelectorAll('.tool-card.error').length"),1,'tool output cannot spoof the host unapplied state')
  await click('.context-usage>div>details>summary')
  assert.equal(await js("document.querySelector('.context-method').textContent"),'原文整理')
  assert.match(await js("document.querySelector('.context-recovery').textContent"),/24 条历史记录/)
  assert.match(await js("document.querySelector('.context-recovery').textContent"),/1 项操作/)
  assert.match(await js("document.querySelector('.context-last-run').textContent"),/未请求摘要模型/)
  assert.equal(await js("document.querySelector('.context-saved').textContent"),'整理 5 次')
  assert.equal(await js("document.querySelector('.context-summary')===null"),true,'do not present an unrelated coordinator checkpoint as the last worker summary')
  await capture('desktop-context')
  await js("document.querySelector('.context-usage>div>details').open=false;document.querySelector('.execution-flow').open=false")
  await capture('desktop')
  for(const width of [1000,720,480]){
   win.setSize(width,900);await delay(180)
   assert.equal(await js("document.documentElement.scrollWidth<=innerWidth+1"),true,`no page overflow at ${width}`)
   assert.equal(await js("document.querySelector('.chat-workbench').scrollWidth<=document.querySelector('.chat-workbench').clientWidth+1"),true,`no workspace overflow at ${width}`)
   const overlaps=await js("!!document.querySelector('.floating-task-list')")
   if(width<=720){
    if(overlaps)await click('.task-panel-close')
    await click('.task-list-toggle');await until(()=>js("document.querySelector('.floating-task-list')?.getAttribute('aria-modal')==='true'"),'narrow task drawer')
    assert.equal(await js("document.querySelector('.agent-main').hasAttribute('inert')"),true)
    await js("(()=>{const focusables=[...document.querySelectorAll('.floating-task-list button,.floating-task-list summary')];focusables.at(-1).focus();focusables.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))})()")
    assert.equal(await js("document.activeElement.classList.contains('task-panel-close')"),true,'drawer traps focus')
    await capture('drawer-'+width)
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
    await until(()=>js("!document.querySelector('.floating-task-list')"),'drawer closed by Escape')
    assert.equal(await js("document.activeElement.classList.contains('task-list-toggle')"),true,'Escape restores focus')
    assert.equal(await js("document.querySelector('.agent-main').hasAttribute('inert')"),false)
   }
   if(width===480)await capture('narrow')
  }
  win.setSize(1440,1000);await delay(150)
  const reopened=service.session(session.id)
  assert.equal(reopened.context.inputTokens,2630);assert.equal(reopened.context.compactions,5);assert.deepEqual(reopened.context.recovery,context.recovery)
  reopened.messages.at(-1).usageTotals={requests:4,inputTokens:560,outputTokens:100,totalTokens:660,inputReports:4,outputReports:4,totalReports:4}
  reopened.context.state='compacting';service.saveSession(reopened)
  await reload()
  assert.match(await js("document.querySelector('.answer-meta .token-usage').getAttribute('aria-label')"),/4 次模型请求/)
  assert.match(await js("document.querySelector('.context-note').textContent"),/未完成/)
  assert.equal(await js("document.querySelector('textarea[aria-label=消息]').disabled"),false)
  const normalized=service.session(session.id)
  assert.equal(normalized.context.state,'error');assert.match(normalized.context.message,/上次上下文整理未完成/)
  normalized.context=structuredClone(context);service.saveSession(normalized);await reload()
  let activeRun
  service.generate=async(current,_connection,_settings,signal,emit,requestId)=>{
   activeRun={signal,emit,requestId}
   current.context={...context,state:'compacting'};emit({type:'context',requestId,context:current.context})
   await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve()})
   current.context={...context,state:'error',message:'上下文整理已停止，原始记录已保留。'}
   current.messages.push({id:randomUUID(),role:'assistant',content:'',status:'stopped',createdAt:new Date().toISOString()})
   service.saveSession(current);emit({type:'finished',requestId,session:current})
  }
  await js("const composer=document.querySelector('textarea[aria-label=消息]');composer.value='测试整理中的界面状态';composer.dispatchEvent(new Event('input',{bubbles:true}))")
  await click('.send-button');await until(()=>js("document.querySelector('.conversation-run-status').textContent.includes('正在整理上下文')"),'live context state')
  assert.equal(await js("document.querySelector('.context-actions>button').disabled"),true)
  await js("const draft=document.querySelector('textarea[aria-label=消息]');draft.value='执行期间保留的草稿';draft.dispatchEvent(new Event('input',{bubbles:true}))")
  await click('.stop-button');await until(()=>js("!document.querySelector('.stop-button')"),'stop finished')
  assert.equal(activeRun.signal.aborted,true);assert.equal(await js("document.querySelector('textarea[aria-label=消息]').value"),'执行期间保留的草稿')
  assert.match(await js("document.querySelector('.conversation-run-status').textContent"),/已停止/)
  await click('.new-conversation-button');await until(()=>js("!!document.querySelector('.conversation-starters')"),'new conversation')
  await click('.conversation-starters button:nth-child(2)')
  assert.match(await js("document.querySelector('textarea[aria-label=消息]').value"),/定位并修复/)
  assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'消息')
  assert.equal(posts,0,'starter cards draft a request without submitting it')
  await capture('welcome')
  win.setSize(480,900);await delay(180)
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth+1"),true,'narrow welcome stays within the viewport')
  await capture('welcome-narrow')
  win.setSize(1440,1000);await delay(150)
  service.saveSession(service.session(session.id));service.saveStudioSettings({theme:'dark'});await reload()
  await until(()=>js("document.querySelector('.local-ai-studio').dataset.theme==='dark'"),'saved dark appearance')
  await capture('dark')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,checks:['desktop dock','attention filtering','host-unapplied distinction','ledger and recovery details','saved worker observation','interrupted compaction normalization','1000/720/480 layouts','drawer focus and Escape','live context and cancellation','draft preserved','starter does not submit'],screenshots:fs.readdirSync(artifacts).filter(name=>name.endsWith('.png'))},null,2))
  console.log('PASS: conversation layout, context/recovery states, task filtering, narrow drawer, keyboard focus, cancellation and draft retention')
 }catch(error){console.error(error);process.exitCode=1}
 finally{clearTimeout(deadline);win?.destroy();await service?.dispose();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
  // Chromium retains its profile handles until process exit. Keep that temporary profile for diagnostics.
  fs.rmSync(path.join(root,'data'),{recursive:true,force:true});app.exit(process.exitCode||0)}
}
void main()
