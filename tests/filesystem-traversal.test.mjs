import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {AgentWorkspace} from '../dist-electron/main/agent/workspace.js'

const python=process.env.MYPLANE_PYTHON||(process.platform==='win32'?'python':'python3')
const worker=path.resolve('python/agent_tools_worker.py')
const signal=()=>new AbortController().signal
function fixture(t){
 const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'myplane-traversal-'))
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),parent);assert.match(path.basename(root),/^myplane-traversal-/);fs.rmSync(root,{recursive:true,force:true})})
 return root
}
function pythonCall(workspace,tool,args={}){
 const result=spawnSync(python,[worker],{input:JSON.stringify({workspace,tool,args}),encoding:'utf8'})
 assert.ok(result.stdout,result.stderr)
 const envelope=JSON.parse(result.stdout)
 return {code:result.status,error:envelope.error,output:envelope.output?JSON.parse(envelope.output):undefined}
}

test('directory junctions and symlinks are reported without reading their targets',async t=>{
 const parent=fixture(t),root=path.join(parent,'workspace'),outside=path.join(parent,'outside')
 fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(path.join(root,'normal.txt'),'needle');fs.writeFileSync(path.join(outside,'secret.txt'),'needle')
 fs.symlinkSync(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir')
 const workspace=new AgentWorkspace(root)
 for(const tool of ['list_files','search_files']){
  const args=tool==='list_files'?{path:'.',depth:2}:{query:'needle'}
  const actual=pythonCall(root,tool,args);assert.equal(actual.code,0,actual.error)
  for(const result of [actual.output,JSON.parse(await workspace.query(tool,args,signal()))]){
   assert.equal(result.truncated,true)
   assert.deepEqual(result.skippedPaths??result.skipped,[{path:'linked',reason:'linked-path'}])
   if(tool==='list_files')assert.deepEqual(result.paths,['normal.txt'])
   else assert.deepEqual(result.matches.map(match=>match.path),['normal.txt'])
  }
 }
 assert.throws(()=>workspace.read('linked/secret.txt'),/符号链接/)
 const blocked=pythonCall(root,'read_file',{path:'linked/secret.txt'})
 assert.notEqual(blocked.code,0);assert.match(blocked.error,/符号链接|目录联接/)
})

test('Python scans retain readable siblings, retry skipped paths, and preserve root permission errors',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'blocked'));fs.writeFileSync(path.join(root,'blocked','inside.txt'),'needle');fs.writeFileSync(path.join(root,'normal.txt'),'needle')
 const script=`
import json,pathlib,sys
from unittest.mock import patch
sys.path.insert(0,'python')
from agent_tools_worker import listing,builtin,LIST_CACHE
root=pathlib.Path(sys.argv[1]).resolve()
original=pathlib.Path.iterdir
def denied(folder):
    if folder.name=='blocked': raise PermissionError('fixture denied')
    return original(folder)
with patch.object(pathlib.Path,'iterdir',denied):
    partial=listing(root)
    searched=json.loads(builtin('search_files',{'query':'needle'},{'workspace':str(root)}))
recovered=listing(root)
LIST_CACHE.clear()
root_denied=False
with patch.object(pathlib.Path,'iterdir',side_effect=PermissionError('root denied')):
    try: listing(root)
    except PermissionError: root_denied=True
print(json.dumps({'partial':partial,'searched':searched,'recovered':recovered,'rootDenied':root_denied}))
`
 const run=spawnSync(python,['-c',script,root],{encoding:'utf8'});assert.equal(run.status,0,run.stderr)
 const result=JSON.parse(run.stdout)
 assert.ok(result.partial.paths.includes('normal.txt'));assert.equal(result.partial.truncated,true)
 assert.deepEqual(result.partial.skipped,[{path:'blocked',reason:'permission-denied'}])
 assert.deepEqual(result.searched.matches.map(match=>match.path),['normal.txt'])
 assert.deepEqual(result.searched.skippedPaths,result.partial.skipped)
 assert.ok(result.searched.truncationReasons.includes('skipped-paths'))
 assert.ok(result.recovered.paths.includes('blocked/inside.txt'));assert.equal(result.recovered.cached,undefined)
 assert.equal(result.recovered.truncated,false);assert.equal(result.rootDenied,true)
})

test('native scans also retain readable siblings and preserve root permission errors',async t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'blocked'));fs.writeFileSync(path.join(root,'normal.txt'),'needle')
 const workspace=new AgentWorkspace(root),open=fs.opendirSync
 t.mock.method(fs,'opendirSync',function(directory,...args){
  if(path.basename(directory)==='blocked')throw Object.assign(new Error('fixture denied'),{code:'EACCES'})
  return open.call(this,directory,...args)
 })
 const partial=workspace.files(),searched=JSON.parse(await workspace.query('search_files',{query:'needle'},signal()))
 assert.ok(partial.paths.includes('normal.txt'));assert.equal(partial.truncated,true)
 assert.deepEqual(partial.skipped,[{path:'blocked',reason:'permission-denied'}])
 assert.deepEqual(searched.matches.map(match=>match.path),['normal.txt']);assert.deepEqual(searched.skippedPaths,partial.skipped)
 t.mock.restoreAll()
 t.mock.method(fs,'opendirSync',()=>{throw Object.assign(new Error('root denied'),{code:'EACCES'})})
 assert.throws(()=>workspace.files(),/root denied/)
})

test('Git status is explicitly inapplicable outside a repository without hiding real Git failures',async t=>{
 const root=fixture(t),workspace=new AgentWorkspace(root)
 const actual=pythonCall(root,'git_status');assert.equal(actual.code,0,actual.error)
 for(const result of [actual.output,JSON.parse(await workspace.query('git_status',{},signal()))]){
  assert.equal(result.repository,false);assert.equal(result.status,'not_applicable');assert.equal(result.output,undefined)
 }
 assert.equal(fs.existsSync(path.join(root,'.git')),false)
 assert.notEqual(pythonCall(root,'git_diff').code,0)
 await assert.rejects(workspace.query('git_diff',{},signal()),/Git 仓库/)
 fs.mkdirSync(path.join(root,'.git'))
 assert.notEqual(pythonCall(root,'git_status').code,0,'broken repositories remain errors')
 await assert.rejects(workspace.query('git_status',{},signal()),/Git 未成功/)
})
