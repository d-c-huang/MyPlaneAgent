<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue'
import RuntimeTemplatePanel from './RuntimeTemplatePanel.vue'
import {emptyNodeConfiguration,type NodeConfiguration,type WorkbenchCommand,type WorkbenchNodeDetail} from '../../electron/shared/runtime-workbench'
const props=defineProps<{sessionId:string;nodeId:string;frozen:boolean}>()
const emit=defineEmits<{changed:[];select:[id:string]}>()
const detail=ref<WorkbenchNodeDetail>(),tab=ref('activity'),busy=ref(false),error=ref(''),notice=ref(''),dirty=ref(false),baseRevision=ref(0),config=ref<NodeConfiguration>(emptyNodeConfiguration())
const scope=ref<'node'|'branch'|'all'>('node'),callId=ref(''),argsText=ref(''),templateName=ref(''),rawArgs=ref(false),loading=ref(true)
let timer:ReturnType<typeof setTimeout>|undefined,epoch=0,disposed=false,loadedKey='',loadedCheckpoint=''
const key=()=>props.sessionId+':'+props.nodeId
const storageKey=()=>`myplane:node-draft:${key()}`
const changedKeys=computed(()=>Object.keys({...detail.value?.config,...config.value}).filter(key=>JSON.stringify((config.value as Record<string,unknown>)[key])!==JSON.stringify((detail.value?.config as Record<string,unknown>|undefined)?.[key])))
const selectedCall=computed(()=>detail.value?.calls.find(call=>call.id===callId.value))
const checkpoint=computed(()=>selectedCall.value?.status==='paused'?selectedCall.value:detail.value?.checkpoint)
const argsValid=computed(()=>{try{const value=JSON.parse(argsText.value);return !!value&&typeof value==='object'&&!Array.isArray(value)}catch{return false}})
const fields=computed(()=>Object.entries((checkpoint.value?.schema as {properties?:Record<string,{type?:string;description?:string;enum?:unknown[]}>})?.properties||{}).filter(([,value])=>['string','number','integer','boolean'].includes(value.type||'')))
const toolsText=computed({get:()=>config.value.tools?.join('\n')||'',set:value=>{config.value.tools=value.split('\n').map(row=>row.trim()).filter(Boolean);markDirty()}})
const fileScopes=computed({get:()=>config.value.fileScope?.join('\n')||'',set:value=>{config.value.fileScope=value.split('\n').map(row=>row.trim()).filter(Boolean);markDirty()}})
const disabled=computed(()=>busy.value||loading.value||props.frozen||!detail.value)
const conflict=computed(()=>dirty.value&&detail.value?.revision!==baseRevision.value)
function markDirty(){dirty.value=true;notice.value='';try{localStorage.setItem(storageKey(),JSON.stringify({revision:baseRevision.value,config:config.value}))}catch{error.value='本地草稿缓存写入失败，请使用保存草稿'}}
function loadConfig(value:WorkbenchNodeDetail,force=false){
 if(!force&&dirty.value)return
 let saved:{revision:number;config:NodeConfiguration}|undefined
 if(!force)try{saved=JSON.parse(localStorage.getItem(storageKey())||'null')}catch{}
 config.value=JSON.parse(JSON.stringify(saved?.config||value.draft||value.config));baseRevision.value=saved?.revision??value.draftBase??value.revision
 dirty.value=!!saved||!!value.draft
}
function accept(value:WorkbenchNodeDetail){
 detail.value=value
 if(loadedKey!==key()){loadedKey=key();dirty.value=false;loadConfig(value);callId.value='';loadedCheckpoint=''}
 else if(!dirty.value)loadConfig(value)
 if(!value.calls.some(call=>call.id===callId.value))callId.value=value.checkpoint?.id||value.calls.at(-1)?.id||''
 if(value.checkpoint&&loadedCheckpoint!==value.checkpoint.id){callId.value=value.checkpoint.id;loadedCheckpoint=value.checkpoint.id;argsText.value=localStorage.getItem(`myplane:call-draft:${props.sessionId}:${loadedCheckpoint}`)||JSON.stringify(value.checkpoint.args,null,2)}
}
async function refresh(){
 clearTimeout(timer);if(disposed||!props.sessionId||!props.nodeId)return
 const generation=epoch,requested=key()
 try{const value=await window.myplane.runtimeGraphDetail(props.sessionId,props.nodeId);if(generation===epoch&&requested===key()){accept(value);loading.value=false}}
 catch(cause){if(generation===epoch){error.value=String(cause);loading.value=false}}
 finally{if(!disposed&&generation===epoch)timer=setTimeout(refresh,900)}
}
async function command(action:WorkbenchCommand['action'],extra:Partial<WorkbenchCommand>={}){
 if(disabled.value||!detail.value)return
 const current=detail.value,requested=key();epoch++;clearTimeout(timer);busy.value=true;error.value='';notice.value=''
 try{
  const value=await window.myplane.runtimeGraphCommand({sessionId:props.sessionId,nodeId:props.nodeId,commandId:crypto.randomUUID(),requestId:current.requestId,expectedRevision:['apply','draft'].includes(action)?baseRevision.value:current.revision,action,scope:scope.value,...extra})
  if(requested!==key())return
  if(action==='apply'){dirty.value=false;localStorage.removeItem(storageKey());baseRevision.value=value.revision;config.value=JSON.parse(JSON.stringify(value.config))}
  if(action==='draft')notice.value='草稿已保存，尚未用于执行'
  else if(action==='apply')notice.value=value.active?'配置已应用，下一次请求采用新指令':'配置已应用，受影响结果已标记过期'
  else if(action==='pause')notice.value='暂停请求已提交，等待执行边界'
  else if(action==='template-save')notice.value='功能模板已保存'
  else notice.value='操作已提交，状态以执行回报为准'
  accept(value);emit('changed')
 }catch(cause){if(requested===key())error.value=String(cause)}
 finally{busy.value=false;if(!disposed)void refresh()}
}
function run(action:'continue'|'step'){
 const point=checkpoint.value
 if(point){if(!argsValid.value){error.value='调用参数必须是 JSON 对象';return}void command(action,{scope:'node',checkpointId:point.id,args:JSON.parse(argsText.value)})}
 else void command(action,{scope:props.nodeId==='task:root'?'all':'node'})
}
function fieldValue(key:string){try{return JSON.parse(argsText.value)[key]}catch{return ''}}
function updateField(key:string,value:unknown){try{argsText.value=JSON.stringify({...JSON.parse(argsText.value),[key]:value},null,2)}catch{error.value='请先修正 JSON 参数'}}
function adopt(configValue:NodeConfiguration,template=false){const preserved=Object.fromEntries(Object.entries(config.value).filter(([key])=>['title','acceptance','kind','dependsOn','fileScope','parallel'].includes(key)));config.value=template?{...preserved,...emptyNodeConfiguration(),...JSON.parse(JSON.stringify(configValue))}:JSON.parse(JSON.stringify(configValue));markDirty();tab.value='config'}
watch(argsText,value=>{if(loadedCheckpoint&&value.length<=200000)try{localStorage.setItem(`myplane:call-draft:${props.sessionId}:${loadedCheckpoint}`,value)}catch{}})
function chooseCall(){const call=selectedCall.value;if(call?.status==='paused'){argsText.value=JSON.stringify(call.args,null,2);loadedCheckpoint=call.id}}
function resetDraft(){if(!detail.value)return;localStorage.removeItem(storageKey());dirty.value=false;config.value=JSON.parse(JSON.stringify(detail.value.config));baseRevision.value=detail.value.revision;notice.value='已载入当前配置';markDirty()}
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false})
watch(()=>[props.sessionId,props.nodeId],()=>{epoch++;clearTimeout(timer);detail.value=undefined;loadedKey='';loading.value=true;error.value='';notice.value='';scope.value='node';void refresh()},{immediate:true})
onBeforeUnmount(()=>{disposed=true;epoch++;clearTimeout(timer)})
</script>

<template>
 <section class="node-editor" aria-label="节点工作台">
  <div class="node-editor-head"><span>节点工作台</span><b v-if="detail">配置 v{{detail.revision}} <small v-if="detail.activity">· 已使用 v{{detail.activity.appliedRevision}}</small></b></div>
  <p v-if="frozen" class="node-message">画面已冻结。恢复刷新后可控制执行。</p>
  <p v-if="loading" class="node-message">正在读取节点…</p>
  <p v-if="error" class="node-message error" role="alert">{{error}}</p>
  <p v-if="notice" class="node-message success" role="status">{{notice}}</p>
  <template v-if="detail">
   <div class="node-live-state" :class="{paused:detail.checkpoint}"><i/>{{detail.checkpoint?'已暂停 · '+detail.checkpoint.name:detail.pauseRequested?'申请暂停 · 等待执行边界':detail.activity?.cancelled?'正在取消':detail.activity?.phase==='finished'||!detail.active?'已保存的执行记录':detail.activity?.label||'等待调度'}}<small v-if="detail.activity">{{time(detail.activity.at)}}</small></div>
   <div class="node-controls">
    <label>控制范围<select v-model="scope" aria-label="节点控制范围"><option value="node">当前节点</option><option value="branch">当前依赖分支</option><option value="all">整个任务</option></select></label>
    <div class="node-actions">
     <button data-node-action="pause" :disabled="disabled||!detail.active||(!detail.controllable&&scope==='node')" @click="command('pause')">暂停执行</button>
     <button data-node-action="continue" :disabled="disabled||!detail.active||(!detail.controllable&&scope==='node')||(!detail.pauseRequested&&!detail.checkpoint&&scope!=='all')||scope==='branch'" @click="scope==='all'?command('continue',{scope:'all'}):run('continue')">继续{{scope==='all'?'全部':''}}</button>
     <button data-node-action="step" :disabled="disabled||!detail.checkpoint||scope!=='node'" @click="run('step')">单步</button>
     <button data-node-action="cancel" class="danger" :disabled="disabled||!detail.active||(!detail.controllable&&scope==='node')" @click="command('cancel')">取消{{scope==='all'?'任务':'节点'}}</button>
    </div>
   </div>
   <nav class="node-tabs" aria-label="节点编辑页签"><button v-for="[id,label] in [['activity','当前活动'],['io','输入输出'],['config','功能配置'],['history','历史版本']]" :key="id" :aria-selected="tab===id" @click="tab=id">{{label}}<i v-if="id==='config'&&dirty"/></button></nav>
   <div v-if="tab==='activity'" class="node-tab-body">
    <dl class="node-facts"><dt>工作目录</dt><dd>{{detail.workspace}}</dd><dt>模型请求</dt><dd>{{detail.activity?.requests??'—'}}</dd><dt>工具调用</dt><dd>{{detail.activity?.toolCalls??'—'}}</dd><dt v-if="detail.scopeId!=='main'">全局配置</dt><dd v-if="detail.scopeId!=='main'">v{{detail.rootRevision}} · 已使用 v{{detail.activity?.appliedRootRevision??0}}</dd><dt>配置生效</dt><dd>指令、输入和模型在下一次请求生效；工具限制在调用前复核。</dd></dl>
    <div v-if="detail.checkpoint" class="node-checkpoint"><strong>执行已停在检查点</strong><p>{{detail.checkpoint.kind==='stage'?'子任务尚未开始。可先修改功能配置。':'可在输入输出页修改本次参数，校验后单步执行。'}}</p><button @click="tab='io'">查看暂停点 →</button></div>
    <div v-for="approval in detail.approvals" :key="approval.id" class="node-checkpoint approval"><strong>等待授权 · {{approval.capability}}</strong><pre>{{JSON.stringify(approval.args,null,2)}}</pre><div class="node-actions"><button :disabled="disabled" @click="command('approve',{approvalId:approval.id})">允许本次</button><button class="danger" :disabled="disabled" @click="command('reject',{approvalId:approval.id})">拒绝</button></div></div>
    <div v-if="!detail.active&&detail.tasks.length" class="node-checkpoint"><strong>从保存的计划恢复</strong><p>重跑当前节点及依赖它的后续节点；保留旧记录与重复写入保护。</p><details><summary>影响 {{detail.affected.length}} 个节点</summary><p v-for="item in detail.affected" :key="item.id">{{item.title}}</p></details><button data-node-action="retry" :disabled="disabled" @click="command('retry')">重新执行受影响分支</button></div>
    <ol class="node-timeline"><li v-for="event in [...detail.events].reverse().slice(0,20)" :key="event.id"><time>{{time(event.at)}}</time><span>{{event.detail}}</span></li></ol>
   </div>
   <div v-else-if="tab==='io'" class="node-tab-body">
    <label class="node-field">具体调用<select v-model="callId" aria-label="选择具体调用" @change="chooseCall"><option v-if="!detail.calls.length" value="">暂无调用</option><option v-for="call in [...detail.calls].reverse()" :key="call.id" :value="call.id">{{call.status==='paused'?'⏸ ':''}}{{call.name}} · {{call.id.slice(-8)}}</option></select></label>
    <template v-if="selectedCall"><p class="node-help">{{selectedCall.source}} · {{selectedCall.status}}<br/>{{selectedCall.id}}</p>
     <template v-if="selectedCall.status==='paused'">
      <label class="node-check"><input v-model="rawArgs" type="checkbox"/>编辑 JSON 参数</label>
      <template v-if="!rawArgs&&fields.length"><label v-for="[key,field] in fields" :key="key" class="node-field">{{key}}<small>{{field.description}}</small><input v-if="field.type==='boolean'" :checked="!!fieldValue(key)" type="checkbox" @change="updateField(key,($event.target as HTMLInputElement).checked)"/><input v-else-if="['number','integer'].includes(field.type||'')" type="number" :value="fieldValue(key)" @input="updateField(key,Number(($event.target as HTMLInputElement).value))"/><textarea v-else :value="fieldValue(key)" rows="3" @input="updateField(key,($event.target as HTMLTextAreaElement).value)"/></label></template>
      <textarea v-else v-model="argsText" aria-label="节点调用参数" rows="10" spellcheck="false" class="node-code"/>
      <p class="node-help">修改仅作用于这次调用。单步后停在下一检查点；已发出的操作不能倒退。</p>
      <div class="node-actions"><button :disabled="disabled||!argsValid" @click="run('step')">校验并单步</button><button :disabled="disabled||!argsValid" @click="run('continue')">校验并继续</button></div>
     </template>
     <pre v-else>{{JSON.stringify(selectedCall.args,null,2)}}</pre>
     <details><summary>参数格式 / Schema</summary><pre>{{JSON.stringify(selectedCall.schema,null,2)}}</pre></details>
     <details v-if="selectedCall.edited"><summary>修改前的参数</summary><pre>{{JSON.stringify(selectedCall.originalArgs,null,2)}}</pre></details>
     <h4>执行结果</h4><pre>{{selectedCall.output||'尚未返回结果'}}</pre>
    </template><p v-else class="node-help">选择具体调用查看输入、输出与执行证据。</p>
   </div>
   <div v-else-if="tab==='config'" class="node-tab-body">
    <p v-if="nodeId.startsWith('tool:')" class="node-help">这里编辑所属 Worker 的功能。本次工具参数请在“输入输出”中修改。</p>
    <p v-if="conflict" class="node-message error">当前配置已更新。本地草稿保留，请载入当前版本后合并修改。</p>
    <label class="node-field">功能指令<textarea v-model="config.instruction" aria-label="节点功能指令" rows="5" maxlength="30000" placeholder="描述此节点如何处理任务、输出要求和约束" @input="markDirty"/></label>
    <label class="node-field">补充输入<textarea v-model="config.input" aria-label="节点补充输入" rows="3" maxlength="30000" placeholder="提供人工补充的资料、内容或参数" @input="markDirty"/></label>
    <label class="node-field">模型 ID<input v-model="config.model" aria-label="节点模型" maxlength="500" placeholder="留空继承；使用当前推理服务可用的模型" @input="markDirty"/><small>本地服务使用已加载模型；切换本地模型请先在“我的模型”加载。</small></label>
    <details class="node-config-group"><summary>工具与执行预算</summary>
     <label class="node-check"><input :checked="config.tools!==undefined" type="checkbox" @change="config.tools=($event.target as HTMLInputElement).checked?[]:undefined;markDirty()"/>限制此节点可用工具</label>
     <label v-if="config.tools!==undefined" class="node-field">每行一个已注册工具名称<textarea v-model="toolsText" rows="4" placeholder="agent.read_file&#10;agent.list_files"/><small>空列表禁用全部工具；不能扩大现有文件、联网或审批权限。</small></label>
     <label class="node-field">模型请求上限<input :value="config.maxRequests" type="number" min="1" placeholder="继承" @input="config.maxRequests=($event.target as HTMLInputElement).value?Number(($event.target as HTMLInputElement).value):undefined;markDirty()"/></label>
     <label class="node-field">工具调用上限<input :value="config.maxToolCalls" type="number" min="1" placeholder="继承" @input="config.maxToolCalls=($event.target as HTMLInputElement).value?Number(($event.target as HTMLInputElement).value):undefined;markDirty()"/></label>
     <label class="node-field">单次模型超时（毫秒）<input :value="config.timeoutMs" type="number" min="1" placeholder="继承" @input="config.timeoutMs=($event.target as HTMLInputElement).value?Number(($event.target as HTMLInputElement).value):undefined;markDirty()"/></label>
    </details>
    <details v-if="config.title!==undefined" class="node-config-group"><summary>任务定义与依赖关系</summary><p class="node-help">{{detail.structuralEditable?'修改后会使相关下游结果过期。':'运行期间锁定结构；结束本轮后可修改。'}}</p>
     <fieldset :disabled="!detail.structuralEditable"><label class="node-field">任务标题<input v-model="config.title" @input="markDirty"/></label><label class="node-field">验收条件<textarea v-model="config.acceptance" rows="3" @input="markDirty"/></label><label class="node-field">任务功能类型<select v-model="config.kind" @change="markDirty"><option value="research">研究</option><option value="inspect">读取与检查</option><option value="edit">编辑</option><option value="verify">验证</option><option value="preview">预览</option><option value="answer">回答</option></select></label>
     <label class="node-field">文件范围<textarea v-model="fileScopes" rows="2" placeholder="每行一个相对文件路径"/></label><label class="node-check"><input v-model="config.parallel" type="checkbox" @change="markDirty"/>允许并行（仍需通过范围与验收检查）</label>
     <span class="node-help">前置依赖</span><label v-for="item in detail.tasks.filter(item=>item.id!==detail?.scopeId)" :key="item.id" class="node-check"><input v-model="config.dependsOn" type="checkbox" :value="item.id" @change="markDirty"/>{{item.title}}</label></fieldset>
    </details>
    <div class="node-diff"><strong>{{dirty?'草稿 · 尚未用于执行':'当前配置'}}</strong><p v-if="changedKeys.length">变更字段：{{changedKeys.join('、')}}</p><p v-if="detail.affected.length&&!detail.active">应用后影响 {{detail.affected.length}} 个节点，旧记录保留。</p><details v-if="changedKeys.length"><summary>查看修改差异</summary><div v-for="key in changedKeys" :key="key"><b>{{key}}</b><pre class="before">− {{JSON.stringify((detail.config as Record<string,unknown>)[key])}}</pre><pre>+ {{JSON.stringify((config as Record<string,unknown>)[key])}}</pre></div></details></div>
    <div class="node-actions sticky"><button data-node-action="draft" :disabled="disabled||conflict" @click="command('draft',{config:JSON.parse(JSON.stringify(config))})">保存草稿</button><button class="primary" data-node-action="apply" :disabled="disabled||conflict||!changedKeys.length" @click="command('apply',{config:JSON.parse(JSON.stringify(config))})">应用配置</button><button :disabled="disabled" @click="resetDraft">载入当前版本</button></div>
    <RuntimeTemplatePanel :config="config" :disabled="disabled" @adopt="adopt($event,true)"/>
    <details class="node-config-group"><summary>当前会话模板</summary><label class="node-field">模板名称<input v-model="templateName" maxlength="80" placeholder="例如：代码审查员"/></label><button :disabled="disabled||!templateName.trim()" @click="command('template-save',{name:templateName,config:JSON.parse(JSON.stringify(config))})">保存为模板</button><div v-for="template in detail.templates" :key="template.id" class="node-template"><span>{{template.name}}</span><button :disabled="disabled" @click="adopt(template.config,true)">载入草稿</button><button :disabled="disabled" @click="command('template-delete',{templateId:template.id})">删除</button></div></details>
   </div>
   <div v-else class="node-tab-body">
    <p class="node-help">恢复旧版本会生成新草稿，应用后创建新版本；不会改写过去的执行结果。</p>
    <article v-for="version in [...detail.history].reverse()" :key="version.revision" class="node-version"><strong>v{{version.revision}} · {{version.reason}}</strong><time>{{time(version.at)}}</time><p>{{version.config.instruction||'使用默认指令'}}</p><button @click="adopt(version.config)">载入此版本</button></article>
    <h4>已归档的执行</h4><details v-for="(archive,index) in [...detail.archives].reverse()" :key="index"><summary>{{archive.item.title}} · {{archive.item.status}}</summary><p>{{time(archive.at)}} · {{archive.reason}}</p><pre>{{archive.item.summary}}</pre><p>证据 {{archive.item.evidenceIds.length}} 条</p></details><p v-if="!detail.history.length&&!detail.archives.length" class="node-help">还没有配置版本或归档执行。</p>
   </div>
  </template>
 </section>
</template>

<style scoped>
.node-editor{border-top:1px solid #ffffff13;padding:17px 18px;color:#dbe7f7;font-size:11px;user-select:text}.node-editor-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:12px;font-weight:600}.node-editor-head b{color:#7bdfe4;font-size:10px;font-weight:500}.node-editor-head small{color:#90a3bd;font-size:9px}.node-live-state{padding:10px 11px;background:#6edee909;border:1px solid #6edee91c;border-radius:8px;color:#a5dbe3;overflow-wrap:anywhere}.node-live-state i{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:7px}.node-live-state small{display:block;font-size:9px;color:#718ba8;margin-top:5px}.node-live-state.paused{color:#c3b0ff;background:#b3a1ef0b;border-color:#b3a1ef33}.node-controls{margin:12px 0}.node-controls>label{display:flex;align-items:center;gap:10px;margin-bottom:9px;color:#8c9fb9}.node-controls select{flex:1}.node-editor button{border:1px solid #ffffff1b;color:#bcd2e7;background:#1b2a40;padding:6px 8px;border-radius:6px;font:inherit;cursor:pointer}.node-editor button:hover:not(:disabled){border-color:#6edee978;color:#e6ffff}.node-editor button:disabled{opacity:.38;cursor:default}.node-editor button.primary{background:#244550;border-color:#71dce44a;color:#b8faff}.node-editor button.danger{color:#f0a2b3}.node-actions{display:flex;flex-wrap:wrap;gap:6px}.node-tabs{display:flex;border-bottom:1px solid #ffffff17;margin:16px -3px 12px}.node-tabs button{position:relative;padding:8px 5px;flex:1;border:none;border-bottom:2px solid transparent;background:transparent;border-radius:0;color:#879db9;font-size:10px;white-space:nowrap}.node-tabs button[aria-selected=true]{color:#8ae8e7;border-color:#6edee9}.node-tabs i{display:inline-block;width:4px;height:4px;background:#f6cb80;border-radius:50%;margin-left:3px}.node-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;color:#bbcee4}.node-field small,.node-help{font-size:10px;line-height:1.8;color:#7f96b4;overflow-wrap:anywhere}.node-editor input:not([type=checkbox]),.node-editor select,.node-editor textarea{width:100%;min-width:0;border:1px solid #ffffff1b;border-radius:6px;padding:7px 9px;background:#0c1525;color:#d5e3f3;font:inherit;line-height:1.6}.node-editor textarea{resize:vertical}.node-editor input[type=checkbox]{accent-color:#6edee9}.node-editor textarea:focus,.node-editor input:focus{outline:1px solid #6edee97a}.node-editor fieldset{border:0;padding:0;margin:0}.node-editor fieldset:disabled{opacity:.55}.node-editor pre{font:10px/1.7 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#0a1424;padding:10px;border-radius:6px;max-height:260px;overflow:auto;color:#adc6e2}.node-editor h4{font-size:11px;margin:18px 0 9px}.node-check{display:flex;align-items:center;gap:8px;font-size:10px;color:#9db3cd;margin:10px 0}.node-config-group{padding:12px 0;border-bottom:1px solid #ffffff0d}.node-editor summary{cursor:pointer;color:#b6c9e0;font-size:10px;line-height:1.8}.node-diff{padding:10px;border:1px solid #eec27824;background:#eec27806;border-radius:6px;font-size:10px;line-height:1.8;margin:14px 0;color:#b9ac8b}.node-diff .before{color:#b48b96}.node-message{font-size:10px;line-height:1.8;padding:9px;border-radius:6px;background:#a38ddd12;color:#c5b9e7;margin:7px 0;overflow-wrap:anywhere}.node-message.error{background:#ff829c12;color:#ffb0c2}.node-message.success{background:#69dbb010;color:#9bdfc5}.node-facts{display:grid;grid-template-columns:65px 1fr;gap:9px;font-size:10px;margin:16px 0}.node-facts dt{color:#7c91af}.node-facts dd{margin:0;overflow-wrap:anywhere;color:#b3c7df}.node-checkpoint{padding:12px;background:#b3a1ef0a;border:1px solid #b3a1ef24;border-radius:8px;margin:12px 0}.node-checkpoint p{color:#8fa6c3;font-size:10px;line-height:1.8;margin:8px 0}.node-checkpoint strong{color:#c6b9ef;font-weight:500}.node-checkpoint.approval{border-color:#eec27840}.node-timeline{list-style:none;margin:16px 0;padding:0}.node-timeline li{border-left:1px solid #ffffff1a;padding:0 0 15px 12px;display:flex;flex-direction:column;gap:5px;color:#a8bed7;font-size:10px}.node-timeline time,.node-version time{color:#6c86a5;font-size:9px}.node-version{padding:12px 0;border-bottom:1px solid #ffffff0d;display:flex;flex-direction:column;gap:8px}.node-version p{font-size:10px;color:#99adc7;white-space:pre-wrap;max-height:120px;overflow:auto}.node-version button{align-self:flex-start}.node-template{display:flex;gap:5px;align-items:center;margin-top:10px}.node-template span{flex:1;overflow-wrap:anywhere}.sticky{position:sticky;bottom:0;background:#101a2bf2;padding:10px 0;backdrop-filter:blur(10px)}
</style>
