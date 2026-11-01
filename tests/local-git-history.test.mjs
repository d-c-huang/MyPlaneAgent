import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {withLocalGitHistory} from '../dist-electron/main/agent/local-git-history.js'
import {isolatedGitWorkspace} from './helpers/workspace.mjs'

const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const workspace=t=>{
 const root=isolatedGitWorkspace('myplane-local-git-')
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 return root
}
const write=(root,name,content)=>withLocalGitHistory(root,[name],async()=>{
 fs.writeFileSync(path.join(root,name),content)
 return JSON.stringify({status:'saved'})
})

test('local history saves original and successive versions without a remote',async t=>{
 const root=workspace(t)
 fs.writeFileSync(path.join(root,'app.txt'),'original')
 fs.writeFileSync(path.join(root,'unrelated.txt'),'leave untracked')
 assert.deepEqual(JSON.parse(await write(root,'app.txt','first')),{status:'saved'})
 await write(root,'app.txt','second')
 assert.equal(git(root,'show','HEAD:app.txt'),'second')
 assert.equal(git(root,'show','HEAD~1:app.txt'),'first')
 assert.equal(git(root,'show','HEAD~2:app.txt'),'original')
 assert.equal(git(root,'rev-list','--count','HEAD'),'3')
 assert.equal(git(root,'remote','-v'),'')
 assert.equal(git(root,'ls-files'),'app.txt')
 await write(root,'app.txt','second')
 assert.equal(git(root,'rev-list','--count','HEAD'),'3')
})

test('new files are tracked while ignored files and staged user changes are preserved',async t=>{
 const root=workspace(t)
 fs.writeFileSync(path.join(root,'.gitignore'),'ignored.txt\n')
 await write(root,'new.txt','new')
 await write(root,'ignored.txt','ignored')
 assert.equal(git(root,'ls-files'),'new.txt')
 fs.writeFileSync(path.join(root,'manual.txt'),'manual')
 git(root,'add','manual.txt')
 await write(root,'new.txt','updated')
 assert.equal(git(root,'diff','--cached','--name-only'),'manual.txt')
 assert.equal(git(root,'show','HEAD:new.txt'),'updated')
})

test('existing repositories and parent repositories are not auto managed',async t=>{
 const root=workspace(t)
 git(root,'init','--template=')
 await write(root,'existing.txt','content')
 assert.equal(git(root,'ls-files'),'')
 assert.equal(fs.readFileSync(path.join(root,'.git','config'),'utf8').includes('localHistory'),false)
 const child=path.join(root,'child');fs.mkdirSync(child)
 await write(child,'nested.txt','content')
 assert.equal(fs.existsSync(path.join(child,'.git')),false)
})

test('Git initialization failure reports a warning and still writes the file',async t=>{
 const root=workspace(t)
 const oldPath=process.env.PATH
 process.env.PATH=''
 try{
  const output=JSON.parse(await write(root,'app.txt','saved'))
  assert.equal(output.status,'saved')
  assert.match(output.localHistoryWarning,/本地 Git 记录不可用/)
  assert.equal(fs.readFileSync(path.join(root,'app.txt'),'utf8'),'saved')
 }finally{process.env.PATH=oldPath}
})
