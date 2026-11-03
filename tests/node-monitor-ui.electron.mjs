import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

// Real monitor IPC, persistence, diagnostics and windows; only model discovery
// uses a local fixture. No monitor responses or diagnosis results are mocked.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-node-monitor-ui-'))
const artifacts=path.join(root,'screenshots'),sessionId=randomUUID(),now=new Date().toISOString()
const monitorFile=path.join(root,'workbench','node-monitor.json')
fs.mkdirSync(artifacts);fs.mkdirSync(path.dirname(monitorFile),{recursive:true});fs.mkdirSync(path.join(root,'local-ai-sessions'))
const policy={enabled:true,autoRepair:false,autoApply:false,maxAttemptsPerIssue:2,maxRepairsPerDay:6,analysisTimeoutSeconds:90}
fs.writeFileSync(monitorFile,JSON.stringify({schema:1,policy,issues:[],repairDates:[]}))
const errorText="PermissionError: [WinError 5] 拒绝访问。: 'Documents/My Music'；Authorization: Bearer fixture-monitor-secret"
const session={id:sessionId,title:'检查项目与角色资源',model:'fixture-model',systemPrompt:'',webEnabled:false,createdAt:now,updatedAt:now,
 messages:[{id:randomUUID(),role:'user',content:'检查项目与角色资源',createdAt:now},{id:randomUUID(),role:'assistant',content:'读取目录需要进一步处理。',status:'error',error:errorText,createdAt:now}],
 taskPlan:{taskId:'monitor-fixture-task',workspace:path.join(root,'cache','tasks',sessionId),updatedAt:now,items:[{
  id:'inspect-assets',title:'检查项目结构与角色资源',mode:'read',status:'blocked',outcome:'needs_input',attempts:1,summary:errorText,
  acceptance:'读取授权范围内的资源并列出可用内容',evidenceIds:['denied-directory'],
  evidence:[{activityId:'denied-directory',capability:'agent.list_files',status:'denied',args:{path:'Documents',depth:1},output:errorText,truncated:false}],
  worker:{id:'worker-inspect',mode:'read',assignedAt:now,startedAt:now,finishedAt:now,toolCalls:1,modelRequests:1,tokens:40}
 }]}}
fs.writeFileSync(path.join(root,'local-ai-sessions',sessionId+'.json'),JSON.stringify(session))
process.env.MYPLANE_AGENT_DATA_DIR=root;process.env.MYPLANE_AGENT_TEST_MODE='1';delete process.env.VITE_DEV_SERVER_URL
app.setAppPath(path.resolve('.'));app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let win,service,server,configured=false,stateRequests=0,networkPosts=0
const screenshots=[],errors=[],contrastChecks=[]
const originalBootstrap=LocalAiStudioService.prototype.bootstrap,originalDispatch=LocalAiStudioService.prototype.dispatch
LocalAiStudioService.prototype.bootstrap=function(...args){
 service=this
 if(!configured){configured=true;this.saveStudioSettings({source:'external',endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',contextLength:8192,maxTokens:1024,theme:'light',showExecutionInspector:false,showTokenSpeed:false})}
 return originalBootstrap.apply(this,args)
}
LocalAiStudioService.prototype.dispatch=function(action,...args){if(action==='nodeMonitorState')stateRequests++;return originalDispatch.call(this,action,...args)}
const js=code=>win.webContents.executeJavaScript(code,true)
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const clickText=(selector,label)=>js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing button: '+${JSON.stringify(label)});button.click()})()`)
async function until(check,label){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw Error('Monitor UI timeout: '+label);await delay(50)}}
async function capture(name){await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(180);const file=path.join(artifacts,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());screenshots.push(file);console.log('SCREENSHOT '+file)}
async function openMonitor(){
 await until(()=>js("!!document.querySelector('[aria-label=\"打开工作区菜单\"]')"),'chat navigation')
 await click('[aria-label="打开工作区菜单"]');await until(()=>js("!!document.querySelector('.settings-more-trigger')"),'workspace navigation')
 await click('.settings-more-trigger');await clickText('.settings-more-menu button','运行监控')
 await until(()=>js("!!document.querySelector('.node-monitor-page .monitor-status-bar')"),'monitor snapshot')
}
async function changeSwitch(label,key,value){
 await click(`[role="switch"][aria-label="${label}"]`)
 await until(()=>service.nodeMonitorState().policy[key]===value,'persist '+key)
 await until(()=>js(`document.querySelector(${JSON.stringify(`[role="switch"][aria-label="${label}"]`)}).getAttribute('aria-checked')===${JSON.stringify(String(value))}`),'render '+key)
}
async function noOverflow(label){
 assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true,label+' has no document overflow')
 assert.equal(await js("(()=>{const panel=document.querySelector('.node-monitor-page');return panel.scrollWidth<=panel.clientWidth+1})()"),true,label+' has no monitor overflow')
}
async function readableText(label){
 const checks=await js(`(()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
  const rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const channels=[...context.getImageData(0,0,1,1).data];channels[3]/=255;return channels};
  const over=(top,bottom)=>{const alpha=top[3]+bottom[3]*(1-top[3]);return [...[0,1,2].map(index=>alpha?(top[index]*top[3]+bottom[index]*bottom[3]*(1-top[3]))/alpha:0),alpha]};
  const luminance=channels=>channels.slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const selectors=['.monitor-heading h1','.monitor-heading p','.monitor-status-main strong','.monitor-status-main>div>span','.monitor-metrics span','.monitor-metrics small','.monitor-issue>p','.monitor-issue-bottom span','.monitor-detail h2','.monitor-detail-title>p','.monitor-action-note','.monitor-diagnosis>p','.monitor-next-step span','.monitor-cause','.monitor-history li p','.monitor-history time','.monitor-footnote p','.monitor-policy-row p','.monitor-budget label','.monitor-filters button','.monitor-phase','.monitor-button.subtle','.monitor-error-details summary>span'];
  return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(element=>element.checkVisibility()).map(element=>{
   let background=[0,0,0,0];for(let parent=element;parent&&background[3]<.999;parent=parent.parentElement)background=over(background,rgba(getComputedStyle(parent).backgroundColor));
   background=over(background,[255,255,255,1]);const color=getComputedStyle(element).color,foreground=over(rgba(color),background),a=luminance(foreground),b=luminance(background);
   return {selector,text:element.textContent.trim().slice(0,40),color,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  }));
 })()`)
 assert.ok(checks.length>=15,label+' samples body and secondary text')
 for(const check of checks)assert.ok(check.ratio>=4.5,`${label}: ${check.selector} (${check.text}) contrast ${check.ratio.toFixed(2)} must be at least 4.5`)
 contrastChecks.push({label,minimum:Math.min(...checks.map(check=>check.ratio)),samples:checks.length})
}
async function main(){
 const watchdog=setTimeout(()=>{console.error('Node monitor native UI timed out');app.exit(1)},120000)
 try{
  server=createServer((request,response)=>{if(request.method==='POST')networkPosts++;response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'fixture-model'}]}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  await import('../dist-electron/main/index.js');await app.whenReady();app.removeAllListeners('window-all-closed')
  await until(()=>BrowserWindow.getAllWindows().length,'main window');win=BrowserWindow.getAllWindows()[0]
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)})
  win.setSize(1320,920);win.show();win.focus()
  await until(()=>service,'Studio service');await openMonitor()
  await until(()=>service.nodeMonitorState().issues.some(issue=>issue.nodeId==='inspect-assets'&&issue.phase==='waiting'),'host permission diagnosis')
  await click('[aria-label="刷新监控记录"]')
  await until(()=>js("document.querySelector('.monitor-cause')?.textContent==='权限限制'"),'permission issue details')
  const issue=service.nodeMonitorState().issues.find(item=>item.nodeId==='inspect-assets')
  assert.equal(issue.diagnosis.action,'needs_user');assert.equal(issue.attempts,0)
  assert.equal(await js("document.querySelector('.monitor-issue.selected')?.getAttribute('aria-pressed')"),'true')
  await click('.monitor-error-details summary')
  assert.match(await js("document.querySelector('.monitor-error-details pre').textContent"),/PermissionError/)
  assert.doesNotMatch(await js("document.querySelector('.node-monitor-page').textContent"),/fixture-monitor-secret/)
  assert.match(await js("document.querySelector('.monitor-footnote').textContent"),/应用内核代码不能在线替换/)
  await noOverflow('desktop');await readableText('light desktop');await capture('monitor-light')

  await changeSwitch('启用运行监控','enabled',false);await changeSwitch('启用运行监控','enabled',true)
  await click('[aria-controls="monitor-settings"]')
  assert.match(await js("document.querySelector('.monitor-budget').textContent"),/单次处理时限/)
  await changeSwitch('启用自动修复','autoRepair',true);await changeSwitch('启用自动修复','autoRepair',false)
  await changeSwitch('自动应用能力热更新','autoApply',true);await changeSwitch('自动应用能力热更新','autoApply',false)
  await js("(()=>{const input=document.querySelector('.monitor-budget input');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  const beforeBudgetPoll=stateRequests
  await until(()=>stateRequests>beforeBudgetPoll,'visible polling')
  assert.equal(await js("document.querySelector('.monitor-budget input').value"),'3','poll preserves an unsaved budget')
  await js("(()=>{const inputs=[...document.querySelectorAll('.monitor-budget input')];[3,9,75].forEach((value,index)=>{inputs[index].value=String(value);inputs[index].dispatchEvent(new Event('input',{bubbles:true}))})})()")
  await click('.monitor-budget button[type="submit"]')
  await until(()=>service.nodeMonitorState().policy.maxRepairsPerDay===9,'budget persistence')
  assert.deepEqual(service.nodeMonitorState().policy,{...policy,maxAttemptsPerIssue:3,maxRepairsPerDay:9,analysisTimeoutSeconds:75})
  assert.deepEqual(JSON.parse(fs.readFileSync(monitorFile,'utf8')).policy,service.nodeMonitorState().policy)
  await readableText('light settings');await capture('monitor-settings')

  await clickText('.monitor-detail-actions button','查看 3D 运行图')
  await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('surface=runtime-graph')),'associated 3D window')
  const graph=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('surface=runtime-graph'))
  await until(()=>graph.webContents.executeJavaScript("document.querySelector('.graph-stage-heading h2')?.textContent==='检查项目与角色资源'",true).catch(()=>false),'associated session graph')
  graph.close();win.focus()

  assert.match(await js("document.querySelector('.monitor-action-note').textContent"),/修复.*权限和预算/)
  await clickText('.monitor-detail-actions button','重新分析并处理')
  await until(()=>service.nodeMonitorState().issues.find(item=>item.id===issue.id).events.some(event=>event.message.includes('用户请求重新分析')),'manual analysis recorded')
  await until(()=>service.nodeMonitorState().issues.find(item=>item.id===issue.id).phase==='waiting','manual permission analysis')
  await click('[aria-label="刷新监控记录"]')
  await until(()=>js("[...document.querySelectorAll('.monitor-detail-actions button')].some(button=>button.textContent.trim()==='忽略此问题')"),'dismiss available')
  await clickText('.monitor-detail-actions button','忽略此问题')
  await until(()=>service.nodeMonitorState().issues.find(item=>item.id===issue.id).phase==='dismissed','dismiss persistence')
  await clickText('.monitor-filters button','全部')
  await until(()=>js("document.querySelector('.monitor-issue .monitor-phase')?.getAttribute('data-phase')==='dismissed'"),'dismissed history')

  await clickText('.monitor-detail-actions button','重新分析并处理')
  await until(()=>service.nodeMonitorState().issues.find(item=>item.id===issue.id).phase==='waiting','reopened issue')
  const nextTask=service.session(sessionId)
  nextTask.taskPlan={...nextTask.taskPlan,taskId:'replacement-task',items:[]};service.saveSession(nextTask)
  await until(()=>service.nodeMonitorState().issues.find(item=>item.id===issue.id).phase==='superseded','old task expires')
  await click('[aria-label="刷新监控记录"]');await clickText('.monitor-filters button','已处理')
  await until(()=>js("document.querySelector('.monitor-detail>header .monitor-phase')?.textContent==='已过期'"),'expired issue remains in processed history')
  assert.equal(await js("[...document.querySelectorAll('.monitor-detail-actions button')].some(button=>button.textContent.includes('重新分析'))"),false,'expired issues cannot be retried')
  assert.equal(await js("document.querySelector('.monitor-metrics>div:nth-child(2) strong').textContent"),'0','expired issues do not inflate verified recoveries')

  await click('.topbar-return-chat');await until(()=>js("!document.querySelector('.node-monitor-page')"),'monitor unmounted')
  await delay(100);const beforeLeaving=stateRequests;await delay(2400)
  assert.equal(stateRequests,beforeLeaving,'leaving monitor stops renderer polling')
  assert.equal(service.nodeMonitorState().policy.enabled,true,'background monitor remains enabled outside its view')

  service.saveStudioSettings({theme:'dark'})
  await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()})
  await openMonitor();await clickText('.monitor-filters button','全部')
  await until(()=>js("document.querySelector('.local-ai-studio').dataset.theme==='dark'"),'dark theme')
  await noOverflow('dark desktop');await readableText('dark desktop');await capture('monitor-dark')
  win.setMinimumSize(520,500);win.setSize(720,880);await delay(300)
  await noOverflow('narrow');await readableText('dark narrow');await capture('monitor-narrow')
  assert.equal(networkPosts,0,'permission diagnostics never dispatch model inference or unauthorized repair')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,screenshots,stateRequests,networkPosts,contrastChecks,checks:['real monitor IPC and permission diagnosis','secret redaction','monitor and repair switches','budget persistence and dirty edit preservation','associated 3D window','manual diagnosis and dismissal history','renderer polling stops on navigation','backend remains enabled','light/dark/responsive layout and actual text contrast >=4.5']},null,2))
  console.log('PASS: native built-in monitor UI, real diagnosis and policy persistence, associated 3D graph, bounded visible polling and responsive themes')
 }catch(error){console.error(error);if(win&&!win.isDestroyed()){console.error(await js('document.body.innerText').catch(()=>''));await capture('failure').catch(()=>{})}process.exitCode=1}
 finally{
  clearTimeout(watchdog);LocalAiStudioService.prototype.bootstrap=originalBootstrap;LocalAiStudioService.prototype.dispatch=originalDispatch
  app.removeAllListeners('window-all-closed');for(const window of BrowserWindow.getAllWindows())window.destroy()
  await service?.dispose();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));app.exit(process.exitCode||0)
 }
}
void main()
