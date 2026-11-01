import type {Capability} from '../../../shared/types/capability.js'
import {estimateTokens} from '../../local-ai-context.js'

/** Bound tool schemas even when no optional model-adapter policy is installed. */
export function budgetCapabilities(capabilities:Capability[],query:string,capacity:number,editing:boolean):Capability[] {
  if(capabilities.length<=8)return capabilities
  const cost=(cap:Capability)=>estimateTokens({name:cap.name,description:cap.description,parameters:cap.parameters})+30
  const budget=Math.max(700,Math.min(16000,Math.floor(capacity*.2)))
  if(capabilities.reduce((sum,cap)=>sum+cost(cap),0)<=budget)return capabilities
  const web=/网页|天气|新闻|联网|网址|https?:|web|browser|weather/i.test(query)
  const preview=/启动|预览|页面|界面|preview|server/i.test(query)
  const priority=[...(web?['agent.web_search','agent.web_fetch','browser.open','browser.read_page','browser.screenshot']:[]),...(preview?['preview.start','preview.status','browser.open','browser.read_page','browser.screenshot']:[]),'agent.read_file','agent.list_files',...(editing?['agent.replace_text','agent.apply_patch','agent.write_file']:[]),'runtime.read_evidence','runtime.read_history','runtime.current_time',...(/测试|test|检查|验收/.test(query)?['agent.run_test','agent.get_diagnostics']:[]),'agent.search_files','agent.inspect_project','agent.web_search','agent.web_fetch']
  const ordered=[...capabilities].sort((a,b)=>{const i=priority.indexOf(a.name),j=priority.indexOf(b.name);return (i<0?100:i)-(j<0?100:j)})
  const selected:Capability[]=[];let used=0
  for(const cap of ordered){const size=cost(cap);if(used+size>budget)continue;selected.push(cap);used+=size}
  return selected
}
