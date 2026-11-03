import type {BrowserWindowConstructorOptions} from 'electron'
import {BrowserWindow,Menu} from 'electron'
import {protectedHandle} from './auth.js'
export const titleBarHeight=36
export function windowChrome():BrowserWindowConstructorOptions{
 return process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#f5f5f5',symbolColor:'#444444',height:titleBarHeight},autoHideMenuBar:true}:{}
}
/** Keep registered application accelerators without exposing a menu bar in the chat window. */
export function useMinimalWindowChrome(window:BrowserWindow){
 if(process.platform==='darwin')return
 window.setAutoHideMenuBar(true)
 window.setMenuBarVisibility(false)
 window.webContents.on('before-input-event',(event,input)=>{
  const standaloneAlt=input.key==='Alt'&&!input.control&&!input.meta
  const menuFocus=input.key==='F10'&&!input.control&&!input.meta&&!input.shift&&!input.alt
  if(standaloneAlt||menuFocus){event.preventDefault();window.setMenuBarVisibility(false)}
 })
}
export function registerTitleMenu(){
 protectedHandle('app:title-colors',(event,color,symbolColor)=>{
  const valid=(value:unknown)=>typeof value==='string'&&/^(#[\da-f]{6}|rgba?\([\d.,\s%]+\)|color\(srgb [\d.\s/]+\))$/i.test(value)
  if(!valid(color)||!valid(symbolColor))throw new Error('标题栏颜色无效')
  const owner=BrowserWindow.fromWebContents(event.sender)
  if(process.platform==='win32'&&owner)owner.setTitleBarOverlay({color,symbolColor,height:titleBarHeight})
 })
 protectedHandle('app:title-menu',(event,label,x)=>{
  const owner=BrowserWindow.fromWebContents(event.sender)
  if(!owner||typeof label!=='string'||!['文件','编辑','视图','窗体','帮助'].includes(label)||typeof x!=='number'||!Number.isFinite(x))throw new Error('菜单请求无效')
  const menu=Menu.getApplicationMenu()?.items.find(item=>item.label===label)?.submenu
  if(!menu)throw new Error('菜单尚未初始化')
  menu.popup({window:owner,x:Math.round(Math.max(0,Math.min(owner.getContentSize()[0]-20,x*event.sender.getZoomFactor()))),y:Math.round(titleBarHeight*event.sender.getZoomFactor())})
 })
}
