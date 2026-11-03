import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {isReadOnlyCommand} from '../dist-electron/main/agent/core/read-only-command.js'
import {ExecutionRuntime} from '../dist-electron/main/agent/core/execution-runtime.js'
import {journalRequired} from '../dist-electron/main/agent/core/operation-journal.js'
import {isPreviewCommand} from '../dist-electron/main/agent/core/preview-command.js'

const cap={name:'agent.run_command',category:'agent',runtime:'python-native',source:{type:'skill',skillId:'agent-tools'},permissions:[],parameters:{type:'object'}}
test('read-only Node checks reject code execution, redirection, command chaining and shell expansion',()=>{
 for(const command of ['node --version','node.exe -v','node --check game.js','node -c "my game.mjs"']){
  assert.equal(isReadOnlyCommand(cap.name,{command}),true,command);assert.equal(journalRequired(cap,{command}),false)
 }
 for(const command of ['node game.js','node -e "doWork()"','node --check game.js; evil','node --check game.js > output.txt','node --check %INPUT%.js','node --check !INPUT!.js','node --check g^ame.js','node --check "$(evil).js"','node --check game.js --require evil.js','node --check *.js'])assert.equal(isReadOnlyCommand(cap.name,{command}),false,command)
 assert.equal(journalRequired({...cap,source:{type:'mcp',serverId:'third-party'}},{command:'node --version'}),true)
})
test('verify worker with an empty write scope can check syntax but cannot execute project code',async t=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-command-check-')),runtime=new ExecutionRuntime()
 t.after(async()=>{await runtime.dispose();fs.rmSync(workspace,{recursive:true,force:true})})
 fs.writeFileSync(path.join(workspace,'game.js'),'const board = []')
 let calls=0
 for(const command of ['node --version','node --check game.js']){
  const result=await runtime.execute(cap,{capability:cap.name,args:{command},workspace,execution:{taskId:'task',itemId:'verify',kind:'verify',mode:'verify',workspace,writeScopes:[[]]}},new AbortController().signal,async()=>{calls++;return {success:true,elapsedMs:1,output:{exitCode:0,stdout:'ok'}}})
  assert.equal(result.success,true,result.error)
 }
 const blocked=await runtime.execute(cap,{capability:cap.name,args:{command:'node -e "write()"'},workspace,execution:{taskId:'task',kind:'verify',mode:'verify',workspace,writeScopes:[[]]}},new AbortController().signal,async()=>assert.fail('must not run'))
 assert.equal(blocked.failureCode,'permission');assert.equal(calls,2)
})
test('preview worker can run its recognized preview command while retaining its empty write scope',async t=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'myplane-command-preview-')),runtime=new ExecutionRuntime()
 t.after(async()=>{await runtime.dispose();fs.rmSync(workspace,{recursive:true,force:true})})
 fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{dev:'vite'}}))
 assert.equal(isPreviewCommand(workspace,cap.name,{command:'npm run dev -- --host 127.0.0.1 --port 5174'}),true)
 for(const command of ['npm run dev --prefix C:/other','pnpm run dev --dir C:/other','yarn run dev --cwd C:/other','npm run dev --workspace other','npm run dev -- --config evil.js'])assert.equal(isPreviewCommand(workspace,cap.name,{command}),false,command)
 const request={capability:cap.name,args:{command:'npm run dev'},workspace,execution:{taskId:'task',kind:'preview',mode:'verify',workspace,writeScopes:[[]]}}
 const result=await runtime.execute(cap,request,new AbortController().signal,async()=>({success:true,elapsedMs:1,output:{exitCode:0}}))
 assert.equal(result.success,true,result.error)
 const rejected=await runtime.execute(cap,{...request,args:{command:'npm run dev && node evil.js'}},new AbortController().signal,async()=>assert.fail('must not run'))
 assert.equal(rejected.failureCode,'permission')
})
