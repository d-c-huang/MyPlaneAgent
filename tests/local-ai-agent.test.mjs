import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import {estimateTokens} from '../dist-electron/main/local-ai-context.js'
import {AgentWorkspace} from '../dist-electron/main/agent/workspace.js'
import {extractDocument,makeDocument,makeSpreadsheet} from '../dist-electron/main/agent/documents.js'
import {LocalAgentService} from '../dist-electron/main/agent/service.js'
import {requestAgentModel,agentModelTiming,llamaToolDefinitions,ModelResponseSizeError} from '../dist-electron/main/agent/model.js'
import {isolatedGitWorkspace} from './helpers/workspace.mjs'
const signal=()=>new AbortController().signal
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check,label='condition'){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error('Timed out: '+label);await pause(10)}}
function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-agent-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
const call=(name,args)=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}})
const response=(content,tool_calls)=>({choices:[{finish_reason:tool_calls?'tool_calls':'stop',message:{role:'assistant',content,tool_calls}}]})

test('llama tool schemas omit grammar-only limits while preserving execution structure',()=>{
 const [definition]=llamaToolDefinitions([{type:'function',function:{name:'write',description:'write',parameters:{type:'object',properties:{changes:{type:'array',maxItems:20,items:{type:'object',properties:{before:{type:'string',minLength:1,maxLength:2000000,pattern:'^x$'}},required:['before'],additionalProperties:false}}},required:['changes'],additionalProperties:false}}}])
 const parameters=definition.function.parameters
 assert.deepEqual(parameters,{type:'object',properties:{changes:{type:'array',items:{type:'object',properties:{before:{type:'string'}},required:['before'],additionalProperties:false}}},required:['changes'],additionalProperties:false})
})

test('deleting an agent conversation removes its task and audit records',t=>{
 const root=sandbox(t),directory=path.join(root,'tasks'),service=new LocalAgentService(directory,()=>{throw new Error('not needed')})
 const id=randomUUID(),task={id,title:'待删除会话',workspace:root,mode:'coding',model:'fixture',status:'completed',steps:0,maxSteps:10,plan:[],events:[],artifacts:[],messages:[],error:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
 fs.mkdirSync(path.join(directory,'audit'),{recursive:true});fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(task));fs.writeFileSync(path.join(directory,'audit',id+'.jsonl'),'audit')
 service.delete(id)
 assert.equal(service.list().length,0);assert.equal(fs.existsSync(path.join(directory,id+'.json')),false);assert.equal(fs.existsSync(path.join(directory,'audit',id+'.jsonl')),false)
 assert.throws(()=>service.delete(id),/不存在|损坏/)
})
async function harness(t,reply,connection,isolatedGit=false){
 const root=isolatedGit?isolatedGitWorkspace('myplane-agent-test-'):sandbox(t),workspace=path.join(root,'project');fs.mkdirSync(workspace);let requests=0
 if(isolatedGit)t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;try{const result=await reply(JSON.parse(raw),requests++);if(result?.sse){res.setHeader('Content-Type','text/event-stream');res.end(result.sse)}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))}}catch(error){res.writeHead(500);res.end(String(error))}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 const service=new LocalAgentService(path.join(root,'tasks'),()=>({endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:16384,...connection}));t.after(()=>service.dispose())
 const events=[];return {root,workspace,service,events,start:(extra={})=>service.start({workspace,mode:'coding',model:'fixture-model',prompt:'检查并修复项目',maxSteps:10,...extra},7,event=>events.push(event))}
}

test('project tasks initialize local Git before model execution, including resumed tasks',async t=>{
 const h=await harness(t,()=>{
  assert.equal(fs.existsSync(path.join(h.workspace,'.git')),true)
  return response('已检查项目')
 },undefined,true)
 const task=h.start()
 await until(()=>h.service.get(task.id).status==='completed')
 const config=fs.readFileSync(path.join(h.workspace,'.git','config'),'utf8')
 assert.match(config,/localHistory = true/)
 assert.doesNotMatch(config,/\[remote /)
 fs.rmSync(path.join(h.workspace,'.git'),{recursive:true,force:true})
 h.start({taskId:task.id,prompt:'继续检查'})
 await until(()=>h.service.get(task.id).status==='completed')
 assert.equal(fs.existsSync(path.join(h.workspace,'.git')),true)
})

test('fast Agent mode disables local thinking and caps each model round',async t=>{
 const bodies=[],h=await harness(t,body=>{bodies.push(body);return response('完成')},{maxTokens:65536,contextLength:131072,localLlama:true})
 const fast=h.start();await until(()=>!h.service.active(fast.id));assert.equal(bodies[0].max_tokens,8192);assert.deepEqual(bodies[0].chat_template_kwargs,{enable_thinking:false})
 const deep=h.start({fastMode:false});await until(()=>!h.service.active(deep.id));assert.equal(bodies[1].max_tokens,65536);assert.deepEqual(bodies[1].chat_template_kwargs,{enable_thinking:true})
})

test('Agent modes expose focused built-ins while retaining mode-relevant tools',async t=>{
 const seen=[],h=await harness(t,body=>{seen.push(body.tools?.map(tool=>tool.function.name)||[]);return response('完成')})
 const documents=h.start({mode:'documents',prompt:'读取扫描图片 OCR 和 ZIP 压缩包并生成报告'});await until(()=>!h.service.active(documents.id));assert.ok(seen[0].length<=16);assert.ok(seen[0].includes('image_ocr'));assert.ok(seen[0].includes('create_document'));assert.ok(seen[0].includes('archive_inspect'));assert.ok(!seen[0].includes('find_symbol'))
 const general=h.start({mode:'general',prompt:'检查 Git 提交历史和 blame，并运行指定测试'});await until(()=>!h.service.active(general.id));assert.ok(seen[1].length<=18);assert.ok(seen[1].includes('run_test_case'));assert.ok(seen[1].includes('git_blame'));assert.ok(seen[1].length<32);assert.equal(h.service.get(general.id).events.some(event=>/未调用工具/.test(event.text)),false)
})

test('Agent can explicitly load a specialized tool pack for the next round',async t=>{
 let round=0
 const h=await harness(t,body=>{const names=body.tools.map(tool=>tool.function.name);if(round++===0){assert.ok(names.includes('load_tool_pack'));assert.ok(!names.includes('http_request'));return response('加载运行时工具。',[call('load_tool_pack',{pack:'runtime'})])}assert.ok(names.includes('http_request'));assert.ok(names.includes('process_status'));assert.ok(names.length<=18);return response('工具包已加载。')})
 const task=h.start({prompt:'整理当前项目'});await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'completed')
})

test('workspace rejects traversal, symlinks, hardlinks, secrets and ignored directories',async t=>{
 const root=sandbox(t),workspace=path.join(root,'project');fs.mkdirSync(workspace);fs.writeFileSync(path.join(root,'secret.txt'),'secret');fs.writeFileSync(path.join(workspace,'normal.txt'),'hello');const tools=new AgentWorkspace(workspace)
 for(const file of ['../secret.txt','sub/../../secret.txt','/etc/passwd','C:/secret','sub\\x','.env','.env.local','.ssh/id_rsa','node_modules/x','.git/config','private.pem'])assert.throws(()=>tools.resolve(file,true))
 if(process.platform!=='win32'){fs.symlinkSync(root,path.join(workspace,'escape'));assert.throws(()=>tools.resolve('escape/secret.txt'),/符号链接/);fs.linkSync(path.join(root,'secret.txt'),path.join(workspace,'hard.txt'));assert.throws(()=>tools.read('hard.txt'),/硬链接/)}
 assert.equal(tools.read('normal.txt'),'hello')
 const result=JSON.parse(await tools.query('read_file',{path:'normal.txt'},signal()));assert.equal(result.text,'1: hello')
})
test('prepared writes do not mutate before approval and reject concurrent edits',async t=>{
 const root=sandbox(t),tools=new AgentWorkspace(root);fs.writeFileSync(path.join(root,'a.txt'),'original')
 const write=await tools.prepare('write_file',{path:'a.txt',content:'proposed'});assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'original');assert.equal(write.preview.before,'original')
 fs.writeFileSync(path.join(root,'a.txt'),'user edit');await assert.rejects(write.execute(signal()),/确认期间/);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'user edit')
 const create=await tools.prepare('write_file',{path:'new/a.txt',content:'你好'});await create.execute(signal());assert.equal(fs.readFileSync(path.join(root,'new/a.txt'),'utf8'),'你好')
 const controller=new AbortController();controller.abort();const stopped=await tools.prepare('write_file',{path:'no.txt',content:'no'});await assert.rejects(stopped.execute(controller.signal));assert.equal(fs.existsSync(path.join(root,'no.txt')),false)
})
test('exact replacement requires a unique match and preserves surrounding text',async t=>{
 const root=sandbox(t),tools=new AgentWorkspace(root);fs.writeFileSync(path.join(root,'a.ts'),'const count = 1\n// 中文\n')
 const edit=await tools.prepare('replace_text',{path:'a.ts',oldText:'count = 1',newText:'count = 2'});await edit.execute(signal());assert.equal(tools.read('a.ts'),'const count = 2\n// 中文\n')
 await assert.rejects(tools.prepare('replace_text',{path:'a.ts',oldText:'missing',newText:'x'}),/唯一匹配/)
 fs.writeFileSync(path.join(root,'a.ts'),'x x');await assert.rejects(tools.prepare('replace_text',{path:'a.ts',oldText:'x',newText:'y'}),/唯一匹配/)
 fs.writeFileSync(path.join(root,'a.ts'),'end\n}\nend\n}\n')
 const targeted=await tools.prepare('replace_text',{path:'a.ts',oldText:'end\n}',newText:'finish\n}',startLine:3})
 await targeted.execute(signal())
 assert.equal(tools.read('a.ts'),'end\n}\nfinish\n}\n')
 await assert.rejects(tools.prepare('replace_text',{path:'a.ts',oldText:'end\n}',newText:'wrong',startLine:3}),/指定 startLine/)
})
test('search skips dependencies, private files and binary files',async t=>{
 const root=sandbox(t),tools=new AgentWorkspace(root);fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules','a.txt'),'needle');fs.writeFileSync(path.join(root,'.env'),'needle');fs.writeFileSync(path.join(root,'data.bin'),Buffer.from([0,1,2]));fs.writeFileSync(path.join(root,'a.ts'),'hello\nNeedle found')
 const result=JSON.parse(await tools.query('search_files',{query:'needle'},signal()));assert.deepEqual(result.matches,[{path:'a.ts',line:2,text:'Needle found'}]);assert.equal(tools.files().paths.includes('.env'),false)
})
test('Word generation and extraction preserve Chinese, escaping, headings and table cells',async t=>{
 const root=sandbox(t),file=path.join(root,'报告.docx'),data=await makeDocument(file,'验收 & 报告','## 结论\n你好 <world>\n- 待办\n\n| 项目 | 结果 |\n| --- | --- |\n| 构建 | 通过 |')
 fs.writeFileSync(file,data);const zip=await JSZip.loadAsync(data);assert.ok(zip.file('word/styles.xml'));assert.match(await zip.file('word/document.xml').async('string'),/<w:tbl>/)
 const result=JSON.parse(await extractDocument(file,{},signal()));assert.match(result.text,/验收 & 报告/);assert.match(result.text,/你好 <world>/);assert.match(result.text,/构建\n通过/)
 const tools=new AgentWorkspace(root),prepared=await tools.prepare('create_document',{path:'报告.md',title:'报告',content:'## 内容\n完成'});await prepared.execute(signal());assert.match(tools.read('报告.md'),/# 报告/)
})
test('Excel generation uses literal cells and extracts cached values',async t=>{
 const root=sandbox(t),file=path.join(root,'结果.xlsx'),data=await makeSpreadsheet([{name:'任务',rows:[['事项','数量'],['检查',12],['=HYPERLINK("https://invalid")',null]]}]);fs.writeFileSync(file,data)
 const book=new ExcelJS.Workbook();await book.xlsx.load(data);assert.equal(book.worksheets[0].getCell('B2').value,12);assert.equal(typeof book.worksheets[0].getCell('A3').value,'string');assert.equal(book.worksheets[0].views[0].ySplit,1)
 const result=JSON.parse(await extractDocument(file,{},signal()));assert.match(result.text,/检查\t12/);await assert.rejects(makeSpreadsheet([{name:'bad/name',rows:[]}]))
})
function simplePdf(){
 const stream='BT /F1 12 Tf 50 750 Td (Hello Agent PDF) Tj ET',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];let body='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${obj}\nendobj\n`});const xref=Buffer.byteLength(body);body+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(body)
}
test('PDF extraction reads actual page text and reports pagination',async t=>{
 const root=sandbox(t),file=path.join(root,'sample.pdf');fs.writeFileSync(file,simplePdf());const result=JSON.parse(await extractDocument(file,{},signal()));assert.match(result.text,/Hello Agent PDF/);assert.match(result.note,/共 1 页/);await assert.rejects(extractDocument(file,{startPage:2},signal()),/共 1 页/)
})
test('commands return exit codes, output, enforce timeout and abort',async t=>{
 const tools=new AgentWorkspace(sandbox(t)),good=await tools.prepare('run_command',{command:'node -e "console.log(42);process.exit(3)"'}),result=JSON.parse(await good.execute(signal()));assert.equal(result.exitCode,3);assert.match(result.output,/42/)
 const timeout=await tools.prepare('run_command',{command:'node -e "setInterval(()=>{},1000)"',timeoutSeconds:1}),start=Date.now(),timed=JSON.parse(await timeout.execute(signal()));assert.match(timed.error,/超过/);assert.ok(Date.now()-start<5000)
 const controller=new AbortController(),pending=timeout.execute(controller.signal);setTimeout(()=>controller.abort(),60);assert.match(JSON.parse(await pending).error,/停止/)
})
test('multi-step agent plans, reads, approves edits, verifies and persists history',async t=>{
 let h
 h=await harness(t,(request,n)=>{
  assert.equal(request.model,'fixture-model');assert.ok(request.tools.length<=18);assert.ok(request.tools.some(tool=>tool.function.name==='find_symbol'));assert.ok(request.tools.some(tool=>tool.function.name==='code_outline'));assert.ok(!request.tools.some(tool=>tool.function.name==='create_spreadsheet'))
  if(n===0)return response('先读取并检查。',[call('set_plan',{steps:[{text:'读取与修复',status:'running'}]}),call('read_file',{path:'a.txt'})])
  if(n===1){assert.match(request.messages.at(-1).content,/before/);return response('修改文件。',[call('replace_text',{path:'a.txt',oldText:'before',newText:'after'})])}
  if(n===2){assert.match(request.messages.at(-1).content,/saved/);return response('验证文件内容。',[call('read_file',{path:'a.txt'}),call('set_plan',{steps:[{text:'读取与修复',status:'completed'}]})])}
  return response('修复完成，已读取文件验证。')
 });fs.writeFileSync(path.join(h.workspace,'a.txt'),'before');const task=h.start();await until(()=>h.service.get(task.id).status==='waiting')
 const pending=h.service.get(task.id).events.find(e=>e.status==='waiting');assert.equal(pending.preview.after,'after');assert.equal(fs.readFileSync(path.join(h.workspace,'a.txt'),'utf8'),'before');assert.throws(()=>h.service.approve(task.id,pending.id,true,999),/过期/)
 h.service.approve(task.id,pending.id,true,7);assert.throws(()=>h.service.approve(task.id,pending.id,true,7),/过期/);await until(()=>!h.service.active(task.id))
 const result=h.service.get(task.id);assert.equal(result.status,'completed');assert.ok(Date.parse(result.runStartedAt)<=Date.parse(result.runCompletedAt));assert.equal(result.plan[0].status,'completed');assert.equal(result.artifacts[0].path,'a.txt');assert.equal(fs.readFileSync(path.join(h.workspace,'a.txt'),'utf8'),'after');assert.equal(h.service.list()[0].id,task.id)
 const again=h.start({taskId:task.id,prompt:'解释修复结果'});assert.equal(again.events.filter(e=>e.kind==='user').length,2);await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'completed')
})
test('denied operations return a tool error and never write a file',async t=>{
 const h=await harness(t,(request,n)=>n===0?response(null,[call('write_file',{path:'denied.txt',content:'no'})]):(assert.match(request.messages.at(-1).content,/拒绝/),response('已取消该修改。')))
 const task=h.start();await until(()=>h.service.get(task.id).status==='waiting');h.service.approve(task.id,h.service.get(task.id).events.at(-1).id,false,7);await until(()=>!h.service.active(task.id));assert.equal(fs.existsSync(path.join(h.workspace,'denied.txt')),false);assert.equal(h.service.get(task.id).events.find(e=>e.tool).status,'rejected')
})
test('task approval modes auto-approve the intended tool risk levels',async t=>{
 let round=0
 const auto=await harness(t,()=>round++===0?response(null,[call('write_file',{path:'auto.txt',content:'approved'})]):response('完成'))
 const safeTask=auto.start({approvalMode:'auto'});await until(()=>!auto.service.active(safeTask.id));const safeResult=auto.service.get(safeTask.id)
 assert.equal(safeResult.approvalMode,'auto');assert.equal(fs.readFileSync(path.join(auto.workspace,'auto.txt'),'utf8'),'approved');assert.equal(safeResult.events.find(event=>event.tool==='write_file').audit.authorization,'automatic')
 round=0
 const previous=process.env.MYPLANE_SANDBOX_DISABLE;process.env.MYPLANE_SANDBOX_DISABLE='1';t.after(()=>{if(previous===undefined)delete process.env.MYPLANE_SANDBOX_DISABLE;else process.env.MYPLANE_SANDBOX_DISABLE=previous})
 const full=await harness(t,()=>round++===0?response(null,[call('run_command',{command:'node -e "console.log(42)"'})]):response('完成'))
 const fullTask=full.start({approvalMode:'full'});await until(()=>full.service.get(fullTask.id).status==='waiting');const pending=full.service.get(fullTask.id).events.at(-1);assert.equal(pending.tool,'run_command');assert.match(pending.preview.note,/宿主机当前用户权限降级/);full.service.approve(fullTask.id,pending.id,true,7);await until(()=>!full.service.active(fullTask.id));const fullResult=full.service.get(fullTask.id)
 const command=fullResult.events.find(event=>event.tool==='run_command'),result=JSON.parse(command.output);assert.equal(fullResult.approvalMode,'full');assert.equal(command.audit.authorization,'confirmed');assert.equal(result.sandbox.active,false);assert.match(result.output,/42/)
})
test('similar command approvals persist in the conversation and skip matching prompts',async t=>{
 let round=0
 const previous=process.env.MYPLANE_SANDBOX_DISABLE;process.env.MYPLANE_SANDBOX_DISABLE='1';t.after(()=>{if(previous===undefined)delete process.env.MYPLANE_SANDBOX_DISABLE;else process.env.MYPLANE_SANDBOX_DISABLE=previous})
 const h=await harness(t,()=>round++===0?response(null,[call('run_command',{command:'node -p 1'})]):round===2?response(null,[call('run_command',{command:'node -p 2'})]):response('完成'))
 const task=h.start({approvalMode:'full'});await until(()=>h.service.get(task.id).status==='waiting');const pending=h.service.get(task.id).events.at(-1)
 assert.equal(pending.preview.approvalLabel,'node -p');h.service.approve(task.id,pending.id,true,7,'similar');await until(()=>!h.service.active(task.id))
 const result=h.service.get(task.id),commands=result.events.filter(event=>event.tool==='run_command')
 assert.equal(result.approvedCommands.length,1);assert.equal(result.approvedCommands[0].label,'node -p');assert.deepEqual(commands.map(event=>event.audit.authorization),['confirmed','automatic']);assert.match(commands[1].output,/2/)
 const resumed=h.start({taskId:task.id,prompt:'继续同类检查',approvalMode:'full'});await until(()=>!h.service.active(resumed.id));assert.equal(h.service.get(task.id).approvedCommands[0].label,'node -p')
})
test('unrestricted conversation mode runs host commands without approval prompts',async t=>{
 let round=0
 const previous=process.env.MYPLANE_SANDBOX_DISABLE;process.env.MYPLANE_SANDBOX_DISABLE='1';t.after(()=>{if(previous===undefined)delete process.env.MYPLANE_SANDBOX_DISABLE;else process.env.MYPLANE_SANDBOX_DISABLE=previous})
 const h=await harness(t,()=>round++===0?response(null,[call('run_command',{command:'node -p 7'})]):response('完成'))
 const task=h.start({approvalMode:'unrestricted'});await until(()=>!h.service.active(task.id));const result=h.service.get(task.id),command=result.events.find(event=>event.tool==='run_command')
 assert.equal(result.approvalMode,'unrestricted');assert.equal(result.status,'completed');assert.equal(command.audit.authorization,'automatic');assert.match(command.output,/7/)
})
test('stop cancels pending approval and closes every outstanding tool call',async t=>{
 const h=await harness(t,()=>response(null,[call('write_file',{path:'stop.txt',content:'no'}),call('read_file',{path:'stop.txt'})]));const task=h.start();await until(()=>h.service.get(task.id).status==='waiting');const pending=h.service.get(task.id).events.at(-1)
 h.service.stop(task.id,7);await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'stopped');assert.throws(()=>h.service.approve(task.id,pending.id,true,7),/过期/);assert.equal(fs.existsSync(path.join(h.workspace,'stop.txt')),false)
 const stored=JSON.parse(fs.readFileSync(path.join(h.root,'tasks',task.id+'.json'),'utf8'));assert.equal(stored.messages.filter(m=>m.role==='tool').length,2)
})
test('restart recovers unfinished tasks without reapproving operations',async t=>{
 const root=sandbox(t),id=randomUUID(),time=new Date().toISOString(),pending=call('write_file',{path:'a.txt',content:'x'}),task={id,title:'恢复',workspace:root,mode:'coding',model:'model',status:'waiting',steps:1,maxSteps:10,plan:[],artifacts:[],error:'',createdAt:time,updatedAt:time,events:[{id:randomUUID(),kind:'tool',text:'write',tool:'write_file',status:'waiting',createdAt:time}],messages:[{role:'user',content:'write'},{role:'assistant',content:null,tool_calls:[pending]}]};fs.writeFileSync(path.join(root,id+'.json'),JSON.stringify(task))
 const service=new LocalAgentService(root,()=>{throw new Error('not needed')});assert.equal(service.get(id).status,'stopped');assert.match(service.get(id).error,/中断/);assert.equal(service.get(id).events[0].status,'failed');assert.equal(fs.existsSync(path.join(root,'a.txt')),false)
 const stored=JSON.parse(fs.readFileSync(path.join(root,id+'.json'),'utf8'));assert.equal(stored.messages.at(-1).tool_call_id,pending.id)
})
test('step budget stops runaway model loops and unknown tools cannot execute',async t=>{
 const h=await harness(t,()=>response(null,[call('unknown_tool',{command:'touch forbidden'})]));const task=h.start({maxSteps:2});await until(()=>!h.service.active(task.id));const result=h.service.get(task.id);assert.equal(result.status,'stopped');assert.match(result.error,/2 轮/);assert.equal(result.events.filter(e=>e.status==='failed').length,2);assert.equal(fs.existsSync(path.join(h.workspace,'forbidden')),false)
})
test('extended and token-budget execution modes keep explicit runaway guards',async t=>{
 const h=await harness(t,(_body,n)=>n<42?{...response(null,[call('read_file',{path:`file-${n}.txt`})]),usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}:{...response('完成'),usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}},{contextLength:1_000_000})
 for(let i=0;i<42;i++)fs.writeFileSync(path.join(h.workspace,`file-${i}.txt`),String(i))
 assert.throws(()=>h.start({maxSteps:0,tokenBudget:0}),/必须设置.*Token 预算/)
 const task=h.start({maxSteps:0,tokenBudget:100000});await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(result.status,'completed');assert.equal(result.steps,43);assert.equal(result.maxSteps,0);assert.equal(result.usage.requests,43)
})
test('token-budget execution pauses when the provider omits usage reports',async t=>{
 const h=await harness(t,()=>response(null,[call('list_files',{})]))
 const task=h.start({maxSteps:0,tokenBudget:1000});await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(result.status,'stopped');assert.match(result.error,/没有报告 Token 用量/);assert.equal(result.events.some(event=>event.kind==='tool'),false)
})
test('truncated tool arguments are never executed and plain text is not treated as a command',async t=>{
 const h=await harness(t,(_request,n)=>n<3?{choices:[{finish_reason:'length',message:{tool_calls:[call('write_file',{path:'bad.txt',content:'truncated'})]}}]}:response('run_command({command:"touch bad.txt"})'))
 const task=h.start();await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'stopped');assert.match(h.service.get(task.id).error,/截断/)
 const next=h.start({taskId:task.id,prompt:'继续'});await until(()=>!h.service.active(next.id));assert.equal(fs.existsSync(path.join(h.workspace,'bad.txt')),false);assert.match(h.service.get(task.id).events.at(-1).text,/未调用工具/)
})
test('projects persist canonical folders, reject invalid names, and deduplicate folder aliases',t=>{
 const root=sandbox(t),workspace=path.join(root,'project');fs.mkdirSync(workspace)
 const service=new LocalAgentService(path.join(root,'tasks'),()=>{throw new Error('not needed')})
 assert.throws(()=>service.createProject(workspace,'  '),/项目名称/)
 assert.throws(()=>service.createProject(workspace,'x'.repeat(81)),/项目名称/)
 assert.throws(()=>service.createProject(path.join(root,'missing'),'Missing'))
 const project=service.createProject(workspace,'  编程项目  ')
 assert.equal(project.name,'编程项目');assert.equal(project.workspace,fs.realpathSync(workspace))
 assert.equal(service.createProject(path.join(workspace,'.'),'重复名称').id,project.id)
 if(process.platform!=='win32'){fs.symlinkSync(workspace,path.join(root,'alias'));assert.equal(service.createProject(path.join(root,'alias'),'别名').id,project.id)}
 const restored=new LocalAgentService(path.join(root,'tasks'),()=>{throw new Error('not needed')})
 assert.deepEqual(restored.projects(),[project]);assert.deepEqual(restored.list(),[])
 fs.rmSync(workspace,{recursive:true});assert.deepEqual(restored.projects(),[project],'unavailable folders remain listed')
})
test('project tasks use saved folder for tools and commands and retain it on resume',async t=>{
 const h=await harness(t,(_request,n)=>n===0?response(null,[call('read_file',{path:'identity.txt'}),call('run_command',{command:'node -p "process.cwd()"'})]):response('完成'))
 const folder=path.join(h.root,'another');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'identity.txt'),'selected project')
 fs.writeFileSync(path.join(h.workspace,'identity.txt'),'wrong workspace')
 const project=h.service.createProject(folder,'文档项目'),other=h.service.createProject(h.workspace,'其他项目')
 assert.throws(()=>h.start({projectId:randomUUID()}),/项目不存在/)
 const task=h.start({projectId:project.id});assert.equal(task.workspace,project.workspace);assert.equal(task.projectId,project.id)
 await until(()=>h.service.get(task.id).status==='waiting')
 const waiting=h.service.get(task.id);assert.match(waiting.events.find(e=>e.tool==='read_file').output,/selected project/)
 assert.equal(waiting.events.at(-1).preview.cwd,project.workspace)
 h.service.approve(task.id,waiting.events.at(-1).id,true,7);await until(()=>!h.service.active(task.id))
 assert.equal(JSON.parse(h.service.get(task.id).events.find(e=>e.tool==='run_command').output).output.trim(),project.workspace)
 assert.throws(()=>h.start({taskId:task.id,projectId:other.id}),/不能更改/)
 const resumed=h.start({taskId:task.id,workspace:h.workspace});assert.equal(resumed.workspace,project.workspace);assert.equal(resumed.projectId,project.id)
 await until(()=>!h.service.active(task.id))
 const restored=new LocalAgentService(path.join(h.root,'tasks'),()=>{throw new Error('not needed')});assert.equal(restored.list()[0].projectId,project.id)
})
test('project start rejects missing folders and folders redirected after registration',async t=>{
 const h=await harness(t,()=>response('完成')),project=h.service.createProject(h.workspace,'目录校验')
 fs.renameSync(h.workspace,h.workspace+'-moved');assert.throws(()=>h.start({projectId:project.id}))
 if(process.platform!=='win32'){fs.symlinkSync(h.workspace+'-moved',h.workspace);assert.throws(()=>h.start({projectId:project.id}),/目录位置已改变/)}
 assert.equal(h.service.list().length,0)
})

test('legacy directory tasks acquire stable projects by full path without rewriting their history',t=>{
 const root=fs.realpathSync(sandbox(t)),directory=path.join(root,'tasks'),web=path.join(root,'web')
 fs.mkdirSync(web)
 const connection=()=>({endpoint:'http://127.0.0.1:1/v1',key:'',maxTokens:2048,contextLength:16384})
 const service=new LocalAgentService(directory,connection),existing=service.createProject(web,'网站项目')
 const time='2026-01-01T00:00:00.000Z'
 const legacy=folder=>({id:randomUUID(),title:'旧任务',workspace:folder,mode:'coding',model:'fixture',status:'failed',steps:1,maxSteps:10,plan:[],artifacts:[],error:'TimeoutError',createdAt:time,updatedAt:time,events:[{id:randomUUID(),kind:'user',text:'任务要求',createdAt:time}],messages:[{role:'user',content:'任务要求'}]})
 const first=legacy(web),second=legacy(web),missing=legacy(path.join(root,'another','web'))
 for(const task of [first,second,missing])fs.writeFileSync(path.join(directory,task.id+'.json'),JSON.stringify(task))
 const restored=new LocalAgentService(directory,connection)
 assert.equal(restored.projects().length,2,'one project per full directory path, even for equal folder names')
 assert.equal(restored.get(first.id).projectId,existing.id,'reuse existing custom project name')
 assert.equal(restored.get(second.id).projectId,existing.id)
 const missingProject=restored.projects().find(p=>p.id===restored.get(missing.id).projectId)
 assert.equal(missingProject.name,'web');assert.equal(missingProject.workspace,missing.workspace)
 for(const task of [first,second,missing]){
  const stored=JSON.parse(fs.readFileSync(path.join(directory,task.id+'.json'),'utf8'))
  const {projectId,...unchanged}=stored;assert.ok(projectId);assert.deepEqual(unchanged,task)
 }
 const files=[first,second,missing].map(task=>fs.readFileSync(path.join(directory,task.id+'.json'),'utf8'))
 const reopened=new LocalAgentService(directory,connection)
 assert.deepEqual(reopened.projects(),restored.projects())
 assert.deepEqual([first,second,missing].map(task=>fs.readFileSync(path.join(directory,task.id+'.json'),'utf8')),files,'migration is idempotent')
 assert.throws(()=>reopened.start({taskId:missing.id,projectId:missingProject.id,mode:'coding',model:'fixture',prompt:'继续',maxSteps:10},7,()=>{}))
 if(process.platform!=='win32'){
  fs.renameSync(web,web+'-moved');fs.symlinkSync(web+'-moved',web)
  assert.throws(()=>reopened.start({taskId:first.id,projectId:existing.id,mode:'coding',model:'fixture',prompt:'继续',maxSteps:10},7,()=>{}),/目录位置已改变/)
 }
})

test('tasks started from a directory automatically join its project and resume after migration',async t=>{
 const h=await harness(t,()=>response('完成')),first=h.start()
 await until(()=>!h.service.active(first.id))
 const project=h.service.projects()[0];assert.equal(first.projectId,project.id);assert.equal(project.name,'project')
 const second=h.start();await until(()=>!h.service.active(second.id));assert.equal(second.projectId,project.id)
 assert.equal(h.service.projects().length,1)
 const file=path.join(h.root,'tasks',first.id+'.json'),legacy=JSON.parse(fs.readFileSync(file,'utf8'));delete legacy.projectId;fs.writeFileSync(file,JSON.stringify(legacy))
 assert.equal(h.service.get(first.id).projectId,project.id)
 const resumed=h.start({taskId:first.id,projectId:project.id,prompt:'继续旧任务'})
 assert.equal(resumed.workspace,first.workspace);await until(()=>!h.service.active(first.id));assert.equal(h.service.get(first.id).status,'completed')
})


async function modelServer(t,handle){
 const server=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;await handle(JSON.parse(raw),res)}catch(error){if(!res.destroyed){res.writeHead(500);res.end(String(error))}}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 return {endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:16384}
}
const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\r\n\r\n'
const streamHeaders=res=>{res.setHeader('Content-Type','text/event-stream');res.flushHeaders()}
const ask=(connection,options={},abort=signal())=>requestAgentModel(connection,'fixture-model',[{role:'user',content:'test'}],abort,options)

test('managed llama requests support explicit fast and deep thinking modes',async t=>{
 const bodies=[]
 const connection=await modelServer(t,async(body,res)=>{bodies.push(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response('摘要完成。')))})
 await ask({...connection,localLlama:true},{tools:false,summary:true})
 await ask({...connection,localLlama:true},{tools:false,thinking:false})
 await ask({...connection,localLlama:true},{tools:false,thinking:true})
 await ask({...connection,localLlama:true},{tools:false})
 await ask(connection,{tools:false,summary:true})
 assert.deepEqual(bodies[0].chat_template_kwargs,{enable_thinking:false})
 assert.deepEqual(bodies[1].chat_template_kwargs,{enable_thinking:false})
 assert.deepEqual(bodies[2].chat_template_kwargs,{enable_thinking:true})
 assert.equal(bodies[3].chat_template_kwargs,undefined)
 assert.equal(bodies[4].chat_template_kwargs,undefined)
})

test('generic text tools cannot create fake Office documents',async t=>{
 const root=sandbox(t),tools=new AgentWorkspace(root)
 await assert.rejects(tools.prepare('write_file',{path:'fake.docx',content:'plain text'}),/create_document/)
 await assert.rejects(tools.prepare('write_file',{path:'fake.xlsx',content:'plain text'}),/create_spreadsheet/)
})

test('streaming preserves reasoning and reports tool names while assembling fragmented tool calls',async t=>{
 const progress=[],reasoning=[]
 const connection=await modelServer(t,async(body,res)=>{
  assert.equal(body.stream,true);streamHeaders(res)
  const wire=frame({role:'assistant',content:null,tool_calls:null})+frame({reasoning_content:'先理解中文任务'})+frame({content:'开始检查。',tool_calls:[{index:1,id:'second',function:{name:'read_',arguments:'{"path":'}},{index:0,id:'first',function:{name:'list_files',arguments:'{'}}]})+frame({tool_calls:[{index:0,id:null,function:{name:null,arguments:'}'}},{index:1,function:{name:'file',arguments:'"报告.md"}'}}]})+frame({},'tool_calls')+'data: [DONE]\n\n'
  const bytes=Buffer.from(wire)
  for(let i=0;i<bytes.length;i+=13){res.write(bytes.subarray(i,i+13));await pause(1)}res.end()
 })
 const answer=await ask(connection,{onProgress:p=>progress.push(p),onReasoning:text=>reasoning.push(text)})
 assert.equal(answer.content,'开始检查。');assert.deepEqual(answer.tool_calls.map(c=>[c.id,c.function.name,JSON.parse(c.function.arguments)]),[['first','list_files',{}],['second','read_file',{path:'报告.md'}]])
 assert.equal(answer.reasoning,'先理解中文任务');assert.equal(reasoning.join(''),'先理解中文任务')
 assert.ok(progress.some(p=>p.phase==='thinking'));assert.ok(progress.some(p=>p.phase==='tools'&&p.toolNames?.includes('read_file')));assert.ok(progress.at(-1).characters>0)
})
test('active generation renews idle timeout instead of aborting at the original deadline',async t=>{
 assert.equal(agentModelTiming.totalMs,30*60*1000);assert.ok(agentModelTiming.firstResponseMs>5*60*1000)
 const connection=await modelServer(t,async(_body,res)=>{streamHeaders(res);for(let i=0;i<8;i++){res.write(frame({reasoning_content:'正在思考'}));await pause(60)}res.end(frame({content:'完成'},'stop'))})
 const answer=await ask(connection,{timing:{firstResponseMs:1000,idleMs:250,totalMs:2000}});assert.equal(answer.content,'完成')
})
test('first-output, stalled-stream and total-budget timeouts return actionable errors',async t=>{
 const silent=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.write(': heartbeat\n\n')})
 await assert.rejects(ask(silent,{timing:{firstResponseMs:100,idleMs:100,totalMs:1000}}),/等待模型首个输出.*本轮未执行工具/)
 const stalled=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.write(frame({content:'partial'}))})
 await assert.rejects(ask(stalled,{timing:{firstResponseMs:1000,idleMs:100,totalMs:2000}}),/没有返回新内容/)
 const endless=await modelServer(t,async(_body,res)=>{streamHeaders(res);while(!res.destroyed){res.write(frame({reasoning_content:'thinking'}));await pause(30)}})
 await assert.rejects(ask(endless,{timing:{firstResponseMs:1000,idleMs:1000,totalMs:200}}),/单轮生成.*上限/)
})
test('user stop cancels a pending stream promptly and preserves the cancellation reason',async t=>{
 let opened=false,closed=false
 const connection=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.write(frame({reasoning_content:'thinking'}));opened=true;res.once('close',()=>{closed=true})})
 const controller=new AbortController(),reason=new Error('explicit user stop'),pending=ask(connection,{},controller.signal)
 const rejected=assert.rejects(pending,error=>error===reason);await until(()=>opened);controller.abort(reason);await rejected;await until(()=>closed)
})
test('truncated and incomplete streams cannot execute partial tool arguments',async t=>{
 for(const finish of [undefined,'length']){
  const root=sandbox(t),connection=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.end(frame({tool_calls:[{index:0,id:'partial',function:{name:'write_file',arguments:'{"path":"unsafe.txt","content":"no"}'}}]})+(finish?frame({},finish):'data: [DONE]\n\n'))})
  const service=new LocalAgentService(path.join(root,'tasks'),()=>connection);t.after(()=>service.dispose())
  const task=service.start({workspace:root,mode:'coding',model:'fixture-model',prompt:'write',maxSteps:10},1,()=>{});await until(()=>!service.active(task.id))
  const result=service.get(task.id);assert.equal(result.status,finish?'stopped':'failed');assert.equal(result.events.some(e=>e.kind==='tool'),false);assert.equal(result.modelProgress,undefined);assert.equal(fs.existsSync(path.join(root,'unsafe.txt')),false)
  assert.match(result.error,finish?/截断/:/中断/)
 }
})
test('stream errors and invalid tool indexes fail before any tool execution',async t=>{
 for(const wire of ['data: {"error":{"message":"model overloaded"}}\n\n',frame({tool_calls:[{index:-1,id:'bad',function:{name:'read_file',arguments:'{}'}}]},'tool_calls'),'data: invalid-json\n\n']){
  const connection=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.end(wire)})
  await assert.rejects(ask(connection),/overloaded|序号|格式错误/)
 }
})

test('sparse tool indexes remain valid when the streamed call is complete',async t=>{
 const connection=await modelServer(t,async(_body,res)=>{streamHeaders(res);res.end(frame({tool_calls:[{index:9,id:'sparse',function:{name:'read_file',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n')})
 const answer=await ask(connection)
 assert.equal(answer.tool_calls?.[0]?.id,'sparse')
 assert.equal(answer.tool_calls?.[0]?.function.name,'read_file')
})

test('oversized SSE payloads report a recoverable size error and discard partial tool calls',async t=>{
 const connection=await modelServer(t,async(_body,res)=>{
  streamHeaders(res)
  const pending=frame({tool_calls:[{index:0,id:'partial',function:{name:'write_file',arguments:'{"path":"never.txt"'}}]})
  const filler='data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:null}],padding:'x'.repeat(900000)})+'\n\n'
  res.end(pending+filler.repeat(10))
 })
 await assert.rejects(ask(connection),error=>{
  assert.ok(error instanceof ModelResponseSizeError)
  assert.equal(error.kind,'wire')
  assert.ok(error.observed>error.limit)
  assert.deepEqual(error.output,{text:0,reasoning:0,arguments:19,calls:1})
  return true
 })
})

test('small SSE deltas can exceed the old transport ceiling without exceeding content capacity',async t=>{
 const connection=await modelServer(t,async(_body,res)=>{
  streamHeaders(res)
  res.end(frame({content:'x'}).repeat(45000)+frame({},'stop')+'data: [DONE]\n\n')
 })
 const answer=await ask({...connection,maxTokens:65536,contextLength:131072})
 assert.equal(answer.content.length,45000)
})

test('semantic response ceiling has a distinct size error with output breakdown',async t=>{
 const connection=await modelServer(t,async(_body,res)=>{
  streamHeaders(res)
  res.end(frame({content:'a'.repeat(700000)})+frame({content:'b'.repeat(400000)})+frame({},'stop')+'data: [DONE]\n\n')
 })
 await assert.rejects(ask(connection),error=>{
  assert.ok(error instanceof ModelResponseSizeError)
  assert.equal(error.kind,'characters')
  assert.equal(error.output.text,1100000)
  assert.equal(error.output.calls,0)
  return true
 })
})

test('runaway SSE envelope overhead raises a recoverable wire-size error',async t=>{
 const connection=await modelServer(t,async(_body,res)=>{
  streamHeaders(res)
  res.end(frame({content:'x'}).repeat(120000)+frame({},'stop')+'data: [DONE]\n\n')
 })
 await assert.rejects(ask({...connection,maxTokens:65536,contextLength:131072}),error=>{
  assert.ok(error instanceof ModelResponseSizeError)
  assert.equal(error.kind,'wire')
  assert.ok(error.output.text<1024*1024)
  return true
 })
})

test('collects usage-only SSE trailers after finish_reason, including duplicate snapshots',async t=>{
 const usages=[],connection=await modelServer(t,async(body,res)=>{
  assert.deepEqual(body.stream_options,{include_usage:true});streamHeaders(res)
  const usage='data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n'
  res.end(frame({content:'完成'},'stop')+usage+usage+'data: [DONE]\n\n')
 })
 const result=await ask(connection,{onUsage:usage=>usages.push(usage)})
 assert.equal(result.content,'完成');assert.equal(usages.length,2);assert.deepEqual(usages.at(-1),{inputTokens:100,outputTokens:20,totalTokens:120})
 assert.equal(result.usage,undefined,'usage metadata must not be sent back in model messages')
})
test('task usage accumulates all model rounds, survives continuation and is persisted',async t=>{
 const h=await harness(t,(_request,n)=>({...((n===0)?response(null,[call('list_files',{})]):response('完成')),usage:n===0?{prompt_tokens:100,completion_tokens:20,total_tokens:120}:n===1?{prompt_tokens:150,completion_tokens:30,total_tokens:180}:{prompt_tokens:90,completion_tokens:10,total_tokens:100}}))
 const task=h.start();await until(()=>!h.service.active(task.id))
 assert.deepEqual(h.service.get(task.id).usage,{requests:2,inputTokens:250,outputTokens:50,totalTokens:300,inputReports:2,outputReports:2,totalReports:2})
 h.start({taskId:task.id,prompt:'继续'});await until(()=>!h.service.active(task.id))
 const restored=new LocalAgentService(path.join(h.root,'tasks'),()=>{throw new Error('unused')})
 assert.deepEqual(restored.get(task.id).usage,{requests:3,inputTokens:340,outputTokens:60,totalTokens:400,inputReports:3,outputReports:3,totalReports:3})
 const stored=JSON.parse(fs.readFileSync(path.join(h.root,'tasks',task.id+'.json'),'utf8'));assert.ok(stored.messages.every(message=>!('usage' in message)))
})
test('missing usage and truncated generations are accounted for honestly',async t=>{
 const h=await harness(t,(_request,n)=>n===0?{choices:[{finish_reason:'length',message:{content:'partial'}}],usage:{prompt_tokens:50,completion_tokens:80,total_tokens:130}}:response('完成'))
 const task=h.start();await until(()=>!h.service.active(task.id));assert.equal(h.service.get(task.id).status,'completed');assert.equal(h.service.get(task.id).usage.totalTokens,130)
 h.start({taskId:task.id,prompt:'继续'});await until(()=>!h.service.active(task.id))
 assert.deepEqual(h.service.get(task.id).usage,{requests:3,inputTokens:50,outputTokens:80,totalTokens:130,inputReports:1,outputReports:1,totalReports:1})
})

test('agent automatically summarizes long histories, preserves archive and resumes after restart',async t=>{
 let summaries=0,lastMain
 const h=await harness(t,body=>{if(!body.tools){summaries++;return {...response('目标：修复项目。已经读取文件，尚未修改；下一步验证。'),usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}}lastMain=body;return {...response('完成'),usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}}})
 const initial=h.start();await until(()=>!h.service.active(initial.id))
 const file=path.join(h.root,'tasks',initial.id+'.json'),task=JSON.parse(fs.readFileSync(file,'utf8'))
 task.messages=Array.from({length:20},(_,i)=>({role:i%2?'assistant':'user',content:i%2?'记录 '+i+'：'+ '历史文件分析结果。'.repeat(300):'继续检查第 '+i+' 项'}))
 const archive=structuredClone(task.messages),events=structuredClone(task.events)
 fs.writeFileSync(file,JSON.stringify(task))
 const next=h.start({taskId:initial.id,prompt:'继续验证，不要部署'});await until(()=>!h.service.active(next.id))
 assert.ok(summaries>0);assert.equal(h.service.get(next.id).status,'completed');assert.match(JSON.stringify(lastMain.messages),/进度摘要/)
 assert.equal(lastMain.messages.at(-1).content,'继续验证，不要部署')
 const stored=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(stored.messages.slice(0,20),archive);assert.deepEqual(stored.events.slice(0,events.length),events)
 assert.ok(stored.checkpoint.through>0);assert.equal(stored.usage.requests,2+summaries)
 const restored=new LocalAgentService(path.join(h.root,'tasks'),()=>({endpoint:'unused',key:'',maxTokens:2048,contextLength:16384}))
 assert.deepEqual(restored.get(next.id).checkpoint,stored.checkpoint)
 assert.ok(h.service.get(next.id).context.inputTokens<h.service.get(next.id).context.capacity)
})

test('manual agent compaction failure and stop preserve checkpoint/history and enforce owner lock',async t=>{
 let hold=false,summaryStarted=false
 const h=await harness(t,async body=>{if(body.tools)return response('任务完成。'.repeat(300));summaryStarted=true;if(hold)await pause(500);throw new Error('summary failed')})
 const first=h.start();await until(()=>!h.service.active(first.id));h.start({taskId:first.id,prompt:'继续检查'});await until(()=>!h.service.active(first.id))
 const before=JSON.parse(fs.readFileSync(path.join(h.root,'tasks',first.id+'.json'),'utf8'))
 await assert.rejects(h.service.compact(first.id,7,()=>{}),/summary failed/)
 let after=JSON.parse(fs.readFileSync(path.join(h.root,'tasks',first.id+'.json'),'utf8'));assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.checkpoint,before.checkpoint)
 hold=true;summaryStarted=false
 const operation=h.service.compact(first.id,7,()=>{});const rejected=assert.rejects(operation)
 await until(()=>summaryStarted);assert.throws(()=>h.start({taskId:first.id}),/完成或停止/);assert.throws(()=>h.service.stop(first.id,999),/另一窗口/)
 h.service.stop(first.id,7);await rejected
 after=JSON.parse(fs.readFileSync(path.join(h.root,'tasks',first.id+'.json'),'utf8'));assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.checkpoint,before.checkpoint)
 assert.equal(h.service.active(first.id),false)
})

test('agent can read archived history after compaction without file or command permissions',async t=>{
 let query=false
 const h=await harness(t,body=>{if(!body.tools)return response('已完成初步分析，接下来核对历史要求。');if(query){query=false;return response(null,[call('read_history',{query:'必须保留字段 customer_id'})])}return response('分析完成。'.repeat(300))})
 const first=h.start({prompt:'必须保留字段 customer_id'});await until(()=>!h.service.active(first.id));h.start({taskId:first.id,prompt:'继续分析'});await until(()=>!h.service.active(first.id))
 const original=h.service.get(first.id)
 await h.service.compact(first.id,7,()=>{});assert.ok(h.service.get(first.id).checkpoint)
 query=true;h.start({taskId:first.id,prompt:'核对早期约束'});await until(()=>!h.service.active(first.id))
 const result=h.service.get(first.id),event=result.events.find(item=>item.tool==='read_history')
 assert.equal(event.status,'completed');assert.match(event.output,/必须保留字段 customer_id/);assert.deepEqual(result.events.slice(0,original.events.length),original.events)
 assert.equal(result.events.some(item=>item.status==='waiting'),false)
})

test('chat conversion preserves history, images and usage; mode switches retain the task and disable tools in chat',async t=>{
 const image={name:'design.png',dataUrl:'data:image/png;base64,aGVsbG8='},time=new Date().toISOString()
 const seed={id:randomUUID(),title:'页面设计',model:'fixture-model',systemPrompt:'使用中文回答',createdAt:time,updatedAt:time,messages:[{id:randomUUID(),role:'user',content:'请使用蓝色主题',images:[image],createdAt:time},{id:randomUUID(),role:'assistant',content:'已记录蓝色要求',createdAt:time}],usage:{requests:1,inputTokens:20,outputTokens:5,totalTokens:25,inputReports:1,outputReports:1,totalReports:1}}
 const original=structuredClone(seed)
 const h=await harness(t,(request,n)=>{
  assert.ok(request.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'&&part.image_url.url===image.dataUrl)))
  assert.ok(request.messages.some(message=>message.content==='已记录蓝色要求'))
  if(n===1){assert.equal(request.tools,undefined);assert.match(request.messages[0].content,/没有文件或命令工具/);assert.ok(request.messages.some(message=>message.content==='检查现有页面'))}
  else assert.ok(request.tools.length)
  return {...response(n===0?'检查完成':'继续说明'),usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}
 })
 const started=h.start({seed,prompt:'检查现有页面'})
 await until(()=>h.service.get(started.id).status==='completed')
 let saved=h.service.get(started.id);assert.equal(saved.sourceSessionId,seed.id);assert.equal(saved.title,seed.title);assert.deepEqual(saved.events[0].images,[image]);assert.equal(saved.usage.totalTokens,37);assert.deepEqual(seed,original)
 h.start({taskId:started.id,mode:'chat',prompt:'解释结果，不修改文件'});await until(()=>h.service.get(started.id).status==='completed')
 h.start({taskId:started.id,mode:'coding',prompt:'再次核对'});await until(()=>h.service.get(started.id).status==='completed')
 saved=h.service.get(started.id);assert.equal(h.service.list().length,1);assert.equal(saved.usage.totalTokens,61);assert.equal(saved.events.filter(event=>event.kind==='user').length,4)
})

test('chat mode rejects tool calls even when a provider ignores the disabled tools setting',async t=>{
 const h=await harness(t,()=>response('write',[call('write_file',{path:'blocked.txt',content:'no'})]))
 const task=h.start({mode:'chat',prompt:'讨论一下'})
 await until(()=>h.service.get(task.id).status==='failed')
 assert.equal(fs.existsSync(path.join(h.workspace,'blocked.txt')),false)
 assert.equal(h.service.get(task.id).events.some(event=>event.kind==='tool'),false)
})


test('output-limit recovery discards all calls, retries once with smaller work and records all usage',async t=>{
 let requests=0
 const h=await harness(t,(body,n)=>{
  requests++;assert.equal(body.max_tokens,n===0?2048:4096)
  if(n===0)return {choices:[{finish_reason:'length',message:{tool_calls:[call('write_file',{path:'discard.txt',content:'never write'}),call('list_files',{})]}}],usage:{prompt_tokens:100,completion_tokens:2048,total_tokens:2148}}
  if(n===1){assert.match(body.messages[0].content,/最多调用一个工具/);assert.doesNotMatch(JSON.stringify(body.messages),/discard.txt/);return {...response(null,[call('list_files',{})]),usage:{prompt_tokens:120,completion_tokens:20,total_tokens:140}}}
  return response('已检查目录')
 })
 const task=h.start();await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(result.status,'completed');assert.equal(requests,3);assert.equal(result.events.filter(e=>e.kind==='tool').length,1)
 assert.equal(result.events.find(e=>e.kind==='tool').tool,'list_files');assert.equal(fs.existsSync(path.join(h.workspace,'discard.txt')),false)
 assert.equal(result.usage.requests,3);assert.equal(result.usage.totalTokens,2288);assert.equal(result.usage.totalReports,2)
})

test('output-limit recovery also retries after streamed reasoning was shown',async t=>{
 let requests=0
 const h=await harness(t,(_body,n)=>{requests++;return n===0?{sse:`data: ${JSON.stringify({choices:[{delta:{reasoning_content:'过长的思考'},finish_reason:'length'}]})}\n\ndata: [DONE]\n\n`}:response('已缩小任务并完成')})
 const task=h.start();await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(result.status,'completed');assert.equal(requests,2)
 assert.ok(result.events.some(event=>event.status==='failed'&&/Token 上限/.test(event.text)))
 assert.ok(result.events.some(event=>event.kind==='assistant'&&event.text==='已缩小任务并完成'))
})

test('output-limit retry respects cancellation and token budget',async t=>{
 for(const cancel of [false,true]){
  let requests=0
  const h=await harness(t,()=>{requests++;if(cancel)h.service.stop(task.id,7);return {choices:[{finish_reason:'length',message:{content:'partial'}}],usage:{total_tokens:100}}})
  const task=h.start({tokenBudget:100});await until(()=>!h.service.active(task.id))
  const result=h.service.get(task.id);assert.equal(result.status,'stopped');assert.equal(requests,1);assert.equal(result.events.some(e=>e.kind==='tool'),false)
  assert.match(result.error,cancel?/停止/:/预算/)
 }
})


test('output-limit recovery grows 2048 to 4096 then 8192 with sufficient context and never executes truncated calls',async t=>{
 const limits=[]
 const h=await harness(t,(body,n)=>{
  limits.push(body.max_tokens)
  if(n<2)return {choices:[{finish_reason:'length',message:{tool_calls:[call('write_file',{path:'truncated.txt',content:'do not execute'})]}}]}
  return response('恢复完成')
 },{contextLength:32768})
 const task=h.start();await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.deepEqual(limits,[2048,4096,8192]);assert.equal(result.status,'completed',result.error)
 assert.equal(result.events.filter(event=>event.kind==='tool').length,0);assert.equal(fs.existsSync(path.join(h.workspace,'truncated.txt')),false)
 assert.equal(result.context.reservedOutput,8192)
})

test('output-limit recovery remains bounded when every response is truncated',async t=>{
 let requests=0
 const h=await harness(t,()=>{requests++;return {choices:[{finish_reason:'length',message:{content:'partial'}}]}},{contextLength:32768})
 const task=h.start();await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(requests,3);assert.equal(result.status,'stopped');assert.match(result.error,/8192/)
 assert.equal(result.events.some(event=>event.kind==='tool'),false)
})

test('output-limit recovery reserves mandatory host state before increasing its output allowance',async t=>{
 const bodies=[],capacity=16384
 const h=await harness(t,(body,n)=>{
  bodies.push(body)
  assert.ok(body.messages.some(message=>String(message.content).includes('approvalMode')),'mandatory permissions must remain in the actual request')
  assert.ok(estimateTokens(body.messages)+estimateTokens(body.tools)+body.max_tokens+32+Math.ceil(capacity*.05)<=capacity)
  return n<2?{choices:[{finish_reason:'length',message:{content:'partial'}}]}:response('完成')
 },{contextLength:capacity})
 const task=h.start();await until(()=>!h.service.active(task.id))
 const result=h.service.get(task.id)
 assert.equal(result.status,'completed',result.error);assert.equal(bodies.length,3)
 assert.deepEqual(bodies.slice(0,2).map(body=>body.max_tokens),[2048,4096])
 assert.ok(bodies[2].max_tokens>4096&&bodies[2].max_tokens<8192)
 assert.equal(result.context.reservedOutput,bodies[2].max_tokens)
})


test('output recovery respects small context space and disables reasoning on retry',async t=>{
 const bodies=[]
 const h=await harness(t,(body,n)=>{
  bodies.push(body)
  assert.ok(estimateTokens(body.messages)+estimateTokens(body.tools)+body.max_tokens+32<=4096)
  return n===0?{choices:[{finish_reason:'length',message:{content:'partial'}}]}:response('完成')
 },{contextLength:4096,localLlama:true})
 const task=h.start({fastMode:false});await until(()=>!h.service.active(task.id));const result=h.service.get(task.id)
 assert.equal(result.status,'completed',result.error);assert.equal(bodies.length,2)
 assert.equal(bodies[0].chat_template_kwargs.enable_thinking,true);assert.equal(bodies[1].chat_template_kwargs.enable_thinking,false)
 assert.ok(bodies[1].max_tokens>0);assert.ok(bodies[1].max_tokens<=2048)
 assert.ok(estimateTokens(bodies[1].messages)+estimateTokens(bodies[1].tools)+bodies[1].max_tokens+32+Math.ceil(4096*.05)<=4096,'recovery reserves the same safety margin as normal inference')
})
