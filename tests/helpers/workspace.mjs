import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// A user's home or temp directory may itself belong to an existing repository.
// Tests of automatic Git initialization must start outside every repository.
export function isolatedGitWorkspace(prefix){
 const bases=process.env.MYPLANE_TEST_TEMP_DIR?[path.resolve(process.env.MYPLANE_TEST_TEMP_DIR)]:[
  os.tmpdir(),path.parse(fileURLToPath(import.meta.url)).root,path.parse(os.tmpdir()).root,
 ]
 const failures=[]
 for(const base of new Set(bases)){
  try{
   const resolved=fs.realpathSync(base)
   let inside=false
   for(let dir=resolved;;dir=path.dirname(dir)){
    if(fs.existsSync(path.join(dir,'.git'))){inside=true;break}
    if(path.dirname(dir)===dir)break
   }
   if(inside){failures.push(`${base}: inside an existing Git repository`);continue}
   return fs.mkdtempSync(path.join(resolved,prefix))
  }catch(error){failures.push(`${base}: ${error.message}`)}
 }
 throw new Error('Set MYPLANE_TEST_TEMP_DIR to a writable directory outside Git repositories. '+failures.join('; '))
}

export function workspaceCleanup(t,directory){
 const resources=[]
 t.after(async()=>{
  const results=await Promise.allSettled(resources.map(resource=>resource.dispose()))
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason)
  if(errors.length)throw new AggregateError(errors,'Test resources could not be released; workspace retained')
  fs.rmSync(directory,{recursive:true,force:true})
 })
 return resource=>{resources.push(resource);return resource}
}
