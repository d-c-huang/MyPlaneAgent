import {app,BrowserWindow,Menu} from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {windowChrome,registerTitleMenu,useMinimalWindowChrome} from '../dist-electron/main/window-chrome.js'
import {trackAuthWindow,protectedHandle} from '../dist-electron/main/auth.js'
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'myplane-titlebar-')))
app.disableHardwareAcceleration()
async function main(){
await app.whenReady()
const deadline=setTimeout(()=>{console.error('titlebar smoke timed out');app.exit(1)},30000)
console.log('titlebar app ready')
let win
let acceleratorCalls=0
try{
 Menu.setApplicationMenu(Menu.buildFromTemplate(['文件','编辑','视图','窗体','帮助'].map(label=>({label,submenu:[{label:'测试菜单项',...(label==='视图'?{accelerator:'Ctrl+Shift+Y',click:()=>acceleratorCalls++}:{})}]}))))
 registerTitleMenu()
 protectedHandle('browser:action',()=>({automationEnabled:false,url:'',title:'',loading:false,canGoBack:false,canGoForward:false,error:''}))
 win=new BrowserWindow({...windowChrome(),width:1100,height:750,webPreferences:{preload:path.resolve('dist-electron/preload/index.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}})
 trackAuthWindow(win.webContents,true)
 await win.loadFile(path.resolve('dist/index.html'),{query:{surface:'browser'}})
 console.log('titlebar loaded')
 for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("!!document.querySelector('.internal-browser')"))break;await new Promise(r=>setTimeout(r,30))}
 assert.deepEqual(await win.webContents.executeJavaScript("[...document.querySelectorAll('.desktop-titlebar button')].map(b=>b.textContent)"),['文件','编辑','视图','窗体','帮助'])
 assert.equal(await win.webContents.executeJavaScript("document.querySelector('.desktop-titlebar').getBoundingClientRect().top"),0)
 assert.equal(await win.webContents.executeJavaScript("document.querySelector('.internal-browser').getBoundingClientRect().top"),36)
 const menu=Menu.getApplicationMenu().items[0].submenu
 console.log('titlebar bounds passed')
  setTimeout(()=>menu.closePopup(win),200)
 await win.webContents.executeJavaScript("document.querySelector('.desktop-titlebar button').click()")
 menu.closePopup(win)
 assert.equal(await win.webContents.executeJavaScript("document.querySelector('.desktop-titlebar [role=alert]')?.textContent||''"),'')
 await assert.rejects(win.webContents.executeJavaScript("window.myplane.showTitleMenu('unknown',0)"))
 useMinimalWindowChrome(win)
 for(const keyCode of ['Alt','F10']){
  win.webContents.sendInputEvent({type:'keyDown',keyCode})
  win.webContents.sendInputEvent({type:'keyUp',keyCode})
  await new Promise(resolve=>setTimeout(resolve,60))
  assert.equal(win.isMenuBarVisible(),false,`${keyCode} must not reveal a menu bar in minimal chrome`)
 }
 win.focus();win.webContents.focus()
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Y',modifiers:['control','shift']})
 win.webContents.sendInputEvent({type:'keyUp',keyCode:'Y',modifiers:['control','shift']})
 for(let i=0;i<50&&!acceleratorCalls;i++)await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal(acceleratorCalls,1,'registered application accelerators remain available')
 fs.mkdirSync(path.resolve('tests/artifacts'),{recursive:true})
 fs.writeFileSync(path.resolve('tests/artifacts/titlebar.png'),(await win.webContents.capturePage()).toPNG())
 console.log('PASS: auxiliary title menu and popup, content bounds, minimal chrome menu suppression and retained accelerators')
}catch(error){console.error(error);process.exitCode=1}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0)}
}
void main()
