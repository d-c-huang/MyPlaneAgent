import {BrowserWindow,type Rectangle} from 'electron'
import path from 'node:path'
import {protectedHandle,trackAuthWindow} from './auth.js'
import type {RuntimeGraphSnapshot} from '../shared/runtime-graph.js'
import type {RuntimeHistoryIndex,RuntimeHistoryFrame,SharedNodeTemplate,TemplateCommand} from '../shared/runtime-workbench.js'

export class RuntimeGraphWindow {
 private window?:BrowserWindow
 private bounds?:Rectangle
 private opening?:Promise<void>
 private selectedSession?:string
 constructor(private readonly options:{directory:string;developmentUrl?:string;icon:string;owner:()=>BrowserWindow|undefined;snapshot:(sessionId?:string)=>RuntimeGraphSnapshot;history?:(sessionId:string)=>RuntimeHistoryIndex;frame?:(sessionId:string,id:string)=>RuntimeHistoryFrame;templates?:(command?:TemplateCommand)=>SharedNodeTemplate[];workflow?:(sessionId:string)=>string;detail?:(sessionId:string,nodeId:string)=>import('../shared/runtime-workbench.js').WorkbenchNodeDetail;command?:(command:import('../shared/runtime-workbench.js').WorkbenchCommand,owner:Electron.WebContents)=>Promise<import('../shared/runtime-workbench.js').WorkbenchNodeDetail>}){}
 register(){
  const allowed=(sender:number)=>{if(sender!==this.options.owner()?.webContents.id&&sender!==this.window?.webContents.id)throw new Error('此窗口无权访问运行视图')}
  protectedHandle('runtime-graph:window',async(event,action:unknown,sessionId?:unknown)=>{
   allowed(event.sender.id)
   if(action==='open')await this.open(this.validateSession(sessionId))
   else if(action==='close')this.close()
   else if(action!=='state')throw new Error('不支持的运行视图操作')
   return !!this.window&&!this.window.isDestroyed()
  })
  protectedHandle('runtime-graph:snapshot',(event,sessionId?:unknown)=>{allowed(event.sender.id);return this.options.snapshot(this.validateSession(sessionId)??this.selectedSession)})
  protectedHandle('runtime-graph:history',(event,sessionId:unknown,frameId?:unknown)=>{
   allowed(event.sender.id);const id=this.validateSession(sessionId);if(!id)throw new Error('会话 ID 无效')
   if(frameId!==undefined){if(typeof frameId!=='string'||frameId.length>100)throw new Error('历史帧 ID 无效');return this.options.frame?.(id,frameId)}
   return this.options.history?.(id)
  })
  protectedHandle('runtime-graph:templates',(event,command?:TemplateCommand)=>{allowed(event.sender.id);return this.options.templates?.(command)})
  protectedHandle('runtime-graph:workflow',(event,sessionId:unknown)=>{allowed(event.sender.id);const id=this.validateSession(sessionId);if(!id)throw new Error('会话 ID 无效');return this.options.workflow?.(id)})
  protectedHandle('runtime-graph:detail',(event,sessionId:unknown,nodeId:unknown)=>{
   allowed(event.sender.id);const id=this.validateSession(sessionId)
   if(!id||typeof nodeId!=='string'||nodeId.length>1500)throw new Error('节点标识无效')
   return this.options.detail?.(id,nodeId)
  })
  protectedHandle('runtime-graph:command',async(event,command:import('../shared/runtime-workbench.js').WorkbenchCommand)=>{
   allowed(event.sender.id);const owner=this.options.owner()
   if(!owner||!command||!this.validateSession(command.sessionId)||typeof command.nodeId!=='string'||command.nodeId.length>1500)throw new Error('运行控制参数无效')
   if(!this.options.command)throw new Error('运行控制服务不可用')
   return this.options.command(command,owner.webContents)
  })
 }
 private validateSession(value:unknown){if(value===undefined||value==='')return undefined;if(typeof value!=='string'||!/^[a-f\d-]{36}$/i.test(value))throw new Error('会话 ID 无效');return value}
 async open(sessionId?:string){
  this.selectedSession=sessionId
  if(this.opening){await this.opening;return}
  if(this.window&&!this.window.isDestroyed()){if(this.window.isMinimized())this.window.restore();this.window.show();this.window.focus();this.window.webContents.send('runtime-graph:selection',sessionId||'');return}
  this.opening=this.create();try{await this.opening}finally{this.opening=undefined}
 }
 private async create(){
  const {directory,developmentUrl,icon}=this.options
  const savedBounds=this.bounds?{...this.bounds}:undefined
  const next=new BrowserWindow({title:'3D 运行视图 · MyPlaneAgent',width:1380,height:900,...savedBounds,minWidth:900,minHeight:600,show:false,autoHideMenuBar:true,backgroundColor:'#0b1220',icon,webPreferences:{preload:path.join(directory,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
  this.window=next;next.setMenu(null)
  const remember=()=>{if(!next.isDestroyed()&&!next.isMinimized()&&!next.isMaximized())this.bounds=next.getBounds()}
  next.on('resize',remember);next.on('move',remember)
  next.on('closed',()=>{if(this.window===next)this.window=undefined})
  next.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  next.webContents.on('will-navigate',event=>event.preventDefault());next.webContents.on('will-attach-webview',event=>event.preventDefault())
  trackAuthWindow(next.webContents,true,developmentUrl)
  try{
   if(developmentUrl){const url=new URL(developmentUrl);url.searchParams.set('surface','runtime-graph');await next.loadURL(url.href)}
   else await next.loadFile(path.join(directory,'../../dist/index.html'),{query:{surface:'runtime-graph'}})
   if(!next.isDestroyed()){if(savedBounds)next.setBounds(savedBounds);next.show()}
  }catch(error){if(!next.isDestroyed())next.destroy();throw error}
 }
 close(){this.selectedSession=undefined;this.window?.close()}
}
