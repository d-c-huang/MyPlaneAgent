import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'
import {AgentWorkspace} from '../dist-electron/main/agent/workspace.js'
import {sessionContextState} from '../dist-electron/main/agent/context-state.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-chat-workspace-'))
app.setPath('userData',path.join(root,'profile'))
app.disableHardwareAcceleration()

async function main(){
 await app.whenReady()
 const window=new BrowserWindow({show:false})
 const data=path.join(root,'data')
 let service=new LocalAiStudioService(data)
 try{
  service.saveStudioSettings({source:'external',endpoint:'http://127.0.0.1:1/v1',model:'fixture-model'})
  async function run(session,input={}){
   let captured,writing
   // Exercise the real entry point and file writer, without a provider or network.
   service.generate=async(current,_connection,_settings,signal,_emit,_requestId,_compact,options)=>{
    captured=options
    writing=(async()=>{
     const workspace=new AgentWorkspace(options.workspace)
     const action=await workspace.prepare('write_file',{path:'output/result.txt',content:current.id})
     await action.execute(signal)
     assert.equal(workspace.read('output/result.txt'),current.id)
    })()
    await writing
   }
   await service.startChat({requestId:randomUUID(),sessionId:session.id,model:'fixture-model',text:'生成测试文件',...input},window.webContents)
   await writing
   // Let startChat's finally clear its active-run guard.
   await new Promise(resolve=>setImmediate(resolve))
   assert.equal(captured.filesEnabled,true)
   assert.equal(captured.approvalMode,'ask')
   return captured
  }
  const first=service.newSession(),second=service.newSession()
  const expected=path.join(data,'cache','tasks',first.id)
  assert.deepEqual(first.defaultWorkspace,{kind:'cache',path:expected})
  assert.notEqual(first.defaultWorkspace.path,second.defaultWorkspace.path)
  const pinned=sessionContextState(first,[])
  assert.equal(pinned.permissions.workspace,expected)
  assert.equal(pinned.permissions.filesEnabled,true)
  const options=await run(first)
  assert.equal(options.workspace,expected)
  assert.equal(options.initializeLocalGit,false)
  assert.equal(fs.existsSync(path.join(second.defaultWorkspace.path,'output/result.txt')),false)
  assert.equal(fs.existsSync(path.join(data,'output/result.txt')),false)

  // Old records need no destructive migration; forged saved paths are ignored.
  const file=service.sessionFile(first.id),legacy=JSON.parse(fs.readFileSync(file,'utf8'))
  delete legacy.defaultWorkspace
  fs.writeFileSync(file,JSON.stringify(legacy))
  assert.equal(service.session(first.id).defaultWorkspace.path,expected)
  legacy.defaultWorkspace={kind:'project',path:os.homedir()}
  fs.writeFileSync(file,JSON.stringify(legacy))
  assert.deepEqual(service.session(first.id).defaultWorkspace,{kind:'cache',path:expected})
  await service.dispose()
  service=new LocalAiStudioService(data)
  assert.equal(service.session(first.id).defaultWorkspace.path,expected)
  assert.equal(fs.readFileSync(path.join(expected,'output/result.txt'),'utf8'),first.id)
  await run(service.session(first.id))
  const toolsCache=await service.dispatch('getDefaultWorkspace',undefined,{sender:window.webContents})
  assert.equal(toolsCache,path.join(data,'cache','tools'))
  assert.ok(fs.statSync(toolsCache).isDirectory())

  const projectPath=path.join(root,'project'),selectedPath=path.join(root,'selected')
  fs.mkdirSync(projectPath);fs.mkdirSync(selectedPath)
  const project=service.agent.createProject(projectPath,'显式项目')
  const attached=service.updateSession({id:second.id,projectId:project.id})
  assert.deepEqual(attached.defaultWorkspace,{kind:'project',path:projectPath})
  assert.equal((await run(attached)).workspace,projectPath)
  const token=randomUUID()
  service.agentWorkspaces.set(token,{owner:window.webContents.id,path:selectedPath})
  assert.equal((await run(attached,{workspaceToken:token})).workspace,selectedPath)
  await assert.rejects(service.startChat({requestId:randomUUID(),sessionId:second.id,workspaceToken:'expired',model:'fixture-model',text:'test'},window.webContents),/授权已失效/)
  const detached=service.updateSession({id:second.id,projectId:''})
  assert.equal((await run(detached)).workspace,second.defaultWorkspace.path)
  assert.equal(fs.readFileSync(path.join(expected,'output/result.txt'),'utf8'),first.id)

  const linked=service.newSession(),outside=path.join(root,'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside,linked.defaultWorkspace.path,process.platform==='win32'?'junction':'dir')
  await assert.rejects(service.startChat({requestId:randomUUID(),sessionId:linked.id,model:'fixture-model',text:'test'},window.webContents),/符号链接/)
  assert.deepEqual(fs.readdirSync(outside),[])
  fs.unlinkSync(linked.defaultWorkspace.path)
  console.log('PASS: isolated session caches, real generated files, legacy sessions and restart, project/selected-folder priority, permission mode, path validation, tools cache')
 }finally{
  window.destroy();await service.dispose()
  // Keep the isolated temp fixture, like the other Electron integration tests:
  // Windows can retain handles until the Electron process has exited.
 }
}
void main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
