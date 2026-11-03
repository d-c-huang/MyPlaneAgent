export interface BrowserAvailabilityInput {
 webEnabled:boolean
 filesEnabled:boolean
 imageCapability?:'supported'|'unsupported'|'unknown'
 browser:{configured:boolean;enabled:boolean;registered:string[];available:string[]}
 preview:{enabled:boolean;registered:string[];available:string[]}
}

/** Host facts, not an authorization grant. Never infer a disabled switch from a filtered tool list. */
export function browserAvailabilityContext(input:BrowserAvailabilityInput):string {
 const {browser,preview}=input
 const lines=[
  '宿主浏览器能力诊断（本次执行开始时的状态；节点权限、并行限制及工具预算过滤后，以本轮实际工具列表为准）：',
  input.webEnabled?'会话联网：已开启，无需建议用户再次开启。':'会话联网：已关闭，浏览器与静态预览均不可使用；需要时请用户在会话设置开启联网，不得绕过该开关。',
  input.filesEnabled?'文件访问：已开启。':'文件访问：已关闭，不能启动工作目录的静态预览。'
 ]
 if(!browser.registered.length)lines.push('浏览器自动化：能力未注册，属于组件加载问题，不能判定用户关闭了插件；请重启应用或修复浏览器插件注册。')
 else if(!browser.configured)lines.push('浏览器自动化：能力已注册，但浏览器实例未就绪；请重启应用或修复组件初始化，开启联网不能解决此问题。')
 else if(!browser.enabled)lines.push('浏览器自动化：能力已注册，插件开关未启用；需要浏览器操作时，请用户在「插件 → 浏览器自动化 → 允许 Agent 使用」开启。')
 else lines.push('浏览器自动化：插件开关已启用；宿主可用工具：'+(browser.available.join('、')||'无，组件状态异常，请检查插件加载')+'。')
 if(!preview.registered.length)lines.push('静态网页预览：能力未注册，属于组件加载问题；请重启应用或修复预览插件注册。')
 else if(!preview.enabled)lines.push('静态网页预览：能力已注册，插件开关未启用；需要本地静态服务时，请用户在「插件 → 静态网页预览 → 允许 Agent 使用」开启。')
 else lines.push('静态网页预览：插件开关已启用；宿主可用工具：'+(preview.available.join('、')||'无，组件状态异常，请检查插件加载')+'。')
 lines.push('browser.open 仅接收 HTTP/HTTPS 地址，不能直接传本地文件路径或 file://。本地 HTML 尚无可用 HTTP 服务时，在权限和插件均启用后使用 preview.start 返回的真实 URL；不得编造端口或用其他工具绕过关闭的权限。')
 lines.push(input.imageCapability==='supported'
  ?'图片识别：已通过检测；截图与实际页面证据满足要求后才能作视觉结论。'
  :'图片识别：'+(input.imageCapability==='unsupported'?'当前模型不支持。':'当前模型尚未通过检测。')+'这不影响已授权且可用的浏览器打开、DOM 读取、布局检查或真实交互；仍应完成这些可执行步骤。截图可保存供用户确认，仅截图的视觉结论需要用户确认或支持图像的模型，不能把缺少图像能力说成浏览器工具不可用。')
 return lines.join('\n')
}
