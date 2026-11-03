import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import type {AgentPreview} from '../../shared/local-ai-agent.js'
import {fingerprint,ToolError} from './registry.js'
import {extractDocument,makeDocument,makeSpreadsheet} from './documents.js'
import type {FileExpectation} from '../../shared/agent-execution.js'
import {executeProcess} from './execution-supervisor.js'
import {inspectBuild,prepareBuild} from './build-profile.js'
import {analyzeTestResult} from './test-analysis.js'
import {withLocalGitHistory} from './local-git-history.js'

const ignored=new Set(['.git','node_modules','dist','dist-electron','release','vendor','.idea','.venv','venv','__pycache__'])
const secret=(name:string)=>/^\.env(?:\.|$)/i.test(name)&&!/^\.env\.(example|sample|template)$/i.test(name)||/^(\.ssh|\.aws|\.gnupg|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(name)||/\.(pem|key|p12|pfx)$/i.test(name)
const maxFile=2*1024*1024
const binaryDocument=/\.(docx?|xlsx?|pptx?|pdf|odt|ods|odp|rtf|zip|7z|rar|png|jpe?g|gif|webp|bmp|tiff?)$/i
export const bounded=(value:unknown,label:string,max=1000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}无效或过长`);return value}
export const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('工具参数必须是对象');return value as Record<string,unknown>}
export const integer=(value:unknown,fallback:number,min:number,max:number)=>{if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error(`数字参数必须在 ${min}–${max} 之间`);return value}
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
export type PreparedAction={expectedFiles?:FileExpectation[];preview:AgentPreview;execute:(signal:AbortSignal,onOutput?:(text:string)=>void)=>Promise<string>;artifact?:{path:string;kind:'file'|'document'|'spreadsheet'}}
export class AgentWorkspace {
 readonly root:string
 constructor(root:string){this.root=fs.realpathSync(root);if(!fs.statSync(this.root).isDirectory())throw new Error('工作目录不可用')}
 resolve(value:unknown,allowMissing=false){
  const relative=bounded(value,'工作区相对路径',2000)
  if(path.isAbsolute(relative)||relative.includes('\\')||relative.includes('\0')||relative.includes(':'))throw new Error('请使用工作区内的相对路径')
  const parts=relative.split('/').filter(p=>p&&p!=='.')
  if(parts.some(p=>p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)||ignored.has(p.toLowerCase())||secret(p)))throw new Error('此路径不允许访问（越界、依赖目录或敏感文件）')
  if(fs.realpathSync(this.root)!==this.root)throw new Error('工作目录已发生变化，请重新选择')
  let current=this.root
  for(const part of parts){current=path.join(current,part);try{const st=fs.lstatSync(current);if(st.isSymbolicLink())throw new Error('不允许访问符号链接');if(st.isFile()&&st.nlink>1)throw new Error('不允许访问具有多个硬链接的文件')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'&&allowMissing)continue;throw e}}
  return current
 }
 files(relative='.',depth=5,limit=1200){
  const base=this.resolve(relative),result:string[]=[],skipped:{path:string;reason:string}[]=[],reasons=new Set<string>();let visited=0,truncated=false,skippedCount=0
  const relativePath=(target:string)=>path.relative(this.root,target).split(path.sep).join('/')
  const skip=(target:string,reason:string)=>{skippedCount++;truncated=true;reasons.add('skipped-paths');if(skipped.length<50)skipped.push({path:relativePath(target),reason})}
  const walk=(dir:string,level:number)=>{
   if(level>depth){truncated=true;reasons.add('depth-limit');return}
   try{
    const handle=fs.opendirSync(dir)
    try{let entry:fs.Dirent|null;while((entry=handle.readSync())){
     if(++visited>5000||result.length>=limit){truncated=true;reasons.add('file-limit');return}
     if(ignored.has(entry.name.toLowerCase())||secret(entry.name))continue
     const full=path.join(dir,entry.name),rel=relativePath(full)
     if(entry.isSymbolicLink()){skip(full,'linked-path');continue}
     if(entry.isDirectory()){result.push(rel+'/');walk(full,level+1)}else if(entry.isFile())result.push(rel)
    }}finally{handle.closeSync()}
   }catch(error){
    const code=(error as NodeJS.ErrnoException).code
    if(dir===base||!code)throw error
    skip(dir,code==='EACCES'||code==='EPERM'?'permission-denied':'unreadable-path')
   }
  }
  if(!fs.statSync(base).isDirectory())throw new Error('请选择目录');walk(base,0);return {paths:result,truncated,skipped,skippedCount,truncationReasons:[...reasons].sort()}
 }
 read(relative:unknown){const file=this.resolve(relative),st=fs.statSync(file);if(!st.isFile()||st.size>maxFile)throw new Error('仅可读取 2 MB 以内的文本文件');const data=fs.readFileSync(file);if(data.includes(0))throw new Error('该文件不是文本，请使用文档读取工具');return data.toString('utf8')}
 async query(name:string,args:Record<string,unknown>,signal:AbortSignal){
  signal.throwIfAborted()
  if(name==='inspect_build')return JSON.stringify(inspectBuild(this))
  if(['git_status','git_diff','git_log'].includes(name))return this.git(name,args,signal)
  if(name==='list_files')return JSON.stringify(this.files(typeof args.path==='string'?args.path:'.',integer(args.depth,4,0,8),500))
  if(name==='read_file'){
   const lines=this.read(args.path).split('\n'),start=integer(args.startLine,1,1,1000000),end=Math.min(lines.length,integer(args.endLine,start+199,start,start+249))
   return JSON.stringify({path:args.path,totalLines:lines.length,startLine:start,endLine:end,text:lines.slice(start-1,end).map((line,i)=>`${start+i}: ${line}`).join('\n').slice(0,24000),note:'每次最多 250 行 / 24000 字符，长文件请分段读取'})
  }
  if(name==='search_files'){
   const query=bounded(args.query,'检索词',200),listing=this.files(typeof args.path==='string'?args.path:'.'),matches:{path:string;line:number;text:string}[]=[];let bytes=0,scanned=0
   for(const file of listing.paths){signal.throwIfAborted();if(file.endsWith('/'))continue;try{const content=this.read(file);bytes+=Buffer.byteLength(content);if(bytes>12*1024*1024)break;scanned++;const lines=content.split('\n');for(let i=0;i<lines.length;i++){if(lines[i].toLowerCase().includes(query.toLowerCase()))matches.push({path:file,line:i+1,text:lines[i].slice(0,400)});if(matches.length>=60)break}}catch{/* Skip binary, oversized and unreadable files. */}if(matches.length>=60)break;if(scanned%30===0)await new Promise(resolve=>setImmediate(resolve))}
   return JSON.stringify({matches,scanned,truncated:listing.truncated||matches.length>=60||bytes>12*1024*1024,skippedPaths:listing.skipped,skippedPathCount:listing.skippedCount})
  }
  if(name==='read_document'){const result=JSON.parse(await extractDocument(this.resolve(args.path),args,signal));return JSON.stringify({...result,path:args.path,nextReads:result.nextReads.map((next:Record<string,unknown>)=>({...next,path:args.path}))})}
  throw new Error(`未知读取工具：${name}`)
 }
 async prepare(name:string,args:Record<string,unknown>,signal:AbortSignal=new AbortController().signal):Promise<PreparedAction>{
  const prepared=await this.prepareAction(name,args,signal)
  const paths=prepared.expectedFiles?.map(file=>file.path)
  if(!paths?.length)return prepared
  const execute=prepared.execute
  return {...prepared,execute:async(s,onOutput)=>{
   s.throwIfAborted()
   paths.forEach(name=>this.resolve(name,true))
   return withLocalGitHistory(this.root,paths,()=>execute(s,onOutput))
  }}
 }
 private async prepareAction(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<PreparedAction>{
  signal.throwIfAborted()
  if(name==='build_project')return prepareBuild(this,args)
  if(name==='apply_patch')return this.patch(args,signal)
  if(name==='run_test'){
   const script=bounded(args.script,'测试脚本',100);if(!/^(test|check|lint|build)(:[a-zA-Z0-9_-]+)?$/.test(script))throw new Error('只支持 test/check/lint/build 及其子脚本')
   const manifest=JSON.parse(this.read('package.json'));if(typeof manifest.scripts?.[script]!=='string')throw new Error('项目未定义此脚本')
   return {preview:{command:'npm run '+script,cwd:this.root,note:'优先在本机已有容器沙盒中运行：网络关闭、临时 HOME、非 root、限制资源；沙盒不可用时必须由用户确认后降级执行。'},execute:async(s,onOutput)=>{
    const raw=JSON.parse(await this.command('npm run '+script,integer(args.timeoutSeconds,60,1,300),s,onOutput))
    const failureAnalysis=analyzeTestResult(raw,[],script)
    return JSON.stringify({exitCode:raw.exitCode,durationMs:raw.durationMs,termination:raw.termination,error:raw.error,truncated:raw.truncated,sandbox:raw.sandbox,failureAnalysis,output:raw.output})
   }}
  }
  if(name==='run_command'){
   const command=bounded(args.command,'命令',8000),timeout=integer(args.timeoutSeconds,60,1,300)
   return {preview:{command,cwd:this.root,note:'优先在本机已有容器沙盒中运行；沙盒不可用时必须由用户确认，降级命令仍可访问宿主机文件和网络。'},execute:(signal,onOutput)=>this.command(command,timeout,signal,onOutput)}
  }
  const relative=bounded(args.path,'目标路径',2000),target=this.resolve(relative,true)
  if(target===this.root)throw new Error('目标必须是文件')
  let previous:Buffer|undefined,mode=0o644
  if(fs.existsSync(target)){const st=fs.statSync(target);if(!st.isFile()||st.size>20*1024*1024)throw new Error('目标不是文件或超过 20 MB');previous=fs.readFileSync(target);mode=st.mode&0o777}
  let next:Buffer,preview:AgentPreview,kind:'file'|'document'|'spreadsheet'='file'
  if(name==='write_file'||name==='replace_text'){
   if(binaryDocument.test(relative))throw new Error('通用文本工具不能写入二进制文档；DOCX 请使用 create_document，XLSX 请使用 create_spreadsheet')
   if(previous&&(previous.includes(0)||previous.length>maxFile))throw new Error('此操作只允许修改 2 MB 以内的文本文件')
   if(name==='replace_text'){
    const old=bounded(args.oldText,'待替换片段',100000),replacement=typeof args.newText==='string'?args.newText:null
    if(replacement===null||replacement.length>100000)throw new Error('替换内容无效')
    if(!previous)throw new Error('待修改文件不存在')
    const before=previous.toString('utf8'),startLine=args.startLine===undefined?undefined:integer(args.startLine,0,1,1000000)
    const positions:number[]=[]
    for(let offset=before.indexOf(old);offset>=0;offset=before.indexOf(old,offset+old.length))positions.push(offset)
    const matches=startLine===undefined?positions:positions.filter(offset=>before.slice(0,offset).split('\n').length===startLine)
    if(matches.length!==1)throw new Error(startLine===undefined?'待替换片段必须在文件中唯一匹配；重复片段请读取目标行号并传入 startLine':'待替换片段在指定 startLine 上必须唯一匹配，请重新读取目标行并核对 oldText')
    const index=matches[0]
    next=Buffer.from(before.slice(0,index)+replacement+before.slice(index+old.length))
   }else{if(typeof args.content!=='string'||args.content.length>100000)throw new Error('写入内容不得超过 100000 字符');next=Buffer.from(args.content)}
   preview={path:relative,before:previous?.toString('utf8'),after:next.toString('utf8'),note:previous?'将替换现有文件；确认时会重新检查文件版本。':'将创建新文件。'}
  }else if(name==='create_document'){
   if(!/\.(docx|md|txt)$/i.test(relative))throw new Error('文档输出仅支持 .docx、.md、.txt')
   const content=bounded(args.content,'文档正文',100000),title=bounded(args.title,'文档标题',200)
   next=await makeDocument(relative,title,content);kind='document';preview={path:relative,after:`# ${title}\n\n${content}`,note:`${previous?'覆盖已有文件。':'创建文档。'}Word 生成支持标题、段落、列表和简单表格，不保留原文件排版。`}
  }else if(name==='create_spreadsheet'){
   if(!/\.xlsx$/i.test(relative))throw new Error('表格输出必须使用 .xlsx')
   next=await makeSpreadsheet(args.sheets);kind='spreadsheet';preview={path:relative,after:JSON.stringify(args.sheets,null,2),note:previous?'将覆盖整个已有工作簿。':'创建 Excel 工作簿，首行作为表头。'}
  }else throw new Error(`未知修改工具：${name}`)
  signal.throwIfAborted()
  const expected=previous?digest(previous):null
  return {expectedFiles:[{path:relative,beforeHash:expected,afterHash:digest(next)}],preview,artifact:{path:relative,kind},execute:async(signal)=>{
   signal.throwIfAborted();const file=this.resolve(relative,true)
   if(fs.existsSync(file)&&fs.statSync(file).size>20*1024*1024)throw new Error('文件在确认期间已变大，本次操作未执行')
   const current=fs.existsSync(file)?fs.readFileSync(file):undefined
   if((current?digest(current):null)!==expected)throw new Error('文件在确认期间已被修改，本次操作未执行。请重新读取并生成修改。')
   fs.mkdirSync(path.dirname(file),{recursive:true});this.resolve(relative,true)
   const temp=path.join(path.dirname(file),`.myplane-agent-${randomUUID()}.tmp`)
   try{fs.writeFileSync(temp,next,{flag:'wx',mode});signal.throwIfAborted();fs.renameSync(temp,file)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
   let validation:any
   if(kind!=='file'){try{validation=JSON.parse(await extractDocument(file,{},signal))}catch{throw new ToolError('RESULT_UNKNOWN','文件已保存，但重新读取验证未完成；请先检查 '+relative+'，不要重复覆盖。')}}
   return JSON.stringify({path:relative,bytes:next.length,status:'saved',...(validation?{validation:{readable:true,characters:validation.totalCharacters,note:'已重新打开并提取内容；未验证视觉排版。'}}:{})})
  }}
 }
 restoreChanges(changes:{path:string;before?:string;after:string}[]){
  const paths=changes.map(change=>{const file=this.resolve(change.path);if(this.read(change.path)!==change.after)throw new Error('文件已被后续修改，不能恢复：'+change.path);return file})
  const applied:number[]=[]
  try{for(let i=0;i<changes.length;i++){const change=changes[i],file=paths[i];this.resolve(change.path);if(this.read(change.path)!==change.after)throw new Error('文件已变化：'+change.path);if(change.before===undefined)fs.unlinkSync(file);else{const temp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,change.before,{flag:'wx',mode:fs.statSync(file).mode&0o777});fs.renameSync(temp,file)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}}applied.push(i)}}
  catch(error){const failed:string[]=[];for(const i of applied.reverse()){const change=changes[i];try{const file=this.resolve(change.path,true);if(change.before===undefined?fs.existsSync(file):this.read(change.path)!==change.before)throw new Error('changed');fs.writeFileSync(file,change.after,{flag:change.before===undefined?'wx':'w'})}catch{failed.push(change.path)}}throw new Error(String(error)+(failed.length?'；恢复未完成，需核对：'+failed.join(','):'；已回退此次恢复'))}
 }
 stateFingerprint(args:Record<string,unknown>,tool=''){
  if(['list_files','search_files','git_status','git_diff','git_log'].includes(tool)){try{const listing=this.files(typeof args.path==='string'?args.path:'.',8,1200);return fingerprint(listing.paths.map(name=>{try{const st=fs.statSync(this.resolve(name));return {name,size:st.size,mtime:st.mtimeMs}}catch{return {name}}}))}catch{/* Preserve the normal tool error below. */}}
  const names=typeof args.path==='string'?[args.path]:Array.isArray(args.changes)?args.changes.map(item=>(item as {path:string}).path):[]
  return fingerprint(names.map(name=>{try{const file=this.resolve(name,true),st=fs.statSync(file);return {name,size:st.size,mtime:st.mtimeMs,...(st.isFile()&&st.size<=maxFile?{hash:digest(fs.readFileSync(file))}:{})}}catch{return {name,missing:true}}}))
 }
 canAutoWrite(name:string,args:Record<string,unknown>,scopes:string[]){
  if(!['write_file','replace_text','apply_patch','create_document','create_spreadsheet'].includes(name))return false
  const names=typeof args.path==='string'?[args.path]:Array.isArray(args.changes)?args.changes.map(item=>(item as {path:string}).path):[]
  return names.length>0&&names.every(name=>{try{this.resolve(name,true);if(/(^|\/)(\.[^/]+|package[^/]*\.json|[^/]*lock[^/]*|AGENTS\.md|[^/]*\.(sh|bat|cmd|ps1)|[^/]*\.config\.[^/]+|tsconfig[^/]*\.json|Makefile|Dockerfile)$/i.test(name))return false;return scopes.some(scope=>scope==='.'||name===scope||name.startsWith(scope.replace(/\/$/,'')+'/'))}catch{return false}})
 }
 private async patch(args:Record<string,unknown>,signal:AbortSignal):Promise<PreparedAction>{
  if(!Array.isArray(args.changes)||!args.changes.length||args.changes.length>20)throw new Error('补丁需要 1–20 个文件')
  const seen=new Set<string>(),changes: {path:string;before?:string;after:string;expected:string|null;mode:number}[]=[]
  for(const value of args.changes){
   const change=object(value),name=bounded(change.path,'补丁路径',2000),file=this.resolve(name,true)
   if(binaryDocument.test(name))throw new Error('文本补丁不能写入二进制文档')
   const identity=process.platform==='win32'?file.toLowerCase():file
   if(seen.has(identity))throw new Error('同一文件只能出现一次');seen.add(identity)
   const before=fs.existsSync(file)?this.read(name):undefined
   if(before===undefined&&change.before!==undefined||before!==undefined&&change.before!==before)throw new Error('补丁基线不匹配，请重新读取 '+name)
   if(typeof change.after!=='string'||change.after.length>100000)throw new Error('补丁内容过大或无效')
   changes.push({path:name,before,after:change.after,expected:before===undefined?null:digest(Buffer.from(before)),mode:fs.existsSync(file)?fs.statSync(file).mode&0o777:0o644})
  }
  return {expectedFiles:changes.map(change=>({path:change.path,beforeHash:change.expected,afterHash:digest(Buffer.from(change.after))})),preview:{changes:changes.map(({path,before,after})=>({path,before,after})),note:'多文件补丁：写入前统一核对所有基线，失败时尝试回退本次写入。'},execute:async s=>{
   signal.throwIfAborted();s.throwIfAborted()
   const valid=(change:typeof changes[number],after=false)=>{const file=this.resolve(change.path,true),value=fs.existsSync(file)?digest(Buffer.from(this.read(change.path))):null;if(value!==(after?digest(Buffer.from(change.after)):change.expected))throw new Error('文件已变化：'+change.path);return file}
   changes.forEach(change=>valid(change));const applied:typeof changes=[],pending:string[]=[]
   try{for(const change of changes){s.throwIfAborted();const file=valid(change);fs.mkdirSync(path.dirname(file),{recursive:true});this.resolve(change.path,true);const temp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,change.after,{flag:'wx',mode:change.mode});fs.renameSync(temp,file);applied.push(change)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}}}
   catch(error){for(const change of applied.reverse()){try{const file=valid(change,true);if(change.before===undefined)fs.unlinkSync(file);else fs.writeFileSync(file,change.before,{mode:change.mode})}catch{pending.push(change.path)}}throw new ToolError('PATCH_FAILED',String(error)+(pending.length?'；这些文件回退失败，需人工核对：'+pending.join(','):'；本次已写入文件已回退'))}
   return JSON.stringify({status:'saved',paths:changes.map(change=>change.path),note:'补丁已应用；尚未运行测试。'})
  }}
 }
 private async git(name:string,args:Record<string,unknown>,signal:AbortSignal){
  const meta=path.join(this.root,'.git')
  let metadata:fs.Stats
  try{metadata=fs.lstatSync(meta)}catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
   if(name==='git_status')return JSON.stringify({repository:false,status:'not_applicable',note:'当前工作目录不是 Git 仓库根目录，未执行 Git 状态查询。可继续使用文件读取工具；需要 Git 操作时请选择实际项目根目录。不要仅为状态查询初始化仓库。'})
   throw new Error('需要项目根目录中的 Git 仓库')
  }
  if(metadata.isSymbolicLink())throw new Error('Git 元数据不能使用符号链接或目录联接')
  const base=['--no-pager','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.hooksPath=/dev/null','-c','diff.external=','-c','core.pager=cat']
  const execute=(more:string[])=>new Promise<string>((resolve,reject)=>{
   signal.throwIfAborted();let output='',settled=false
   const child=spawn('git',[...base,...more],{cwd:this.root,shell:false,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_LITERAL_PATHSPECS:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true})
   const kill=()=>child.kill('SIGKILL'),timer=setTimeout(kill,15000);signal.addEventListener('abort',kill,{once:true})
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',kill);if(error)reject(error);else resolve(output)}
   child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>32000)kill()});child.stderr.on('data',chunk=>{output+=chunk.toString();if(output.length>32000)kill()});child.on('error',finish);child.on('close',code=>finish(signal.aborted?new Error('已停止'):code!==0?new Error('Git 未成功：'+output.slice(0,1000)):undefined))
  })
  const root=(await execute(['rev-parse','--show-toplevel'])).trim();if(fs.realpathSync(root)!==this.root)throw new Error('Git 根目录与项目目录不一致')
  if(name==='git_status')return JSON.stringify({repository:true,output:await execute(['status','--short','--untracked-files=no','--ignore-submodules=all'])})
  if(name==='git_log')return JSON.stringify({output:await execute(['log','-n',String(integer(args.limit,10,1,30)),'--format=%h %s'])})
  const staged=args.staged===true?['--cached']:[]
  const names=(await execute(['diff',...staged,'--name-only','-z','--ignore-submodules=all'])).split('\0').filter(Boolean).filter(name=>{try{this.resolve(name,true);return true}catch{return false}}).slice(0,100)
  return JSON.stringify({output:names.length?await execute(['diff',...staged,'--no-ext-diff','--no-textconv','--ignore-submodules=all','--',...names]):'',note:'仅显示允许访问路径中的已跟踪文件差异。'})
 }
 private async command(command:string,timeout:number,signal:AbortSignal,onOutput?:(text:string)=>void):Promise<string>{
  signal.throwIfAborted();this.resolve('.')
  return JSON.stringify(await executeProcess({executable:command,cwd:this.root,shell:true,timeoutMs:timeout*1000,sandbox:'prefer'},signal,onOutput))
 }
}
