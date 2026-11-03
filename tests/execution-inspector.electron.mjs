import {app,BrowserWindow} from 'electron'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'
import {AgentCoreService} from '../dist-electron/main/agent/agent-core-service.js'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'inspector-native-ui-'))
process.env.MYPLANE_AGENT_DATA_DIR=root;process.env.MYPLANE_AGENT_TEST_MODE='1';app.setAppPath(path.resolve('.'));app.disableHardwareAcceleration()
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let service,other,server,entered=false,release
const gate=new Promise(resolve=>{release=resolve}),executed=[]
const original=LocalAiStudioService.prototype.generate
LocalAiStudioService.prototype.generate=function(...args){service=this;return original.apply(this,args)}
AgentCoreService.prototype.runConversation=async function(options){
 entered=true;options.onContent('正在准备测试工具。');await gate
 for(let i=0;i<2;i++){
  const cap={name:'fixture.lookup',source:{type:'skill',skillId:'fixture-plugin'},parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}
  const id='fixture-'+i,args=await options.inspectTool(cap,{query:'original-'+i},id)
  options.signal.throwIfAborted();options.onActivity({id,capability:cap.name,args,status:'running'})
  executed.push(args);options.onActivity({id,capability:cap.name,args,status:'complete',output:'result: '+args.query})
 }
 options.onContent('测试已完成。')
}
const watchdog=setTimeout(()=>{console.error('native inspector test timeout');app.exit(1)},90000)
async function until(check,label){for(let i=0;i<300;i++){if(await check())return;await delay(50)}throw Error('UI timeout: '+label)}
const surface=()=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('surface=inspector'))
async function main(){let win,inspector
 try{
 server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}],choices:[{message:{content:'fixture response'},finish_reason:'stop'}]}))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 await import('../dist-electron/main/index.js');await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length,'main window')
 win=BrowserWindow.getAllWindows()[0]
 const mainEval=code=>win.webContents.executeJavaScript(code,true),evaluate=code=>inspector.webContents.executeJavaScript(code,true)
 await until(()=>mainEval("!!document.querySelector('.chat-workbench')").catch(()=>false),'main loaded')
 await mainEval(`window.myplane.localAiStudio('settings',{source:'external',endpoint:'http://127.0.0.1:${server.address().port}/v1',model:'fixture-model',showExecutionInspector:true,pauseBeforeAgentCalls:true})`)
 win.webContents.reload();await until(()=>surface(),'default native inspector');inspector=surface()
 await until(()=>evaluate("!!document.querySelector('.execution-inspector')").catch(()=>false),'inspector loaded')
 assert.equal(await evaluate("!!document.querySelector('.desktop-titlebar')"),false)
 assert.equal(await mainEval("!!document.querySelector('.execution-inspector')"),false)
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
 const edit=(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 async function send(){await mainEval("(()=>{const input=document.querySelector('textarea[aria-label=\"消息\"]');input.value='你好，请回答一个问题';input.dispatchEvent(new Event('input',{bubbles:true}))})()");await until(()=>mainEval("!!document.querySelector('.send-button:not(:disabled)')"),'send ready');await mainEval("document.querySelector('.send-button').click()")}
 await send();await until(()=>evaluate("!!document.querySelector('textarea[aria-label=\"暂停调用入参\"]')"),'first ability pause')
 assert.equal(entered,false)
 const requestId=[...service.chats.keys()][0]
 other=new BrowserWindow({show:false});await assert.rejects(()=>service.dispatch('chatInspect',{requestId,action:'state'},{sender:other.webContents}),/不属于当前窗口/)
 const first=JSON.parse(await evaluate("document.querySelector('textarea[aria-label=\"暂停调用入参\"]').value"));first.messages[0].text+='（测试修改）'
 const firstDraft=JSON.stringify(first)
 await edit('textarea[aria-label="暂停调用入参"]',firstDraft)
 await until(()=>service.inspectors.get(requestId).snapshot().draft===firstDraft,'draft saved before closing')
 inspector.close();await until(()=>!surface(),'closed while paused')
 assert.ok(service.inspectors.get(requestId).snapshot().checkpointId)
 await mainEval("window.myplane.inspectorWindow('open')");inspector=surface()
 await until(()=>evaluate(`document.querySelector('textarea[aria-label="暂停调用入参"]')?.value===${JSON.stringify(firstDraft)}`).catch(()=>false),'restored draft')
 await click('[data-inspect-action="step"]')
 await until(()=>evaluate("document.querySelector('.call-meta strong')?.textContent==='conversation-state'"),'next ability')
 assert.equal(service.inspectors.get(requestId).snapshot().calls[0].edited,true)
 await click('[data-inspect-action="continue"]');await until(()=>entered,'core entered')
 await until(()=>evaluate("!!document.querySelector('[data-inspect-action=\"pause\"]:not(:disabled)')"),'pause ready');await click('[data-inspect-action="pause"]');release()
 await until(()=>evaluate("document.querySelector('.call-meta strong')?.textContent==='fixture.lookup' && !!document.querySelector('textarea[aria-label=\"暂停调用入参\"]')"),'tool pause');assert.equal(executed.length,0)
 await edit('textarea[aria-label="暂停调用入参"]','{"query":42}');await click('[data-inspect-action="step"]')
 await until(()=>evaluate("!!document.querySelector('.execution-inspector [role=alert]')"),'validation error');assert.equal(executed.length,0)
 await edit('textarea[aria-label="暂停调用入参"]','{"query":"edited by user"}');await click('[data-inspect-action="step"]')
 await until(()=>evaluate("document.querySelector('textarea[aria-label=\"暂停调用入参\"]')?.value.includes('original-1')"),'next tool');assert.deepEqual(executed,[{query:'edited by user'}])
 inspector.setBounds({x:180,y:120,width:560,height:720});await delay(150)
 fs.writeFileSync(path.join(root,'inspector.png'),(await inspector.webContents.capturePage()).toPNG());console.log('SCREENSHOT '+path.join(root,'inspector.png'))
 await click('[data-inspect-action="continue"]');await until(()=>evaluate("document.querySelector('.run-status')?.textContent==='本轮已结束'"),'finished')
 assert.equal(executed.length,2);await until(()=>evaluate("document.querySelector('.ai-output').textContent.includes('测试已完成')"),'output synced')
 await send();await until(()=>evaluate("!!document.querySelector('textarea[aria-label=\"暂停调用入参\"]')"),'next round pause')
 await evaluate("[...document.querySelectorAll('.execution-inspector button')].find(b=>b.textContent==='停止对话').click()")
 await until(()=>service.chats.size===0,'stop releases pause');assert.equal(executed.length,2)
 await mainEval("document.querySelector('[aria-label=\"打开工作区菜单\"]').click()")
 await until(()=>mainEval("!!document.querySelector('[aria-label=\"更多菜单\"]')"),'workspace navigation')
 await mainEval("document.querySelector('[aria-label=\"更多菜单\"]').click()")
 await mainEval("[...document.querySelectorAll('.settings-more-menu button')].find(b=>b.textContent.trim()==='应用设置').click()")
 await until(()=>mainEval("!!document.querySelector('input[aria-label=\"显示执行检查器\"]')"),'settings')
 await mainEval("document.querySelector('input[aria-label=\"显示执行检查器\"]').click()")
 await until(()=>!surface(),'toggle closes native window')
 await mainEval("document.querySelector('.page-intro .primary-button').click()")
 await until(()=>!service.studioSettings().showExecutionInspector,'toggle persisted')
 console.log('PASS native inspector auto-open, owner delegation, pause/edit/step/stop, close/reopen draft, live output and settings')
 }catch(error){console.error(error);console.error('ACTIVE',JSON.stringify([...service?.chats||[]].map(([id,chat])=>({id,owner:chat.owner,state:service.inspectors.get(id)?.snapshot()}))));console.error('OWNERS',JSON.stringify([...service?.inspectorOwners||[]]));if(inspector&&!inspector.isDestroyed()){console.error('VIEW',inspector.webContents.id,await inspector.webContents.executeJavaScript("window.myplane.inspectorSnapshot()"));console.error(await inspector.webContents.executeJavaScript("document.body.innerText"));}process.exitCode=1}
 finally{clearTimeout(watchdog);app.removeAllListeners('window-all-closed');for(const win of BrowserWindow.getAllWindows())win.destroy();await service?.dispose();server?.close();app.exit(process.exitCode||0)}
}
void main()
