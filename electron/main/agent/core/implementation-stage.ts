import type {TaskKind} from '../../../shared/task-contract.js'
import type {TaskCompletionReview,TaskReviewQueue} from '../../../shared/task-plan.js'
export function requiresImplementation(title:string,acceptance='',kind?:TaskKind){
 if(kind)return kind==='edit'
 if(/(?:不修改|不改动|无需修改|只读)(?:任何|所有|项目)?(?:文件|代码|源码)/.test(acceptance))return false
 if(/^(定位|读取|查找|核对|验证|确认|检查|梳理|分析|评估|调研|盘点|总结|列出|提出)/.test(title)&&!/并(?:修改|修复|实现|添加|增加|创建|优化)/.test(title))return false
 return /修改|修复|添加|增加|实现|编写|创建|绘制|替换|调整|优化|删除|初始化|搭建/.test(title)
}
export function missingImplementation(review:TaskCompletionReview){
 if(review.implementation?.status==='missing')return true
 return (review.missingEvidence||[]).some(text=>/未实现|尚未.*(?:写入|修改|实现)|未落地|未写入|不存在.*(?:实现|花纹|代码)|没有.*(?:实现|修改)|(?:实现|功能|花纹).*缺失/.test(text))
}
export function initImplementationStage(queue:TaskReviewQueue,title?:string,acceptance?:string,kind?:TaskKind){
 if(!title||!requiresImplementation(title,acceptance,kind))return
 queue.phase??='implement'
 if(queue.phase==='implement'&&queue.checks.length)returnToImplementation(queue)
}
export function returnToImplementation(queue:TaskReviewQueue){
 queue.phase='implement';queue.implementationRecovery=true
 // Keep historical checks, but stale queued browser refs must not run after edits.
 for(const check of queue.checks)if(check.status==='pending'){
  check.status='deferred';check.summary='等待实现完成后重新生成检查参数。'
 }
}
