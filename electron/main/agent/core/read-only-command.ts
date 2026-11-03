import {isReadCommand} from './read-evidence.js'

/** Recognize checks that do not execute project code. Normal tool approval,
 * workspace locking and post-command source-change detection still apply. */
export function isReadOnlyCommand(name:string,args:Record<string,unknown>):boolean {
 if(isReadCommand(name,args))return true
 if(name!=='agent.run_command'||typeof args.command!=='string')return false
 const command=args.command.trim()
 if(/[;&|<>$`%!^\r\n()\0]/.test(command))return false
 if(/^node(?:\.exe)?\s+(?:--version|-v)$/.test(command))return true
 const check=command.match(/^node(?:\.exe)?\s+(?:--check|-c)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))$/)
 const file=check?.[1]??check?.[2]??check?.[3]
 return !!file&&!file.startsWith('-')&&!/[?*\[\]]/.test(file)&&/\.(?:[cm]?js)$/.test(file)
}
