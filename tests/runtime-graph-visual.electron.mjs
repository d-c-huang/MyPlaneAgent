import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

// Native visual/performance regression with actual application IPC and synthetic,
// deterministic task records. No external model or user data is used.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-graph-visual-'))
process.env.MYPLANE_AGENT_DATA_DIR=root
process.env.MYPLANE_AGENT_TEST_MODE='1'
delete process.env.VITE_DEV_SERVER_URL
app.setAppPath(path.resolve('.'))
const screenshots=[],consoleErrors=[],runs=new Map()
let service,mainWindow,graphWindow
let contextRestoration='not-run'
const original=LocalAiStudioService.prototype.runtimeGraphSnapshot
LocalAiStudioService.prototype.runtimeGraphSnapshot=function(...args){service=this;return original.apply(this,args)}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const js=code=>graphWindow.webContents.executeJavaScript(code,true)
const mainJs=code=>mainWindow.webContents.executeJavaScript(code,true)
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const surface=()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('surface=runtime-graph'))
const stats=()=>js(`({...document.querySelector('.graph-canvas').dataset})`)
async function until(check,label){
 const deadline=Date.now()+18000
 while(!await check()){
  if(Date.now()>deadline)throw Error('Visual regression timeout: '+label)
  await delay(60)
 }
}
async function panel(action,open){
 const selector=`[data-graph-action="${action}"]`
 const expanded=await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`)
 if((expanded==='true')!==open)await click(selector)
 await delay(220)
}
async function capture(name){
 // Scope and panel changes animate the camera; capture the settled view.
 await delay(650)
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
 const file=path.join(root,name+'.png')
 fs.writeFileSync(file,(await graphWindow.webContents.capturePage()).toPNG())
 screenshots.push(file);console.log('SCREENSHOT '+file)
}
async function hoverModel(id){
 const box=await js(`(()=>{const r=document.querySelector('[data-graph-canvas]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
 for(const [x,y] of [[.5,.5],[.5,.44],[.5,.56],[.45,.5],[.55,.5],[.5,.38],[.5,.62]]){
  graphWindow.webContents.sendInputEvent({type:'mouseMove',x:Math.round(box.x+box.width*x),y:Math.round(box.y+box.height*y)})
  await delay(180)
  if((await stats()).hoveredNode===id)return
 }
 throw Error('Focused model cannot be hovered through its canvas: '+id)
}
function fixture(count,title){
 const session=service.newSession(),now=new Date().toISOString()
 session.title=title
 const items=Array.from({length:count},(_,index)=>({
  id:'step-'+index,title:`${String(index+1).padStart(2,'0')} · ${['检查项目结构','实现交互与布局','验证界面与结果'][index%3]}`,
  mode:['read','write','verify'][index%3],status:index%7===0?'blocked':index%4===0?'running':index%3===0?'pending':'complete',
  attempts:1,summary:'来自真实任务结构的确定性视觉夹具',acceptance:'结果需要经过工具记录核验',evidenceIds:[],dependsOn:index?['step-'+(index-1)]:[],
  worker:{id:'fixture-worker-'+index,mode:['read','write','verify'][index%3],assignedAt:now,startedAt:now,toolCalls:2,modelRequests:3,tokens:1200+index*50},
 }))
 session.taskPlan={taskId:'visual-'+randomUUID(),workspace:session.defaultWorkspace.path,updatedAt:now,items}
 const toolActivity=items.flatMap((item,index)=>['read_file','write_file'].map((capability,tool)=>({
  id:`fixture-${index}-${tool}`,capability:'agent.'+capability,workerId:item.worker.id,args:{path:`src/panel-${index}.vue`},
  status:item.status==='running'&&tool===1?'running':'complete',output:tool?'已保存修改':'已读取文件',
 })))
 session.messages.push({id:randomUUID(),role:'assistant',content:'已完成初始检查，正在更新界面。',createdAt:now,status:'complete',toolActivity})
 service.saveSession(session)
 return session
}
async function start(session){
 const requestId=randomUUID()
 await service.startChat({sessionId:session.id,requestId,model:'visual-fixture',text:'继续当前任务'},mainWindow.webContents)
 return runs.get(requestId)
}
async function open(session){
 await mainJs(`window.myplane.runtimeGraphWindow('open',${JSON.stringify(session.id)})`)
 await until(()=>surface(),'graph window')
 graphWindow=surface()
 await until(()=>js(`document.querySelector('.graph-stage-heading h2')?.textContent===${JSON.stringify(session.title)}&&!!document.querySelector('[data-graph-canvas]')`).catch(()=>false),'selected fixture '+session.title)
 await until(async()=>Number((await stats()).frameCount)>1,'renderer diagnostics')
}
async function select(id){
 await panel('objects',true)
 await click(`[data-object-id="${id}"]`)
 await until(()=>js(`document.querySelector('[data-node-id=${JSON.stringify(id)}]')?.getAttribute('aria-pressed')==='true'`),'selection '+id)
}
async function main(){
 const watchdog=setTimeout(()=>{console.error('graph visual regression watchdog');app.exit(1)},150000)
 try{
  await import('../dist-electron/main/index.js')
  await app.whenReady();app.removeAllListeners('window-all-closed')
  await until(()=>BrowserWindow.getAllWindows().length,'main window')
  mainWindow=BrowserWindow.getAllWindows()[0]
  await until(()=>mainJs(`!!document.querySelector('[aria-label="打开 3D 运行视图"]')`).catch(()=>false),'graph launcher')
  await mainJs(`window.myplane.runtimeGraphWindow('open')`)
  await until(()=>surface(),'first graph window');graphWindow=surface()
  graphWindow.webContents.on('console-message',event=>{if(event.level==='error')consoleErrors.push(event.message)})
  await until(()=>service&&js(`!!document.querySelector('[data-graph-canvas]')`).catch(()=>false),'initial WebGL scene')
  service.saveStudioSettings({source:'external',endpoint:'http://127.0.0.1:1/v1',model:'visual-fixture',showExecutionInspector:false})
  service.generate=async(session,_connection,_settings,signal,emit,requestId)=>{
   let release
   const gate=new Promise(resolve=>{release=resolve})
   const run={session,signal,emit,requestId,release}
   runs.set(requestId,run)
   emit({type:'task-plan',requestId,plan:session.taskPlan})
   signal.addEventListener('abort',release,{once:true})
   await gate
   emit({type:'finished',requestId,session})
  }
  const small=fixture(3,'节点工作室 · 任务与智能体'),smallRun=await start(small)
  await open(small)
  await panel('objects',true);await panel('details',true)
  await click('[data-graph-action="fit"]');await delay(900)
  const overview=await stats()
  assert.equal(Number(overview.nodes),17,'three tasks and their real workers/tool records')
  await capture('overview')
  await select('worker:fixture-worker-0')
  await click('[data-graph-action="related"]')
  await until(async()=>(await stats()).scope==='related','related scope')
  const scoped=await stats()
  assert.ok(Number(scoped.visibleNodes)>1&&Number(scoped.visibleNodes)<Number(scoped.nodes),'selection scope contains only its graph neighborhood')
  await capture('related-worker')
  await click('[aria-label="显示Worker"]')
  await until(async()=>(await stats()).scope==='all','hiding the related anchor restores the whole graph')
  assert.equal(await js(`document.querySelector('[data-graph-action="related"]').getAttribute('aria-pressed')`),'false','related control reflects its removed anchor')
  assert.equal((await stats()).view,'overview','hidden related anchor does not leave an empty closeup')
  await click('[aria-label="显示Worker"]')
  await until(async()=>Number((await stats()).nodes)===17,'worker models restored')
  for(const [kind,id] of [['agent','agent:step-0'],['worker','worker:fixture-worker-0'],['task','task:step-0'],['tool','tool:worker:fixture-worker-0:agent.write_file']]){
   await select(id);await click('[data-graph-action="focus"]')
   await until(async()=>(await stats()).view==='detail','model focus '+kind)
   await delay(850)
   assert.equal(Number((await stats()).visibleNodes),1,'detail view isolates the selected model')
   const label=await js(`(()=>{const el=document.querySelector('[data-node-id=${JSON.stringify(id)}]'),r=el.getBoundingClientRect(),c=document.querySelector('.graph-canvas').getBoundingClientRect();return {visible:getComputedStyle(el).visibility,inside:r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom}})()`)
   assert.equal(label.visible,'visible','selected label remains visible')
   assert.equal(label.inside,true,'selected label fits in its viewport')
   if(kind==='agent')await hoverModel(id)
   await capture('detail-'+kind)
  }
  await click('[aria-label="显示工具"]')
  await until(async()=>(await stats()).view==='overview','hiding a focused tool returns the camera to the graph')
  assert.ok(Number((await stats()).visibleNodes)>1,'remaining models are visible after hiding the focused model')
  await click('[aria-label="显示工具"]')
  await until(async()=>Number((await stats()).nodes)===17,'tools restored after detail filter')
  await click('[data-graph-action="fit"]');await delay(900)
  const hoverId='agent:step-0'
  await js(`document.querySelector('[data-node-id=${JSON.stringify(hoverId)}]').dispatchEvent(new PointerEvent('pointerenter'))`)
  await until(async()=>(await stats()).hoveredNode===hoverId,'label hover highlights the model')
  await js(`document.querySelector('[data-node-id=${JSON.stringify(hoverId)}]').dispatchEvent(new PointerEvent('pointerleave'))`)
  await until(async()=>!(await stats()).hoveredNode,'hover clears')

  await js(`[...document.querySelectorAll('.graph-topbar button')].find(button=>button.textContent==='暂停刷新').click()`)
  await until(async()=>(await stats()).animation==='paused','pause stops model animation')
  assert.equal(smallRun.signal.aborted,false,'pausing the view does not stop execution')
  await delay(800)
  const pausedFrames=(await stats()).frameCount
  await delay(450)
  assert.equal((await stats()).frameCount,pausedFrames,'paused view stops drawing once controls settle')
  await js(`[...document.querySelectorAll('.graph-topbar button')].find(button=>button.textContent==='继续刷新').click()`)
  await until(async()=>(await stats()).animation!=='paused','resume animation')

  graphWindow.setSize(900,680)
  await panel('objects',false);await panel('details',false);await panel('events',false)
  await click('[data-graph-action="fit"]');await delay(1000)
  const viewport=await js(`(()=>{const c=document.querySelector('.graph-canvas').getBoundingClientRect();return {canvas:c.width,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,toolbar:document.querySelector('.graph-topbar').scrollWidth>document.querySelector('.graph-topbar').clientWidth}})()`)
  assert.ok(viewport.canvas>=viewport.viewport*.8,'collapsed panels give the narrow window its drawing space')
  assert.equal(viewport.overflow,false,'narrow window has no page overflow')
  assert.equal(viewport.toolbar,false,'narrow toolbar stays inside the window')
  await capture('narrow-canvas')
  await panel('objects',true);await panel('details',true);await panel('events',true)
  await capture('narrow-controls')

  graphWindow.setSize(1380,900)
  const large=fixture(25,'并行任务 · 127 个运行对象'),largeRun=await start(large)
  await open(large);await panel('objects',true);await panel('details',false);await panel('events',false)
  await click('[data-graph-action="fit"]');await delay(1200)
  assert.equal(Number((await stats()).nodes),127,'large graph has no synthetic or missing nodes')
  assert.equal(await js(`document.querySelectorAll('.runtime-node-label').length`),127,'labels match graph identities')
  await capture('large-overview')
  await click('[data-object-filter="active"]')
  assert.equal(await js(`[...document.querySelectorAll('[data-object-id]')].every(row=>row.dataset.status==='running')`),true,'active filter shows running records')
  assert.equal(Number((await stats()).nodes),127,'list filtering preserves the spatial map')
  await click('[data-object-filter="attention"]')
  assert.equal(await js(`[...document.querySelectorAll('[data-object-id]')].every(row=>['waiting','paused','error'].includes(row.dataset.status))`),true,'attention filter finds blocked records')
  await click('[data-object-filter="all"]')
  await js(`(()=>{const input=document.querySelector('[aria-label="搜索对象"]');input.value='fixture-worker-12';input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  assert.ok(await js(`document.querySelectorAll('[data-object-id]').length<127`),'search narrows the list')
  assert.equal(await js(`!!document.querySelector('[data-object-id="worker:fixture-worker-12"]')`),true,'search includes worker instance identity')
  await click('[aria-label="清除对象搜索"]')
  await select('worker:fixture-worker-12');await click('[data-graph-action="related"]');await delay(700)
  assert.ok(Number((await stats()).visibleNodes)<=5,'large graph can isolate a worker and its immediate relationships')
  await capture('large-related')
  await click('[data-graph-action="related"]')
  const warm=await stats()
  assert.ok(Number(warm.geometries)>0&&Number(warm.textures)>0&&Number(warm.drawCalls)>0,'GPU resource telemetry is populated')
  for(let index=0;index<5;index++){
   const plan=largeRun.session.taskPlan
   plan.items[12].status=index%2?'complete':'running';plan.updatedAt=new Date().toISOString()
   largeRun.emit({type:'task-plan',requestId:largeRun.requestId,plan})
   await delay(1100)
  }
  const after=await stats()
  assert.ok(Number(after.geometries)<=Number(warm.geometries)+2,'status-only refreshes do not accumulate geometries')
  assert.ok(Number(after.textures)<=Number(warm.textures)+2,'status-only refreshes do not accumulate textures')
  assert.equal(await js(`document.querySelectorAll('[data-graph-canvas]').length`),1,'updates retain one renderer')
  assert.equal(await js(`!!document.querySelector('.graphics-error')`),false,'large graph retains its WebGL context')
  await click('[aria-label="显示工具"]')
  await until(async()=>Number((await stats()).nodes)===77,'kind filter removes only tool models')
  await click('[aria-label="显示工具"]')
  await until(async()=>Number((await stats()).nodes)===127,'kind filter restores tool models')
  await delay(1200)
  const recreated=await stats()
  assert.ok(Number(recreated.geometries)<=Number(warm.geometries)+2,'recreated tools release their previous resources')
  assert.ok(Number(recreated.textures)<=Number(warm.textures)+2,'recreated tools release their previous textures')

  const canLoseContext=await js(`(()=>{const canvas=document.querySelector('[data-graph-canvas]'),gl=canvas.getContext('webgl2');window.__graphContextTest=gl?.getExtension('WEBGL_lose_context');return !!window.__graphContextTest})()`)
  if(canLoseContext){
   const beforeLoss=Number((await stats()).frameCount)
   await js(`window.__graphContextTest.loseContext()`)
   await until(()=>js(`!!document.querySelector('.graphics-error')`),'context loss exposes a recoverable error')
   assert.equal(await js(`document.querySelectorAll('[data-object-id]').length`),127,'object navigation survives context loss')
   await delay(500)
   await js(`window.__graphContextTest.restoreContext()`)
   await until(()=>js(`!document.querySelector('.graphics-error')`),'context restores its environment')
   await until(async()=>Number((await stats()).frameCount)>beforeLoss,'rendering resumes after context restoration')
   assert.equal(Number((await stats()).nodes),127,'restoration preserves the topology')
   assert.equal(await js(`document.querySelectorAll('[data-graph-canvas]').length`),1,'restoration reuses its single canvas')
   assert.ok(Number((await stats()).drawCalls)>0,'restored context renders its models')
   await capture('restored-context')
   await js(`delete window.__graphContextTest`)
   contextRestoration='passed'
  }else{contextRestoration='unsupported';console.log('SKIP: WEBGL_lose_context is not exposed by this GPU')}

  graphWindow.close();await until(()=>!surface(),'close observer')
  assert.equal(largeRun.signal.aborted,false,'closing the observer leaves active task intact')
  await open(large);await delay(1200)
  assert.equal(await js(`document.querySelectorAll('[data-graph-canvas]').length`),1,'reopening creates one fresh renderer')
  assert.equal(Number((await stats()).nodes),127)
  assert.equal(await js(`!!document.querySelector('.graphics-error')`),false)
  assert.deepEqual(consoleErrors.filter(error=>/WebGL|THREE|ResizeObserver|Uncaught|Vue warn/i.test(error)),[])
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,screenshots,contextRestoration,resources:{warm,after,recreated},checks:['four detailed model families','related topology focus','hidden related anchor restores overview','hidden focused tool restores overview','label hover','pause/resume without cancellation','narrow canvas and panel controls','127 real graph objects','stable resources under live status updates','filter teardown/recreate','window teardown/reopen']},null,2))
  console.log('PASS: native 3D visual regression, related focus, responsive controls, hover, paused animation, large topology and stable GPU resources')
 }catch(error){
  console.error(error);process.exitCode=1
  if(graphWindow&&!graphWindow.isDestroyed()){try{await capture('failure');console.error(await js('document.body.innerText'));console.error(await stats())}catch{}}
 }finally{
  for(const run of runs.values())run.release()
  clearTimeout(watchdog);app.removeAllListeners('window-all-closed')
  for(const window of BrowserWindow.getAllWindows())window.destroy()
  await service?.dispose();app.exit(process.exitCode||0)
 }
}
main()
