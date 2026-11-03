<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import {ElMessage} from 'element-plus'
import {AppMessageBox as ElMessageBox} from './message-box'
import {
  Aim,
  ChatLineSquare,
  Sort,
  Checked,
  Collection,
  Operation,
  Switch,
  Bell,
  Check,
  Close,
  Connection,
  Cpu,
  DataAnalysis,
  Delete,
  DocumentChecked,
  Edit,
  Flag,
  Fold,
  FullScreen,
  Guide,
  QuestionFilled,
  MagicStick,
  Plus,
  RefreshLeft,
  RefreshRight,
  Search,
  ScaleToOriginal,
  UserFilled,
  VideoPause,
  VideoPlay,
  ZoomIn,
  ZoomOut,
} from "@element-plus/icons-vue";
import type { StudioSettings } from "../../electron/shared/local-ai-studio";
import { ruleOperators, isDecision } from "../../electron/shared/workflow-decisions";
import type { WorkflowRule } from "../../electron/shared/local-ai-workflow";
import { mapVariableReferences } from "../../electron/shared/workflow-variable-references";
import { workflowInputPreview } from "../../electron/shared/workflow-inputs";
import { readWorkflowValidationError } from "../../electron/shared/workflow-validation";
import { nextWorkflowNodeName, workflowNodeNameError } from "../../electron/shared/workflow-node-names";
import { parseWorkflowAiOutput } from "../../electron/shared/workflow-ai-output";
import { formatWorkflowJson, parseWorkflowJsonTemplate, workflowJsonError } from "../../electron/shared/workflow-json-template";
import type {
  WorkflowBranch,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowModelRef,
  WorkflowNode,
  WorkflowRun,
  WorkflowVariableAssignment,
} from "../../electron/shared/local-ai-workflow";

type ModelOption = { id: string; name?: string; instanceId?: string; modelRef?: WorkflowModelRef };
const props = withDefaults(
    defineProps<{
      model: string;
      models: ModelOption[];
      windowMode?: boolean;
      workflowId?: string;
      appearanceStyle?: StudioSettings["appearanceStyle"];
      theme?: StudioSettings["theme"];
    }>(),
    { windowMode: false, workflowId: "", appearanceStyle: "minimal", theme: "system" },
  ),
  api = window.myplane.localAiStudio;
const definitions = ref<WorkflowDefinition[]>([]),
  runs = ref<WorkflowRun[]>([]),
  editing = ref(false),
  selectedId = ref(""),
  historyId = ref(""),
  workflowSearch = ref(""),
  historyStatus = ref<"all" | "active" | "failed">("all"),
  busy = ref(""),
  error = ref(""),
  selectedNodeId = ref("__start__");
const canvas = ref<HTMLElement>(),
  canvasHost = ref<HTMLElement>(),
  editorBody = ref<HTMLElement>();
const saveErrorNodeIds = ref(new Set<string>());
let timer: ReturnType<typeof setInterval> | undefined,
  autoSaveTimer: ReturnType<typeof setInterval> | undefined,
  historyTimer: ReturnType<typeof setTimeout> | undefined,
  disposeSaved: (() => void) | undefined,
  nodeSequence = 0,
  applyingHistory = false;
type FormBranch = WorkflowBranch;
type FormNode = {
  id: string;
  name: string;
  type: WorkflowNode["type"];
  branches: FormBranch[];
  instruction: string;
  executionJson: string;
  model: string;
  modelRef?: WorkflowModelRef;
  modelSource: "current" | "specified";
  mode: "coding" | "general" | "documents";
  maxSteps: number;
  fastMode: boolean;
  approvalMode: "ask" | "auto" | "full" | "unrestricted";
  inputSignalMode: "all" | "any";
  branchMode: "direct" | "ai" | "rules";
  judgeMode: "classify" | "legacy";
  judgeInput: string;
  unknownBranchId: string;
  sourceNodeId: string;
  operator: "succeeded" | "failed";
  rules: WorkflowRule[];
  ruleMode: 'all' | 'any';
  switchValue: string;
  switchKind: 'text' | 'number' | 'boolean';
  switchCases: {branchId:string;value:string}[];
  defaultBranchId: string;
  assignments: WorkflowVariableAssignment[];
  joinMode: "all" | "any";
  approvalTitle: string;
  approvalWaitMode: 'forever'|'duration'|'until';
  approvalDuration: number;
  approvalDeadline: string;
  approvalTimeoutAction: 'reject'|'fail';
  approvalPrompt: string;
  approveLabel: string;
  rejectLabel: string;
  title: string;
  body: string;
  endStatus: "succeeded" | "failed";
  endSummary: string;
  endScope: 'path'|'workflow';
  endResult: string;
  x: number;
  y: number;
};
type Branch = string;
type ConnectionDraft = {
  sourceId: string;
  branch: Branch;
  mode: "add" | "replace";
  originalTargetId?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
type DragState = {
  clientX: number;
  clientY: number;
  positions: Map<string, { x: number; y: number }>;
};
type PanState = { clientX: number; clientY: number; x: number; y: number };
type InspectorDragState = {
  clientX: number;
  clientY: number;
  x: number;
  y: number;
};
type CanvasEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  branch: Branch;
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
  color: string;
};
type SelectionMode = "replace" | "add" | "toggle" | "subtract";
type SelectionBox = {
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mode: SelectionMode;
  initial: Set<string>;
};
const connection = ref<ConnectionDraft>(),
  drag = ref<DragState>(),
  pan = ref<PanState>(),
  selectionBox = ref<SelectionBox>(),
  viewport = reactive({ x: 0, y: 0 }),
  zoom = ref(1),
  edgeMenu = ref<{ edge: CanvasEdge; x: number; y: number }>(),
  selectedEdgeKey = ref<{
    sourceId: string;
    branch: Branch;
    targetId: string;
  }>(),
  selectedNodeIds = ref(new Set<string>(["__start__"]));
const componentPanelCollapsed = ref(false);
const inspectorFloating = ref(false),
  inspectorPosition = reactive({ x: 24, y: 18 }),
  inspectorDrag = ref<InspectorDragState>();
let spacePressed = false,
  suppressEdgeMenuUntil = 0;
const newNode = (type: FormNode["type"] = "agent", index = 0): FormNode => {
  nodeSequence++;
  const names: Record<FormNode["type"], string> = {
      agent: "Agent 任务",
      "ai-judge": "AI 判断",
      condition: "旧版判断",
      route: "旧版路由",
      judge: "数据判断", predicate: "条件判断", switch: "Switch",
      data: "数据变量",
      join: "汇合",
      approval: "人工确认",
      notify: "系统通知",
      end: "结束",
    },
    branches: FormBranch[] =
      isDecision(type)
        ? ['成立', type === 'switch' ? '默认' : '不成立'].map((name, i) => ({id:`decision_${nodeSequence}_${i}`,name:type === 'switch' && i === 0 ? '匹配 1' : name,condition:'',color:i ? '#d45b68' : '#2f9b74',targetNodeIds:[],outputValue:'{"result":""}'}))
        : type === "ai-judge"
        ? ["符合条件", "不符合条件", "无法判断"].map((name, i) => ({id:`ai_${nodeSequence}_${i}`,name,condition:["输入明确符合判断标准", "输入明确不符合判断标准", "输入缺失、含糊或无法确定"][i],color:["#2f9b74", "#347fc5", "#d45b68"][i],targetNodeIds:[],outputValue:'{"result":"","reason":""}'}))
        : type === "agent"
        ? [
            {
              id: `result_${nodeSequence}`,
              name: "任务结果",
              condition: "",
              color: "#347fc5",
              targetNodeIds: [],
              outputValue: '{"result":""}',
            },
          ]
        : type === "join"
          ? [{ id: `joined_${nodeSequence}`, name: "汇合完成", condition: "", color: "#347fc5", targetNodeIds: [], outputValue: '{"result":""}' }]
        : type === "data"
          ? [{ id: `data_${nodeSequence}`, name: "设置完成", condition: "", color: "#347fc5", targetNodeIds: [], outputValue: '{"result":""}' }]
        : type === "notify"
          ? ['发送成功','发送失败'].map((name,i)=>({id:`notify_${nodeSequence}_${i}`,name,condition:'',color:i?'#d45b68':'#2f9b74',targetNodeIds:[],outputValue:'{"result":""}'}))
        : type === "approval"
          ? [
              {
                id: `approved_${nodeSequence}`,
                name: "批准",
                condition: "",
                outputValue:'{"result":""}',
                color: "#2f9b74",
                targetNodeIds: [],
              },
              {
                id: `rejected_${nodeSequence}`,
                name: "拒绝",
                condition: "",
                outputValue:'{"result":""}',
                color: "#d45b68",
                targetNodeIds: [],
              },
            ]
          : [];
  return {
    id: `step_${Date.now().toString(36)}_${nodeSequence}`,
    name: nextWorkflowNodeName(form.nodes, type, names[type]),
    type,
    branches,
    instruction: "",
    executionJson: "",
    model: props.model || props.models[0]?.id || "",
    modelSource: "current",
    mode: type === "ai-judge" ? "general" : "coding",
    maxSteps: 30,
    fastMode: true,
    approvalMode: "ask",
    inputSignalMode: "any",
    branchMode: type === "agent" ? "direct" : "ai",
    judgeMode: type === "ai-judge" ? "classify" : "legacy",
    judgeInput: "",
    unknownBranchId: type === "ai-judge" ? branches[2].id : "",
    sourceNodeId: "",
    operator: "succeeded",
    rules: [{kind:'text',left:'',operator:'eq',right:''}], ruleMode:'all',
    switchValue:'',switchKind:'text',switchCases:type === 'switch' ? [{branchId:branches[0].id,value:''}] : [],defaultBranchId:type === 'switch' ? branches[1].id : '',
    assignments: type === "data" ? [{ name: "result", value: "" }] : [],
    joinMode: "all",
    approvalTitle:'人工确认',approvalWaitMode:'forever',approvalDuration:60,approvalDeadline:'',approvalTimeoutAction:'reject',
    approvalPrompt: "请确认是否继续执行工作流",
    approveLabel: "批准",
    rejectLabel: "拒绝",
    title: "工作流通知",
    body: "工作流节点执行完成",
    endStatus: "succeeded",
    endSummary: "工作流执行完成",
    endScope:"path",endResult:"",
    x: 430 + (index % 3) * 290,
    y: 110 + Math.floor(index / 3) * 260,
  };
};
const fresh = () => ({
  id: "",
  name: "新建工作流",
  description: "",
  enabled: true,
  timeoutMinutes: 120,
  entryNodeIds: [] as string[],
  startX: 230,
  startY: 180,
  nodes: [] as FormNode[],
});
const form = reactive(fresh());
type ComponentItem = {label:string;type:FormNode['type'];icon:typeof Cpu;kind?:WorkflowRule['kind']};
const componentGroups: {name:string;items:ComponentItem[]}[] = [
  {name:'任务执行',items:[{label:'Agent',type:'agent',icon:Cpu},{label:'系统通知',type:'notify',icon:Bell}]},
  {name:'数据处理',items:[{label:'数据变量',type:'data',icon:DataAnalysis},{label:'汇合',type:'join',icon:Connection}]},
  {name:'逻辑判断',items:[{label:'AI 判断',type:'ai-judge',icon:Cpu},...(['text','number','boolean','collection'] as const).map((kind,i)=>({label:['文本判断','数值判断','布尔判断','集合判断'][i],type:'judge' as const,icon:[ChatLineSquare,Sort,Checked,Collection][i],kind})),{label:'条件判断',type:'predicate',icon:Operation},{label:'Switch',type:'switch',icon:Switch}]},
  {name:'流程控制',items:[{label:'人工确认',type:'approval',icon:UserFilled},{label:'结束',type:'end',icon:Flag}]},
];
function addComponent(item: ComponentItem) {
  addNode(item.type);
  const node = form.nodes[form.nodes.length - 1];
  node.name = nextWorkflowNodeName(form.nodes.filter(other => other.id !== node.id), item.type, item.label);
  if (item.kind) { node.rules[0].kind = item.kind; resetRule(node.rules[0]); }
}
function resetRule(rule: WorkflowRule) {
  rule.operator = ruleOperators[rule.kind][0].value;
  rule.right = rule.kind === 'boolean' ? 'true' : rule.kind === 'number' ? '0' : '';
}
function addSwitchCase(node: FormNode) {
  const id = `case_${Date.now().toString(36)}_${++nodeSequence}`;
  node.switchCases.push({branchId:id,value:''});
  node.branches.splice(node.branches.length-1,0,{id,name:`匹配 ${node.switchCases.length}`,condition:'',color:'#347fc5',targetNodeIds:[],outputValue:'{"result":""}'});
}
function removeSwitchCase(node: FormNode, index: number) {
  const item = node.switchCases.splice(index,1)[0];
  node.branches = node.branches.filter(branch=>branch.id !== item.branchId);
}
const history = ref<string[]>([]),
  historyIndex = ref(-1),
  lastSavedSnapshot = ref(""),
  lastAutoSaveAttempt = ref(""),
  lastSavedAt = ref<Date>(),
  canUndo = computed(() => historyIndex.value > 0),
  canRedo = computed(
    () =>
      historyIndex.value >= 0 && historyIndex.value < history.value.length - 1,
  );
const selected = computed(() =>
    definitions.value.find((item) => item.id === selectedId.value),
  ),
  starterWorkflow = computed(() => selected.value || definitions.value[0]),
  filteredDefinitions = computed(() =>
    definitions.value.filter((item) =>
      item.name.toLocaleLowerCase().includes(workflowSearch.value.trim().toLocaleLowerCase()),
    ),
  ),
  visibleRuns = computed(() =>
    runs.value.filter(
      (item) => !historyId.value || item.workflowId === historyId.value,
    ),
  ),
  filteredRuns = computed(() =>
    visibleRuns.value.filter((item) =>
      historyStatus.value === "all" ||
      (historyStatus.value === "active"
        ? ["running", "waiting"].includes(item.status)
        : ["failed", "cancelled"].includes(item.status)),
    ),
  );
const selectedNode = computed(() =>
    form.nodes.find((node) => node.id === selectedNodeId.value),
  ),
  encodeModelRef = (ref: WorkflowModelRef) => JSON.stringify(ref),
  decodeModelRef = (value: string): WorkflowModelRef | undefined => {
    try {
      const parsed = JSON.parse(value) as WorkflowModelRef;
      if (
        parsed?.source === "local" ||
        parsed?.source === "remote" ||
        parsed?.source === "current"
      )
        return parsed;
    } catch {
      /* Legacy plain model id. */
    }
  },
  specifiedModelOptions = computed(() => {
    const rows = new Map<string, string>();
    for (const item of props.models) {
      const value = item.id || item.instanceId || "";
      if (!value) continue;
      const name = item.name || value;
      rows.set(item.modelRef ? encodeModelRef(item.modelRef) : value, name);
    }
    const current = selectedNode.value?.model?.trim();
    const currentValue = selectedNode.value?.modelRef
      ? encodeModelRef(selectedNode.value.modelRef)
      : current;
    if (currentValue && !rows.has(currentValue))
      rows.set(currentValue, `当前配置：${current}`);
    return [...rows].map(([value, label]) => ({ value, label }));
  }),
  selectedModelValue = computed({
    get: () =>
      selectedNode.value?.modelRef
        ? encodeModelRef(selectedNode.value.modelRef)
        : selectedNode.value?.model || "",
    set: (value: string) => {
      if (!selectedNode.value) return;
      const ref = decodeModelRef(value);
      selectedNode.value.modelRef = ref;
      selectedNode.value.model =
        ref?.source === "local" || ref?.source === "remote" ? ref.id : value;
    },
  }),
  nodeCandidates = computed(() =>
    form.nodes.filter((node) => node.id !== selectedNode.value?.id),
  ),
  nodeById = computed(() => new Map(form.nodes.map((node) => [node.id, node])));
const viewportTransform = computed(() => ({
    transform: `translate3d(${viewport.x}px,${viewport.y}px,0) scale(${zoom.value})`,
  })),
  gridPosition = computed(() => ({
    backgroundPosition: `${viewport.x}px ${viewport.y}px,${viewport.x}px ${viewport.y}px,${viewport.x}px ${viewport.y}px`,
    backgroundSize: `${100 * zoom.value}px ${100 * zoom.value}px,${100 * zoom.value}px ${100 * zoom.value}px,${20 * zoom.value}px ${20 * zoom.value}px`,
  }));
const selectionStyle = computed(() =>
  selectionBox.value
    ? {
        left: selectionBox.value.x + "px",
        top: selectionBox.value.y + "px",
        width: selectionBox.value.width + "px",
        height: selectionBox.value.height + "px",
      }
    : {},
);
const formSnapshot = () => JSON.stringify(form);
const hasUnsavedChanges = computed(
  () => !!lastSavedSnapshot.value && formSnapshot() !== lastSavedSnapshot.value,
);
const saveStateText = computed(() => {
  if (busy.value === "save") return "正在保存";
  if (!form.id) return "首次保存后启用自动保存";
  if (hasUnsavedChanges.value) return "有未保存更改";
  if (lastSavedAt.value)
    return `已保存 ${lastSavedAt.value.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  return "已保存";
});
function markSaved() {
  lastSavedSnapshot.value = formSnapshot();
  lastAutoSaveAttempt.value = lastSavedSnapshot.value;
  lastSavedAt.value = new Date();
}
function resetHistory() {
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = undefined;
  history.value = [formSnapshot()];
  historyIndex.value = 0;
}
function commitHistory() {
  historyTimer = undefined;
  if (applyingHistory) return;
  const snapshot = formSnapshot();
  if (history.value[historyIndex.value] === snapshot) return;
  history.value = history.value.slice(0, historyIndex.value + 1);
  history.value.push(snapshot);
  if (history.value.length > 100) history.value.shift();
  historyIndex.value = history.value.length - 1;
}
function scheduleHistory() {
  if (applyingHistory || historyIndex.value < 0) return;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, 220);
}
function flushHistory() {
  if (historyTimer) {
    clearTimeout(historyTimer);
    commitHistory();
  }
}
function restoreHistory(index: number) {
  const snapshot = history.value[index];
  if (!snapshot) return;
  applyingHistory = true;
  Object.assign(form, JSON.parse(snapshot));
  applyingHistory = false;
  historyIndex.value = index;
  selectedEdgeKey.value = undefined;
  setSelection(["__start__"], "__start__");
}
function undo() {
  flushHistory();
  if (canUndo.value) restoreHistory(historyIndex.value - 1);
}
function redo() {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = undefined;
  }
  if (canRedo.value) restoreHistory(historyIndex.value + 1);
}
const date = (value?: string) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const status = (value: string) =>
  (
    ({
      running: "执行中",
      waiting: "等待中",
      succeeded: "成功",
      failed: "失败",
      cancelled: "已取消",
      skipped: "已跳过",
    }) as Record<string, string>
  )[value] || value;
const nodeType = (type: FormNode["type"]) =>
  (
    ({
      agent: "Agent",
      "ai-judge": "AI 判断",
      condition: "旧版判断",
      route: "旧版路由",
      judge: "数据判断", predicate: "条件判断", switch: "Switch",
      data: "数据变量",
      join: "汇合",
      approval: "人工确认",
      notify: "系统通知",
      end: "结束",
    }) as Record<FormNode["type"], string>
  )[type];
const isJudgement = (type: FormNode["type"]) =>
  isDecision(type) || ["ai-judge", "condition", "route"].includes(type);
const nodeHeight = (node: FormNode) =>
  Math.max(isJudgement(node.type) ? 220 : 140, 92 + node.branches.length * 28);
function outputPortPosition(node: FormNode, index: number) {
  if (!isJudgement(node.type)) return { x: 230, y: 68 + index * 28 };
  const height = nodeHeight(node);
  const y = node.branches.length === 1 ? height / 2
    : height * (0.25 + 0.5 * index / Math.max(1, node.branches.length - 1));
  return { x: 230 * (1 - Math.abs(2 * y / height - 1) / 2), y };
}
const nodeSummary = (node: FormNode) =>
  isDecision(node.type) ? (node.type === 'switch' ? `${node.switchCases.length} 个匹配值 · 默认分支` : `${node.ruleMode === 'all' ? '全部' : '任一'}满足 · ${node.rules.length} 条规则`)
    : node.type === "ai-judge"
    ? node.instruction.trim().split("\n")[0] || "点击设置 AI 判断标准"
    : node.type === "agent"
    ? node.instruction.trim().split("\n")[0] || "点击设置 Agent 执行内容"
    : node.type === "condition"
      ? `${nodeById.value.get(node.sourceNodeId)?.name || "未选择来源"} · ${node.operator === "succeeded" ? "执行成功" : "执行失败"}`
      : node.type === "route"
        ? `根据 ${nodeById.value.get(node.sourceNodeId)?.name || "上游结果"} 路由`
        : node.type === "data"
          ? `设置 ${node.assignments.length} 个变量`
          : node.type === "join"
            ? `${node.joinMode === "all" ? "等待全部" : "任一到达"} · ${incomingSourceCount(node.id)} 个上游`
            : node.type === "approval"
              ? node.approvalPrompt
              : node.type === "notify"
                ? node.title || "点击设置通知内容"
                : `${node.endStatus === "succeeded" ? "成功" : "失败"}结束`;
const incomingSourceCount = (nodeId: string) =>
  new Set(
    form.nodes
      .filter((source) =>
        source.branches.some((branch) =>
          branch.targetNodeIds?.includes(nodeId),
        ),
      )
      .map((source) => source.id),
  ).size;
type UpstreamReference = {
  sourceId: string;
  sourceName: string;
  label: string;
  expression: string;
  detail: string;
};
function jsonLeaves(value: string | undefined) {
  if (!value?.trim()) return [] as string[];
  try {
    const parsed = JSON.parse(value),
      rows: string[] = [],
      walk = (item: unknown, path: string) => {
        if (path) rows.push(path);
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return;
        }
        for (const [key, child] of Object.entries(item as Record<string, unknown>))
          walk(child, path ? `${path}.${key}` : key);
      };
    walk(parsed, "");
    return rows;
  } catch {
    return [];
  }
}
function upstreamOutputReferences(nodeId: string) {
  const rows = new Map<string, UpstreamReference>();
  for (const input of workflowInputPreview(form.nodes, nodeId)) {
    for (const path of jsonLeaves(JSON.stringify(input.value))) {
      const expression = `{{input.${input.sourceId}.${path}}}`;
      const existing = rows.get(expression);
      rows.set(expression, {
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        label: path,
        expression,
        detail: existing ? `${existing.detail}、${input.branchName}` : `分支：${input.branchName}`,
      });
    }
  }
  return [...rows.values()];
}
function dataVariableReferences(): UpstreamReference[] {
  return form.nodes.filter(node=>node.type === 'data').flatMap(node=>node.assignments.filter(item=>item.name.trim()).map(item=>({sourceId:node.id,sourceName:node.name,label:item.name,expression:`{{${node.name.trim()}.${item.name.trim()}}}`,detail:'组件变量（该组件执行后可用）'})));
}
let variableNameBeforeEdit = '';
function renameVariableReferences(node: FormNode) {
  if (node.type !== 'data' || !variableNameBeforeEdit || workflowNodeNameError(node,form.nodes)) return;
  const before = form.nodes.map(item=>({...item,name:item.id === node.id ? variableNameBeforeEdit : item.name}));
  const updated = mapVariableReferences(mapVariableReferences(form.nodes,before,'store'),form.nodes,'display');
  form.nodes.forEach((item,index)=>Object.assign(item,updated[index]));
  variableNameBeforeEdit = node.name;
}
const upstreamReferences = computed<UpstreamReference[]>(() => {
  const node = selectedNode.value;
  return node ? [...upstreamOutputReferences(node.id),...dataVariableReferences()] : [];
});
const upstreamJsonPreviews = computed(() => {
  const node = selectedNode.value;
  return node ? workflowInputPreview(form.nodes, node.id) : [];
});
function bindReference(target: { value?: string }, expression: string) {
  target.value = expression;
}
function appendReference(target: { value?: string }, expression: string) {
  target.value = `${target.value || ""}${target.value ? " " : ""}${expression}`;
}
function portPoint(sourceId: string, branch: Branch) {
  if (sourceId === "__start__")
    return { x: form.startX + 150, y: form.startY + 38 };
  const node = nodeById.value.get(sourceId);
  if (!node) return { x: 0, y: 0 };
  const index = Math.max(
    0,
    node.branches.findIndex((item) => item.id === branch),
  );
  const port = outputPortPosition(node, index);
  return { x: node.x + port.x, y: node.y + port.y };
}
function inputPoint(id: string) {
  const node = nodeById.value.get(id);
  return node ? { x: node.x, y: node.y + (isJudgement(node.type) ? nodeHeight(node) / 2 : 70) } : { x: 0, y: 0 };
}
const edges = computed(() => {
  const rows: CanvasEdge[] = [];
  for (const target of form.entryNodeIds)
    if (nodeById.value.has(target))
      rows.push({
        id: "start-" + target,
        sourceId: "__start__",
        targetId: target,
        branch: "start",
        from: portPoint("__start__", "start"),
        to: inputPoint(target),
        label: "开始",
        color: "#2f8a59",
      });
  for (const node of form.nodes)
    for (const branch of node.branches)
      for (const target of branch.targetNodeIds || []) {
        if (nodeById.value.has(target))
          rows.push({
            id: `${node.id}-${branch.id}-${target}`,
            sourceId: node.id,
            targetId: target,
            branch: branch.id,
            from: portPoint(node.id, branch.id),
            to: inputPoint(target),
            label: branch.name,
            color: branch.color,
          });
      }
  return rows;
});
const selectedEdge = computed(() =>
  selectedEdgeKey.value
    ? edges.value.find(
        (edge) =>
          edge.sourceId === selectedEdgeKey.value!.sourceId &&
          edge.branch === selectedEdgeKey.value!.branch &&
          edge.targetId === selectedEdgeKey.value!.targetId,
      )
    : undefined,
);
function outputJsonError(value?: string) {
  try {
    parseWorkflowAiOutput(value);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function branchOutputError(node: FormNode, branch: FormBranch) {
  if (node.type === "agent" || (node.type === "ai-judge" && node.judgeMode === "classify")) return "";
  if ((branch.outputValue?.length || 0) > 4000) return "输出内容不能超过 4000 个字符";
  const syntaxError = workflowJsonError(branch.outputValue);
  if (syntaxError) return syntaxError;
  if (node.type === "ai-judge" && node.branchMode === "ai") return outputJsonError(branch.outputValue);

  return "";
}
function formatBranchOutput(branch: FormBranch) {
  if (!branch.outputValue?.trim()) return;
  try {
    const formatted = formatWorkflowJson(branch.outputValue);
    if (formatted.length > 4000) {
      ElMessage.error("格式化后超过 4000 个字符，请减少输出字段或内容");
      return;
    }
    branch.outputValue = formatted;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}
function endResultBranch(node: FormNode): FormBranch {
  return {id:`end_${node.id}`,name:'最终结果',condition:'',color:'#347fc5',get outputValue(){return node.endResult;},set outputValue(value){node.endResult = value || '';}};
}
const endResultErrors = computed(()=>form.nodes.filter(node=>node.type === 'end' && workflowJsonError(node.endResult)).map(node=>({node,message:workflowJsonError(node.endResult)})));
const branchOutputErrors = computed(() =>
  form.nodes.flatMap((node) =>
    node.branches
      .map((branch) => ({
        node,
        branch,
        message: branchOutputError(node, branch),
      }))
      .filter((item) => item.message),
  ),
);
const invalidInputEdges = computed(
  () =>
    new Set(
      edges.value
        .filter((edge) => {
          const source = nodeById.value.get(edge.sourceId),
            branch = source?.branches.find((item) => item.id === edge.branch);
          return !!source && !!branch && !!branchOutputError(source, branch);
        })
        .map((edge) => edge.id),
    ),
);
const inputConnectionErrors = computed(() =>
  branchOutputErrors.value.map(
    (item) => `${item.node.name} / ${item.branch.name}：${item.message}`,
  ),
);
const curve = (
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  const bend = Math.max(70, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};
const isSelected = (id: string) => selectedNodeIds.value.has(id);
function setSelection(ids: Iterable<string>, primary?: string) {
  selectedEdgeKey.value = undefined;
  selectedNodeIds.value = new Set(ids);
  selectedNodeId.value =
    primary && selectedNodeIds.value.has(primary)
      ? primary
      : [...selectedNodeIds.value].at(-1) || "";
}
function selectionMode(event: MouseEvent | PointerEvent): SelectionMode {
  return event.altKey
    ? "subtract"
    : event.metaKey || event.ctrlKey
      ? "toggle"
      : event.shiftKey
        ? "add"
        : "replace";
}
function selectNode(id: string, event: PointerEvent) {
  const mode = selectionMode(event),
    next = new Set(selectedNodeIds.value);
  if (mode === "replace") {
    if (!next.has(id) || next.size === 1) setSelection([id], id);
    else selectedNodeId.value = id;
    return;
  }
  if (mode === "add") next.add(id);
  else if (mode === "subtract") next.delete(id);
  else if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelection(next, next.has(id) ? id : undefined);
}
async function load() {
  try {
    const [nextDefinitions, nextRuns] = await Promise.all([
      api("workflowDefinitions"),
      api("workflowRuns", { limit: 200 }),
    ]);
    definitions.value = nextDefinitions;
    runs.value = nextRuns;
  } catch (cause) {
    error.value = String(cause).replace(/^Error: /, "");
  }
}
function addNode(type: FormNode["type"] = "agent") {
  const node = newNode(type, form.nodes.length);
  node.x = (node.x - viewport.x) / zoom.value;
  node.y = (node.y - viewport.y) / zoom.value;
  form.nodes.push(node);
  setSelection([node.id], node.id);
}
function initializeNew() {
  saveErrorNodeIds.value = new Set();
  centerCanvas();
  Object.assign(form, fresh());
  addNode();
  form.entryNodeIds = form.nodes[0]?.id ? [form.nodes[0].id] : [];
  editing.value = true;
  selectedId.value = "";
  setSelection(["__start__"], "__start__");
  resetHistory();
  lastSavedSnapshot.value = formSnapshot();
  lastAutoSaveAttempt.value = lastSavedSnapshot.value;
  lastSavedAt.value = undefined;
}
async function create() {
  if (!props.windowMode) {
    void window.myplane.openWorkflowEditor();
    return;
  }
  initializeNew();
}
const canCreate = computed(() => true);
defineExpose({ create, canCreate });
function fromNode(
  node: WorkflowNode,
  index: number,
  definition: WorkflowDefinition,
): FormNode {
  node = mapVariableReferences(node, definition.nodes, "display");
  const position = definition.layout?.nodes[node.id] || {
      x: 320 + (index % 3) * 290,
      y: 110 + Math.floor(index / 3) * 260,
    },
    branches = node.branches?.map((branch) => {
      const targetNodeIds = [
        ...(branch.targetNodeIds ||
          (branch.targetNodeId ? [branch.targetNodeId] : [])),
      ];
      return {
        ...branch,
        targetNodeIds,
        ...(targetNodeIds.length
          ? { targetNodeId: targetNodeIds.join("\u001f") }
          : {}),
      };
    }) || [
      ...(node.onSuccess
        ? [
            {
              id: "success",
              name: "成功",
              condition: "执行成功",
              color: "#4a9a6e",
              targetNodeIds: [node.onSuccess],
              targetNodeId: node.onSuccess,
            },
          ]
        : []),
      ...(node.onFailure
        ? [
            {
              id: "failure",
              name: "失败",
              condition: "执行失败",
              color: "#c65a52",
              targetNodeIds: [node.onFailure],
              targetNodeId: node.onFailure,
            },
          ]
        : []),
    ];
  if (node.type === 'notify') {
    if (branches.length === 2 && ['执行失败','失败','failed','failure'].includes(branches[0].condition)) branches.reverse();
    if (branches.length === 1 && ['执行失败','失败','failed','failure'].includes(branches[0].condition)) branches.unshift({id:`notify_success_${node.id}`,name:'发送成功',condition:'',color:'#2f9b74',targetNodeIds:[],outputValue:'{"result":""}'});
    while (branches.length < 2) branches.push({id:`notify_${node.id}_${branches.length}`,name:branches.length ? '发送失败' : '发送成功',condition:'',color:branches.length?'#d45b68':'#2f9b74',targetNodeIds:[],outputValue:'{"result":""}'});
  }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    branches: node.type === "agent"
      ? branches.map(branch => ({ ...branch, condition: "", outputValue: '{"result":""}' }))
      : node.type === "ai-judge" && node.config.judgeMode === "classify"
        ? branches.map(branch => ({ ...branch, outputValue: '{"result":"","reason":""}' }))
        : branches,
    instruction: (node.type === "agent" || node.type === "ai-judge") ? node.config.instruction : "",
    executionJson: (node.type === 'agent'||node.type === 'ai-judge')&&node.config.execution ? JSON.stringify(node.config.execution,null,2) : '',
    model: (node.type === "agent" || node.type === "ai-judge") ? node.config.model || "" : props.model || "",
    modelRef: (node.type === "agent" || node.type === "ai-judge") ? node.config.modelRef : undefined,
    modelSource:
      (node.type === "agent" || node.type === "ai-judge") ? node.config.modelSource || "current" : "current",
    mode: (node.type === "agent" || node.type === "ai-judge") ? node.config.mode : "coding",
    maxSteps: (node.type === "agent" || node.type === "ai-judge") ? node.config.maxSteps : 30,
    fastMode: (node.type === "agent" || node.type === "ai-judge") ? node.config.fastMode : true,
    approvalMode: (node.type === "agent" || node.type === "ai-judge") ? node.config.approvalMode : "ask",
    inputSignalMode:
      (node.type === "agent" || node.type === "ai-judge") ? node.config.inputSignalMode || "all" : "all",
    branchMode: node.type === "agent" ? "direct" : "ai",
    judgeMode: node.type === "ai-judge" ? node.config.judgeMode || "legacy" : "legacy",
    judgeInput: node.type === "ai-judge" ? node.config.judgeInput || "" : "",
    unknownBranchId: node.type === "ai-judge" ? node.config.unknownBranchId || "" : "",
    sourceNodeId:
      node.type === "condition" || node.type === "route"
        ? node.config.sourceNodeId
        : "",
    operator: node.type === "condition" ? node.config.operator : "succeeded",
    rules: node.type === 'judge' || node.type === 'predicate' ? node.config.rules.map(item=>({...item})) : [{kind:'text',left:'',operator:'eq',right:''}],
    ruleMode: node.type === 'judge' || node.type === 'predicate' ? node.config.mode : 'all',
    switchValue: node.type === 'switch' ? node.config.value : '',
    switchKind: node.type === 'switch' ? node.config.kind : 'text',
    switchCases: node.type === 'switch' ? node.config.cases.map(item=>({...item})) : [],
    defaultBranchId: node.type === 'switch' ? node.config.defaultBranchId : '',
    assignments:
      node.type === "data"
        ? node.config.assignments.map((item) => ({ ...item }))
        : [],
    joinMode: node.type === "join" ? node.config.mode : "all",
    approvalTitle:node.type === 'approval' ? node.config.title || node.name : '人工确认',
    approvalWaitMode:node.type === 'approval' ? node.config.wait?.mode || 'forever' : 'forever',
    approvalDuration:node.type === 'approval' ? node.config.wait?.durationMinutes || 60 : 60,
    approvalDeadline:node.type === 'approval' && node.config.wait?.deadline ? localDateTime(node.config.wait.deadline) : '',
    approvalTimeoutAction:node.type === 'approval' ? node.config.wait?.onTimeout || 'reject' : 'reject',
    approvalPrompt:
      node.type === "approval"
        ? node.config.prompt
        : "请确认是否继续执行工作流",
    approveLabel: node.type === "approval" ? node.config.approveLabel : "批准",
    rejectLabel: node.type === "approval" ? node.config.rejectLabel : "拒绝",
    title: node.type === "notify" ? node.config.title : "工作流通知",
    body: node.type === "notify" ? node.config.body : "",
    endStatus: node.type === "end" ? node.config.status : "succeeded",
    endSummary: node.type === "end" ? node.config.summary : "工作流执行完成",
    endScope:node.type === "end" ? node.config.scope || (node.config.status === "failed" ? "workflow" : "path") : "path",
    endResult:node.type === "end" ? node.config.resultJson || "" : "",
    x: position.x,
    y: position.y,
  };
}
function initializeEdit(item: WorkflowDefinition) {
  centerCanvas();
  Object.assign(form, {
    id: item.id,
    name: item.name,
    description: item.description,
    enabled: item.enabled,
    timeoutMinutes: item.timeoutMinutes,
    entryNodeIds: [
      ...(item.entryNodeIds?.length ? item.entryNodeIds : [item.entryNodeId]),
    ],
    startX: item.layout?.start?.x ?? 60,
    startY: item.layout?.start?.y ?? 180,
    nodes: item.nodes.map((node, index) => fromNode(node, index, item)),
  });
  selectedId.value = item.id;
  setSelection(["__start__"], "__start__");
  editing.value = true;
  resetHistory();
  markSaved();
}
function edit(item: WorkflowDefinition) {
  saveErrorNodeIds.value = new Set();
  if (!props.windowMode) {
    void window.myplane.openWorkflowEditor(item.id);
    return;
  }
  initializeEdit(item);
}
const confirmingNodeDeletion = ref(false);
function removeNodeFromForm(node: FormNode) {
  const index = form.nodes.indexOf(node);
  if (index < 0) return;
  form.nodes.splice(index, 1);
  for (const item of form.nodes) {
    for (const branch of item.branches) {
      branch.targetNodeIds = (branch.targetNodeIds || []).filter(
        (id) => id !== node.id,
      );
      branch.targetNodeId = branch.targetNodeIds.join("\u001f") || undefined;
    }
    if (item.sourceNodeId === node.id) item.sourceNodeId = "";
  }
  form.entryNodeIds = form.entryNodeIds.filter((id) => id !== node.id);
  if (!form.entryNodeIds.length && form.nodes[0])
    form.entryNodeIds = [form.nodes[0].id];
  setSelection(["__start__"], "__start__");
}
async function confirmDeleteNodes(nodes: FormNode[]) {
  if (!nodes.length || confirmingNodeDeletion.value) return;
  confirmingNodeDeletion.value = true;
  try {
    await ElMessageBox.confirm(
      nodes.length === 1
        ? `确定删除组件“${nodes[0].name}”？相关连线也会一并移除。`
        : `确定删除选中的 ${nodes.length} 个组件？相关连线也会一并移除。`,
      "删除组件",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        closeOnClickModal: false,
        modalClass: "workflow-node-delete-modal",
      },
    );
    for (const node of nodes) removeNodeFromForm(node);
  } catch (cause) {
    if (cause !== "cancel" && cause !== "close") ElMessage.error(String(cause));
  } finally {
    confirmingNodeDeletion.value = false;
  }
}
function deleteSelected() {
  const ids = new Set(
    [...selectedNodeIds.value].filter((id) => id !== "__start__"),
  );
  if (!ids.size) return;
  void confirmDeleteNodes(form.nodes.filter((node) => ids.has(node.id)));
}
function payload(): WorkflowDefinitionInput {
  const nodes = form.nodes.map((node) => {
    const base = {
      id: node.id,
      name: node.name,
      branches: node.branches.map(({ targetNodeId: _legacy, ...branch }) => ({
        ...branch,
        targetNodeIds: [...(branch.targetNodeIds || [])],
      })),
    };
    if (node.type === "agent" || node.type === "ai-judge")
      return {
        ...base,
        type: node.type,
        config: {
          instruction: node.instruction,
          ...(node.executionJson.trim()?{execution:JSON.parse(node.executionJson)}:{}),
          modelSource: node.modelSource,
          ...(node.modelSource === "specified" && node.model.trim()
            ? { model: node.model.trim() }
            : {}),
          ...(node.modelSource === "specified" && node.modelRef
            ? { modelRef: node.modelRef }
            : {}),
          mode: node.mode,
          maxSteps: Number(node.maxSteps),
          fastMode: node.fastMode,
          approvalMode: node.approvalMode,
          inputSignalMode: node.inputSignalMode,
          branchMode: node.branchMode,
          ...(node.type === "ai-judge" ? {
            judgeMode: node.judgeMode,
            ...(node.judgeMode === "classify" ? { judgeInput: node.judgeInput, unknownBranchId: node.unknownBranchId } : {}),
          } : {}),
        },
      };
    if (node.type === 'judge' || node.type === 'predicate') return {...base,type:node.type,config:{rules:node.rules.map(rule=>({...rule})),mode:node.ruleMode}};
    if (node.type === 'switch') return {...base,type:'switch' as const,config:{value:node.switchValue,kind:node.switchKind,cases:node.switchCases.map(item=>({...item})),defaultBranchId:node.defaultBranchId}};
    if (node.type === "condition")
      return {
        ...base,
        type: "condition" as const,
        config: { sourceNodeId: node.sourceNodeId, operator: node.operator },
      };
    if (node.type === "route")
      return {
        ...base,
        type: "route" as const,
        config: { sourceNodeId: node.sourceNodeId },
      };
    if (node.type === "data")
      return {
        ...base,
        type: "data" as const,
        config: { assignments: node.assignments.map((item) => ({ ...item })) },
      };
    if (node.type === "join")
      return {
        ...base,
        type: "join" as const,
        config: { mode: node.joinMode },
      };
    if (node.type === "approval")
      return {
        ...base,
        type: "approval" as const,
        config: {
          title:node.approvalTitle,
          wait:{mode:node.approvalWaitMode,onTimeout:node.approvalTimeoutAction,...(node.approvalWaitMode === 'duration' ? {durationMinutes:Number(node.approvalDuration)} : {}),...(node.approvalWaitMode === 'until' ? {deadline:node.approvalDeadline && Number.isFinite(Date.parse(node.approvalDeadline)) ? new Date(node.approvalDeadline).toISOString() : ''} : {})},
          prompt: node.approvalPrompt,
          approveLabel: node.approveLabel,
          rejectLabel: node.rejectLabel,
        },
      };
    if (node.type === "end")
      return {
        ...base,
        type: "end" as const,
        branches: [],
        config: { status: node.endStatus, summary: node.endSummary, scope:node.endScope, resultJson:node.endResult },
      };
    return {
      ...base,
      type: "notify" as const,
      config: { title: node.title, body: node.body, fixedBranches:true },
    };
  });
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    timeoutMinutes: Number(form.timeoutMinutes),
    entryNodeId: form.entryNodeIds[0] || "",
    entryNodeIds: [...form.entryNodeIds],
    nodes,
    layout: {
      nodes: Object.fromEntries(
        form.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
      ),
      start: { x: form.startX, y: form.startY },
    },
  };
}
async function save(manual = true) {
  const snapshot = formSnapshot();
  if (!manual && (!form.id || snapshot === lastSavedSnapshot.value || snapshot === lastAutoSaveAttempt.value))
    return;
  if (!manual) lastAutoSaveAttempt.value = snapshot;
  error.value = "";
  if (!form.name.trim()) {
    saveErrorNodeIds.value = new Set(["__start__"]);
    error.value = "请先填写工作流名称";
    setSelection(["__start__"], "__start__");
    return;
  }
  if (!form.entryNodeIds.length) {
    error.value = "请连接开始节点，设置工作流入口";
    saveErrorNodeIds.value = new Set(["__start__"]);
    if (manual) setSelection(["__start__"]);
    return;
  }
  saveErrorNodeIds.value = new Set([
    ...form.nodes.filter(node => workflowNodeNameError(node, form.nodes)).map(node => node.id),
    ...form.nodes.filter(node => node.type === "agent" && node.branches.length !== 1).map(node => node.id),
    ...branchOutputErrors.value.map(item => item.node.id),
    ...endResultErrors.value.map(item=>item.node.id),
  ]);
  const invalidNameNode = form.nodes.find(node => workflowNodeNameError(node, form.nodes));
  if (invalidNameNode) {
    error.value = workflowNodeNameError(invalidNameNode, form.nodes);
    if (manual) setSelection([invalidNameNode.id], invalidNameNode.id);
    return;
  }
  const invalidAgentNode = form.nodes.find(node => node.type === "agent" && node.branches.length !== 1);
  if (invalidAgentNode) {
    error.value = `${invalidAgentNode.name} 必须有且只有一个输出分支`;
    if (manual) setSelection([invalidAgentNode.id], invalidAgentNode.id);
    return;
  }
  if (inputConnectionErrors.value.length || endResultErrors.value.length) {
    error.value = "请先修复输出或最终结果的 JSON 格式";
    if (manual) setSelection([(branchOutputErrors.value[0]?.node || endResultErrors.value[0].node).id]);
    return;
  }
  busy.value = "save";
  try {
    const item = await api("workflowSave", payload());
    saveErrorNodeIds.value = new Set();
    form.id = item.id;
    selectedId.value = item.id;
    markSaved();
    if (props.windowMode) {
      await window.myplane.workflowEditorSaved(item.id);
      if (manual) ElMessage.success(`工作流 v${item.version} 已保存`);
    } else {
      await load();
      editing.value = false;
      ElMessage.success(`工作流 v${item.version} 已保存`);
    }
  } catch (cause) {
    const failure = readWorkflowValidationError(cause);
    error.value = failure.message;
    saveErrorNodeIds.value = new Set(failure.nodeIds);
    if (manual && failure.nodeIds.length) setSelection([failure.nodeIds[0]]);
  } finally {
    busy.value = "";
  }
}
async function action(
  item: WorkflowDefinition,
  action: "run" | "enable" | "pause",
) {
  busy.value = item.id + action;
  try {
    await api("workflowAction", { id: item.id, action });
    await load();
    if (action === "run") ElMessage.success("已创建工作流运行");
  } catch (cause) {
    ElMessage.error(String(cause));
  } finally {
    busy.value = "";
  }
}
async function remove(item: WorkflowDefinition) {
  try {
    await ElMessageBox.confirm(
      `删除“${item.name}”及其运行历史？`,
      "删除工作流",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await api("workflowDelete", { id: item.id });
    await load();
  } catch (cause) {
    if (cause !== "cancel" && cause !== "close") ElMessage.error(String(cause));
  }
}
async function cancel(run: WorkflowRun) {
  await api("workflowCancel", { runId: run.id });
  await load();
}
async function retry(run: WorkflowRun, nodeId: string) {
  await api("workflowRetry", { runId: run.id, nodeId });
  await load();
  ElMessage.success("已从失败节点创建新的运行");
}
const approvalNotes = reactive<Record<string,string>>({});
const approvalSubmitting = reactive(new Set<string>());
function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
}
async function resolveApproval(run: WorkflowRun, nodeId: string, decision: 'approved'|'rejected') {
  const key = `${run.id}:${nodeId}`;
  if (approvalSubmitting.has(key)) return;
  approvalSubmitting.add(key);
  try {
    await api('workflowResolveApproval',{runId:run.id,nodeId,decision,note:approvalNotes[key] || ''});
    delete approvalNotes[key];await load();
    ElMessage.success(decision === 'approved' ? '已批准继续执行' : '已进入拒绝分支');
  } catch (cause) { ElMessage.error(String(cause));await load(); }
  finally {approvalSubmitting.delete(key);}
}
function canvasPoint(event: PointerEvent) {
  const box = canvas.value?.getBoundingClientRect();
  return {
    x: (event.clientX - (box?.left || 0)) / zoom.value,
    y: (event.clientY - (box?.top || 0)) / zoom.value,
  };
}
function beginSelectionDrag(id: string, event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  selectNode(id, event);
  if (!selectedNodeIds.value.has(id)) return;
  const ids = selectedNodeIds.value,
    positions = new Map(
      form.nodes
        .filter((item) => ids.has(item.id))
        .map((item) => [item.id, { x: item.x, y: item.y }]),
    );
  if (ids.has("__start__"))
    positions.set("__start__", { x: form.startX, y: form.startY });
  drag.value = { clientX: event.clientX, clientY: event.clientY, positions };
}
function beginDrag(node: FormNode, event: PointerEvent) {
  beginSelectionDrag(node.id, event);
}
function beginStartDrag(event: PointerEvent) {
  beginSelectionDrag("__start__", event);
}
function beginCanvasAction(event: PointerEvent) {
  edgeMenu.value = undefined;
  if (
    event.button === 1 ||
    event.button === 2 ||
    (event.button === 0 && spacePressed)
  ) {
    event.preventDefault();
    pan.value = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: viewport.x,
      y: viewport.y,
    };
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect(),
    x = event.clientX - box.left,
    y = event.clientY - box.top,
    mode = selectionMode(event),
    initial = new Set(selectedNodeIds.value);
  selectionBox.value = {
    startX: x,
    startY: y,
    x,
    y,
    width: 0,
    height: 0,
    mode,
    initial,
  };
  if (mode === "replace") setSelection([]);
}
function beginConnection(
  sourceId: string,
  branch: Branch,
  event: PointerEvent,
  mode: "add" | "replace" = "add",
  originalTargetId?: string,
) {
  event.preventDefault();
  event.stopPropagation();
  edgeMenu.value = undefined;
  const from = portPoint(sourceId, branch);
  connection.value = {
    sourceId,
    branch,
    mode,
    originalTargetId,
    x1: from.x,
    y1: from.y,
    x2: from.x,
    y2: from.y,
  };
}
function selectEdge(edge: CanvasEdge) {
  selectedNodeIds.value = new Set();
  selectedNodeId.value = "";
  selectedEdgeKey.value = {
    sourceId: edge.sourceId,
    branch: edge.branch,
    targetId: edge.targetId,
  };
}
function isEdgeSelected(edge: CanvasEdge) {
  return (
    selectedEdgeKey.value?.sourceId === edge.sourceId &&
    selectedEdgeKey.value.branch === edge.branch &&
    selectedEdgeKey.value.targetId === edge.targetId
  );
}
function beginEdgeRewire(edge: CanvasEdge, event: PointerEvent) {
  if (event.button !== 0 && event.button !== 2) return;
  selectEdge(edge);
  edgeMenu.value = undefined;
  beginConnection(
    edge.sourceId,
    edge.branch,
    event,
    event.button === 2 ? "replace" : "add",
    edge.targetId,
  );
  const point = canvasPoint(event);
  if (connection.value) {
    connection.value.x2 = point.x;
    connection.value.y2 = point.y;
  }
}
function openEdgeMenu(edge: CanvasEdge, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (Date.now() < suppressEdgeMenuUntil) return;
  selectEdge(edge);
  edgeMenu.value = {
    edge,
    x: Math.min(event.clientX, window.innerWidth - 245),
    y: Math.min(event.clientY, window.innerHeight - 112),
  };
}
function deleteEdge(edge: CanvasEdge) {
  if (edge.sourceId === "__start__")
    form.entryNodeIds = form.entryNodeIds.filter((id) => id !== edge.targetId);
  else {
    const branch = nodeById.value
      .get(edge.sourceId)
      ?.branches.find((item) => item.id === edge.branch);
    if (branch) {
      branch.targetNodeIds = (branch.targetNodeIds || []).filter(
        (id) => id !== edge.targetId,
      );
      branch.targetNodeId = branch.targetNodeIds.join("\u001f") || undefined;
    }
  }
  edgeMenu.value = undefined;
  selectedEdgeKey.value = undefined;
}
function edgeNodeName(id: string): string {
  if (id.includes("\u001f"))
    return id.split("\u001f").map(edgeNodeName).join("、");
  return id === "__start__"
    ? "开始"
    : nodeById.value.get(id)?.name || "节点已移除";
}
function edgeBranchName(edge: CanvasEdge) {
  return edge.branch === "start"
    ? "开始入口"
    : nodeById.value
        .get(edge.sourceId)
        ?.branches.find((item) => item.id === edge.branch)?.name || edge.label;
}
function completeConnection(targetId: string, event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  const draft = connection.value;
  if (!draft || draft.sourceId === targetId) return;
  if (draft.sourceId === "__start__") {
    const targets = [...form.entryNodeIds];
    if (draft.mode === "replace" && draft.originalTargetId) {
      const index = targets.indexOf(draft.originalTargetId);
      if (index >= 0 && !targets.includes(targetId)) targets[index] = targetId;
      suppressEdgeMenuUntil = Date.now() + 350;
    } else if (!targets.includes(targetId)) targets.push(targetId);
    form.entryNodeIds = targets;
  } else {
    const branch = nodeById.value
      .get(draft.sourceId)
      ?.branches.find((item) => item.id === draft.branch);
    if (branch) {
      const targets = [...(branch.targetNodeIds || [])];
      if (draft.mode === "replace" && draft.originalTargetId) {
        const index = targets.indexOf(draft.originalTargetId);
        if (index >= 0 && !targets.includes(targetId))
          targets[index] = targetId;
        suppressEdgeMenuUntil = Date.now() + 350;
      } else if (!targets.includes(targetId)) targets.push(targetId);
      branch.targetNodeIds = targets;
      branch.targetNodeId = targets.join("\u001f") || undefined;
    }
  }
  connection.value = undefined;
}
const branchColors = [
  "#347fc5",
  "#c98a18",
  "#8058b4",
  "#2f9b74",
  "#d45b68",
  "#3a9da8",
  "#9b6b43",
  "#6677cc",
];
function addBranch(node: FormNode) {
  if (["agent", "join", "data"].includes(node.type) && node.branches.length) return;
  const index = node.branches.length,
    used = new Set(node.branches.map((branch) => branch.color.toLowerCase())),
    color =
      branchColors.find((value) => !used.has(value.toLowerCase())) ||
      branchColors[index % branchColors.length],
    output =
      node.type === "join" || node.type === "data" || ((node.type === "agent" || node.type === "ai-judge") && node.branchMode === "ai")
        ? node.type === "ai-judge" && node.judgeMode === "classify" ? '{"result":"","reason":""}' : '{"result":""}'
        : undefined;
  node.branches.splice(node.type === "ai-judge" ? Math.max(0, index - 1) : index, 0, {
    id: `branch_${Date.now().toString(36)}_${++nodeSequence}`,
    name: node.type === "join" ? "汇合完成" : node.type === "data" ? "设置完成" : `分支 ${index + 1}`,
    condition: "",
    color,
    targetNodeIds: [],
    ...(output ? { outputValue: output } : {}),
  });
}
async function openWorkflowHelp() {
  try {
    await window.myplane.openHelpDocument('workflow');
  } catch (cause) {
    ElMessage.error(`无法打开帮助文档：${String(cause)}`);
  }
}
function insertOutputReference(branch: FormBranch, item: UpstreamReference) {
  const editor = document.getElementById(`workflow-output-${branch.id}`) as HTMLTextAreaElement | null;
  const source = branch.outputValue || "{}";
  const start = editor?.selectionStart || 0, end = editor?.selectionEnd || start;
  for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
    const index = match.index!;
    if (start > index && end < index + match[0].length && !source.slice(index + match[0].length).trimStart().startsWith(":")) {
      branch.outputValue = source.slice(0, start) + item.expression + source.slice(end);
      return;
    }
  }
  try {
    const output = parseWorkflowJsonTemplate(source);
    const base = item.label.split(".").at(-1) || "value";
    let key = base, suffix = 2;
    while (Object.hasOwn(output, key)) key = `${base}_${suffix++}`;
    branch.outputValue = JSON.stringify({ ...output, [key]: item.expression }, null, 2);
  } catch (error) {
    ElMessage.error(String(error));
  }
}
function removeBranch(node: FormNode, branch: FormBranch) {
  if (node.type === "ai-judge" && (node.branches.length <= (node.judgeMode === "classify" ? 3 : 2) || branch.id === node.unknownBranchId)) return;
  if (["agent", "join", "data"].includes(node.type) && node.branches.length <= 1) return;
  node.branches.splice(node.branches.indexOf(branch), 1);
  if (
    selectedEdgeKey.value?.sourceId === node.id &&
    selectedEdgeKey.value.branch === branch.id
  )
    selectedEdgeKey.value = undefined;
}
function addAssignment(node: FormNode) {
  node.assignments.push({ name: "", value: "" });
}
function removeAssignment(node: FormNode, index: number) {
  node.assignments.splice(index, 1);
}
function pointerMove(event: PointerEvent) {
  if (inspectorDrag.value) {
    const body = editorBody.value?.getBoundingClientRect();
    if (body) {
      inspectorPosition.x = Math.max(
        10,
        Math.min(
          body.width - 390,
          inspectorDrag.value.x + event.clientX - inspectorDrag.value.clientX,
        ),
      );
      inspectorPosition.y = Math.max(
        10,
        Math.min(
          body.height - 120,
          inspectorDrag.value.y + event.clientY - inspectorDrag.value.clientY,
        ),
      );
    }
  }
  if (pan.value) {
    viewport.x = Math.round(pan.value.x + event.clientX - pan.value.clientX);
    viewport.y = Math.round(pan.value.y + event.clientY - pan.value.clientY);
  }
  if (drag.value) {
    for (const [id, position] of drag.value.positions) {
      const x = Math.round(
          position.x + (event.clientX - drag.value.clientX) / zoom.value,
        ),
        y = Math.round(
          position.y + (event.clientY - drag.value.clientY) / zoom.value,
        );
      if (id === "__start__") {
        form.startX = x;
        form.startY = y;
      } else {
        const node = nodeById.value.get(id);
        if (node) {
          node.x = x;
          node.y = y;
        }
      }
    }
  }
  if (selectionBox.value) {
    const host = canvasHost.value?.getBoundingClientRect();
    if (host) {
      const currentX = event.clientX - host.left,
        currentY = event.clientY - host.top,
        box = selectionBox.value;
      box.x = Math.min(box.startX, currentX);
      box.y = Math.min(box.startY, currentY);
      box.width = Math.abs(currentX - box.startX);
      box.height = Math.abs(currentY - box.startY);
      const hits = new Set<string>(),
        intersects = (x: number, y: number, width: number, height: number) =>
          x < box.x + box.width &&
          x + width > box.x &&
          y < box.y + box.height &&
          y + height > box.y;
      if (
        intersects(
          form.startX * zoom.value + viewport.x,
          form.startY * zoom.value + viewport.y,
          150 * zoom.value,
          78 * zoom.value,
        )
      )
        hits.add("__start__");
      for (const node of form.nodes)
        if (
          intersects(
            node.x * zoom.value + viewport.x,
            node.y * zoom.value + viewport.y,
            230 * zoom.value,
            nodeHeight(node) * zoom.value,
          )
        )
          hits.add(node.id);
      const next =
        box.mode === "replace" ? new Set<string>() : new Set(box.initial);
      if (box.mode === "replace" || box.mode === "add")
        for (const id of hits) next.add(id);
      else if (box.mode === "subtract") for (const id of hits) next.delete(id);
      else
        for (const id of hits)
          box.initial.has(id) ? next.delete(id) : next.add(id);
      setSelection(next);
    }
  }
  if (connection.value) {
    const point = canvasPoint(event);
    connection.value.x2 = point.x;
    connection.value.y2 = point.y;
  }
}
function pointerUp() {
  drag.value = undefined;
  pan.value = undefined;
  selectionBox.value = undefined;
  connection.value = undefined;
  inspectorDrag.value = undefined;
}
function toggleInspectorMode() {
  inspectorFloating.value = !inspectorFloating.value;
  if (inspectorFloating.value) {
    const body = editorBody.value?.getBoundingClientRect();
    inspectorPosition.x = Math.max(12, (body?.width || 900) - 430);
    inspectorPosition.y = 16;
  }
}
function beginInspectorDrag(event: PointerEvent) {
  if (!inspectorFloating.value || (event.target as HTMLElement).closest("button"))
    return;
  inspectorDrag.value = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: inspectorPosition.x,
    y: inspectorPosition.y,
  };
  event.preventDefault();
}
function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element?.closest('input,textarea,select,[contenteditable="true"]');
}
function keyDown(event: KeyboardEvent) {
  if (confirmingNodeDeletion.value) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (isEditableTarget(event.target)) return;
  if (event.code === "Space") {
    spacePressed = true;
    event.preventDefault();
  } else if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "a"
  ) {
    event.preventDefault();
    setSelection(
      ["__start__", ...form.nodes.map((node) => node.id)],
      selectedNodeId.value,
    );
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    if (selectedEdge.value) deleteEdge(selectedEdge.value);
    else deleteSelected();
  }
}
function keyUp(event: KeyboardEvent) {
  if (event.code === "Space") spacePressed = false;
}
function centerCanvas() {
  viewport.x = 0;
  viewport.y = 0;
}
function setZoom(value: number, anchor?: { x: number; y: number }) {
  const next = Math.max(0.25, Math.min(2, Math.round(value * 20) / 20));
  if (next === zoom.value) return;
  const host = canvasHost.value?.getBoundingClientRect(),
    point = anchor || {
      x: (host?.width || 800) / 2,
      y: (host?.height || 600) / 2,
    },
    contentX = (point.x - viewport.x) / zoom.value,
    contentY = (point.y - viewport.y) / zoom.value;
  viewport.x = Math.round(point.x - contentX * next);
  viewport.y = Math.round(point.y - contentY * next);
  zoom.value = next;
}
function zoomWheel(event: WheelEvent) {
  const host = canvasHost.value?.getBoundingClientRect();
  if (!host) return;
  setZoom(zoom.value * (event.deltaY < 0 ? 1.1 : 0.9), {
    x: event.clientX - host.left,
    y: event.clientY - host.top,
  });
}
function setZoomPercent(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  setZoom(Number(input.value) / 100);
  input.value = String(Math.round(zoom.value * 100));
}
function resetZoom() {
  setZoom(1);
}
function autoLayout() {
  form.startX = 60;
  form.startY = 180;
  let rowY = 100;
  form.nodes.forEach((node, index) => {
    if (index && index % 3 === 0)
      rowY += Math.max(...form.nodes.slice(index - 3, index).map(nodeHeight)) + 40;
    node.x = 330 + (index % 3) * 290;
    node.y = rowY;
  });
  centerCanvas();
}
function closeEditor() {
  if (props.windowMode) void window.myplane.closeWorkflowEditor();
  else editing.value = false;
}
watch(
  () => props.model,
  (value) => {
    for (const node of form.nodes) if (!node.model) node.model = value;
  },
);
watch(form, scheduleHistory, { deep: true, flush: "sync" });
onMounted(async () => {
  await load();
  if (props.windowMode) {
    const item = props.workflowId
      ? definitions.value.find((value) => value.id === props.workflowId)
      : undefined;
    if (props.workflowId && !item) error.value = "找不到要编辑的工作流";
    else if (item) initializeEdit(item);
    else initializeNew();
    autoSaveTimer = setInterval(() => void save(false), 30_000);
  } else {
    timer = setInterval(() => void load(), 4000);
    disposeSaved = window.myplane.onWorkflowSaved(() => void load());
  }
  window.addEventListener("pointermove", pointerMove);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  if (historyTimer) clearTimeout(historyTimer);
  disposeSaved?.();
  window.removeEventListener("pointermove", pointerMove);
  window.removeEventListener("pointerup", pointerUp);
  window.removeEventListener("keydown", keyDown);
  window.removeEventListener("keyup", keyUp);
});
</script>

<template>
  <main v-if="!windowMode" class="workflow-page scroll-page">
    <div v-if="error && !editing" class="workflow-error">
      {{ error }}<button @click="error = ''">关闭</button>
    </div>
    <section v-if="!definitions.length && !runs.length" class="workflow-onboarding">
      <div class="workflow-onboarding-hero">
        <div class="workflow-onboarding-copy">
          <span class="workflow-onboarding-kicker">从一个想法开始</span>
          <h2>把重复任务，<br />变成清晰的工作流。</h2>
          <p>连接 AI 任务、条件判断与人工确认，让每一步按预期执行，结果都有记录可查。</p>
          <small>点击顶部的「＋」按钮创建第一个工作流。</small>
        </div>
        <div class="workflow-onboarding-preview" aria-hidden="true">
          <div class="workflow-preview-caption"><span class="workflow-preview-dot"></span> 流程预览</div>
          <div class="workflow-preview-flow">
            <div class="workflow-preview-node start"><span><VideoPlay /></span><strong>开始</strong><small>设定目标</small></div>
            <i></i>
            <div class="workflow-preview-node agent"><span><ChatLineSquare /></span><strong>AI 任务</strong><small>分析与生成</small></div>
            <i></i>
            <div class="workflow-preview-node check"><span><DocumentChecked /></span><strong>人工确认</strong><small>把关关键步骤</small></div>
            <i></i>
            <div class="workflow-preview-node finish"><span><Flag /></span><strong>完成</strong><small>保存结果</small></div>
          </div>
          <p>拖放组件，连接步骤，保存后即可运行。</p>
        </div>
      </div>
      <div class="workflow-onboarding-steps">
        <article><span>01</span><strong>搭建流程</strong><p>用可视化画布编排任务与判断。</p></article>
        <article><span>02</span><strong>运行与确认</strong><p>需要人工决策时，流程会等待处理。</p></article>
        <article><span>03</span><strong>查看结果</strong><p>按节点回看执行记录与最终输出。</p></article>
      </div>
    </section>
    <div v-else class="workflow-grid">
      <section class="workflow-list">
        <header>
          <div><h2>我的流程</h2><span>{{ definitions.length }} 个流程</span></div>
          <button class="icon-btn" aria-label="刷新工作流" title="刷新工作流" @click="load"><RefreshRight /></button>
        </header>
        <label v-if="definitions.length > 3 || workflowSearch" class="workflow-list-search"><Search /><input v-model="workflowSearch" type="search" placeholder="搜索工作流名称" aria-label="搜索工作流名称" /></label>
        <div v-if="!definitions.length" class="workflow-empty workflow-empty-list"><Collection /><strong>从第一个工作流开始</strong><p>点击顶部的「＋」按钮，创建可重复运行的流程。</p></div>
        <p v-else-if="!filteredDefinitions.length" class="workflow-empty">没有匹配的工作流</p>
        <article
          v-for="item in filteredDefinitions"
          :key="item.id"
          :class="{ selected: selectedId === item.id }"
        >
          <button type="button" class="workflow-item-select" :aria-label="`查看 ${item.name} 的运行历史`" :aria-pressed="selectedId === item.id" @click="selectedId = item.id; historyId = item.id">
            <span class="workflow-item-top">
              <span class="workflow-state" :class="{ enabled: item.enabled }">{{ item.enabled ? "已启用" : "已暂停" }}</span>
              <small>v{{ item.version }}</small>
            </span>
            <strong class="workflow-item-name" :title="item.name">{{ item.name }}</strong>
            <span class="workflow-item-meta"><span>{{ item.nodes.length }} 个节点</span></span>
          </button>
          <div class="workflow-actions">
            <button class="workflow-run-action" @click.stop="action(item, 'run')"><VideoPlay />运行</button
            ><button
              @click.stop="action(item, item.enabled ? 'pause' : 'enable')"
            >
              <component :is="item.enabled ? VideoPause : VideoPlay" />{{
                item.enabled ? "暂停" : "启用"
              }}</button
            ><button @click.stop="edit(item)"><Edit />编辑</button
            ><button class="danger" :aria-label="`删除 ${item.name}`" :title="`删除 ${item.name}`" @click.stop="remove(item)">
              <Delete />
            </button>
          </div>
        </article>
      </section>
      <section class="workflow-detail">
        <div class="workflow-history">
          <header>
            <div>
              <span class="eyebrow">RUN HISTORY</span>
              <h2>
                {{ selected ? selected.name + " · 运行历史" : "全部运行历史" }}
              </h2>
              <p>{{ visibleRuns.length }} 条记录 · 查看节点执行过程和结果</p>
            </div>
            <button
              v-if="historyId"
              class="text-button"
              @click="
                historyId = '';
                selectedId = '';
              "
            >
              查看全部
            </button>
          </header>
          <div v-if="visibleRuns.length" class="workflow-history-filters" aria-label="筛选运行记录">
            <button :class="{ active: historyStatus === 'all' }" :aria-pressed="historyStatus === 'all'" @click="historyStatus = 'all'">全部</button>
            <button :class="{ active: historyStatus === 'active' }" :aria-pressed="historyStatus === 'active'" @click="historyStatus = 'active'">进行中</button>
            <button :class="{ active: historyStatus === 'failed' }" :aria-pressed="historyStatus === 'failed'" @click="historyStatus = 'failed'">失败或取消</button>
          </div>
          <div v-if="!visibleRuns.length" class="workflow-empty workflow-empty-history"><Guide /><strong>让流程跑起来</strong><p>运行后可在这里查看每个节点的状态、输出与错误。</p><button v-if="starterWorkflow" class="workflow-empty-run" @click="action(starterWorkflow, 'run')"><VideoPlay />运行{{ starterWorkflow.name }}</button></div>
          <div v-else-if="!filteredRuns.length" class="workflow-empty workflow-empty-history workflow-filter-empty"><Guide /><strong>此筛选下没有记录</strong><p>切换到全部，查看这 {{ visibleRuns.length }} 条运行记录。</p><button class="workflow-empty-run" @click="historyStatus = 'all'">查看全部记录</button></div>
          <article
            v-for="run in filteredRuns"
            :key="run.id"
            class="workflow-run"
          >
            <header>
              <div>
                <strong>{{ run.workflowName }}</strong
                ><small>v{{ run.workflowVersion }} · {{ date(run.startedAt) }} · {{ run.nodeRuns.length }} 个节点</small>
              </div>
              <span class="workflow-run-status" :class="run.status">{{
                status(run.status)
              }}</span>
            </header>
            <div class="node-timeline">
              <div
                v-for="node in run.nodeRuns"
                :key="node.nodeId + node.startedAt"
                :class="node.status"
              >
                <i></i>
                <div>
                  <strong>{{ node.nodeName }}</strong
                  ><small
                    >{{ status(node.status) }} · {{ node.type }} ·
                    {{ date(node.finishedAt || node.startedAt) }}</small
                  >
                  <h4 v-if="node.approval?.title">{{ node.approval.title }}</h4>
                  <small v-if="node.approval && node.status === 'waiting'">{{ node.approval.deadline ? '截止：' + date(node.approval.deadline) : '一直等待人工确认' }}</small>
                  <p v-if="node.approval?.decision">确认记录：{{ node.approval.decision === 'approved' ? '批准' : node.approval.decision === 'rejected' ? '拒绝' : '超时' }} · {{ date(node.approval.decidedAt) }}<span v-if="node.approval.note"> · 备注：{{ node.approval.note }}</span></p>
                  <label v-if="node.type === 'approval' && node.status === 'waiting' && ['running','waiting'].includes(run.status)" class="workflow-approval-note">备注（可选）<textarea v-model="approvalNotes[run.id+':'+node.nodeId]" maxlength="1000" rows="2" placeholder="填写确认原因或处理说明"></textarea></label>
                  <p v-if="node.summary">{{ node.summary }}</p>
                  <details v-if="node.type === 'end' && node.outputValue !== undefined" class="workflow-final-result"><summary>最终结果 JSON</summary><pre>{{ node.outputValue }}</pre></details>
                  <p v-if="node.error" class="danger">{{ node.error }}</p>
                  <div
                    v-if="
                      node.type === 'approval' &&
                      node.status === 'waiting' &&
                      ['running','waiting'].includes(run.status)
                    "
                    class="workflow-approval-actions"
                  >
                    <button :disabled="approvalSubmitting.has(run.id+':'+node.nodeId)" @click="resolveApproval(run, node.nodeId, 'approved')">
                      <Check />{{
                        node.approval?.approveLabel || "批准继续"
                      }}</button
                    ><button
                      class="danger"
                      :disabled="approvalSubmitting.has(run.id+':'+node.nodeId)" @click="resolveApproval(run, node.nodeId, 'rejected')"
                    >
                      <Close />{{ node.approval?.rejectLabel || "拒绝" }}
                    </button>
                  </div>
                  <button
                    v-if="
                      node.status === 'failed' &&
                      ['failed', 'cancelled'].includes(run.status)
                    "
                    @click="retry(run, node.nodeId)"
                  >
                    <RefreshRight />从此节点重试
                  </button>
                </div>
              </div>
            </div>
            <p v-if="run.error" class="danger">{{ run.error }}</p>
            <details v-if="run.logs?.length" class="workflow-run-logs">
              <summary>执行日志（{{ run.logs.length }}）</summary>
              <ol>
                <li v-for="entry in run.logs" :key="entry.at + entry.message" :class="entry.level">
                  <time>{{ date(entry.at) }}</time>
                  <span>{{ entry.message }}</span>
                </li>
              </ol>
            </details>
            <button
              v-if="['running', 'waiting'].includes(run.status)"
              class="secondary-button"
              @click="cancel(run)"
            >
              <VideoPause />取消运行
            </button>
          </article>
        </div>
      </section>
    </div>
  </main>

  <Teleport to="body" :disabled="windowMode"
    ><form
      v-if="editing"
      class="workflow-editor-window"
      :data-style="appearanceStyle"
      :data-theme="theme"
      :class="{
        'is-native-window': windowMode,
        'is-connecting': !!connection,
        'inspector-is-floating': inspectorFloating,
      }"
      role="dialog"
      aria-modal="true"
      aria-label="工作流画布编辑器"
      novalidate
      @submit.prevent="save()"
      @keydown.esc.prevent="closeEditor"
    >
      <header class="workflow-editor-header">
        <div>
          <span class="eyebrow">VISUAL WORKFLOW</span
          ><strong>{{ form.name || "未命名工作流" }}</strong
          ><small>端口拖动创建连线；已有连线左拖新增目标、右拖切换目标</small>
        </div>
        <div class="workflow-editor-actions">
          <button type="button" class="workflow-help-button" aria-label="工作流帮助" title="打开工作流使用指南" @click="openWorkflowHelp">
            <QuestionFilled />帮助
          </button>
          <span class="workflow-save-state" :class="{ dirty: hasUnsavedChanges }"
            >{{ saveStateText }} · {{ form.nodes.length }} 个节点</span
          ><div class="workflow-header-history">
            <button
              type="button"
              title="撤销 (Ctrl/Cmd+Z)"
              aria-label="撤销"
              :disabled="!canUndo"
              @click="undo"
            >
              <RefreshLeft /></button
            ><button
              type="button"
              title="重做 (Ctrl/Cmd+Shift+Z / Ctrl+Y)"
              aria-label="重做"
              :disabled="!canRedo"
              @click="redo"
            >
              <RefreshRight />
            </button>
          </div>
          <button
            class="workflow-save-button"
            :disabled="busy === 'save'"
            :title="busy === 'save' ? '正在保存工作流' : '保存工作流'"
            :aria-label="busy === 'save' ? '正在保存工作流' : '保存工作流'"
          >
            <DocumentChecked />
          </button>
        </div>
      </header>
      <div v-if="error" class="workflow-editor-error">
        {{ error }}<button type="button" @click="error = ''">关闭</button>
      </div>
      <div
        v-if="inputConnectionErrors.length"
        class="workflow-editor-error workflow-connection-errors"
      >
        <div>
          <strong>发现 {{ inputConnectionErrors.length }} 处输出内容 JSON 格式错误</strong
          ><span v-for="message in inputConnectionErrors" :key="message">{{
            message
          }}</span>
        </div>
      </div>
      <div ref="editorBody" class="workflow-editor-body">
        <section class="workflow-canvas-pane">
          <div class="workflow-canvas-toolbar">
            <span class="workflow-canvas-tip"
              >左拖框选 · Shift 追加 · Alt 减选 · 空格或右键拖动画布</span
            >
          </div>
          <aside class="workflow-component-panel" :class="{collapsed:componentPanelCollapsed}" aria-label="组件库" @pointerdown.stop>
            <header><strong>组件库 <button type="button" @click="componentPanelCollapsed = !componentPanelCollapsed" :aria-expanded="!componentPanelCollapsed">{{ componentPanelCollapsed ? '展开' : '收起' }}</button></strong><small v-if="!componentPanelCollapsed">点击添加到画布</small></header>
            <section v-for="group in componentGroups" v-show="!componentPanelCollapsed" :key="group.name">
              <h3>{{ group.name }}</h3>
              <div class="workflow-component-buttons">
                <button v-for="item in group.items" :key="item.label" type="button" :class="item.type" :title="item.label" :aria-label="item.label" @click="addComponent(item)"><component :is="item.icon" aria-hidden="true" /></button>
              </div>
            </section>
          </aside>
          <div class="workflow-canvas-float-controls" aria-label="画布视图控制">
              <div class="workflow-zoom-control">
                <button
                  type="button"
                  title="缩小画布"
                  aria-label="缩小画布"
                  :disabled="zoom <= 0.25"
                  @click="setZoom(zoom - 0.1)"
                >
                  <ZoomOut /></button
                ><label
                  ><input
                    type="number"
                    min="25"
                    max="200"
                    step="5"
                    :value="Math.round(zoom * 100)"
                    aria-label="画布缩放百分比"
                    @change="setZoomPercent"
                  /><span>%</span></label
                ><button
                  type="button"
                  title="放大画布"
                  aria-label="放大画布"
                  :disabled="zoom >= 2"
                  @click="setZoom(zoom + 0.1)"
                >
                  <ZoomIn /></button
                ><button
                  type="button"
                  title="恢复 100%"
                  aria-label="恢复百分百缩放"
                  @click="resetZoom"
                >
                  <ScaleToOriginal />
                </button>
              </div>
              <button
                type="button"
                title="将画布平移回初始位置"
                aria-label="回到原点"
                @click="centerCanvas"
              >
                <Aim /></button
              ><button
                type="button"
                title="自动整理节点位置"
                aria-label="自动排列"
                @click="autoLayout"
              >
                <MagicStick />
              </button>
          </div>
          <div
            ref="canvasHost"
            class="workflow-canvas-scroll"
            :class="{ 'is-selecting': !!selectionBox, 'is-panning': !!pan }"
            :style="gridPosition"
            @wheel.prevent="zoomWheel"
            @pointerdown.self="beginCanvasAction"
            @contextmenu.self.prevent
          >
            <div
              ref="canvas"
              class="workflow-canvas"
              :style="viewportTransform"
            >
              <svg class="workflow-connections" aria-label="工作流连线">
                <defs>
                  <marker
                    id="workflow-arrow-success"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" />
                  </marker>
                  <marker
                    id="workflow-arrow-failure"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" />
                  </marker>
                </defs>
                <g
                  v-for="edge in edges"
                  :key="edge.id"
                  :class="[
                    'workflow-edge',
                    {
                      selected: isEdgeSelected(edge),
                      invalid: invalidInputEdges.has(edge.id),
                    },
                  ]"
                  :style="{ '--edge-color': edge.color }"
                >
                  <path
                    class="workflow-edge-flow"
                    :d="curve(edge.from, edge.to)"
                  />
                  <path
                    class="workflow-edge-pulse"
                    :d="curve(edge.from, edge.to)"
                  />
                  <path
                    class="workflow-edge-hit"
                    :d="curve(edge.from, edge.to)"
                    @pointerdown="beginEdgeRewire(edge, $event)"
                    @contextmenu="openEdgeMenu(edge, $event)"
                  />
                  <circle
                    class="workflow-edge-handle"
                    :cx="edge.to.x"
                    :cy="edge.to.y"
                    r="6"
                    @pointerdown="beginEdgeRewire(edge, $event)"
                    @contextmenu="openEdgeMenu(edge, $event)"
                  />
                  <text
                    :x="(edge.from.x + edge.to.x) / 2"
                    :y="(edge.from.y + edge.to.y) / 2 - 6"
                  >
                    {{ edge.label }}
                  </text>
                </g>
                <path
                  v-if="connection"
                  class="workflow-edge-draft"
                  :d="
                    curve(
                      { x: connection.x1, y: connection.y1 },
                      { x: connection.x2, y: connection.y2 },
                    )
                  "
                />
              </svg>
              <article
                class="workflow-start-node"
                :class="{ selected: isSelected('__start__'), 'has-save-error': saveErrorNodeIds.has('__start__') }"
                :aria-invalid="saveErrorNodeIds.has('__start__')"
                :style="{ left: form.startX + 'px', top: form.startY + 'px' }"
                @pointerdown.stop="beginStartDrag"
              >
                <span>流程入口</span><strong>开始</strong
                ><small>{{
                  form.entryNodeIds.length
                    ? form.entryNodeIds.length + " 个入口节点"
                    : "拖动端口连接入口节点"
                }}</small
                ><button
                  type="button"
                  class="workflow-output-port start"
                  title="新增入口节点"
                  @pointerdown="beginConnection('__start__', 'start', $event)"
                ></button>
              </article>
              <article
                v-for="node in form.nodes"
                :key="node.id"
                class="workflow-canvas-node"
                :class="[node.type, { 'decision-diamond': isJudgement(node.type), selected: isSelected(node.id), 'has-save-error': saveErrorNodeIds.has(node.id) }]"
                :aria-invalid="saveErrorNodeIds.has(node.id)"
                :style="{
                  left: node.x + 'px',
                  top: node.y + 'px',
                  height: nodeHeight(node) + 'px',
                }"
                @pointerdown.stop="beginDrag(node, $event)"
              >
                <svg v-if="isJudgement(node.type)" class="workflow-diamond-shape" viewBox="0 0 230 220" preserveAspectRatio="none" aria-hidden="true">
                  <polygon points="115,2 228,110 115,218 2,110" />
                </svg>
                <button
                  type="button"
                  class="workflow-input-port"
                  :style="isJudgement(node.type) ? { top: nodeHeight(node) / 2 - 7 + 'px' } : undefined"
                  title="连接到此节点"
                  @pointerdown.stop
                  @pointerup="completeConnection(node.id, $event)"
                  @contextmenu.prevent
                ></button>
                <header>
                  <span>{{ nodeType(node.type) }}</span
                  ><strong>{{ node.name }}</strong>
                </header>
                <p>{{ nodeSummary(node) }}</p>
                <footer>
                  <small v-if="form.entryNodeIds.includes(node.id)"
                    >入口节点 · {{ node.branches.length }} 条分支</small
                  ><small v-else>{{ node.branches.length }} 条分支</small>
                </footer>
                <button
                  v-for="(branch, branchIndex) in node.branches"
                  :key="branch.id"
                  type="button"
                  class="workflow-output-port custom"
                  :style="{
                    top: outputPortPosition(node, branchIndex).y - 7 + 'px',
                    left: outputPortPosition(node, branchIndex).x - 7 + 'px',
                    background: branch.color,
                    boxShadow: '0 0 0 1px ' + branch.color,
                  }"
                  :title="'连接 ' + branch.name"
                  @pointerdown="beginConnection(node.id, branch.id, $event)"
                >
                  <span>{{ branch.name }}</span>
                </button>
              </article>
            </div>
            <div
              v-if="selectionBox"
              class="workflow-selection-box"
              :style="selectionStyle"
            ></div>
          </div>
          <div
            v-if="edgeMenu"
            class="workflow-edge-menu"
            :style="{ left: edgeMenu.x + 'px', top: edgeMenu.y + 'px' }"
            @pointerdown.stop
            @contextmenu.prevent
          >
            <strong>{{ edgeMenu.edge.label }}连线</strong
            ><button type="button" @click="deleteEdge(edgeMenu.edge)">
              <Delete />删除连线</button
            ><small>左键拖动新增目标，右键拖动切换当前目标</small>
          </div>
        </section>
        <aside
          class="workflow-inspector"
          :class="{ floating: inspectorFloating, dragging: !!inspectorDrag }"
          :style="
            inspectorFloating
              ? {
                  left: inspectorPosition.x + 'px',
                  top: inspectorPosition.y + 'px',
                  height: `calc(100% - ${inspectorPosition.y + 12}px)`,
                }
              : undefined
          "
        >
          <div class="workflow-inspector-modebar" @pointerdown="beginInspectorDrag">
            <span>属性</span>
            <button
              type="button"
              :title="inspectorFloating ? '停靠到右侧' : '浮动显示属性面板'"
              :aria-label="inspectorFloating ? '停靠属性面板' : '浮动属性面板'"
              @click="toggleInspectorMode"
            >
              <Fold v-if="inspectorFloating" />
              <FullScreen v-else />
            </button>
          </div>
          <template v-if="selectedEdge"
            ><header>
              <Connection />
              <div>
                <strong>{{ edgeBranchName(selectedEdge) }}连线</strong
                ><small>连线属性</small>
              </div>
            </header>
            <div class="workflow-edge-properties">
              <label
                >起点<input
                  :value="edgeNodeName(selectedEdge.sourceId)"
                  disabled /></label
              ><label
                >分支类型<input
                  :value="edgeBranchName(selectedEdge)"
                  disabled /></label
              ><label
                >连接目标<input
                  :value="edgeNodeName(selectedEdge.targetId)"
                  disabled
                  title="输出目标由画布连线产生"
              /></label>
              <p>
                左键拖动高亮连线或末端圆点可新增目标；右键拖动可切换当前目标。
              </p>
              <button type="button" @click="deleteEdge(selectedEdge)">
                <Delete />删除这条连线
              </button>
            </div></template
          ><template v-else-if="selectedNodeIds.size > 1"
            ><header>
              <Connection />
              <div>
                <strong>已选择 {{ selectedNodeIds.size }} 个节点</strong
                ><small>拖动任一节点可整体移动</small>
              </div>
            </header>
            <div class="workflow-multi-selection">
              <p>Shift 追加，Ctrl/Cmd 切换，Alt 减选。</p>
              <button
                type="button"
                :disabled="
                  ![...selectedNodeIds].some((id) => id !== '__start__')
                "
                @click="deleteSelected"
              >
                <Delete />删除所选节点
              </button>
            </div></template
          ><template v-else-if="selectedNodeId === '__start__'"
            ><header>
              <Connection />
              <div>
                <strong>开始节点</strong
                ><small>每个工作流固定一个，可连接多个入口</small>
              </div>
            </header>
            <label
              >工作流名称<input
                v-model="form.name"
                required
                maxlength="100" /></label
            ><label
              >说明<textarea
                v-model="form.description"
                rows="4"
                maxlength="1000"
              ></textarea></label
            ><label
              >入口节点（可多选）<select
                v-model="form.entryNodeIds"
                required
                multiple
                :size="Math.min(5, Math.max(2, form.nodes.length))"
              >
                <option
                  v-for="node in form.nodes"
                  :key="node.id"
                  :value="node.id"
                >
                  {{ node.name }}
                </option>
              </select></label
            ><label
              >总超时（分钟）<input
                v-model.number="form.timeoutMinutes"
                type="number"
                min="1"
                max="1440" /></label
            ><label class="workflow-switch"
              ><input v-model="form.enabled" type="checkbox" />保存后启用</label
            ></template
          >
          <template v-else-if="selectedNode">
            <header>
              <component
                :is="
                  selectedNode.type === 'notify'
                    ? Bell
                    : (selectedNode.type === 'agent' || selectedNode.type === 'ai-judge')
                      ? Edit
                      : Connection
                "
              />
              <div>
                <strong>{{ selectedNode.name }}</strong
                ><small>{{ nodeType(selectedNode.type) }} 节点</small>
              </div>
            </header>
            <label
              >节点名称<input
                v-model="selectedNode.name"
                @focus="variableNameBeforeEdit = selectedNode.name"
                @change="renameVariableReferences(selectedNode)"
                required
                :aria-invalid="!!workflowNodeNameError(selectedNode, form.nodes)"
                aria-describedby="workflow-node-name-error"
                maxlength="100" /></label
            ><p v-if="workflowNodeNameError(selectedNode, form.nodes)" id="workflow-node-name-error" class="workflow-field-note danger" aria-live="polite">{{ workflowNodeNameError(selectedNode, form.nodes) }}</p><label
              >节点类型<input
                :value="nodeType(selectedNode.type)"
                disabled
                title="节点类型创建后不可修改"
            /></label>
            <section
              v-if="incomingSourceCount(selectedNode.id) > 0"
              class="workflow-upstream"
            >
              <header>
                <div>
                  <strong>预计接收结构</strong
                  ><small>逐条展示相连分支定义的 JSON，运行时按命中分支原样接收。字段引用中的节点 ID 仅用于选择来源。</small>
                </div>
              </header>
              <div v-for="input in upstreamJsonPreviews" :key="input.sourceId + ':' + input.branchId">
                <span>{{ input.sourceName }} · {{ input.branchName }}</span>
                <textarea
                  :value="JSON.stringify(input.value, null, 2)"
                  rows="5"
                  readonly
                  aria-label="接收的上游 JSON 数据结构"
                ></textarea>
              </div>
              <article
                v-for="item in upstreamReferences"
                :key="item.sourceId + item.expression + item.detail"
              >
                <span>{{ item.sourceName }} · {{ item.label }}</span>
                <code>{{ item.expression }}</code>
                <small>{{ item.detail }}</small>
              </article>
            </section>
            <template v-if="(selectedNode.type === 'agent' || selectedNode.type === 'ai-judge')"
              ><label
                >{{ selectedNode.type === "ai-judge" && selectedNode.judgeMode === "classify" ? "判断问题" : selectedNode.type === "ai-judge" ? "判断任务与标准" : "执行内容" }}<textarea
                  v-model="selectedNode.instruction"
                  rows="8"
                  required
	                  :placeholder="selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify' ? '例如：上海市今天是否会下雨？' : '描述任务；可引用上游字段或数据变量'"
                ></textarea>
              </label>
              <label v-if="selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify'"
                >判断输入<select v-model="selectedNode.judgeInput" required>
                  <option value="" disabled>选择直接连接的上游字段</option>
                  <option v-for="item in upstreamOutputReferences(selectedNode.id)" :key="item.expression" :value="item.expression">{{ item.sourceName }} · {{ item.label }}</option>
                </select></label>
              <p class="workflow-field-note">
                {{ selectedNode.type === "ai-judge" && selectedNode.judgeMode === "classify" ? "只根据选定输入分类，返回分支和理由；无法确定时走“无法判断”分支。原输入会继续传给下游。" : selectedNode.type === "ai-judge" ? "AI 会按顺序评估自然语言条件，只选择一个分支，并按该分支的 JSON 格式输出。" : "任务完成后，唯一输出分支会将 AI 的完整回答放入 result 字段。" }}
              </p>
              <label
                >模型来源<select v-model="selectedNode.modelSource">
                  <option value="current">跟随当前连接模型</option>
                  <option value="specified">指定模型 ID</option>
                </select></label
              ><label v-if="selectedNode.modelSource === 'specified'"
                >模型 ID<select v-model="selectedModelValue" required>
                  <option value="" disabled>选择模型</option>
                  <option
                    v-for="item in specifiedModelOptions"
                    :key="item.value"
                    :value="item.value"
                  >
                    {{ item.label }}
                  </option>
                </select></label>
              ><p
                v-if="selectedNode.modelSource === 'current'"
                class="workflow-field-note"
              >
                运行时使用当前连接的模型；切换连接后自动生效。
              </p>
              <div class="workflow-inspector-grid">
                <label
                  >模式<select v-model="selectedNode.mode">
                    <option value="coding">编码</option>
                    <option value="general">通用</option>
                    <option value="documents">文档</option>
                  </select></label
                ><label
                  >最大步骤<input
                    v-model.number="selectedNode.maxSteps"
                    type="number"
                    min="1"
                    max="500"
                /></label>
              </div>
              <details v-if="selectedNode.type==='agent'" class="workflow-execution-policy"><summary>任务验收与执行约束</summary><p class="workflow-field-note">从 3D 工作台生成的流程保留工具限制、请求预算、任务类型、文件范围及验收规则。此处修改后保存为新流程版本；执行使用流程独立工作目录。</p><label>约束 JSON<textarea v-model="selectedNode.executionJson" aria-label="工作流执行约束" rows="10" placeholder='{"tools":["agent.read_file"],"maxRequests":10}'/></label><p class="workflow-field-note">留空使用默认约束；tools 为空数组时禁用全部工具。保存时验证格式。</p></details>
              <label
                >权限<select v-model="selectedNode.approvalMode">
                  <option value="ask">安全</option>
                  <option value="auto">标准自动</option>
                  <option value="full">自主</option>
                  <option value="unrestricted">完全控制</option>
                </select></label
              ></template
            >
            <template v-else-if="selectedNode.type === 'judge' || selectedNode.type === 'predicate'">
              <section class="workflow-decision-rules">
                <h3>判断规则</h3>
                <p>字段可输入固定值，或引用上游字段和工作流变量。字段缺失或类型错误会停止执行。</p>
                <label v-if="selectedNode.type === 'predicate'">组合方式<select v-model="selectedNode.ruleMode"><option value="all">全部满足（AND）</option><option value="any">任一满足（OR）</option></select></label>
                <article v-for="(rule,index) in selectedNode.rules" :key="index">
                  <header>规则 {{ index + 1 }}<button v-if="selectedNode.type === 'predicate' && selectedNode.rules.length > 1" type="button" @click="selectedNode.rules.splice(index,1)">删除</button></header>
                  <label>数据类型<select v-model="rule.kind" @change="resetRule(rule)"><option value="text">文本</option><option value="number">数值</option><option value="boolean">布尔值</option><option value="collection">集合（数组／对象）</option></select></label>
                  <label>判断字段<input v-model="rule.left" list="workflow-decision-fields" placeholder="输入值或选择上游字段" maxlength="4000" /></label>
                  <label>运算符<select v-model="rule.operator"><option v-for="option in ruleOperators[rule.kind]" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
                  <label v-if="!['empty','notEmpty'].includes(rule.operator)">比较值<input v-model="rule.right" list="workflow-decision-fields" :placeholder="rule.kind === 'boolean' ? 'true 或 false' : rule.kind === 'collection' && rule.operator === 'contains' ? 'JSON 元素，例如 1 或 &quot;high&quot;' : '固定值或字段引用'" maxlength="4000" /></label>
                </article>
                <button v-if="selectedNode.type === 'predicate'" type="button" :disabled="selectedNode.rules.length >= 50" @click="selectedNode.rules.push({kind:'text',left:'',operator:'eq',right:''})">添加规则</button>
                <small>第一条输出分支：成立；第二条输出分支：不成立。每次仅执行其中一条。</small>
              </section>
            </template>
            <template v-else-if="selectedNode.type === 'switch'">
              <section class="workflow-decision-rules">
                <h3>Switch 多路选择</h3>
                <label>判断值<input v-model="selectedNode.switchValue" list="workflow-decision-fields" placeholder="固定值或上游字段引用" maxlength="4000" /></label>
                <label>数据类型<select v-model="selectedNode.switchKind"><option value="text">文本（区分大小写）</option><option value="number">数值</option><option value="boolean">布尔值</option></select></label>
                <article v-for="(item,index) in selectedNode.switchCases" :key="item.branchId">
                  <header>{{ selectedNode.branches.find(branch=>branch.id === item.branchId)?.name }}<button v-if="selectedNode.switchCases.length > 1" type="button" @click="removeSwitchCase(selectedNode,index)">删除</button></header>
                  <label>等于固定值<input v-model="item.value" maxlength="4000" placeholder="精确匹配，值不能重复" /></label>
                </article>
                <button type="button" :disabled="selectedNode.switchCases.length >= 50" @click="addSwitchCase(selectedNode)">添加匹配分支</button>
                <small>仅选择一个匹配分支；均不匹配时走默认分支。默认分支始终保留。</small>
              </section>
            </template>
            <template v-else-if="selectedNode.type === 'condition'"
              ><p class="workflow-legacy-note">
                这是旧版判断节点。建议改用路由节点。
              </p>
              <label
                >判断来源<select v-model="selectedNode.sourceNodeId" required>
                  <option value="" disabled>选择此前节点</option>
                  <option
                    v-for="candidate in nodeCandidates"
                    :key="candidate.id"
                    :value="candidate.id"
                  >
                    {{ candidate.name }}
                  </option>
                </select></label
              ><label
                >判断内容<select v-model="selectedNode.operator">
                  <option value="succeeded">来源节点执行成功</option>
                  <option value="failed">来源节点执行失败</option>
                </select></label
              ></template
            >
            <template v-else-if="selectedNode.type === 'route'"
              ><label
                >路由依据<select v-model="selectedNode.sourceNodeId" required>
                  <option value="" disabled>选择此前节点</option>
                  <option
                    v-for="candidate in nodeCandidates"
                    :key="candidate.id"
                    :value="candidate.id"
                  >
                    {{ candidate.name }}
                  </option>
                </select></label
              >
              <p class="workflow-field-note">
                路由按分支顺序选择首个匹配项；最后可添加“始终”作为默认分支。
              </p></template
            >
            <template v-else-if="selectedNode.type === 'data'"
              ><section class="workflow-agent-inputs">
                <header>
                  <div>
                    <strong>工作流变量</strong
                    ><small
                      >后续节点通过
                      <code v-text="'{{数据变量 1.result}}'"></code> 引用</small
                    >
                  </div>
                  <button type="button" @click="addAssignment(selectedNode)">
                    <Plus />添加变量
                  </button>
                </header>
                <article
                  v-for="(assignment, index) in selectedNode.assignments"
                  :key="index"
                >
                  <header>
                    <strong>变量 {{ index + 1 }}</strong
                    ><button
                      type="button"
                      title="删除变量"
                      @click="removeAssignment(selectedNode, index)"
                    >
                      <Delete />
                    </button>
                  </header>
                  <label
                    >名称<input
                      v-model="assignment.name"
                      required
                      maxlength="80"
                      placeholder="例如 reportTitle" /></label
                  ><label
                    >值<textarea
                      v-model="assignment.value"
                      rows="3"
                      maxlength="4000"
	                      placeholder="支持 {{input.上游节点ID.name}} 和 {{数据变量 1.result}}"
                    ></textarea>
                  </label>
                  <div
                    v-if="upstreamReferences.length"
                    class="workflow-reference-actions"
                  >
                    <button
                      v-for="item in upstreamReferences"
                      :key="item.expression"
                      type="button"
                      @click="bindReference(assignment, item.expression)"
                    >
                      绑定 {{ item.label }}
                    </button>
                  </div>
                </article></section
            ></template>
            <template v-else-if="selectedNode.type === 'join'"
              ><label
                >汇合方式<select v-model="selectedNode.joinMode">
                  <option value="all">等待全部上游</option>
                  <option value="any">任一上游到达</option></select
                ><small
                  >当前有
                  {{ incomingSourceCount(selectedNode.id) }} 个上游连接。</small
                ></label
              ></template
            >
            <template v-else-if="selectedNode.type === 'approval'"
              ><label>确认标题<input v-model="selectedNode.approvalTitle" maxlength="120" placeholder="支持上游字段和数据变量引用" /></label><label
                >确认内容<textarea
                  v-model="selectedNode.approvalPrompt"
                  required
                  rows="5"
                  maxlength="1000"
                  placeholder="支持工作流变量模板"
                ></textarea>
              </label>
              <div class="workflow-inspector-grid">
                <label
                  >批准按钮<input
                    v-model="selectedNode.approveLabel"
                    required
                    maxlength="30" /></label
                ><label
                  >拒绝按钮<input
                    v-model="selectedNode.rejectLabel"
                    required
                    maxlength="30"
                /></label>
              </div>
              <label>等待方式<select v-model="selectedNode.approvalWaitMode"><option value="forever">一直等待（默认）</option><option value="duration">等待指定时长</option><option value="until">等待至指定时间</option></select></label>
              <label v-if="selectedNode.approvalWaitMode === 'duration'">等待时长（分钟）<input v-model.number="selectedNode.approvalDuration" type="number" min="0.01" max="525600" step="any" /><small>从该确认节点开始等待时计时，60 分钟为 1 小时。</small></label>
              <label v-if="selectedNode.approvalWaitMode === 'until'">截止时间（本地时区）<input v-model="selectedNode.approvalDeadline" type="datetime-local" /><small>到达已过期的截止时间时，立即执行超时策略。</small></label>
              <label v-if="selectedNode.approvalWaitMode !== 'forever'">超时处理<select v-model="selectedNode.approvalTimeoutAction"><option value="reject">进入拒绝分支</option><option value="fail">结束工作流并标记失败</option></select></label>
              <p class="workflow-field-note">
                当前路径等待人工处理，其他路径继续运行。批准、拒绝分支各自配置输出内容，可连接多个下游。
              </p></template
            >
            <template v-else-if="selectedNode.type === 'notify'"
              ><label
                >通知标题<input
                  v-model="selectedNode.title"
                  required
                  maxlength="120"
	                  placeholder="支持 {{input.上游节点ID.name}} 或 {{数据变量 1.result}}" /></label
              ><label
                >通知内容<textarea
                  v-model="selectedNode.body"
                  rows="6"
                  required
                  maxlength="1000"
                  placeholder="支持工作流变量模板"
                ></textarea>
              </label>
              <p class="workflow-field-note">
                系统通知用于用户未停留在应用中时提醒关键结果。
              </p><details v-if="upstreamReferences.length" class="workflow-text-references"><summary>插入引用值</summary><div v-for="item in upstreamReferences" :key="item.expression"><span>{{ item.sourceName }} · {{ item.label }}</span><button type="button" @click="selectedNode.title += item.expression">插入标题</button><button type="button" @click="selectedNode.body += item.expression">插入正文</button></div></details></template
            >
            <template v-else-if="selectedNode.type === 'end'"
              ><label
                >结束状态<select v-model="selectedNode.endStatus">
                  <option value="succeeded">成功结束</option>
                  <option value="failed">失败结束</option>
                </select></label
              ><label>结束范围<select v-model="selectedNode.endScope"><option value="path">当前路径（默认）</option><option value="workflow">整个工作流</option></select><small>{{ selectedNode.endScope === 'path' ? '其他路径继续执行；存在失败路径时，流程最终记为失败。' : '立即停止其他任务并清理人工确认待办，按所选状态结束整个流程。' }}</small></label><label
                >结束摘要<textarea
                  v-model="selectedNode.endSummary"
                  rows="5"
                  maxlength="1000"
                  placeholder="支持工作流变量模板"
                ></textarea></label>
              <label>最终结果 JSON（可选）<textarea :id="'workflow-output-end_'+selectedNode.id" v-model="selectedNode.endResult" rows="5" maxlength="4000" placeholder='{"result":""}' :aria-invalid="!!workflowJsonError(selectedNode.endResult)"></textarea></label>
              <p v-if="workflowJsonError(selectedNode.endResult)" class="workflow-field-note danger" aria-live="polite">{{ workflowJsonError(selectedNode.endResult) }}</p>
              <button class="workflow-format-result" type="button" :disabled="!selectedNode.endResult.trim()" @click="formatBranchOutput(endResultBranch(selectedNode))">格式化 JSON</button>
              <div class="workflow-end-references"><button v-for="item in upstreamReferences" :key="item.expression" type="button" @click="insertOutputReference(endResultBranch(selectedNode),item)">插入 {{ item.sourceName }} · {{ item.label }}</button></div>
              <p class="workflow-field-note">摘要用于说明结果，JSON 用于保存业务数据；均显示在运行记录中。结束组件没有输出分支。</p>
            </template>
            <datalist id="workflow-decision-fields"><option v-for="item in upstreamOutputReferences(selectedNode.id)" :key="item.expression" :value="item.expression">{{ item.label }}</option><option v-for="item in dataVariableReferences()" :key="item.expression" :value="item.expression">{{ item.sourceName }}：{{ item.label }}</option></datalist>
            <section
              v-if="selectedNode.type !== 'end'"
              class="workflow-branches"
            >
              <header>
                <div>
                  <h3>
                    {{
                      selectedNode.type === "route" ? "路由规则" : "输出分支"
                    }}
                  </h3>
                  <small>{{
                    selectedNode.type === "notify" ? "由实际发送结果选择成功或失败分支，不代表用户已阅读" : selectedNode.type === "approval" ? "固定批准和拒绝分支，由人工选择或超时策略决定" : isDecision(selectedNode.type) ? "由上方规则选择分支；各分支独立定义输出内容" : selectedNode.type === "join"
                      ? "汇合完成后直接输出；一个输出分支可连接多个下游"
                      : selectedNode.type === "data"
                        ? "变量设置完成后直接输出；一个输出分支可连接多个下游"
                      : selectedNode.type === "ai-judge"
                      ? selectedNode.judgeMode === "classify" ? "只选择一个分类分支；输入和理由传给下游" : "AI 按顺序判断自然语言条件，每次只选择一个分支"
                      : selectedNode.type === "agent"
                      ? "任务完成后以 result 字段传递 AI 回答；一个分支可连接多个下游"
                      : "按顺序匹配第一条规则"
                  }}</small>
                </div>
                <button v-if="!isDecision(selectedNode.type) && !['approval','notify'].includes(selectedNode.type) && selectedNode.type !== 'join' && (!['agent', 'data'].includes(selectedNode.type) || !selectedNode.branches.length)" type="button" @click="addBranch(selectedNode)">
                  <Plus />添加分支
                </button>
              </header>
              <p
                v-if="!selectedNode.branches.length"
                class="workflow-branches-empty"
              >
                没有分支时，节点完成后当前路径结束。
              </p>
              <article
                v-for="(branch, index) in selectedNode.branches"
                :key="branch.id"
              >
                <header>
                  <strong>{{ selectedNode.type === 'notify' ? (index === 0 ? '发送成功分支' : index === 1 ? '发送失败分支' : '旧版多余分支，请删除') : selectedNode.type === 'approval' ? (index === 0 ? '批准分支' : '拒绝分支') : selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify' && branch.id === selectedNode.unknownBranchId ? '无法判断分支' : selectedNode.type === 'switch' ? (branch.id === selectedNode.defaultBranchId ? '默认分支' : '匹配分支 ' + (index + 1)) : ['judge','predicate'].includes(selectedNode.type) ? (index === 0 ? '成立分支' : '不成立分支') : '分支 ' + (index + 1) }}</strong
                  ><button
                    v-if="!isDecision(selectedNode.type) && (selectedNode.type !== 'ai-judge' || (selectedNode.branches.length > (selectedNode.judgeMode === 'classify' ? 3 : 2) && branch.id !== selectedNode.unknownBranchId)) && selectedNode.type !== 'approval' && (selectedNode.type !== 'notify' || selectedNode.branches.length > 2) && (!['agent', 'join', 'data'].includes(selectedNode.type) || selectedNode.branches.length > 1)"
                    type="button"
                    title="删除分支"
                    @click="removeBranch(selectedNode, branch)"
                  >
                    <Delete />
                  </button>
                </header>
                <div class="workflow-branch-name">
                  <label
                    >名称<input
                      v-model="branch.name"
                      required
                      maxlength="80" /></label
                  ><label
                    >颜色<input v-model="branch.color" type="color" required
                  /></label>
                </div>
                <p v-if="selectedNode.type === 'agent'" class="workflow-field-note">输出格式固定为 <code>{"result":""}</code>；运行时填入 AI 的完整回答，无需配置判断条件。</p>
                <p v-if="selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify'" class="workflow-field-note">输出固定为 <code>{"result":"原输入","reason":"判断理由"}</code>。</p>
                <label v-if="!['agent', 'join', 'data', 'approval', 'notify'].includes(selectedNode.type) && !isDecision(selectedNode.type)"
                  >{{
                    (selectedNode.type === "agent" || selectedNode.type === "ai-judge") &&
                    selectedNode.branchMode === "ai"
                      ? "AI 识别条件"
                      : "匹配条件"
                  }}<textarea
                    v-if="
                      (selectedNode.type === 'agent' || selectedNode.type === 'ai-judge') &&
                      selectedNode.branchMode === 'ai'
                    "
                    v-model="branch.condition"
                    required
                    rows="3"
                    maxlength="500"
                    placeholder="用自然语言描述什么情况下应选择此分支"
                  ></textarea
                  ><input
                    v-else
                    v-model="branch.condition"
                    required
                    maxlength="500"
                    list="workflow-branch-conditions"
                    placeholder="例如 变量：risk 等于：high" /></label
                ><small v-if="!['agent', 'join', 'data', 'approval', 'notify'].includes(selectedNode.type) && !isDecision(selectedNode.type)">{{
                  (selectedNode.type === "agent" || selectedNode.type === "ai-judge") &&
                  selectedNode.branchMode === "ai"
                    ? "描述业务语义，AI 将在所有分支中选择唯一最符合的一条。"
                    : "支持执行状态、摘要/错误包含，以及变量等于、不等于、包含、大小或为空。"
                }}</small
                ><div v-if="selectedNode.type !== 'agent' && !(selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify')" class="workflow-json-toolbar">
                  <label :for="`workflow-output-${branch.id}`">输出内容</label>
                  <button type="button" :disabled="!branch.outputValue?.trim()" @click="formatBranchOutput(branch)">格式化</button>
                </div>
                <textarea
                    v-if="selectedNode.type !== 'agent' && !(selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify')"
                    :id="`workflow-output-${branch.id}`"
                    v-model="branch.outputValue"
                    :rows="selectedNode.type === 'join' ? 6 : 4"
                    maxlength="4000"
                    :aria-invalid="!!branchOutputError(selectedNode, branch)"
                    :aria-describedby="`workflow-output-error-${branch.id}`"
                    placeholder='{"result":""}'
                ></textarea>
                <small v-if="selectedNode.type !== 'agent' && !(selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify')" :id="`workflow-output-error-${branch.id}`" :class="{ danger: branchOutputError(selectedNode, branch) }" aria-live="polite">{{
                  branchOutputError(selectedNode, branch) ||
                  (selectedNode.type === 'ai-judge' && selectedNode.branchMode === 'ai'
                    ? '填写合法 JSON：固定值原样保留，空字符串由 AI 填写，引用值由程序自动填入。'
                    : selectedNode.type === 'join'
                      ? '填写合法 JSON，固定值原样输出；引用值保留原始类型。引用缺失或不唯一时会报错。'
                      : branch.outputValue?.trim() ? 'JSON 格式正确；固定值原样输出，支持引用上游字段或数据变量。' : '输出内容可留空；填写时请使用合法 JSON，可包含固定值或引用值。')
                }}</small>
                <div
                  v-if="selectedNode.type !== 'agent' && !(selectedNode.type === 'ai-judge' && selectedNode.judgeMode === 'classify') && upstreamReferences.length"
                  class="workflow-reference-actions"
                >
                  <button
                    v-for="item in upstreamReferences"
                    :key="item.expression"
                    type="button"
                    :title="item.expression"
                    @click="insertOutputReference(branch, item)"
                  >
                    插入 {{ item.sourceName }} · {{ item.label }}
                  </button>
                </div>
              </article>
            </section>
            <button
              type="button"
              class="workflow-delete-node"
              :disabled="confirmingNodeDeletion"
              @click="confirmDeleteNodes([selectedNode])"
            >
              <Delete />删除此节点
            </button>
          </template>
        </aside>
      </div>
      <datalist id="workflow-branch-conditions">
        <option value="执行成功"></option>
        <option value="执行失败"></option>
        <option value="始终"></option>
        <option value="摘要包含："></option>
        <option value="错误包含："></option>
        <option value="变量：name 等于：value"></option>
        <option value="变量：name 不等于：value"></option>
        <option value="变量：name 包含：value"></option>
        <option value="变量：name 大于：0"></option>
        <option value="变量：name 为空"></option>
      </datalist></form
  ></Teleport>
</template>

<style scoped src="./studio-workflow.css"></style>
