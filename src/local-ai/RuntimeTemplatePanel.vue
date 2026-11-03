<script setup lang="ts">
import {computed,onMounted,ref} from 'vue'
import type {NodeConfiguration,SharedNodeTemplate,TemplateCommand} from '../../electron/shared/runtime-workbench'
const props=defineProps<{config:NodeConfiguration;disabled:boolean}>()
const emit=defineEmits<{adopt:[config:NodeConfiguration]}>()
const templates=ref<SharedNodeTemplate[]>([]),selectedId=ref(''),name=ref(''),busy=ref(false),error=ref(''),notice=ref(''),transfer=ref(''),transferMode=ref<'import'|'export'>(),version=ref(0)
const selected=computed(()=>templates.value.find(row=>row.id===selectedId.value))
const selectedConfig=computed(()=>version.value===selected.value?.revision?selected.value.config:selected.value?.history.find(row=>row.revision===version.value)?.config)
async function refresh(){try{templates.value=await window.myplane.runtimeGraphTemplates()}catch(cause){error.value=String(cause)}}
function choose(){name.value=selected.value?.name||'';version.value=selected.value?.revision||0;notice.value=''}
async function send(command:TemplateCommand){
 busy.value=true;error.value='';notice.value=''
 try{templates.value=await window.myplane.runtimeGraphTemplates(command);if(command.action==='delete'){selectedId.value='';choose()}else{selectedId.value=templates.value[0]?.id||'';choose();notice.value='已保存到本机共享模板库；节点配置尚未改变';transferMode.value=undefined}}
 catch(cause){error.value=String(cause);await refresh()}
 finally{busy.value=false}
}
function save(update=false){void send({action:'save',name:name.value,config:JSON.parse(JSON.stringify(props.config)),...(update&&selected.value?{id:selected.value.id,expectedRevision:selected.value.revision}:{})})}
function exportTemplate(){if(!selected.value||!selectedConfig.value)return;transfer.value=JSON.stringify({format:'myplane-node-template',version:1,name:selected.value.name,config:selectedConfig.value},null,2);transferMode.value='export'}
onMounted(refresh)
</script>
<template>
 <details class="node-config-group shared-template-panel"><summary>共享模板库 · 跨会话复用</summary>
  <p class="node-help">保存指令、输入、模型、工具限制和预算。加载到草稿后再应用；保留当前任务的标题与依赖。</p>
  <p v-if="error" class="node-message error" role="alert">{{error}}</p><p v-if="notice" class="node-message success">{{notice}}</p>
  <label class="node-field">模板<select v-model="selectedId" aria-label="共享功能模板" @change="choose"><option value="">新建模板</option><option v-for="item in templates" :key="item.id" :value="item.id">{{item.name}} · v{{item.revision}}</option></select></label>
  <label class="node-field">模板名称<input v-model="name" aria-label="共享模板名称" maxlength="80" placeholder="例如：代码审查员"/></label>
  <label v-if="selected" class="node-field">模板版本<select v-model="version" aria-label="共享模板版本"><option :value="selected.revision">v{{selected.revision}} · 当前版本</option><option v-for="item in [...selected.history].reverse()" :key="item.revision" :value="item.revision">v{{item.revision}} · {{new Date(item.at).toLocaleString()}}</option></select></label>
  <div class="node-actions"><button :disabled="disabled||busy||!selectedConfig" @click="selectedConfig&&emit('adopt',selectedConfig)">加载到节点草稿</button><button :disabled="disabled||busy||!name.trim()" @click="save()">另存为共享模板</button><button v-if="selected" :disabled="disabled||busy||!name.trim()" @click="save(true)">以当前草稿发布新版本</button></div>
  <div class="node-actions"><button :disabled="busy" @click="refresh">刷新模板库</button><button :disabled="busy||!selectedConfig" @click="exportTemplate">导出 JSON</button><button :disabled="disabled||busy" @click="transferMode='import';transfer=''">导入 JSON</button><button v-if="selected" class="danger" :disabled="disabled||busy" @click="send({action:'delete',id:selected.id,expectedRevision:selected.revision})">删除模板</button></div>
  <template v-if="transferMode"><p class="node-help">{{transferMode==='export'?'复制以下 JSON 保存到文件，即可在另一台设备导入。':'粘贴 MyPlaneAgent 模板 JSON。导入会新建模板。'}}</p><textarea v-model="transfer" aria-label="模板 JSON" class="node-code" rows="9" :readonly="transferMode==='export'" maxlength="100000"/><div class="node-actions"><button v-if="transferMode==='import'" :disabled="disabled||busy||!transfer.trim()" @click="send({action:'import',json:transfer})">校验并导入</button><button @click="transferMode=undefined">收起</button></div></template>
 </details>
</template>
