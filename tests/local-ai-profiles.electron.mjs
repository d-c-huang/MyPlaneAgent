import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'node:net'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-profiles-'))
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function run(){
 await app.whenReady()
 const service=new LocalAiStudioService(root)
 const window=new BrowserWindow({show:false})
 try{
  assert.equal(service.studioSettings().appearanceStyle,'minimal')
  service.saveStudioSettings({appearanceStyle:'ocean'})
  assert.equal(service.studioSettings().appearanceStyle,'ocean')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'local-ai-studio-settings.json'),'utf8')).appearanceStyle,'ocean')
  service.saveStudioSettings({endpoint:'https://first.example/v1',model:'first-model',apiKey:'secret-one'})
  const migrated=service.remoteProfiles();assert.equal(migrated.length,1);assert.equal(migrated[0].hasApiKey,true)
  const created=service.remoteProfileSave({name:'第二个服务',apiFormat:'anthropic',endpoint:'https://second.example/v1',model:'second-model',contextLength:65536,apiKey:'secret-two'})
  assert.equal(created.settings.endpoint,'https://second.example/v1');assert.equal(created.profiles.length,2)
  const second=created.profiles.find(profile=>profile.name==='第二个服务');assert.equal(second.apiFormat,'anthropic');assert.equal(second.contextLength,65536)
  const updated=service.remoteProfileSave({id:second.id,name:'第二个服务（已修改）',apiFormat:'openai',endpoint:'https://changed.example/v1',model:'changed-model',contextLength:32768})
  assert.equal(updated.profiles.length,2);assert.equal(updated.profiles.find(profile=>profile.id===second.id).name,'第二个服务（已修改）');assert.equal(updated.profiles.find(profile=>profile.id===second.id).model,'changed-model')
  const stored=fs.readFileSync(path.join(root,'local-ai-remote-profiles.json'),'utf8');assert.doesNotMatch(stored,/secret-one|secret-two/)
  const switched=service.remoteProfileUse(migrated[0].id);assert.equal(switched.settings.endpoint,'https://first.example/v1');assert.equal(switched.settings.model,'first-model');assert.equal(switched.settings.hasApiKey,true)
  const remaining=service.remoteProfileDelete(second.id);assert.equal(remaining.length,1)
  service.saveStudioSettings({source:'external',contextLength:1000000,endpoint:'https://api.deepseek.com',model:'deepseek-flash'})
  const remoteBudget=service.remoteProfiles().find(profile=>profile.endpoint==='https://api.deepseek.com');assert.equal(remoteBudget.contextLength,1000000)
  service.saveStudioSettings({source:'managed',contextLength:8192})
  assert.equal(service.studioSettings().contextLength,8192)
  assert.equal(service.remoteProfiles().find(profile=>profile.id===remoteBudget.id).contextLength,1000000)
  service.saveStudioSettings({source:'external'})
  assert.equal(service.studioSettings().contextLength,1000000)
  service.saveStudioSettings({managedContextLength:16384})
  assert.equal(service.studioSettings().contextLength,1000000)
  assert.equal(service.studioSettings().managedContextLength,16384)
  assert.equal(service.remoteProfiles().find(profile=>profile.id===remoteBudget.id).contextLength,1000000)
  service.saveStudioSettings({managedContextLength:8192})
  service.saveStudioSettings({source:'managed'})
  assert.equal(service.studioSettings().contextLength,8192)
  await service.dispatch('remoteProfileSave',{id:remoteBudget.id,name:'DeepSeek',apiFormat:'openai',endpoint:'https://api.deepseek.com',model:'deepseek-flash',contextLength:1000000},{sender:window.webContents})
  await service.dispatch('remoteProfileUse',{id:remoteBudget.id},{sender:window.webContents})
  assert.equal(service.studioSettings().source,'managed')
  assert.equal(service.studioSettings().contextLength,8192)
  assert.equal(service.remoteProfiles().find(profile=>profile.id===remoteBudget.id).contextLength,1000000)
  const restored=new LocalAiStudioService(root)
  try{
   assert.equal(restored.studioSettings().contextLength,8192)
   restored.saveStudioSettings({source:'external'})
   assert.equal(restored.studioSettings().contextLength,1000000)
  }finally{await restored.dispose()}
  service.saveStudioSettings({runtimePort:await freePort()});await service.startApiServer();assert.equal(service.studioSettings().source,'managed')
  service.saveStudioSettings({source:'external'});assert.equal(service.studioSettings().source,'external');assert.equal(service.snapshot().runtime.endpoint.startsWith('http://127.0.0.1:'),true)
  service.saveStudioSettings({source:'managed'});assert.equal(service.studioSettings().source,'managed')
  console.log(JSON.stringify({ok:true,checks:['persists visual style','migrates current remote settings','stores protocol and context budget','updates a named profile without adding history','stores encrypted key references only','switches profiles','deletes history','isolates local and remote context budgets across switches and restart','switches inference source while local API keeps running']}))
 }finally{window.destroy();await service.dispose()}
 app.exit(0)
}
void run().catch(error=>{console.error(error);app.exit(1)})
