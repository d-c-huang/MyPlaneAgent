import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {PythonRuntimeManager} from '../dist-electron/main/agent/core/python-runtime-manager.js'

function fixture(t,source,config){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-worker-'))
 fs.writeFileSync(path.join(root,'index.py'),source??`import json, os, pathlib, sys, time
print('READY', flush=True)
for line in sys.stdin:
    request=json.loads(line)
    args=request['args']
    if args.get('started'): pathlib.Path(args['started']).write_text('started')
    while args.get('gate') and not pathlib.Path(args['gate']).exists(): time.sleep(0.005)
    print(json.dumps({'type':'response','id':request['id'],'output':{'pid':os.getpid(),'value':args.get('value')},'elapsedMs':1}), flush=True)
`)
 const manager=new PythonRuntimeManager(root,config)
 t.after(async()=>{await manager.dispose();fs.rmSync(root,{recursive:true,force:true})})
 const run=(args,signal=new AbortController().signal)=>manager.execute({skillId:'fixture',skillPath:root,tool:'read',args,workspace:root,venv:false,timeout:5000},signal)
 return {root,manager,run}
}
async function started(file){
 for(let n=0;n<400;n++){if(fs.existsSync(file))return;await new Promise(resolve=>setTimeout(resolve,5))}
 assert.fail('Python request did not start')
}

test('concurrent subagents reuse one skill process without startup races',async t=>{
 const {manager,run}=fixture(t)
 const results=await Promise.all([run({value:'A'}),run({value:'B'})])
 assert.equal(results[0].output.pid,results[1].output.pid)
 assert.deepEqual(results.map(result=>result.output.value),['A','B'])
 assert.equal(manager.listWorkers().length,1)
 assert.equal(manager.listWorkers()[0].pendingTasks,0)
})

test('cancelling a queued or completed caller does not interrupt another subagent',async t=>{
 const {root,run}=fixture(t),firstController=new AbortController(),queuedController=new AbortController()
 const firstStarted=path.join(root,'first'),firstGate=path.join(root,'release-first')
 const first=run({started:firstStarted,gate:firstGate,value:'first'},firstController.signal)
 await started(firstStarted)
 const cancelled=assert.rejects(run({value:'cancelled'},queuedController.signal),/queued cancellation/)
 const secondStarted=path.join(root,'second'),secondGate=path.join(root,'release-second')
 const second=run({started:secondStarted,gate:secondGate,value:'second'})
 queuedController.abort(new Error('queued cancellation'))
 await cancelled
 fs.writeFileSync(firstGate,'go')
 const firstResult=await first
 await started(secondStarted)
 firstController.abort(new Error('old completed caller cancelled'))
 fs.writeFileSync(secondGate,'go')
 const secondResult=await second
 assert.equal(firstResult.output.pid,secondResult.output.pid)
 assert.equal(secondResult.output.value,'second')
})

test('active cancellation finishes stopping its process before a queued peer starts',async t=>{
 const {root,manager,run}=fixture(t),controller=new AbortController(),marker=path.join(root,'active')
 const cancelled=assert.rejects(run({started:marker,gate:path.join(root,'never')},controller.signal),/cancelled/i)
 await started(marker)
 const oldPid=manager.listWorkers()[0].pid
 const next=run({value:'recovered'})
 controller.abort()
 await cancelled
 const result=await next
 assert.notEqual(result.output.pid,oldPid)
 assert.equal((await run({value:'again'})).output.pid,result.output.pid)
})

test('disposing the runtime prevents queued callers from restarting a worker',async t=>{
 const {root,manager,run}=fixture(t),marker=path.join(root,'active')
 const active=assert.rejects(run({started:marker,gate:path.join(root,'never')}),/stopped/)
 await started(marker)
 const queued=assert.rejects(run({value:'must not start'}),/disposed/)
 await manager.dispose()
 await Promise.all([active,queued])
 assert.equal(manager.listWorkers().length,0)
 await assert.rejects(run({}),/disposed/)
})

const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
function stalledWorker(t){
 let pid
 // Ensure a regression cannot leave the deliberately unresponsive fixture alive.
 t.after(()=>{if(pid&&alive(pid))process.kill(pid)})
 const f=fixture(t,`import os, pathlib, time
pathlib.Path('pid').write_text(str(os.getpid()))
time.sleep(60)
`)
 return {...f,pid:async()=>{await started(path.join(f.root,'pid'));pid=Number(fs.readFileSync(path.join(f.root,'pid'),'utf8'));return pid}}
}

test('startup timeout terminates an unresponsive worker before rejecting',{timeout:15000},async t=>{
 const f=stalledWorker(t),rejected=assert.rejects(f.run({}),/Worker startup timeout/)
 const pid=await f.pid()
 await rejected
 assert.equal(alive(pid),false,'timed-out Python process must have exited')
 assert.deepEqual(f.manager.listWorkers(),[])
})

test('cancellation during startup terminates the process and preserves the reason',{timeout:15000},async t=>{
 const f=stalledWorker(t),controller=new AbortController(),reason=new Error('cancel startup')
 const rejected=assert.rejects(f.run({},controller.signal),error=>error===reason)
 const pid=await f.pid()
 controller.abort(reason)
 await rejected
 assert.equal(alive(pid),false)
 assert.deepEqual(f.manager.listWorkers(),[])
})

test('disposing during startup terminates the worker without waiting for readiness',{timeout:15000},async t=>{
 const f=stalledWorker(t),rejected=assert.rejects(f.run({}),/stopped|exited|disposed/i)
 const pid=await f.pid()
 await f.manager.dispose()
 await rejected
 assert.equal(alive(pid),false)
 assert.deepEqual(f.manager.listWorkers(),[])
})

test('startup reports the actual early exit instead of a readiness timeout',async t=>{
 const {manager,run}=fixture(t,'import sys\nsys.exit(23)\n')
 await assert.rejects(run({}),/Worker exited: code=23/)
 assert.deepEqual(manager.listWorkers(),[])
})

test('startup reports an executable error and removes the failed worker',async t=>{
 const {manager,run}=fixture(t,'',{pythonExecutable:path.join(os.tmpdir(),'myplane-python-does-not-exist')})
 await assert.rejects(run({}),/ENOENT/)
 assert.deepEqual(manager.listWorkers(),[])
})
