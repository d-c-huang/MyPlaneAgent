import fs from 'node:fs'
import {AgentWorkspace} from '../workspace.js'

/** Classifies a declared preview script; ordinary command approval still applies. */
export function isPreviewCommand(workspace:string,name:string,args:Record<string,unknown>):boolean {
  if(name!=='agent.run_command'||typeof args.command!=='string')return false
  const command=args.command.trim()
  if(/[;&|<>$`\r\n()\\]/.test(command))return false
  const match=command.match(/^(?:npm\s+(?:run\s+)?|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?)(dev|start|preview|serve)((?:\s+\S+)*)$/)
  if(!match)return /^python3?\s+-m\s+http\.server(?:\s+\d{1,5})?(?:\s+--bind\s+(?:localhost|127\.0\.0\.1))?$/.test(command)
  // The script must run from this workspace. Package-manager --prefix/--cwd/
  // --workspace flags can otherwise redirect an approved preview to other code.
  const argsList=match[2].trim().split(/\s+/).filter(Boolean)
  if(argsList[0]==='--')argsList.shift()
  for(let i=0;i<argsList.length;i++){
    const flag=argsList[i]
    if(flag==='--strictPort')continue
    if(/^--host=(?:localhost|127\.0\.0\.1)$/.test(flag)||/^--port=\d{1,5}$/.test(flag))continue
    if(flag==='--host'&&/^(?:localhost|127\.0\.0\.1)$/.test(argsList[i+1]||'')){i++;continue}
    if(flag==='--port'&&/^\d{1,5}$/.test(argsList[i+1]||'')){i++;continue}
    return false
  }
  try{
    const root=new AgentWorkspace(workspace),file=root.resolve('package.json')
    return fs.statSync(file).size<=200000&&typeof JSON.parse(fs.readFileSync(file,'utf8')).scripts?.[match[1]]==='string'
  }catch{return false}
}
