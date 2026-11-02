import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
const shippedEngineHashes=new Set(['7bad8f898b1dae4f74472ae3e04c2e188a56667fb4a1630d70052d935034ff6e','ed45e6e3ca697b67e5333085450ce3faf675c8f21747e31afa7ac438a028bb93','4973454e09c45c34c139953f8c3d64fa1160697f12c81abf1c0e09cf81c92ea3','ec4ad0ab6568664440da6d6541caaa5a4ac0af96f44b59c834034f4f725c39fe'])
/** Upgrade only a recognized shipped engine. Keep user-edited engines and an immutable copy of the old one. */
export function upgradeBundledEngine(source:string,destination:string,history:string,knownHashes:ReadonlySet<string>=shippedEngineHashes):boolean{
  if(!fs.existsSync(source)||!fs.existsSync(destination))return false
  const previous=fs.readFileSync(destination),next=fs.readFileSync(source)
  const normalized=previous.toString('utf8').replace(/\r\n/g,'\n')
  if(previous.equals(next)||![normalized,normalized.endsWith('\n')?normalized:normalized+'\n'].some(value=>knownHashes.has(hash(Buffer.from(value)))))return false
  fs.mkdirSync(history,{recursive:true})
  const archive=path.join(history,hash(previous)+(path.extname(destination)||'.py'))
  if(!fs.existsSync(archive))fs.writeFileSync(archive,previous,{flag:'wx'})
  const temp=destination+'.'+randomUUID()+'.tmp'
  try{
    fs.writeFileSync(temp,next,{flag:'wx'})
    if(!fs.readFileSync(destination).equals(previous))return false
    fs.renameSync(temp,destination)
    return true
  }finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
}
