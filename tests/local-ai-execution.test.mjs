import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {ExecutionJournal,contentHash} from '../dist-electron/main/agent/execution-journal.js'
import {AgentWorkspace} from '../dist-electron/main/agent/workspace.js'
import {inspectBuild,prepareBuild,parseDiagnostics} from '../dist-electron/main/agent/build-profile.js'
import {analyzeTestResult,parseFailedTests} from '../dist-electron/main/agent/test-analysis.js'
import {executeProcess} from '../dist-electron/main/agent/execution-supervisor.js'
import {buildSandboxedRequest,sandboxCapability} from '../dist-electron/main/agent/execution-sandbox.js'
import {PythonToolRuntime} from '../dist-electron/main/agent/python.js'
import {AgentToolStore} from '../dist-electron/main/agent/tool-store.js'
import {LocalAgentService} from '../dist-electron/main/agent/service.js'
const signal=()=>new AbortController().signal
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check){for(let i=0;i<1000;i++){if(check())return;await pause(10)}throw new Error('Timed out')}
function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-execution-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root}
const record=(taskId,expectedFiles=[])=>({id:randomUUID(),taskId,tool:'write_file',source:'builtin',argumentHash:'fixture',state:'running',effectful:true,expectedFiles,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})
const call=(name,args)=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}})
const response=(content,tool_calls)=>({choices:[{finish_reason:tool_calls?'tool_calls':'stop',message:{role:'assistant',content,tool_calls}}]})

test('journal reconciles complete, unchanged and partially applied writes after reopening',t=>{
 const root=sandbox(t),journal=new ExecutionJournal(root),workspace=new AgentWorkspace(root),task=randomUUID()
 fs.writeFileSync(path.join(root,'a'),'after');fs.writeFileSync(path.join(root,'b'),'before')
 const expected=name=>({path:name,beforeHash:contentHash('before'),afterHash:contentHash('after')})
 const completed=journal.save(record(task,[expected('a')])),unchanged=journal.save(record(task,[expected('b')])),partial=journal.save(record(task,[expected('a'),expected('b')]))
 const reopened=new ExecutionJournal(root)
 for(const item of reopened.list(task))reopened.reconcile(item,workspace)
 const byId=id=>reopened.list(task).find(item=>item.id===id)
 assert.equal(byId(completed.id).state,'succeeded');assert.equal(byId(unchanged.id).state,'not-applied');assert.equal(byId(partial.id).state,'unknown')
 assert.equal(fs.readFileSync(path.join(root,'b'),'utf8'),'before','reconciliation never replays a write')
 reopened.resolve(task,partial.id,'completed','核对了实际文件');assert.equal(byId(partial.id).verification.status,'unverified')
 assert.throws(()=>reopened.resolve(task,partial.id,'completed','again'))
})

test('build discovery is read-only, captures diagnostic locations and rejects changed configuration',async t=>{
 const root=sandbox(t),workspace=new AgentWorkspace(root)
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{build:'node build.cjs'}}))
 fs.writeFileSync(path.join(root,'build.cjs'),"console.log('src/main.ts(4,2): error TS2322: Type mismatch');process.exitCode=2")
 const profile=inspectBuild(workspace);assert.equal(profile.kind,'node');assert.deepEqual(profile.scripts,['build'])
 const prepared=prepareBuild(workspace,{action:'build'});const result=JSON.parse(await prepared.execute(signal()))
 assert.equal(result.exitCode,2);assert.deepEqual(result.diagnostics[0],{file:'src/main.ts',line:4,column:2,severity:'error',code:'TS2322',message:'Type mismatch'});assert.equal(result.validation.passed,false);assert.equal(result.failureAnalysis.category,'unknown');assert.equal(result.failureAnalysis.retryPolicy.automatic,false)
 const stale=prepareBuild(workspace,{action:'build'});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{build:'node something-else.cjs'}}))
 await assert.rejects(stale.execute(signal()),/配置或锁文件/)
 assert.throws(()=>prepareBuild(workspace,{action:'build & echo BAD'}),/未定义/)
 assert.equal(parseDiagnostics('C:\\src\\a.c:10:2: error: bad')[0].line,10)
})

test('test failures are classified with evidence and bounded retry policies',()=>{
 const assertion=analyzeTestResult({exitCode:1,output:'not ok 1 - cancels a paid order\nAssertionError: expected cancelled received paid'},[],'test')
 assert.equal(assertion.category,'assertion');assert.deepEqual(assertion.failedTests,['cancels a paid order']);assert.equal(assertion.retryPolicy.controlledRerun,false);assert.match(assertion.guardrails[0],/删除、跳过或弱化/)
 const transient=analyzeTestResult({exitCode:1,output:'socket hang up ECONNRESET'},[],'test')
 assert.equal(transient.category,'transient');assert.equal(transient.retryPolicy.controlledRerun,true);assert.equal(transient.retryPolicy.maxAttempts,1);assert.equal(transient.retryPolicy.automatic,false)
 const dependency=analyzeTestResult({exitCode:1,output:"ModuleNotFoundError: No module named 'pytest'"},[],'test')
 assert.equal(dependency.category,'dependency');assert.equal(dependency.retryPolicy.maxAttempts,0)
 const timeout=analyzeTestResult({exitCode:null,output:'',termination:'timeout',error:'命令超过运行时间限制'},[],'test')
 assert.equal(timeout.category,'timeout');assert.equal(timeout.confidence,1);assert.equal(timeout.retryPolicy.controlledRerun,false)
 assert.deepEqual(parseFailedTests('FAILED tests/test_order.py::test_cancel - AssertionError\nFAIL src/order.test.ts'),['tests/test_order.py::test_cancel','src/order.test.ts'])
})

test('managed run_test returns failure analysis before its raw output',async t=>{
 const root=sandbox(t),runtime=new PythonToolRuntime()
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node failing.cjs'}}))
  fs.writeFileSync(path.join(root,'failing.cjs'),"console.log('not ok 1 - fixture case\\nAssertionError: expected yes received no');process.exit(1)")
  const store=new AgentToolStore(path.join(root,'tools.json'),runtime),spec=store.specs(root).find(item=>item.definition.function.name==='run_test')
  const prepared=await spec.prepare({script:'test',timeoutSeconds:10},signal(),{})
  const result=JSON.parse(await prepared.execute(signal()))
  assert.equal(result.exitCode,1);assert.equal(result.failureAnalysis.category,'assertion');assert.deepEqual(result.failureAnalysis.failedTests,['fixture case']);assert.equal(result.failureAnalysis.retryPolicy.automatic,false)
 }finally{await runtime.dispose()}
})

test('supervisor retains long output and split UTF-8; cancellation and timeout are explicit',async t=>{
 const root=sandbox(t)
 const result=await executeProcess({executable:process.execPath,args:['-e',"const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stdout.write('x'.repeat(50000))},10)"],cwd:root,timeoutMs:3000},signal())
 assert.equal(result.exitCode,0);assert.ok(result.output.startsWith('中文'));assert.ok(result.output.length>32000);assert.equal(result.truncated,false)
 const request={executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root,timeoutMs:100}
 const timed=await executeProcess(request,signal());assert.equal(timed.termination,'timeout')
 const controller=new AbortController(),pending=executeProcess({...request,timeoutMs:5000},controller.signal);setTimeout(()=>controller.abort(),50)
 assert.equal((await pending).termination,'cancelled')
})

for(const first of ['cancelled','timeout']){
 test(`supervisor preserves ${first} when another stop reason arrives during process cleanup`,{timeout:15000},async t=>{
  const root=sandbox(t),controller=new AbortController(),nativeTimeout=globalThis.setTimeout
  let deadline,ready
  const started=new Promise(resolve=>{ready=resolve})
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
   if(delay===60000)deadline=()=>callback(...args)
   return nativeTimeout(callback,delay,...args)
  })
  t.after(()=>controller.abort())
  const pending=executeProcess({executable:process.execPath,args:['-e',"console.log('READY');setInterval(()=>{},1000)"],cwd:root,timeoutMs:60000},controller.signal,output=>{if(output.includes('READY'))ready()})
  await Promise.race([started,pending.then(()=>assert.fail('fixture exited before it was ready'))])
  assert.equal(typeof deadline,'function')
  if(first==='cancelled'){controller.abort();deadline()}else{deadline();controller.abort()}
  const result=await pending
  assert.equal(result.termination,first)
  assert.match(result.error,first==='cancelled'?/已停止/:/超过运行时间/)
 })
}

test('sandbox wrapper disables network, drops privileges and host fallback uses a temporary home',async t=>{
 const root=sandbox(t),wrapped=buildSandboxedRequest({executable:'node',args:['-e',"console.log('ok')"],cwd:root},{available:true,runtime:'docker',image:'fixture:latest',reason:'fixture'})
 assert.equal(wrapped.executable,'docker');assert.ok(wrapped.args.includes('none'));assert.ok(wrapped.args.includes('ALL'));assert.ok(wrapped.args.includes('no-new-privileges'));assert.ok(wrapped.args.includes('fixture:latest'));assert.ok(wrapped.args.some(value=>value===`${path.resolve(root)}:/workspace:rw`))
 const previous=process.env.MYPLANE_SANDBOX_DISABLE;process.env.MYPLANE_SANDBOX_DISABLE='1';t.after(()=>{if(previous===undefined)delete process.env.MYPLANE_SANDBOX_DISABLE;else process.env.MYPLANE_SANDBOX_DISABLE=previous;sandboxCapability(true)})
 sandboxCapability(true)
 const result=await executeProcess({executable:process.execPath,args:['-e','console.log(process.env.HOME)'],cwd:root,timeoutMs:3000,sandbox:'prefer'},signal())
 const temporary=result.output.trim();assert.equal(result.sandbox.active,false);assert.equal(result.sandbox.home,'temporary');assert.notEqual(temporary,process.env.HOME);assert.equal(fs.existsSync(temporary),false)
})

test('cancelling one Python invocation does not terminate another invocation',async t=>{
 const root=sandbox(t),runtime=new PythonToolRuntime(),controller=new AbortController()
 try{
  const slow=runtime.execute({tool:'slow',workspace:root,args:{},code:'def execute(args, context):\n    import time\n    time.sleep(10)\n    return "slow"'},controller.signal)
  const rejected=assert.rejects(slow,/停止/)
  const fast=runtime.execute({tool:'fast',workspace:root,args:{},code:'def execute(args, context):\n    import time\n    time.sleep(0.2)\n    return "survived"'},signal())
  setTimeout(()=>controller.abort(),80);assert.equal((await fast).output,'survived');await rejected
 }finally{await runtime.dispose()}
})

test('supervisor cancellation terminates a spawned child process',async t=>{
 const root=sandbox(t),controller=new AbortController(),pidFile=path.join(root,'child.pid')
 const code="const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000)"
 const pending=executeProcess({executable:process.execPath,args:['-e',code],cwd:root,timeoutMs:10000},controller.signal)
 await until(()=>fs.existsSync(pidFile));const pid=Number(fs.readFileSync(pidFile,'utf8'));controller.abort();assert.equal((await pending).termination,'cancelled')
 await until(()=>{try{process.kill(pid,0);return false}catch{return true}})
})

test('Python batch patch rolls back earlier files when a later rename fails',async t=>{
 const root=sandbox(t),runtime=new PythonToolRuntime()
 try{
  fs.writeFileSync(path.join(root,'a'),'old-a');fs.writeFileSync(path.join(root,'b'),'old-b')
  const changes=[{path:'a',before:'old-a',after:'new-a'},{path:'b',before:'old-b',after:'new-b'}]
  const planned=JSON.parse((await runtime.execute({tool:'apply_patch',workspace:root,args:{changes},context:{phase:'plan'}},signal())).output)
  const code='def execute(args, context):\n    import os\n    original = os.replace\n    def fail_second(src, dst):\n        if str(dst).endswith("b"):\n            raise OSError("injected rename failure")\n        return original(src, dst)\n    os.replace = fail_second\n    return builtin("apply_patch", args, context)\n'
  await assert.rejects(runtime.execute({tool:'apply_patch',workspace:root,args:{},context:{phase:'commit',plan:planned.plan},code},signal()),/已回退/)
  assert.equal(fs.readFileSync(path.join(root,'a'),'utf8'),'old-a');assert.equal(fs.readFileSync(path.join(root,'b'),'utf8'),'old-b')
 }finally{await runtime.dispose()}
})

test('managed Python file preparation occurs before execution and includes byte-accurate expectations',async t=>{
 const root=sandbox(t),runtime=new PythonToolRuntime()
 try{
  const store=new AgentToolStore(path.join(root,'tools.json'),runtime),spec=store.specs(root).find(spec=>spec.definition.function.name==='apply_patch')
  fs.writeFileSync(path.join(root,'a.txt'),'old\r\n')
  const prepared=await spec.prepare({changes:[{path:'a.txt',before:'old\r\n',after:'new\r\n'}]},signal(),{})
  assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'old\r\n');assert.equal(prepared.expectedFiles[0].beforeHash,contentHash('old\r\n'))
  await prepared.execute(signal());assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'new\r\n')
  const stale=await spec.prepare({changes:[{path:'a.txt',before:'new\r\n',after:'newer'}]},signal(),{})
  fs.writeFileSync(path.join(root,'a.txt'),'user edit');await assert.rejects(stale.execute(signal()),/已被修改/);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'user edit')
 }finally{await runtime.dispose()}
})

async function harness(t,reply,external){
 const root=sandbox(t),workspace=path.join(root,'project');fs.mkdirSync(workspace)
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;try{res.end(JSON.stringify(await reply(JSON.parse(raw))))}catch(error){res.writeHead(500);res.end(String(error))}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
 const directory=path.join(root,'tasks'),connection=()=>({endpoint:`http://127.0.0.1:${server.address().port}/v1`,key:'',maxTokens:2048,contextLength:16384}),service=new LocalAgentService(directory,connection,external);t.after(()=>service.dispose())
 return {root,workspace,directory,connection,service,start:(extra={})=>service.start({workspace,mode:'coding',model:'fixture',prompt:'执行任务',maxSteps:10,approvalMode:'full',...extra},7,()=>{})}
}

test('unknown external side effects block further writes across continuation until explicitly reconciled',async t=>{
 let executions=0,round=0
 const external=()=>[{definition:{type:'function',function:{name:'external',description:'fixture',parameters:{type:'object',properties:{},additionalProperties:false}}},source:'mcp:test',risk:'high',timeoutMs:1000,execute:async()=>{executions++;throw new Error('connection lost')}}]
 const h=await harness(t,()=>response(null,[round++===0?call('external',{}):call('write_file',{path:'after.txt',content:'done'})]),external)
 const first=h.start();await until(()=>h.service.get(first.id).status==='waiting');h.service.approve(first.id,h.service.get(first.id).events.at(-1).id,true,7);await until(()=>!h.service.active(first.id));let task=h.service.get(first.id)
 const event=task.events.find(event=>event.tool==='external');assert.equal(event.execution.state,'unknown');assert.equal(executions,1)
 h.start({taskId:first.id,prompt:'继续'});await until(()=>!h.service.active(first.id));assert.equal(fs.existsSync(path.join(h.workspace,'after.txt')),false)
 h.service.resolveExecution(first.id,event.id,'completed','已核对外部服务，提交已完成')
 h.start({taskId:first.id,prompt:'继续后续写入',maxSteps:1});await until(()=>!h.service.active(first.id))
 task=h.service.get(first.id);assert.equal(fs.readFileSync(path.join(h.workspace,'after.txt'),'utf8'),'done');assert.equal(executions,1)
 const write=task.events.filter(event=>event.tool==='write_file').at(-1);assert.equal(write.execution.verification.status,'passed')
})

test('restart recovers a saved write even when task event was not saved after execution',async t=>{
 const h=await harness(t,()=>response('完成')),first=h.start();await until(()=>!h.service.active(first.id))
 const file=path.join(h.directory,first.id+'.json'),task=JSON.parse(fs.readFileSync(file,'utf8')),operation=record(first.id,[{path:'saved.txt',beforeHash:null,afterHash:contentHash('done')}])
 task.status='running';task.events.push({id:operation.id,kind:'tool',tool:'write_file',text:'write_file',status:'running',createdAt:new Date().toISOString()})
 fs.writeFileSync(file,JSON.stringify(task));new ExecutionJournal(h.directory).save(operation);fs.writeFileSync(path.join(h.workspace,'saved.txt'),'done')
 const restored=new LocalAgentService(h.directory,h.connection);t.after(()=>restored.dispose())
 const recovered=restored.get(first.id);assert.equal(recovered.events.at(-1).execution.state,'succeeded');assert.equal(recovered.events.at(-1).status,'completed');assert.ok(recovered.artifacts.some(item=>item.path==='saved.txt'))
})

test('continuing after restoring a file does not revive the old artifact from the execution journal',async t=>{
 let round=0
 const h=await harness(t,()=>round++===0?response(null,[call('write_file',{path:'created.txt',content:'temporary'})]):response('完成'))
 const first=h.start();await until(()=>!h.service.active(first.id));const write=h.service.get(first.id).events.find(event=>event.tool==='write_file')
 await h.service.restore(first.id,write.id);assert.equal(fs.existsSync(path.join(h.workspace,'created.txt')),false)
 h.start({taskId:first.id,prompt:'只确认恢复情况'});await until(()=>!h.service.active(first.id))
 assert.deepEqual(h.service.get(first.id).artifacts,[]);assert.ok(h.service.get(first.id).facts.pending.includes('恢复文件后需要重新验证'))
})
