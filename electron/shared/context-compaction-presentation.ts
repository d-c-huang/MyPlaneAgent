import type {ContextCompactionReport} from './local-ai-context.js'

const labels={compressed:'压缩完成',recovered:'已用原文摘录恢复',unchanged:'保留原检查点',failed:'压缩失败',cancelled:'压缩已取消'} as const
const count=(value:number)=>value.toLocaleString('zh-CN')
/** Provider usage is distinct from the estimate of the next model input. */
export function compactionDetails(report:ContextCompactionReport):string[]{
 const lines=[`${labels[report.outcome]} · ${count(report.durationMs)} 毫秒 · 摘要调用 ${count(report.requests)} 次（含分片与重试）`]
 if(report.method==='ledger')lines.push('整理方式：原文整理。直接保留实际工具状态与原文引用，没有让模型推断执行进度。')
 else if(report.method==='recovery')lines.push('整理方式：恢复摘录。部分细节未展示，需要时核对原文。')
 if(report.beforeInputTokens!==undefined){
  lines.push(report.afterInputTokens===undefined?`压缩前预计输入 ${count(report.beforeInputTokens)} Tokens；未提交新检查点。`:
   `预计输入 ${count(report.beforeInputTokens)} → ${count(report.afterInputTokens)} Tokens，减少 ${count(report.savedInputTokens??0)} Tokens。`)
 }
 if(!report.requests)lines.push('本次未请求摘要模型。')
 else{
  const usage=report.usage
  const field=(tokens:number,reports:number)=>!reports?'未报告':reports<report.requests?`已报告 ${count(tokens)}（${reports}/${report.requests} 次）`:count(tokens)
  lines.push(`服务报告用量：输入 ${field(usage.inputTokens,usage.inputReports)}，输出 ${field(usage.outputTokens,usage.outputReports)}，总计 ${field(usage.totalTokens,usage.totalReports)} Tokens。`)
 }
 if(report.quality)lines.push(`程序校验：保留 ${count(report.quality.requirements)} 条用户要求、${count(report.quality.unresolvedEffects)} 项未确认副作用；原始历史未变，工具边界完整。`)
 return lines
}
