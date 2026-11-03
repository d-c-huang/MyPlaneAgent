import type {StudioMessage, StudioToolActivity} from './local-ai-studio.js'
import type {TaskItem, TaskPlan} from './task-plan.js'

export type VisualDecision = {itemId:string;activityId:string;imageHash:string;decision:'accept'|'reject'|'recapture';note?:string}
const visualRequirement=/视觉|画面|外观|正面视角|(?:canvas|3D).*渲染/i
// Only a whole, explicitly excluded verification clause can waive this gate.
// Unknown wording and affirmative appearance criteria stay conservative; a
// negation about one check cannot erase another clause's visual requirement.
const excludedVisualCheck=/^(?:(?:本项|本次|本轮|此项|当前任务|该任务)(?:验收)?[：:\s]*)?(?:不要求|不需要|无需|无须|不必|不做|不进行)(?:额外|另行|专项|再|进行|执行|提供|取得|人工|人眼|查看|截图|图像|图片|视觉|画面|外观|正面视角|canvas|3D|模型|场景|渲染|效果|质量|证据|检查|核验|验收|验证|确认|评审|的|以及|及|和|与|或|也不要求|也不需要|[、/\s])+$/i
function requiredVisualText(text:string):string{
 const required=text.split(/[，,。；;!?！？\n]|但是|不过|然而|但|同时|并且|而且/).filter(clause=>!excludedVisualCheck.test(clause.trim()))
 return required.join('；')
}
export const needsVisualEvidence=(text:string)=>visualRequirement.test(requiredVisualText(text))
export function visualReviewQuestion(item:TaskItem):string|undefined{
 if(needsVisualEvidence(item.acceptance))return item.acceptance
 // Overall acceptance is generic; the reviewer can discover a visual gap later.
 // This is a request for visual confirmation, never completion of other checks.
 if(item.completionReview?.missingEvidence?.some(needsVisualEvidence))return '请查看截图，确认画面渲染是否符合本项要求。'
 const nextStep=requiredVisualText(item.completionReview?.nextStep||'')
 if(/截图/.test(nextStep)&&/查看|确认|核验/.test(nextStep))return '请查看截图，确认画面是否符合本项要求。'
}
export function invalidatesVisualEvidence(activity:StudioToolActivity){
 return activity.status==='complete'&&['agent.write_file','agent.replace_text','agent.apply_patch','agent.run_command','agent.run_test','agent.build_project','agent.create_document','agent.create_spreadsheet','browser.open','browser.click','browser.fill','browser.select_option'].includes(activity.capability)
}
/** Match evidence owned by this task, never an arbitrary screenshot from another item. */
export function visualReviewCard(item:TaskItem,messages:StudioMessage[]){
 const question=visualReviewQuestion(item)
 if(item.reviewQueue?.phase==='implement'||item.status!=='blocked'||!question||!(item.outcome==='needs_input'||item.completionReview?.status==='needs_input'))return
 const activities=messages.flatMap(message=>message.toolActivity||[])
 let index=-1
 for(let position=activities.length-1;position>=0;position--){const activity=activities[position];if(item.evidenceIds.includes(activity.id)&&activity.capability==='browser.screenshot'&&activity.status==='complete'&&!!activity.images?.length){index=position;break}}
 const activity=activities[index]
 let metadata:Record<string,unknown>={}
 try{metadata=JSON.parse(activity?.output||'{}')}catch{}
 const imageHash=typeof metadata.imageHash==='string'?metadata.imageHash:''
 const responded=!!item.visualResponses?.some(response=>response.activityId===activity?.id&&response.imageHash===imageHash)
 const stale=activities.slice(index+1).some(invalidatesVisualEvidence)
 return {itemId:item.id,title:item.title,question,activityId:activity?.id||'',imageHash,
  image:activity?.images?.[0],url:typeof metadata.url==='string'?metadata.url:'',capturedAt:typeof metadata.capturedAt==='string'?metadata.capturedAt:'',
  stale,responded,canAccept:!responded&&!!activity?.images?.length&&/^[a-f0-9]{64}$/.test(imageHash)&&!stale}
}
export function validateVisualDecision(plan:TaskPlan|undefined,messages:StudioMessage[],input:unknown):VisualDecision{
 const value=input as VisualDecision
 if(!value||!['accept','reject','recapture'].includes(value.decision)||typeof value.itemId!=='string'||typeof value.activityId!=='string'||typeof value.imageHash!=='string'||(value.note!==undefined&&(typeof value.note!=='string'||value.note.length>1000)))throw new Error('无效的视觉验收操作')
 const item=plan?.items.find(item=>item.id===value.itemId)
 const card=item&&visualReviewCard(item,messages)
 if(!card||plan?.needsReplan||plan?.items.find(item=>item.status!=='complete')?.id!==value.itemId)throw new Error('当前任务已变化，请刷新后确认')
 if(card.activityId!==value.activityId||card.imageHash!==value.imageHash)throw new Error('截图已更新，请查看最新截图后确认')
 if(value.decision!=='recapture'&&!card.canAccept)throw new Error('截图缺失或已过期，请重新截图')
 if(value.decision!=='recapture'&&item?.visualResponses?.some(response=>response.activityId===value.activityId&&response.imageHash===value.imageHash))throw new Error('这张截图已提交过验收结果，请继续任务或重新截图')
 return {itemId:value.itemId,activityId:value.activityId,imageHash:value.imageHash,decision:value.decision,...(value.note?.trim()?{note:value.note.trim()}:{})}
}
export function visualDecisionText(item:TaskItem,decision:VisualDecision){
 const action=decision.decision==='accept'?'视觉效果符合要求，请核验其余条件后继续下一项。':decision.decision==='reject'?'视觉效果仍有问题，请针对本项排查修复，然后重新截图验收。':'截图看不清或已过期，请调整到验收要求的视角并重新截图，暂不修改代码。'
 return `继续当前任务「${item.title}」：${action}${decision.note?'\n补充：'+decision.note:''}`
}
