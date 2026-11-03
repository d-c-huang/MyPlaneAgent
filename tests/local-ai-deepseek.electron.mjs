import {app} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {LocalAiStudioService} from '../dist-electron/main/local-ai-studio.js'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-deepseek-'))
let service
const applicationLogs=[]
const originalFetch=globalThis.fetch
async function main(){try{
 await app.whenReady()
 fs.writeFileSync(path.join(root,'local-ai-settings.json'),JSON.stringify({endpoint:'https://api.deepseek.com',model:'deepseek-flash',maxTokens:2048,encryptedApiKey:'',encryptedHfToken:'',downloadDirectory:path.join(root,'models')}))
 fs.writeFileSync(path.join(root,'local-ai-studio-settings.json'),JSON.stringify({source:'external',contextLength:134096}))
 service=new LocalAiStudioService(root,(level,scope,message)=>applicationLogs.push({level,scope,message}))
 assert.equal(service.studioSettings().maxTokens,65536)
 assert.equal(service.studioSettings().contextLength,1000000)
 assert.match((await service.connect('startup')).error,/API Key/)
 assert.ok(applicationLogs.some(entry=>entry.scope==='remote-service'&&entry.message.includes('原因=startup')&&entry.message.includes('验证失败')))
 // Fake credentials and transport: no billable calls or OS credential changes.
 service.service=()=>({apiFormat:'openai',endpoint:'https://api.deepseek.com',key:'test-key'})
 assert.doesNotMatch(JSON.stringify(service.operationAudit('settings',{apiKey:'test-key',systemPrompt:'private prompt',model:'deepseek-flash'})),/test-key|private prompt/)
 assert.doesNotMatch(JSON.stringify(service.operationAudit('developerRequest',{route:'models',body:{apiKey:'test-key',prompt:'private prompt'}})),/test-key|private prompt/)
 const requests=[]
 globalThis.fetch=async(url,init)=>{
  requests.push(url)
  assert.equal(init.headers.Authorization,'Bearer test-key')
  if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-flash'},{id:'deepseek-v4-pro'}]})
  const body=JSON.parse(init.body)
  assert.equal(body.model,'deepseek-flash')
  assert.equal(body.max_tokens,65536)
  assert.equal(body.repeat_penalty,undefined)
  assert.deepEqual(body.thinking,{type:'disabled'})
  const reviewing=body.messages.some(message=>message.role==='system'&&message.content?.includes('你是任务完成检查器。'))
  const delta=reviewing?{content:JSON.stringify({status:'complete',reason:'已回应用户问候',nextStep:''})}:{content:'连接成功',reasoning_content:'思考'}
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }
 const connection=await service.connect()
 assert.equal(connection.provider,'deepseek')
 assert.equal(connection.models.length,2)
 assert.deepEqual(requests,['https://api.deepseek.com/models'])
 assert.doesNotMatch(JSON.stringify(applicationLogs),/test-key/)
 const session=service.newSession()
 session.model='deepseek-flash'
 session.messages.push({id:'user-1',role:'user',content:'你好',createdAt:new Date().toISOString()})
 await service.generate(session,service.service(),service.studioSettings(),new AbortController().signal,()=>{},'test',false,{
  workspace:root,filesEnabled:false,webEnabled:false,approvalMode:'ask',approve:async()=>false,
 })
 assert.equal(session.messages.at(-1).status,'complete',session.messages.at(-1).error)
 assert.equal(session.messages.at(-1).content,'连接成功')
 assert.equal(session.messages.at(-1).reasoning,'思考')
 assert.equal(session.messages.at(-1).outcome,'complete')
 assert.equal(requests.filter(url=>url.endsWith('/chat/completions')).length,2)
 assert.equal(session.usage.totalTokens,30)
 const config=JSON.parse(fs.readFileSync(path.join(root,'local-ai-settings.json'),'utf8'))
 config.encryptedApiKey='fake-old-encrypted-key'
 fs.writeFileSync(path.join(root,'local-ai-settings.json'),JSON.stringify(config))
 service.saveStudioSettings({endpoint:'http://127.0.0.1:1234/v1'})
 assert.equal(service.settings().hasApiKey,false)
 console.log('PASS DeepSeek connection, streaming chat, usage, endpoint key isolation')
}catch(error){console.error(error);process.exitCode=1}finally{
 globalThis.fetch=originalFetch
 await service?.dispose()
 fs.rmSync(root,{recursive:true,force:true})
 app.exit(Number(process.exitCode)||0)
}

}
void main()
