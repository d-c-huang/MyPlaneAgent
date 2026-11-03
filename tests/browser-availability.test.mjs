import test from 'node:test'
import assert from 'node:assert/strict'
import {browserAvailabilityContext} from '../dist-electron/main/agent/core/browser-availability.js'
import {browserCapabilityNames,browserPluginState,configureBrowserPlugin,registerBrowserPlugin} from '../dist-electron/main/browser-plugin.js'
import {CapabilityRegistry} from '../dist-electron/main/agent/core/capability-registry.js'
import {chatCapabilityAllowed} from '../dist-electron/main/agent/core/chat-capability-policy.js'

const defaults=()=>({webEnabled:true,filesEnabled:true,imageCapability:'unknown',
 browser:{configured:true,enabled:false,registered:[...browserCapabilityNames],available:[]},
 preview:{enabled:false,registered:['preview.start','preview.status','preview.stop'],available:[]}})

test('missing registration and missing browser instance are diagnosed without guessing a user opt-out',()=>{
 const input=defaults();input.browser.registered=[];input.preview.registered=[]
 const missing=browserAvailabilityContext(input)
 assert.match(missing,/浏览器自动化：能力未注册/)
 assert.match(missing,/静态网页预览：能力未注册/)
 assert.doesNotMatch(missing,/插件开关未启用/)
 input.browser.registered=[...browserCapabilityNames];input.browser.configured=false
 assert.match(browserAvailabilityContext(input),/浏览器实例未就绪/)
})

test('disabled plugins identify their own settings while preserving an already enabled network switch',()=>{
 const input=defaults(),before=structuredClone(input),text=browserAvailabilityContext(input)
 assert.match(text,/会话联网：已开启，无需建议用户再次开启/)
 assert.match(text,/插件 → 浏览器自动化 → 允许 Agent 使用/)
 assert.match(text,/插件 → 静态网页预览 → 允许 Agent 使用/)
 assert.match(text,/preview.start 返回的真实 URL/)
 assert.deepEqual(input,before,'diagnostics must not enable plugins or alter permissions')
})

test('enabled plugins remain unavailable for execution when the conversation network switch is off',()=>{
 const input=defaults();input.webEnabled=false;input.browser.enabled=true;input.browser.available=[...browserCapabilityNames];input.preview.enabled=true;input.preview.available=[...input.preview.registered]
 const text=browserAvailabilityContext(input)
 assert.match(text,/会话联网：已关闭，浏览器与静态预览均不可使用/)
 assert.match(text,/插件开关已启用/)
 assert.doesNotMatch(text,/插件开关未启用|无需建议用户再次开启/)
 configureBrowserPlugin({isAutomationEnabled:()=>true,automate:async()=>{throw Error('diagnostic must not execute browser')}})
 const registry=new CapabilityRegistry({getAllTools:()=>[]});registerBrowserPlugin(registry)
 for(const capability of registry.list())assert.equal(chatCapabilityAllowed(capability,{filesEnabled:true,webEnabled:false,workerMode:'verify'}),false)
})

test('verify workers retain authorized browser tools without image support and diagnosis does not operate the browser',()=>{
 let enabled=true,calls=0
 configureBrowserPlugin({isAutomationEnabled:()=>enabled,automate:async()=>{calls++;return {}}})
 const registry=new CapabilityRegistry({getAllTools:()=>[]});registerBrowserPlugin(registry)
 const input=defaults();input.imageCapability='unsupported';input.browser={...browserPluginState(),registered:[...browserCapabilityNames],available:registry.list().map(cap=>cap.name)}
 const text=browserAvailabilityContext(input)
 assert.match(text,/browser.open、browser.read_page/)
 assert.match(text,/不影响已授权且可用的浏览器打开、DOM 读取、布局检查或真实交互/)
 assert.match(text,/仅截图的视觉结论需要用户确认或支持图像的模型/)
 for(const capability of registry.list())assert.equal(chatCapabilityAllowed(capability,{filesEnabled:true,webEnabled:true,workerMode:'verify'}),true)
 enabled=false
 assert.deepEqual(browserPluginState(),{configured:true,enabled:false})
 assert.equal(registry.list().length,0)
 assert.equal(calls,0)
})

test('host availability is explicitly a snapshot and does not claim filtered worker tools are provided',()=>{
 const input=defaults();input.filesEnabled=false;input.browser.enabled=true;input.browser.available=[]
 const text=browserAvailabilityContext(input)
 assert.match(text,/节点权限、并行限制及工具预算过滤后，以本轮实际工具列表为准/)
 assert.match(text,/文件访问：已关闭，不能启动工作目录的静态预览/)
 assert.match(text,/宿主可用工具：无，组件状态异常/)
 assert.doesNotMatch(text,/浏览器自动化：能力已注册，插件开关未启用/)
})
