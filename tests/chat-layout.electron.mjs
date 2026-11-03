import {app,BrowserWindow,dialog} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

// Exercise the real main window with isolated application data and a local model catalogue.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-chat-layout-'))
const artifacts=path.join(root,'screenshots'),workspace=path.join(root,'sample-project')
fs.mkdirSync(artifacts);fs.mkdirSync(workspace)
process.env.MYPLANE_AGENT_DATA_DIR=root;process.env.MYPLANE_AGENT_TEST_MODE='1';delete process.env.VITE_DEV_SERVER_URL
app.setAppPath(path.resolve('.'));app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let win,service,server,configured=false,sends=0,directorySelections=0,networkPosts=0
const errors=[],screenshots=[],keyboardIssues=[]
const originalBootstrap=LocalAiStudioService.prototype.bootstrap,originalChooseDirectory=dialog.showOpenDialog,originalSaveDialog=dialog.showSaveDialog
LocalAiStudioService.prototype.bootstrap=function(...args){
 service=this
 if(!configured){configured=true;this.saveStudioSettings({source:'external',endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',contextLength:8192,maxTokens:1024,theme:'light',showExecutionInspector:false,showTokenSpeed:false})}
 return originalBootstrap.apply(this,args)
}
const js=code=>win.webContents.executeJavaScript(code,true)
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function until(check,label){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw Error('Chat layout timeout: '+label);await delay(40)}}
async function capture(name){await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(180);const file=path.join(artifacts,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());screenshots.push(file);console.log('SCREENSHOT '+file)}
async function reload(){await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()});await until(()=>js("!!document.querySelector('.chat-workbench')&&!!document.querySelector('textarea[aria-label=消息]')"),'restored conversation')}
async function noOverflow(label){
 assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true,label+' has no page overflow')
 assert.equal(await js("document.querySelector('.chat-workbench').scrollWidth<=document.querySelector('.chat-workbench').clientWidth+1"),true,label+' has no workspace overflow')
 assert.equal(await js("(()=>{const rect=document.querySelector('.agent-prompt').getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1})()"),true,label+' keeps the complete composer visible')
}
async function openHistoryIfNeeded(){
 const hidden=await js("(()=>{const rect=document.querySelector('[aria-label=\"打开工作区菜单\"]').getBoundingClientRect();return rect.left<0||rect.right>innerWidth||rect.width===0})()")
 if(hidden){await click('[aria-label="展开会话导航"]');await delay(200)}
}
async function checkConnectionEntry(){
 assert.equal(await js("(()=>{const entry=document.querySelector('[aria-label=\"模型与连接设置\"]'),rect=entry.getBoundingClientRect(),sidebar=document.querySelector('.agent-history').getBoundingClientRect();return entry.checkVisibility()&&rect.left>=Math.max(0,sidebar.left)-1&&rect.right<=Math.min(innerWidth,sidebar.right)+1&&rect.top>=sidebar.top&&rect.bottom<=Math.min(innerHeight,sidebar.bottom)+1&&rect.width>40})()"),true,'connection settings remains visible within the sidebar')
 assert.equal(await js("document.querySelector('[aria-label=\"模型与连接设置\"]').getBoundingClientRect().top>=document.querySelector('[aria-label=\"打开工作区菜单\"]').getBoundingClientRect().bottom-1"),true,'sidebar footer actions are vertically stacked')
}
async function checkWorkspaceEntry(){
 await openHistoryIfNeeded()
 await checkConnectionEntry()
 assert.equal(await js("!!document.querySelector('.agent-history [aria-label=\"打开工作区菜单\"]')"),true,'workspace entry belongs to navigation')
 assert.equal(await js("(()=>{const rect=document.querySelector('[aria-label=\"打开工作区菜单\"]').getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1&&rect.width>0})()"),true,'workspace entry is reachable')
 await click('[aria-label="打开工作区菜单"]')
 await until(()=>js("!!document.querySelector('.topbar-return-chat')"),'workspace console')
 await click('.topbar-return-chat')
 await until(()=>js("!!document.querySelector('.chat-workbench')"),'return to AI conversation')
}
async function checkToolsMenu(){
 await js("(()=>{const entry=document.querySelector('[aria-label=\"打开 3D 运行视图\"]');const menu=entry?.closest('details');if(!menu)throw Error('secondary tools must live in a disclosure menu');if(!menu.open)menu.querySelector('summary').click()})()")
 assert.equal(await js("(()=>{const menu=document.querySelector('[aria-label=\"打开 3D 运行视图\"]').closest('details');return menu.open&&!!menu.querySelector('[aria-label=\"打开内置浏览器\"]')})()"),true)
 await js("document.querySelector('[aria-label=\"打开 3D 运行视图\"]').closest('details').querySelector('summary').click()")
}
async function checkToolsKeyboard(withExports=false){
 await js("(()=>{const trigger=document.querySelector('summary[aria-label=\"会话工具\"]');trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})()")
 assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'打开 3D 运行视图','ArrowDown opens the tools and focuses the first item')
 await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))")
 const expected=withExports?'导出会话':'打开内置浏览器',actual=await js("document.activeElement.getAttribute('aria-label')")
 if(actual!==expected){keyboardIssues.push(`End should focus ${expected}, actually ${actual}`);console.error('KEYBOARD ISSUE '+keyboardIssues.at(-1));console.error(await js("[...document.querySelectorAll('.conversation-tools-menu button,.conversation-tools-menu summary')].map(element=>({text:element.textContent.trim(),rects:element.getClientRects().length,visible:element.checkVisibility(),tag:element.tagName}))"))}
 await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))")
 assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'打开 3D 运行视图','Home focuses the first real tool, excluding the trigger')
 await js("document.querySelector('summary[aria-label=\"会话工具\"]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))")
 assert.equal(await js("document.activeElement.getAttribute('aria-label')"),expected,'ArrowUp from the trigger reaches the last visible item')
 if(withExports){
  await js("document.querySelector('summary[aria-label=\"导出会话\"]').focus()")
  await js('document.activeElement.click()')
  assert.deepEqual(await js("[...document.querySelectorAll('.conversation-export-options button')].map(button=>button.textContent)"),['PDF 文档','Markdown','JSON 数据'])
  await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))")
  assert.equal(await js('document.activeElement.textContent'),'JSON 数据','expanded export formats join keyboard traversal')
  await capture('conversation-tools')
  const exported=path.join(root,'exported-session.json')
  dialog.showSaveDialog=async(_owner,options)=>{assert.match(options.defaultPath,/\.json$/);return {canceled:false,filePath:exported}}
  await js('document.activeElement.click()');await until(()=>fs.existsSync(exported),'JSON export')
  assert.equal(JSON.parse(fs.readFileSync(exported,'utf8')).messages.length,2)
  assert.equal(await js("document.querySelector('.conversation-tools-menu').open"),false,'choosing an export closes the outer tools menu')
 }else{
  await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  assert.equal(await js("document.querySelector('.conversation-tools-menu').open"),false,'Escape closes tools')
  assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'会话工具','Escape returns focus to the tools trigger')
 }
}
async function main(){
 const watchdog=setTimeout(()=>{console.error('Chat layout UI timed out');app.exit(1)},120000)
 try{
  server=createServer((request,response)=>{if(request.method==='POST')networkPosts++;response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'fixture-model'},{id:'fixture-creative'}]}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  await import('../dist-electron/main/index.js');await app.whenReady();app.removeAllListeners('window-all-closed')
  await until(()=>BrowserWindow.getAllWindows().length,'main window')
  win=BrowserWindow.getAllWindows()[0]
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)})
  await until(()=>service&&js("!!document.querySelector('.conversation-starters')").catch(()=>false),'empty conversation')
  await until(()=>js("document.querySelector('[aria-label=\"模型与连接设置\"]')?.textContent.includes('模型已连接')"),'model service connected')
  assert.equal(win.isMenuBarVisible(),false,'main window has no native menu bar')
  assert.equal(await js("document.querySelectorAll('.desktop-titlebar button,[role=menubar]').length"),0,'no top application menu items')
  assert.equal(await js("!!document.querySelector('.agent-toolbar [aria-label=\"打开工作区菜单\"]')"),false,'workspace navigation is absent from the conversation header')
  assert.equal(await js("document.querySelector('.conversation-brand strong').textContent"),'MyPlaneAgent')
  await checkConnectionEntry()
  assert.equal(await js("document.querySelector('.agent-prompt').getBoundingClientRect().height<260"),true,'composer remains compact')
  await noOverflow('desktop welcome');await capture('welcome-light')
  await checkToolsMenu();await checkToolsKeyboard();await checkWorkspaceEntry()
  await click('.conversation-starters button:nth-child(2)')
  assert.match(await js("document.querySelector('textarea[aria-label=消息]').value"),/定位并修复/)
  assert.equal(sends,0,'quick suggestions only prepare a draft')
  assert.equal(await js("document.activeElement.getAttribute('aria-label')"),'消息')
  await click('.conversation-model-select .el-select__wrapper')
  await until(()=>js("[...document.querySelectorAll('.el-select-dropdown__item')].some(row=>row.textContent.includes('fixture-creative'))"),'model menu options')
  await js("[...document.querySelectorAll('.el-select-dropdown__item')].find(row=>row.textContent.includes('fixture-creative')).click()")
  await until(()=>js("document.querySelector('.conversation-model-select').textContent.includes('fixture-creative')"),'model choice applied')
  dialog.showOpenDialog=async()=>{directorySelections++;return {canceled:false,filePaths:[workspace]}}
  await click('[aria-label="选择聊天工作目录"]')
  await until(()=>js("document.querySelector('[aria-label=\"选择聊天工作目录\"]').textContent.includes('sample-project')"),'workspace picker applied')
  assert.equal(directorySelections,1)
  await click('[aria-label="会话设置"]')
  await until(()=>js("!!document.querySelector('[aria-label=\"联网搜索\"]')"),'conversation settings')
  await click('[aria-label="关闭会话设置"]')
  const at=new Date().toISOString()
  service.generate=async(current,_connection,_settings,_signal,emit,requestId)=>{
   sends++
   current.taskPlan={taskId:'layout-task',workspace,updatedAt:at,scope:{goal:'核对项目结构并完成界面整理'},items:[
    {id:'read',title:'检查项目结构',kind:'inspect',mode:'read',status:'complete',acceptance:'记录实际入口与模块',attempts:1,summary:'已确认主界面入口和样式文件',evidenceIds:['read'],runtime:{status:'succeeded',phase:'observe',updatedAt:at}},
    {id:'edit',title:'优化对话界面布局',kind:'edit',mode:'write',status:'blocked',outcome:'needs_input',acceptance:'主要控件可用且窄窗无横向溢出',attempts:1,summary:'等待确认最终文案',evidenceIds:[],runtime:{status:'waiting',waitReason:'input',phase:'observe',updatedAt:at}},
    {id:'check',title:'验证布局与交互',kind:'verify',mode:'verify',status:'pending',acceptance:'检查桌面、窄窗与深色外观',attempts:0,summary:'',evidenceIds:[],dependsOn:['edit']}
   ]}
   current.messages.push({id:randomUUID(),role:'assistant',content:'已梳理项目结构，并整理了会话界面的层级。\n\n- 会话内容保持清晰的阅读宽度。\n- 模型和发送操作集中在输入区。\n- 工具与设置按需展开。\n\n请确认需要保留的欢迎文案，随后继续验证。',createdAt:at,status:'complete',outcome:'needs_input'})
   service.saveSession(current);emit({type:'task-plan',requestId,plan:current.taskPlan});emit({type:'finished',requestId,session:current})
  }
  await click('[aria-label="发送消息"]')
  await until(()=>sends===1&&js("!!document.querySelector('.conversation-run-status')&&!document.querySelector('.stop-button')"),'message sent and task state rendered')
  assert.equal(networkPosts,0,'layout fixture never sends inference requests to a provider')
  assert.match(await js("document.querySelector('.conversation-run-status').textContent"),/有事项需要处理/)
  assert.equal(await js("!!document.querySelector('.floating-task-list')"),false,'task panel is collapsed by default')
  assert.equal(await js("document.querySelector('textarea[aria-label=消息]').disabled"),false,'composer remains ready for follow-up')
  await noOverflow('desktop conversation');await capture('conversation-light')
  await checkToolsKeyboard(true)
  await click('.task-list-toggle');await until(()=>js("!!document.querySelector('.floating-task-list')"),'task panel opens on demand')
  assert.equal(await js("document.querySelector('.floating-task-list').getBoundingClientRect().left>=document.querySelector('.agent-main').getBoundingClientRect().right-1"),true,'desktop task panel stays beside the conversation')
  await capture('conversation-tasks');await click('.task-panel-close')
  service.saveStudioSettings({theme:'dark'});await reload()
  await until(()=>js("document.querySelector('.local-ai-studio').dataset.theme==='dark'"),'dark theme')
  await noOverflow('dark conversation');await capture('conversation-dark')
  for(const width of [960,720,520]){
   win.setSize(width,850);await delay(220)
   await noOverflow('conversation at '+width)
   await checkToolsMenu()
   if(width===520){
    await capture('conversation-narrow');await click('.task-list-toggle')
    await until(()=>js("document.querySelector('.floating-task-list')?.getAttribute('aria-modal')==='true'"),'task drawer at narrow width')
    assert.equal(await js("document.querySelector('.agent-main').hasAttribute('inert')"),true,'task drawer prevents background interaction')
    await capture('tasks-narrow');await click('.task-panel-close')
    await checkWorkspaceEntry();await noOverflow('return from workspace at narrow width')
   }
  }
  await openHistoryIfNeeded();await click('.new-conversation-button')
  await until(()=>js("!!document.querySelector('.conversation-starters')"),'narrow empty conversation')
  await noOverflow('narrow welcome');await capture('welcome-narrow-dark')
  assert.deepEqual(errors,[])
  assert.deepEqual(keyboardIssues,[])
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,screenshots,checks:['real main window without top menus','sidebar workspace entry','secondary tools menu','model selection','directory selection','settings dialog','draft-only suggestions','send and task state','light and dark appearance','960/720/520 responsive layout']},null,2))
  console.log('PASS: native menu-free AI conversation, sidebar navigation, compact tools, model/workspace/send controls, task state, light/dark and responsive layout')
 }catch(error){console.error(error);if(win&&!win.isDestroyed()){console.error(await js('document.body.innerText').catch(()=>''));await capture('failure').catch(()=>{})}process.exitCode=1}
 finally{clearTimeout(watchdog);LocalAiStudioService.prototype.bootstrap=originalBootstrap;dialog.showOpenDialog=originalChooseDirectory;dialog.showSaveDialog=originalSaveDialog;app.removeAllListeners('window-all-closed');for(const window of BrowserWindow.getAllWindows())window.destroy();await service?.dispose();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));app.exit(process.exitCode||0)}
}
void main()
