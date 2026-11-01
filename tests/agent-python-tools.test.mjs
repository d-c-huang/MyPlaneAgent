import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:http'
import {AgentToolStore} from '../dist-electron/main/agent/tool-store.js'
import {PythonToolRuntime} from '../dist-electron/main/agent/python.js'

const python=process.env.MYPLANE_PYTHON||(process.platform==='win32'?'python':'python3')
const worker=path.resolve('python/agent_tools_worker.py')
function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-python-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
function call(workspace,tool,args={},context={},code){const run=spawnSync(python,[worker],{input:JSON.stringify({workspace,tool,args,context,code}),encoding:'utf8'});assert.equal(run.status,0,run.stderr||run.stdout);const envelope=JSON.parse(run.stdout);assert.equal(envelope.error,undefined);return typeof envelope.output==='string'?envelope.output:JSON.stringify(envelope.output)}
function callAsync(workspace,tool,args={}){return new Promise((resolve,reject)=>{const child=spawn(python,[worker],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,stderr||stdout);const envelope=JSON.parse(stdout);assert.equal(envelope.error,undefined);resolve(typeof envelope.output==='string'?envelope.output:JSON.stringify(envelope.output))}catch(error){reject(error)}});child.stdin.end(JSON.stringify({workspace,tool,args}))})}

test('Python runtime isolates invocations and reads current filesystem state',async t=>{
 const root=sandbox(t),runtime=new PythonToolRuntime(worker);t.after(()=>runtime.dispose());const signal=new AbortController().signal
 const code='def execute(args, context):\n    import os\n    print("custom diagnostic")\n    return {"pid": os.getpid(), "cwd": os.getcwd()}\n'
 const first=JSON.parse((await runtime.execute({workspace:root,tool:'worker_pid',args:{},code},signal)).output),second=JSON.parse((await runtime.execute({workspace:root,tool:'worker_pid',args:{},code},signal)).output);assert.notEqual(first.pid,second.pid);assert.equal(first.cwd,fs.realpathSync(root))
 fs.writeFileSync(path.join(root,'a.txt'),'one');const listed=JSON.parse((await runtime.execute({workspace:root,tool:'list_files',args:{}},signal)).output);assert.ok(listed.paths.includes('a.txt'))
 const cached=JSON.parse((await runtime.execute({workspace:root,tool:'list_files',args:{}},signal)).output);assert.equal(cached.cached,undefined)
 fs.writeFileSync(path.join(root,'b.txt'),'two');const refreshed=JSON.parse((await runtime.execute({workspace:root,tool:'list_files',args:{}},signal)).output);assert.ok(refreshed.paths.includes('b.txt'));assert.equal(refreshed.cached,undefined)
 fs.writeFileSync(path.join(root,'a.txt'),'updated value');const read=JSON.parse((await runtime.execute({workspace:root,tool:'read_file',args:{path:'a.txt'}},signal)).output);assert.match(read.text,/updated value/)
})

test('Python worker reads, searches and atomically writes workspace files',t=>{
 const root=sandbox(t);fs.writeFileSync(path.join(root,'before.txt'),'alpha\nbeta\n')
 assert.match(JSON.parse(call(root,'list_files',{path:'.'})).paths.join(','),/before\.txt/)
 assert.match(JSON.parse(call(root,'read_file',{path:'before.txt'})).text,/1: alpha/)
 assert.equal(JSON.parse(call(root,'search_files',{query:'BETA'})).matches[0].line,2)
 const prepared=JSON.parse(call(root,'write_file',{path:'after.txt',content:'created'},{phase:'plan'}));assert.equal(prepared.preview.path,'after.txt');assert.equal(fs.existsSync(path.join(root,'after.txt')),false)
 const saved=JSON.parse(call(root,'write_file',{},{phase:'commit',plan:prepared.plan}));assert.deepEqual(saved.paths,['after.txt']);assert.equal(fs.readFileSync(path.join(root,'after.txt'),'utf8'),'created')
})

test('replace_text reports exact match count and escaped newline mismatch without changing files',t=>{
 const root=sandbox(t),file=path.join(root,'source.js')
 const failed=oldText=>{
  const attempt=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'replace_text',args:{path:'source.js',oldText,newText:'changed'},context:{phase:'plan'}}),encoding:'utf8'})
  assert.notEqual(attempt.status,0)
  return JSON.parse(attempt.stdout).error
 }
 const source='console.log(`\\nend`);\n'
 fs.writeFileSync(file,source)
 assert.match(failed('console.log(`\\\\nend`);'),/实际匹配 0 处.*两个反斜杠加 n/)
 assert.match(failed('missing'),/实际匹配 0 处.*重新读取目标文件/)
 assert.equal(fs.readFileSync(file,'utf8'),source)
 fs.writeFileSync(file,'A\nB')
 assert.match(failed('A\\nB'),/实际匹配 0 处.*实际换行/)
 fs.writeFileSync(file,'repeat repeat')
 assert.match(failed('repeat'),/实际匹配 2 处.*扩大 oldText 的上下文/)
 assert.equal(fs.readFileSync(file,'utf8'),'repeat repeat')
})

test('replace_text can target a repeated snippet by its current line without changing other occurrences',t=>{
 const root=sandbox(t),file=path.join(root,'gomoku.test.js')
 const source='g.reset();\n}\n\n// other case\ng.reset();\n}\n\nprocess.exit(fail > 0 ? 1 : 0);\n'
 fs.writeFileSync(file,source)
 const args={path:'gomoku.test.js',oldText:'g.reset();\n}',newText:'g.reset();\n}\n\n// added coverage',startLine:5}
 const prepared=JSON.parse(call(root,'replace_text',args,{phase:'plan'}))
 assert.equal(fs.readFileSync(file,'utf8'),source)
 call(root,'replace_text',{}, {phase:'commit',plan:prepared.plan})
 assert.equal(fs.readFileSync(file,'utf8'),'g.reset();\n}\n\n// other case\ng.reset();\n}\n\n// added coverage\n\nprocess.exit(fail > 0 ? 1 : 0);\n')
 const invalid=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'replace_text',args:{...args,startLine:4},context:{phase:'plan'}}),encoding:'utf8'})
 assert.notEqual(invalid.status,0)
 assert.match(JSON.parse(invalid.stdout).error,/第 4 行匹配 0 处/)
})

test('custom FAIL lines are reported as assertion failures with individual test names',()=>{
 const script="import sys,json;sys.path.insert(0,'python');from agent_tools_worker import test_failure_analysis;print(json.dumps(test_failure_analysis(sys.stdin.read(),1)))"
 const output='  FAIL  空盘迭代加深返回合法着法 — 无着法\n  FAIL  二次搜索命中置换表 — hits=0\n===== 汇总：78 通过 / 2 失败 ====='
 const run=spawnSync(python,['-c',script],{input:output,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}})
 assert.equal(run.status,0,run.stderr)
 const analysis=JSON.parse(run.stdout)
 assert.equal(analysis.category,'assertion')
 assert.deepEqual(analysis.failedTests,['空盘迭代加深返回合法着法 — 无着法','二次搜索命中置换表 — hits=0'])
})

test('Python worker creates readable DOCX and XLSX artifacts',t=>{
 const root=sandbox(t)
 for(const [tool,args,file] of [['create_document',{path:'report.docx',title:'Title',content:'Body'},'report.docx'],['create_spreadsheet',{path:'report.xlsx',sheets:[{name:'Data',rows:[['Name','Count'],['A',2]]}]},'report.xlsx']]){
  const prepared=JSON.parse(call(root,tool,args,{phase:'plan'}));call(root,tool,{},{phase:'commit',plan:prepared.plan});assert.equal(fs.readFileSync(path.join(root,file)).subarray(0,2).toString(),'PK')
 }
 assert.match(JSON.parse(call(root,'read_document',{path:'report.docx'})).text,/Title/);assert.match(JSON.parse(call(root,'read_document',{path:'report.xlsx'})).text,/Name/)
 const archive=JSON.parse(call(root,'archive_inspect',{path:'report.docx'}));assert.equal(archive.kind,'zip');for(const expected of ['word/document.xml','word/styles.xml','word/settings.xml','word/_rels/document.xml.rels','docProps/core.xml','docProps/app.xml'])assert.ok(archive.entries.some(entry=>entry.path===expected),expected)
 const invalid=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'create_document',args:{path:'invalid.doc',title:'Title',content:'Body'},context:{phase:'plan'}}),encoding:'utf8'});assert.notEqual(invalid.status,0);assert.match(JSON.parse(invalid.stdout).error,/\.docx/)
 for(const tool of ['write_file','replace_text']){const args=tool==='write_file'?{path:'fake.docx',content:'plain text'}:{path:'report.docx',oldText:'Title',newText:'Fake'};const attempt=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool,args,context:{phase:'plan'}}),encoding:'utf8'});assert.notEqual(attempt.status,0);assert.match(JSON.parse(attempt.stdout).error,/create_document/)}
 const patch=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'apply_patch',args:{changes:[{path:'fake.docx',after:'plain text'}]},context:{phase:'plan'}}),encoding:'utf8'});assert.notEqual(patch.status,0);assert.match(JSON.parse(patch.stdout).error,/create_document/)
})

test('generated DOCX can be opened by an installed office suite',t=>{
 if(process.env.TEST_WORD_CONVERSION!=='1')return t.skip('set TEST_WORD_CONVERSION=1 to run the LibreOffice integration')
 const probe=spawnSync(process.platform==='win32'?'where.exe':'which',['soffice'],{encoding:'utf8'});if(probe.status!==0)return t.skip('LibreOffice is not installed')
 const root=sandbox(t),output=path.join(root,'converted'),profile=path.join(root,'libreoffice-profile');fs.mkdirSync(output);fs.mkdirSync(profile)
 const prepared=JSON.parse(call(root,'create_document',{path:'兼容性报告.docx',title:'兼容性报告',content:'## 摘要\n\n- 中文内容\n\n| 项目 | 状态 |\n| --- | --- |\n| Word | 正常 |'},{phase:'plan'}));call(root,'create_document',{},{phase:'commit',plan:prepared.plan})
 const profileUrl='file:///'+profile.replaceAll('\\','/');const converted=spawnSync('soffice',[`-env:UserInstallation=${profileUrl}`,'--headless','--convert-to','pdf','--outdir',output,path.join(root,'兼容性报告.docx')],{encoding:'utf8',timeout:60000});assert.equal(converted.status,0,converted.stderr||converted.stdout);assert.ok(fs.existsSync(path.join(output,'兼容性报告.pdf')),converted.stdout)
})

test('Python worker inspects projects and performs semantic code searches',t=>{
 const root=sandbox(t);fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',scripts:{check:'tsc --noEmit'},dependencies:{vue:'latest'}}));fs.writeFileSync(path.join(root,'package-lock.json'),'{}');fs.writeFileSync(path.join(root,'src','app.ts'),'// TODO: add localization\nexport function greet(name: string) { return name }\nconsole.log(greet("Ada"))\n');fs.writeFileSync(path.join(root,'src','copy.ts'),'export function greet(name: string) { return name.toUpperCase() }\n')
 const project=JSON.parse(call(root,'inspect_project',{}));assert.equal(project.package.name,'fixture');assert.equal(project.package.frameworks[0],'vue');assert.equal(project.languages.TypeScript,2)
 const outline=JSON.parse(call(root,'code_outline',{path:'src/app.ts'}));assert.equal(outline.symbols[0].name,'greet');assert.equal(outline.symbols[0].line,2)
 const symbols=JSON.parse(call(root,'find_symbol',{query:'greet'}));assert.equal(symbols.matches[0].path,'src/app.ts');assert.equal(symbols.matches[0].line,2)
 const fileSymbols=JSON.parse(call(root,'find_symbol',{query:'greet',path:'src/app.ts'}));assert.deepEqual(fileSymbols.matches.map(match=>match.path),['src/app.ts'])
 const references=JSON.parse(call(root,'find_references',{query:'greet'}));assert.equal(references.matches.length,3)
 const fileReferences=JSON.parse(call(root,'find_references',{query:'greet',path:'src/app.ts'}));assert.equal(fileReferences.matches.length,2)
 const todos=JSON.parse(call(root,'find_todos',{}));assert.equal(todos.matches[0].tag,'TODO')
 const dependencies=JSON.parse(call(root,'dependency_report',{}));assert.equal(dependencies.dependencies.dependencies[0].name,'vue');assert.deepEqual(dependencies.lockfiles,['package-lock.json'])
 const info=JSON.parse(call(root,'file_info',{path:'src/app.ts'}));assert.equal(info.kind,'file');assert.equal(info.lines,3);assert.match(info.sha256,/^[a-f0-9]{64}$/)
 const compared=JSON.parse(call(root,'compare_files',{left:'src/app.ts',right:'src/copy.ts'}));assert.equal(compared.identical,false);assert.match(compared.output,/toUpperCase/)
 const processes=JSON.parse(call(root,'process_status',{query:'python',limit:5}));assert.ok(Array.isArray(processes.processes))
})

test('search reports pagination and reads several bounded source ranges',t=>{
 const root=sandbox(t);fs.mkdirSync(path.join(root,'src'))
 fs.writeFileSync(path.join(root,'src','a.ts'),'export const alpha = 1\n')
 fs.writeFileSync(path.join(root,'src','b.ts'),'export const alpha = 2\n')
 fs.writeFileSync(path.join(root,'src','ignore.md'),'alpha\n')
 const first=JSON.parse(call(root,'search_files',{query:'alpha\\s*=',mode:'regex',glob:'src/*.ts',limit:1}))
 assert.equal(first.matches.length,1);assert.equal(first.truncated,true);assert.equal(first.nextOffset,1)
 const second=JSON.parse(call(root,'search_files',{query:'alpha\\s*=',mode:'regex',glob:'src/*.ts',limit:1,offset:first.nextOffset}))
 assert.equal(second.matches.length,1);assert.notEqual(first.matches[0].path,second.matches[0].path)
 const read=JSON.parse(call(root,'read_files',{files:[{path:'src/a.ts'},{path:'src/b.ts'}]}))
 assert.equal(read.files.length,2);assert.match(read.files[0].text,/alpha = 1/)
})

test('targeted tests select the native Node runner from package scripts',t=>{
 const root=sandbox(t);fs.mkdirSync(path.join(root,'tests'))
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.mjs'}}))
 fs.writeFileSync(path.join(root,'tests','sample.test.mjs'),"import {test} from 'node:test'; test('selected case',()=>{});\n")
 const result=JSON.parse(call(root,'run_test_case',{target:'tests/sample.test.mjs',name:'selected case'}))
 assert.equal(result.exitCode,0);assert.deepEqual(result.command.slice(0,2),['node','--test'])
})

test('Vue code outline uses the TypeScript parser when the project provides it',()=>{
 const outline=JSON.parse(call(process.cwd(),'code_outline',{path:'src/LocalAiStudio.vue'}))
 assert.equal(outline.parser,'typescript')
 assert.ok(outline.symbols.some(symbol=>symbol.name==='selectNavigation'))
})

test('existing DOCX and XLSX can be edited with version checked plans',t=>{
 const root=sandbox(t)
 const createdDoc=JSON.parse(call(root,'create_document',{path:'report.docx',title:'Title',content:'Old value'},{phase:'plan'}))
 call(root,'create_document',{},{phase:'commit',plan:createdDoc.plan})
 const editedDoc=JSON.parse(call(root,'replace_document_text',{path:'report.docx',oldText:'Old',newText:'New'},{phase:'plan'}))
 call(root,'replace_document_text',{},{phase:'commit',plan:editedDoc.plan})
 assert.match(JSON.parse(call(root,'read_document',{path:'report.docx'})).text,/New value/)
 const createdSheet=JSON.parse(call(root,'create_spreadsheet',{path:'report.xlsx',sheets:[{name:'Data',rows:[['Name','Count'],['A',2]]}]},{phase:'plan'}))
 call(root,'create_spreadsheet',{},{phase:'commit',plan:createdSheet.plan})
 const editedSheet=JSON.parse(call(root,'update_spreadsheet_cells',{path:'report.xlsx',sheet:'Data',updates:[{cell:'A2',value:'B'},{cell:'B2',value:3}]},{phase:'plan'}))
 call(root,'update_spreadsheet_cells',{},{phase:'commit',plan:editedSheet.plan})
 assert.match(JSON.parse(call(root,'read_document',{path:'report.xlsx'})).text,/B\t3/)
})

test('Python worker reads bounded Git commit and blame details',t=>{
 const root=sandbox(t);fs.writeFileSync(path.join(root,'tracked.txt'),'first\nsecond\n')
 for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','fixture@example.test'],['add','tracked.txt'],['commit','-m','initial']]){const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr)}
 const shown=JSON.parse(call(root,'git_show',{ref:'HEAD',path:'tracked.txt',patch:true}));assert.match(shown.output,/initial/);assert.match(shown.output,/\+first/)
 const blamed=JSON.parse(call(root,'git_blame',{path:'tracked.txt',startLine:2,endLine:2}));assert.equal(blamed.startLine,2);assert.match(blamed.output,/Fixture/)
})

test('Python worker returns structured diagnostics, targeted test results and localhost HTTP',async t=>{
 const root=sandbox(t);fs.writeFileSync(path.join(root,'broken.py'),'def broken(:\n');const diagnostics=JSON.parse(call(root,'get_diagnostics',{checker:'python',path:'broken.py'}));assert.notEqual(diagnostics.exitCode,0);assert.match(diagnostics.output,/SyntaxError/)
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node test-runner.cjs'}}));fs.writeFileSync(path.join(root,'test-runner.cjs'),'console.log("passed selected test", process.argv.slice(2).join(" "))');fs.writeFileSync(path.join(root,'sample.test.js'),'// fixture');const tested=JSON.parse(call(root,'run_test_case',{target:'sample.test.js',runner:'npm',name:'selected'}));assert.equal(tested.exitCode,0);assert.match(tested.output,/passed selected test/)
 const server=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true}))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const address=server.address();const http=JSON.parse(await callAsync(root,'http_request',{url:`http://127.0.0.1:${address.port}/health`}));assert.equal(http.status,200);assert.deepEqual(JSON.parse(http.body),{ok:true})
 const processes=JSON.parse(await callAsync(root,'process_status',{port:address.port,limit:10}))
 if(processes.listenerLookupAvailable)assert.ok(processes.listeners.some(listener=>listener.address.includes(':'+address.port)))
})

test('image OCR either runs locally or reports its optional dependency clearly',t=>{
 const root=sandbox(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(root,'pixel.png'),png)
 const run=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'image_ocr',args:{path:'pixel.png'}}),encoding:'utf8'}),envelope=JSON.parse(run.stdout)
 if(run.status===0){const result=JSON.parse(envelope.output);assert.ok(['rapidocr-onnxruntime','pytesseract','tesseract-cli'].includes(result.provider))}else assert.match(envelope.error,/OCR|Tesseract|requirements/)
})

test('scanned PDF OCR reads a bounded page when local tools are available',t=>{
 const root=sandbox(t),parts=['%PDF-1.4\n'],objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Length 54 >>\nstream\nBT /F1 28 Tf 20 40 Td (HELLO OCR) Tj ET\nendstream'
 ],offsets=[0]
 for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(parts.join('')));parts.push(`${i+1} 0 obj\n${objects[i]}\nendobj\n`)}
 const xref=Buffer.byteLength(parts.join(''));parts.push(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`)
 for(const offset of offsets.slice(1))parts.push(`${String(offset).padStart(10,'0')} 00000 n \n`)
 parts.push(`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
 fs.writeFileSync(path.join(root,'scan.pdf'),parts.join(''))
 const run=spawnSync(python,[worker],{input:JSON.stringify({workspace:root,tool:'pdf_ocr',args:{path:'scan.pdf',pageCount:1}}),encoding:'utf8'})
 if(run.status!==0){assert.match(JSON.parse(run.stdout).error,/Poppler|Tesseract/);return}
 const result=JSON.parse(JSON.parse(run.stdout).output)
 assert.equal(result.pageCount,1);assert.match(result.pages[0].text,/HELLO OCR/i)
})

test('tool store increments immutable versions and restores by creating a new version',t=>{
 const root=sandbox(t),file=path.join(root,'tools.json'),runtime={revision:()=> 'runtime-v1',execute:async()=>({output:'ok',elapsedMs:1})},store=new AgentToolStore(file,runtime)
 assert.equal(store.list().length,37);assert.ok(store.list().every(tool=>tool.current.runtimeRevision==='runtime-v1'))
 const created=store.save({key:'hello_python',name:'问候',description:'返回问候',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},python:'def execute(args, context):\n    return {"hello": args["name"]}\n',risk:'read',timeoutMs:5000,changeNote:'创建'})
 assert.equal(created.activeVersion,1);assert.equal(created.current.risk,'high','user Python remains high risk')
 const changed=store.save({id:created.id,key:created.key,name:'问候',description:'返回新的问候',parameters:created.current.parameters,python:created.current.python,risk:'high',timeoutMs:5000,changeNote:'修改说明'});assert.equal(changed.activeVersion,2);assert.equal(changed.versions.length,2)
 const restored=store.restore(created.id,1);assert.equal(restored.activeVersion,3);assert.equal(restored.current.description,'返回问候');assert.equal(restored.versions.length,3)
})

test('tool store routes built-in, control and custom tool versions through Python',async t=>{
 const root=sandbox(t),file=path.join(root,'tools.json')
 const runtime={revision:()=> 'runtime-v1',execute:async request=>({output:call(request.workspace,request.tool,request.args,request.context,request.code),elapsedMs:1})}
 const store=new AgentToolStore(file,runtime),signal=new AbortController().signal
 fs.writeFileSync(path.join(root,'input.txt'),'from python')
 const specs=store.specs(root),byName=name=>specs.find(spec=>spec.definition.function.name===name)
 assert.match(JSON.parse(await byName('read_file').execute({path:'input.txt'},signal)).text,/from python/)
 assert.deepEqual(JSON.parse(await byName('set_plan').execute({steps:[{text:'检查',status:'pending'}]},signal)).steps,[{text:'检查',status:'pending'}])
 assert.match(JSON.parse(await byName('read_history').execute({query:'needle'},signal,{history:[{role:'user',content:'needle'}]})).text,/needle/)
 const written=JSON.parse(await byName('write_file').execute({path:'output.txt',content:'saved'},signal));assert.deepEqual(written.paths,['output.txt']);assert.equal(written._preview.path,'output.txt');assert.equal(written._preview.after,'saved')
 assert.equal(fs.readFileSync(path.join(root,'output.txt'),'utf8'),'saved')
 const custom=store.save({key:'context_value',name:'上下文',description:'读取执行上下文',parameters:{type:'object',properties:{},additionalProperties:false},python:'def execute(args, context):\n    return context.get("marker", "missing")\n',risk:'read',timeoutMs:5000,changeNote:'创建'})
 const customSpec=store.specs(root).find(spec=>spec.definition.function.name===custom.key)
 assert.equal(await customSpec.execute({},signal,{marker:'passed'}),'passed')
})

test('existing managed tool definitions upgrade while edited definitions stay intact',t=>{
 const root=sandbox(t),file=path.join(root,'tools.json'),runtime={revision:()=> 'runtime-v1'}
 new AgentToolStore(file,runtime)
 const persisted=JSON.parse(fs.readFileSync(file,'utf8'))
 const search=persisted.find(tool=>tool.key==='search_files');search.versions[0].parameters={type:'object',properties:{query:{type:'string'}},required:['query']}
 const custom=persisted.find(tool=>tool.key==='read_files');custom.versions[0].description='自定义说明';custom.versions[0].changeNote='用户编辑'
 fs.writeFileSync(file,JSON.stringify(persisted))
 const upgraded=new AgentToolStore(file,runtime)
 assert.ok(upgraded.list().find(tool=>tool.key==='search_files').current.parameters.properties.mode)
 assert.equal(upgraded.list().find(tool=>tool.key==='read_files').current.description,'自定义说明')
})

test('document edits use prepared preview and version checked commit',async t=>{
 const root=sandbox(t),file=path.join(root,'tools.json')
 const runtime={revision:()=> 'runtime-v1',execute:async request=>({output:call(request.workspace,request.tool,request.args,request.context,request.code),elapsedMs:1})}
 const store=new AgentToolStore(file,runtime),signal=new AbortController().signal
 const created=JSON.parse(call(root,'create_document',{path:'existing.docx',title:'Title',content:'Old'},{phase:'plan'}))
 call(root,'create_document',{},{phase:'commit',plan:created.plan})
 const spec=store.specs(root).find(item=>item.definition.function.name==='replace_document_text')
 const prepared=await spec.prepare({path:'existing.docx',oldText:'Old',newText:'New'},signal,{})
 assert.match(prepared.preview.after,/Old → New/)
 assert.match(JSON.parse(await prepared.execute(signal)).paths[0],/existing\.docx/)
 assert.match(JSON.parse(call(root,'read_document',{path:'existing.docx'})).text,/New/)
})


test('modified builtin executes once, retains high risk across saves and runtime upgrades',async t=>{
 const root=sandbox(t),file=path.join(root,'tools.json');let calls=0
 const runtime={revision:()=> 'runtime-v1',execute:async()=>{calls++;return {output:'{"ok":true}',elapsedMs:1}}}
 const store=new AgentToolStore(file,runtime),original=store.list().find(tool=>tool.key==='write_file')
 const input={id:original.id,key:original.key,...original.current,risk:'read',python:'def execute(args, context):\n    # builtin( is only a comment\n    return {"ok": True}\n'}
 const modified=store.save(input);assert.equal(modified.current.risk,'high')
 assert.equal(store.save(input).current.risk,'high')
 const spec=store.specs(root).find(item=>item.definition.function.name==='write_file')
 assert.equal(spec.prepare,undefined);await spec.execute({},new AbortController().signal);assert.equal(calls,1)
 const restarted=new AgentToolStore(file,{...runtime,revision:()=> 'runtime-v2'})
 const current=restarted.list().find(tool=>tool.id===original.id)
 assert.equal(current.activeVersion,3,'custom implementation must not receive runtime-only versions')
 assert.equal(current.current.risk,'high');assert.equal(current.current.runtimeRevision,undefined)
 const snapshot=restarted.version(original.id);snapshot.version.risk='read'
 assert.equal(restarted.version(original.id).version.risk,'high','returned versions cannot mutate the store')
})

test('builtin risk floors apply to saves, restore and previously persisted unsafe versions',t=>{
 const root=sandbox(t),file=path.join(root,'tools.json'),runtime={revision:()=> 'runtime-v1'},store=new AgentToolStore(file,runtime)
 for(const key of ['write_file','run_command']){
  const original=store.list().find(tool=>tool.key===key)
  const saved=store.save({id:original.id,key,...original.current,risk:'read'})
  assert.equal(saved.current.risk,key==='write_file'?'write':'high')
  assert.equal(store.restore(original.id,1).current.risk,saved.current.risk)
 }
 const persisted=JSON.parse(fs.readFileSync(file,'utf8'))
 const modified=persisted.find(tool=>tool.key==='read_file');modified.versions[0].python+='\n# changed implementation';modified.versions[0].risk='read'
 const command=persisted.find(tool=>tool.key==='run_command');for(const version of command.versions)version.risk='read'
 fs.writeFileSync(file,JSON.stringify(persisted))
 const restarted=new AgentToolStore(file,runtime)
 assert.equal(restarted.version(modified.id,1).version.risk,'high')
 assert.ok(restarted.list().find(tool=>tool.id===command.id).versions.every(version=>version.risk==='high'))
})


test('running tool snapshots keep their original implementation and schema after an update',async t=>{
 const root=sandbox(t),runtime={revision:()=> 'v1',execute:async request=>({output:request.code,elapsedMs:1})},store=new AgentToolStore(path.join(root,'tools.json'),runtime)
 const input={key:'snapshot_tool',name:'snapshot',description:'version one',parameters:{type:'object',properties:{},additionalProperties:false},python:'def execute(args, context):\n    return 1\n',risk:'high',timeoutMs:1000}
 const original=store.save(input),snapshot=store.specs(root).find(spec=>spec.definition.function.name===input.key)
 store.save({...input,id:original.id,description:'version two',python:'def execute(args, context):\n    return 2\n'})
 assert.equal(snapshot.definition.function.description,'version one')
 assert.equal(await snapshot.execute({},new AbortController().signal),input.python)
 const next=store.specs(root).find(spec=>spec.definition.function.name===input.key)
 assert.equal(next.definition.function.description,'version two');assert.notEqual(next.revision,snapshot.revision)
})
