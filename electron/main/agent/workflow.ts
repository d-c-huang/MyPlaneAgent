import { variableReference, mapVariableReferences } from '../../shared/workflow-variable-references.js';
import { isDecision, validateDecision, evaluateRule, decisionValue, typedDecisionValue } from '../../shared/workflow-decisions.js';
import { randomUUID } from "node:crypto";
import {validateWorkflowExecution} from './workflow-execution.js';
import fs from "node:fs";
import { WorkflowValidationError } from "../../shared/workflow-validation.js";
import path from "node:path";
import {
  readIntegrationJson,
  writeIntegrationJson,
} from "../integration-store.js";
import type { AgentTask } from "../../shared/local-ai-agent.js";
import type { AgentConnection } from "./model.js";
import type {
  WorkflowBranch,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowModelRef,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
} from "../../shared/local-ai-workflow.js";
import type { LocalAgentService } from "./service.js";
import type { CoreWorkflowAdapter } from "./core-workflow-adapter.js";
import { workflowOutputData } from "../../shared/workflow-inputs.js";
import { workflowNodeNameError } from "../../shared/workflow-node-names.js";
import { parseWorkflowAiOutput, workflowAiGeneratedTemplate, assembleWorkflowAiOutput } from "../../shared/workflow-ai-output.js";
import { parseWorkflowJson, parseWorkflowJsonTemplate, renderWorkflowJsonTemplate } from "../../shared/workflow-json-template.js";

const now = () => new Date().toISOString();
const text = (value: unknown, label: string, max: number, optional = false) => {
  const result = String(value ?? "").trim();
  if ((!result && !optional) || result.length > max)
    throw new Error(`${label}需要 ${optional ? "0" : "1"}–${max} 个字符`);
  return result;
};
const integer = (value: unknown, label: string, min: number, max: number) => {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`${label}需要 ${min}–${max} 的整数`);
  return result;
};
type WorkflowModelPlan = {
  model: string;
  source?: "current" | "local" | "remote";
  label?: string;
  connection?: AgentConnection;
};

export class WorkflowService {
  private readonly definitionsFile: string;
  private readonly versionsFile: string;
  private readonly runsFile: string;
  private readonly callbacks = new Map<string, (run: WorkflowRun) => void>();
  private readonly activeAgents = new Map<string, string>();
  private readonly classifierControllers = new Map<string, AbortController>();
  private readonly pendingLocalAgents: { definition: WorkflowDefinition; runId: string; nodeId: string }[] = [];
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly directory: string,
    private agent: Pick<LocalAgentService, 'start' | 'stop' | 'projects' | 'logModelConversation'> | CoreWorkflowAdapter,
    private log?: (level: "info" | "warn" | "error", message: string) => void,
    private notify?: (title: string, body: string) => void | boolean,
    private currentModel?: () => string | Promise<string>,
    private isLocalModel?: () => boolean,
    private prepareModel?: (
      ref: WorkflowModelRef | undefined,
      legacyModel: string | undefined,
    ) => Promise<WorkflowModelPlan>,
    private classify?: (
      model: string,
      connection: AgentConnection | undefined,
      prompt: string,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {
    this.definitionsFile = path.join(directory, "definitions.json");
    this.versionsFile = path.join(directory, "versions.json");
    this.runsFile = path.join(directory, "runs.json");
    this.removeLegacyProjectBindings();
    this.recover();
  }
  private removeLegacyProjectBindings() {
    for (const file of [this.definitionsFile, this.versionsFile, this.runsFile]) {
      const rows = readIntegrationJson<Record<string, unknown>[]>(file, []);
      if (!Array.isArray(rows) || !rows.some((row) => row && "projectId" in row)) continue;
      writeIntegrationJson(file, rows.map(({ projectId: _legacy, ...row }) => row));
    }
  }
  private modelRef(input: unknown, label: string): WorkflowModelRef | undefined {
    if (!input || typeof input !== "object") return;
    const row = input as Record<string, unknown>,
      source = row.source;
    if (source === "current")
      return {
        source,
        ...(typeof row.id === "string" && row.id.trim()
          ? { id: text(row.id, `${label} ID`, 500) }
          : {}),
        ...(typeof row.name === "string" && row.name.trim()
          ? { name: text(row.name, `${label}名称`, 500) }
          : {}),
      };
    if (source === "local")
      return {
        source,
        id: text(row.id, `${label} ID`, 500),
        ...(typeof row.name === "string" && row.name.trim()
          ? { name: text(row.name, `${label}名称`, 500) }
          : {}),
      };
    if (source === "remote") {
      const apiFormat = row.apiFormat === "anthropic" ? "anthropic" : "openai",
        endpoint = text(row.endpoint, `${label}服务地址`, 1000);
      try {
        const url = new URL(endpoint);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(`${label}服务地址无效`);
      }
      return {
        source,
        id: text(row.id, `${label} ID`, 500),
        apiFormat,
        endpoint: endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint,
        ...(typeof row.name === "string" && row.name.trim()
          ? { name: text(row.name, `${label}名称`, 500) }
          : {}),
        ...(typeof row.profileId === "string" && row.profileId.trim()
          ? { profileId: text(row.profileId, `${label}配置`, 100) }
          : {}),
        ...(Number.isFinite(Number(row.contextLength))
          ? {
              contextLength: integer(
                row.contextLength,
                `${label}上下文`,
                512,
                1_000_000,
              ),
            }
          : {}),
      };
    }
    throw new Error(`${label}来源无效`);
  }
  definitions() {
    const rows = readIntegrationJson<WorkflowDefinition[]>(
      this.definitionsFile,
      [],
    );
    if (!Array.isArray(rows)) throw new Error("工作流定义记录已损坏");
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  runs(workflowId?: string, limit = 100) {
    const rows = readIntegrationJson<WorkflowRun[]>(this.runsFile, []);
    if (!Array.isArray(rows)) throw new Error("工作流运行记录已损坏");
    return rows
      .filter((row) => !workflowId || row.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(1, Math.min(2000, limit)));
  }
  private writeDefinitions(rows: WorkflowDefinition[]) {
    writeIntegrationJson(this.definitionsFile, rows);
  }
  private writeRuns(rows: WorkflowRun[]) {
    writeIntegrationJson(
      this.runsFile,
      [...rows]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-2000),
    );
  }
  private node(input: WorkflowNode, ids: Set<string>): WorkflowNode {
    const name = text(input.name, "节点名称", 100),
      legacyBranches: WorkflowBranch[] = [
        ...(input.onSuccess
          ? [
              {
                id: "success",
                name: "成功",
                condition: "执行成功",
                color: "#4a9a6e",
                targetNodeId: input.onSuccess,
              },
            ]
          : []),
        ...(input.onFailure
          ? [
              {
                id: "failure",
                name: "失败",
                condition: "执行失败",
                color: "#c65a52",
                targetNodeId: input.onFailure,
              },
            ]
          : []),
      ],
      sourceBranches = Array.isArray(input.branches)
        ? input.branches
        : legacyBranches;
    const directAgent = input.type === "agent" && (!input.config?.branchMode || input.config.branchMode === "direct"),
      classifyJudge = input.type === "ai-judge" && input.config?.judgeMode === "classify",
      aiBranchMode =
        input.type === "ai-judge" || (input.type === "agent" && input.config?.branchMode === "ai"),
      branchIds = new Set<string>(),
      branches = sourceBranches.map((branch, index) => {
        const id = text(
            branch.id,
            `节点“${name}”第 ${index + 1} 条分支 ID`,
            80,
          ),
          branchName = text(
            branch.name,
            `节点“${name}”第 ${index + 1} 条分支名称`,
            80,
          ),
          condition = directAgent || input.type === "join" || input.type === "data" || input.type === "approval" || (input.type === "notify" && input.config?.fixedBranches) || isDecision(input.type) ? "" : text(
            branch.condition,
            `节点“${name}”分支“${branchName}”的判断条件`,
            500,
          ),
          color = String(branch.color || "").trim();
        if (branchIds.has(id))
          throw new Error(`节点“${name}”的分支 ID 不能重复`);
        branchIds.add(id);
        if (!/^#[0-9a-f]{6}$/i.test(color))
          throw new Error(`节点“${name}”分支“${branchName}”的颜色无效`);
        if (!aiBranchMode && !directAgent && input.type !== "join" && input.type !== "data" && input.type !== "approval" && !(input.type === "notify" && input.config?.fixedBranches) && !isDecision(input.type))
          this.validateBranchCondition(condition, name, branchName);
        const rawTargets = Array.isArray(branch.targetNodeIds)
            ? branch.targetNodeIds
            : branch.targetNodeId
              ? [branch.targetNodeId]
              : [],
          targetNodeIds = [
            ...new Set(
              rawTargets.map((target) =>
                text(target, `节点“${name}”分支“${branchName}”的输出目标`, 80),
              ),
            ),
          ];
        if (
          targetNodeIds.some(
            (target) => !ids.has(target) || target === input.id,
          )
        )
          throw new Error(`节点“${name}”分支“${branchName}”的输出目标无效`);
        const outputValue = directAgent || classifyJudge ? "" : text(
          branch.outputValue,
          `节点“${name}”分支“${branchName}”的输出值`,
          4000,
          true,
        );
        try {
          if (outputValue) parseWorkflowJson(outputValue);
        } catch (error) {
          throw new Error(`节点“${name}”分支“${branchName}”：${error instanceof Error ? error.message : String(error)}`);
        }
        return {
          id,
          name: branchName,
          condition,
          color,
          ...(targetNodeIds.length ? { targetNodeIds } : {}),
          ...(outputValue ? { outputValue } : {}),
        };
      });
    const base = { id: text(input.id, "节点 ID", 80), name, branches };
    if (input.type === "agent" || input.type === "ai-judge") {
      if (directAgent && branches.length !== 1)
        throw new Error(`Agent“${base.name}”必须有且只有一个输出分支`);
      if (input.type === "ai-judge" && branches.length < (classifyJudge ? 3 : 2))
        throw new Error(`AI 判断“${base.name}”至少需要${classifyJudge ? "三个" : "两个"}输出分支`);
      if (classifyJudge) {
        if (!/^\{\{\s*input\.[^.{}\s]+(?:\.[^{}\s]+)*\s*\}\}$/.test(input.config.judgeInput || ""))
          throw new Error(`AI 判断“${base.name}”请选择有效的上游输入字段`);
        if (!branches.some(branch => branch.id === input.config.unknownBranchId))
          throw new Error(`AI 判断“${base.name}”缺少无法判断分支`);
      }
      const branchMode = input.type === "ai-judge" ? "ai" : input.config?.branchMode || "direct",
        modelRef = this.modelRef(input.config?.modelRef, `节点“${base.name}”的模型`),
        modelSource =
          input.config?.modelSource ||
          (input.config?.model || (modelRef && modelRef.source !== "current")
            ? "specified"
            : "current");
      if (
        !["general", "coding", "documents"].includes(input.config?.mode) ||
        !["ask", "auto", "full", "unrestricted"].includes(
          input.config?.approvalMode,
        ) ||
        !["all", "any"].includes(input.config?.inputSignalMode || "all") ||
        !["direct", "ai", "rules"].includes(branchMode) ||
        !["current", "specified"].includes(modelSource) ||
        (modelSource === "specified" &&
          !String(input.config?.model || modelRef?.id || "").trim())
      )
        throw new Error(`节点“${base.name}”的 Agent 配置无效`);
      const inputNames = new Set<string>(),
        inputs = (
          Array.isArray(input.config.inputs) ? input.config.inputs : []
        ).map((parameter, index) => {
          const parameterName = text(
              parameter.name,
              `节点“${base.name}”第 ${index + 1} 个输入参数名称`,
              100,
            ),
            legacy = parameter as unknown as {
              description?: unknown;
              value?: unknown;
            },
            description = text(
              legacy.description ?? legacy.value,
              `输入参数“${parameterName}”的说明`,
              4000,
              true,
            ),
            value = text(
              legacy.value,
              `输入参数“${parameterName}”的绑定值`,
              4000,
              true,
            );
          if (inputNames.has(parameterName))
            throw new Error(`节点“${base.name}”的输入参数名称不能重复`);
          inputNames.add(parameterName);
          return { name: parameterName, description, ...(value ? { value } : {}) };
        });
      if (branchMode === "ai" && !classifyJudge) {
        if (!branches.length)
          throw new Error(`Agent“${base.name}”至少需要一个输出分支`);
        for (const branch of branches)
          this.outputTemplate(
            branch.outputValue,
            `Agent“${base.name}”分支“${branch.name}”的输出内容`,
          );
      }
      return {
        ...base,
        type: input.type,
        config: {
          instruction: text(input.config.instruction, "Agent 要求", 16000),
          ...(input.config.execution===undefined?{}:{execution:validateWorkflowExecution(input.config.execution)}),
          ...(input.config.model
            ? { model: text(input.config.model, "模型", 500) }
            : {}),
          ...(modelRef ? { modelRef } : {}),
          modelSource,
          mode: input.config.mode,
          maxSteps: integer(input.config.maxSteps, "最大步骤", 1, 500),
          fastMode: input.config.fastMode !== false,
          approvalMode: input.config.approvalMode,
          inputs,
          inputSignalMode: input.config.inputSignalMode || "all",
          branchMode,
          ...(classifyJudge ? {
            judgeMode: "classify" as const,
            judgeInput: text(input.config.judgeInput, "判断输入", 300),
            unknownBranchId: text(input.config.unknownBranchId, "无法判断分支", 80),
          } : input.type === "ai-judge" ? { judgeMode: "legacy" as const } : {}),
        },
      };
    }
    if (input.type === "judge" || input.type === "predicate" || input.type === "switch") {
      const node = { ...input, ...base };
      validateDecision(node);
      return node;
    }
    if (input.type === "condition") {
      const sourceNodeId = text(input.config?.sourceNodeId, "条件来源节点", 80);
      if (
        !ids.has(sourceNodeId) ||
        !["succeeded", "failed"].includes(input.config?.operator)
      )
        throw new Error(`节点“${base.name}”的条件配置无效`);
      return {
        ...base,
        type: "condition",
        config: { sourceNodeId, operator: input.config.operator },
      };
    }
    if (input.type === "route") {
      const sourceNodeId = text(input.config?.sourceNodeId, "路由来源节点", 80);
      if (!ids.has(sourceNodeId))
        throw new Error(`节点“${base.name}”的路由来源无效`);
      return { ...base, type: "route", config: { sourceNodeId } };
    }
    if (input.type === "data") {
      const names = new Set<string>(),
        assignments = (
          Array.isArray(input.config?.assignments)
            ? input.config.assignments
            : []
        ).map((assignment, index) => {
          const assignmentName = text(
              assignment.name,
              `节点“${base.name}”第 ${index + 1} 个变量名`,
              80,
            ),
            value = text(
              assignment.value,
              `变量“${assignmentName}”的值`,
              4000,
              true,
            );
          if (names.has(assignmentName))
            throw new Error(`节点“${base.name}”的变量名不能重复`);
          names.add(assignmentName);
          return { name: assignmentName, value };
        });
      if (!assignments.length)
        throw new Error(`节点“${base.name}”至少需要设置一个变量`);
      if (branches.length > 1)
        throw new Error(`数据变量节点“${name}”只允许一个输出分支，可连接多个下游节点`);
      return { ...base, type: "data", config: { assignments } };
    }
    if (input.type === "join") {
      if (!["all", "any"].includes(input.config?.mode))
        throw new Error(`节点“${base.name}”的汇合方式无效`);
      if (branches.length !== 1)
        throw new Error(`汇合节点“${name}”必须有且只有一个输出分支，可连接多个下游节点`);
      return { ...base, type: "join", config: { mode: input.config.mode } };
    }
    if (input.type === "approval") {
      if (branches.length !== 2) throw new Error('人工确认必须保留批准和拒绝两个输出分支');
      const wait = input.config?.wait || {mode:'forever' as const,onTimeout:'reject' as const};
      if (!['forever','duration','until'].includes(wait.mode) || !['reject','fail'].includes(wait.onTimeout)) throw new Error('人工确认等待配置无效');
      if (wait.mode === 'duration' && (!Number.isFinite(wait.durationMinutes) || Number(wait.durationMinutes) <= 0 || Number(wait.durationMinutes) > 525600)) throw new Error('等待时长需大于 0 且不超过 525600 分钟');
      if (wait.mode === 'until' && !Number.isFinite(Date.parse(wait.deadline || ''))) throw new Error('请选择有效的截止时间');
      return {
        ...base,type:'approval',config:{
          title:text(input.config?.title || '人工确认','确认标题',120),
          prompt:text(input.config?.prompt,'确认内容',1000),
          approveLabel:text(input.config?.approveLabel,'批准按钮文字',30),
          rejectLabel:text(input.config?.rejectLabel,'拒绝按钮文字',30),
          wait:{mode:wait.mode,onTimeout:wait.onTimeout,...(wait.mode === 'duration' ? {durationMinutes:Number(wait.durationMinutes)} : {}),...(wait.mode === 'until' ? {deadline:new Date(wait.deadline!).toISOString()} : {})},
        },
      };
    }
    if (input.type === "notify") {
      if (input.config?.fixedBranches && branches.length !== 2) throw new Error("通知组件必须保留发送成功和发送失败两个分支");
      return {
        ...base,
        type: "notify",
        config: {
          ...(input.config?.fixedBranches ? {fixedBranches:true} : {}),
          title: text(input.config?.title, "通知标题", 120),
          body: text(input.config?.body, "通知内容", 1000),
        },
      };
    }
    if (input.type === "end") {
      if (base.branches.length)
        throw new Error(`结束节点“${base.name}”不能包含分支`);
      if (!["succeeded", "failed"].includes(input.config?.status))
        throw new Error(`节点“${base.name}”的结束状态无效`);
      const scope = input.config.scope || 'path';
      if (!['path','workflow'].includes(scope)) throw new Error('结束范围无效');
      const resultJson = text(input.config.resultJson,'最终结果 JSON',4000,true);
      if (resultJson) {
        try { parseWorkflowJson(resultJson); }
        catch (error) { throw new Error(`最终结果 JSON 格式错误：${error instanceof Error ? error.message : String(error)}`); }
      }
      return {
        ...base,
        type: "end",
        config: {
          status: input.config.status,
          scope,
          ...(resultJson ? {resultJson} : {}),
          summary: text(input.config?.summary, "结束摘要", 1000, true),
        },
      };
    }
    throw new Error("不支持的工作流节点类型");
  }
  private variableCondition(value: string) {
    return value.match(
      /^(?:变量|variable)[.：:\s]+([\w.\-\u4e00-\u9fff]+)\s*(大于等于|小于等于|不等于|不包含|等于|包含|非空|为空|>=|<=|!=|==|>|<)\s*[:：]?\s*(.*)$/i,
    );
  }
  private validateBranchCondition(
    value: string,
    nodeName: string,
    branchName: string,
  ) {
    const condition = value.trim().toLowerCase();
    if (
      [
        "成功",
        "执行成功",
        "success",
        "succeeded",
        "失败",
        "执行失败",
        "failure",
        "failed",
        "始终",
        "总是",
        "always",
      ].includes(condition)
    )
      return;
    if (
      /^(摘要|summary)\s*(包含|contains)\s*[:：]?\s*.+$/i.test(value) ||
      /^(错误|error)\s*(包含|contains)\s*[:：]?\s*.+$/i.test(value) ||
      this.variableCondition(value)
    )
      return;
    throw new Error(
      `节点“${nodeName}”分支“${branchName}”的判断条件无效；支持执行状态、摘要/错误包含及变量比较`,
    );
  }
  private branchMatches(
    branch: WorkflowBranch,
    success: boolean,
    nodeRun?: WorkflowNodeRun,
    run?: WorkflowRun,
  ) {
    const value = branch.condition.trim(),
      condition = value.toLowerCase();
    if (["成功", "执行成功", "success", "succeeded"].includes(condition))
      return success;
    if (["失败", "执行失败", "failure", "failed"].includes(condition))
      return !success;
    if (["始终", "总是", "always"].includes(condition)) return true;
    const content = value.match(
      /^(摘要|summary|错误|error)\s*(包含|contains)\s*[:：]?\s*(.+)$/i,
    );
    if (content) {
      const source = /^(摘要|summary)$/i.test(content[1])
        ? nodeRun?.summary
        : nodeRun?.error;
      return !!source?.includes(content[3].trim());
    }
    const variable = this.variableCondition(value);
    if (!variable) return false;
    const actual = run?.variables?.[variable[1]] || "",
      operator = variable[2],
      expected = variable[3].trim();
    if (["为空"].includes(operator)) return !actual;
    if (["非空"].includes(operator)) return !!actual;
    if (["等于", "=="].includes(operator)) return actual === expected;
    if (["不等于", "!="].includes(operator)) return actual !== expected;
    if (operator === "包含") return actual.includes(expected);
    if (operator === "不包含") return !actual.includes(expected);
    const left = Number(actual),
      right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (["大于等于", ">="].includes(operator)) return left >= right;
    if (["小于等于", "<="].includes(operator)) return left <= right;
    if (operator === ">") return left > right;
    if (operator === "<") return left < right;
    return false;
  }
  private validate(
    input: WorkflowDefinitionInput,
    previous?: WorkflowDefinition,
  ): WorkflowDefinition {
    if (
      !Array.isArray(input.nodes) ||
      !input.nodes.length ||
      input.nodes.length > 100
    )
      throw new Error("工作流需要 1–100 个节点");
    const ids = new Set(
      input.nodes.map((node) => text(node.id, "节点 ID", 80)),
    );
    if (ids.size !== input.nodes.length) throw new Error("节点 ID 不能重复");
    input = mapVariableReferences(input, input.nodes, "store");
    const nodes = input.nodes.map((node) => {
        try {
          return this.node(structuredClone(node), ids);
        } catch (error) {
          throw new WorkflowValidationError(error instanceof Error ? error.message : String(error), [node.id]);
        }
      }),
      rawEntryNodeIds =
        Array.isArray(input.entryNodeIds) && input.entryNodeIds.length
          ? input.entryNodeIds
          : [input.entryNodeId],
      entryNodeIds = [
        ...new Set(rawEntryNodeIds.map((id) => text(id, "入口节点", 80))),
      ];
    for (const node of nodes) {
      const error = workflowNodeNameError(node, nodes);
      if (error) throw new WorkflowValidationError(error, nodes.filter(item => !!workflowNodeNameError(item, nodes)).map(item => item.id));
    }
    if (entryNodeIds.some((id) => !ids.has(id)))
      throw new WorkflowValidationError("入口节点不存在", ["__start__"]);
    const entryNodeId = entryNodeIds[0];
    const map = new Map(nodes.map((node) => [node.id, node])),
      visiting = new Set<string>(),
      visited = new Set<string>();
    for (const node of nodes) {
      if (node.type !== "ai-judge" || node.config.judgeMode !== "classify") continue;
      const sourceId = node.config.judgeInput!.match(/^\{\{\s*input\.([^.{}\s]+)/)?.[1];
      const source = sourceId ? map.get(sourceId) : undefined;
      if (!source?.branches?.some(branch => branch.targetNodeIds?.includes(node.id)))
        throw new WorkflowValidationError(`AI 判断“${node.name}”的输入必须来自直接连接的上游节点`, [node.id]);
    }
    const targets = (node: WorkflowNode) =>
      node.branches?.flatMap((branch) => branch.targetNodeIds || []) || [];
    const walk = (id: string) => {
      if (visiting.has(id))
        throw new WorkflowValidationError("首版工作流不允许循环，请移除节点回路", [...visiting].slice([...visiting].indexOf(id)));
      if (visited.has(id)) return;
      visiting.add(id);
      const node = map.get(id)!;
      for (const next of targets(node)) walk(next);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of entryNodeIds) walk(id);
    const unreachable = nodes.filter((node) => node.type !== "data" && !visited.has(node.id));
    if (unreachable.length)
      throw new WorkflowValidationError("工作流包含从入口无法到达的节点", unreachable.map(node => node.id));
    for (const node of nodes) walk(node.id);
    const reaches = (
      from: string,
      target: string,
      seen = new Set<string>(),
    ): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      const node = map.get(from);
      return (
        !!node && targets(node).some((next) => reaches(next, target, seen))
      );
    };
    for (const node of nodes)
      if (["condition", "route"].includes(node.type)) {
        const sourceNodeId =
          node.type === "condition" || node.type === "route"
            ? node.config.sourceNodeId
            : "";
        if (sourceNodeId === node.id || !reaches(sourceNodeId, node.id))
          throw new WorkflowValidationError(
            `${node.type === "route" ? "路由" : "条件"}节点“${node.name}”只能引用此前执行的节点`,
            [node.id],
          );
      }
    const layout =
      input.layout?.nodes && typeof input.layout.nodes === "object"
        ? {
            nodes: Object.fromEntries(
              nodes.flatMap((node) => {
                const point = input.layout!.nodes[node.id];
                return point &&
                  Number.isFinite(point.x) &&
                  Number.isFinite(point.y)
                  ? [
                      [
                        node.id,
                        {
                          x: Math.max(0, Math.min(10000, Math.round(point.x))),
                          y: Math.max(0, Math.min(10000, Math.round(point.y))),
                        },
                      ],
                    ]
                  : [];
              }),
            ),
            ...(input.layout.start &&
            Number.isFinite(input.layout.start.x) &&
            Number.isFinite(input.layout.start.y)
              ? {
                  start: {
                    x: Math.max(
                      0,
                      Math.min(10000, Math.round(input.layout.start.x)),
                    ),
                    y: Math.max(
                      0,
                      Math.min(10000, Math.round(input.layout.start.y)),
                    ),
                  },
                }
              : {}),
          }
        : undefined;
    const timestamp = now();
    return {
      id: previous?.id || randomUUID(),
      name: text(input.name, "工作流名称", 100),
      description: text(input.description, "工作流说明", 1000, true),
      enabled: input.enabled !== false,
      version: (previous?.version || 0) + 1,
      entryNodeId,
      entryNodeIds,
      nodes,
      ...(layout ? { layout } : {}),
      timeoutMinutes: integer(input.timeoutMinutes, "工作流超时", 1, 1440),
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
    };
  }
  save(input: WorkflowDefinitionInput) {
    const rows = this.definitions(),
      previous = input.id ? rows.find((row) => row.id === input.id) : undefined;
    if (input.id && !previous) throw new Error("工作流不存在");
    const definition = this.validate(input, previous),
      next = previous
        ? rows.map((row) => (row.id === definition.id ? definition : row))
        : [definition, ...rows];
    this.writeDefinitions(next);
    const versions = readIntegrationJson<WorkflowDefinition[]>(
      this.versionsFile,
      [],
    );
    writeIntegrationJson(
      this.versionsFile,
      [
        ...versions.filter(
          (item) =>
            item.id !== definition.id || item.version !== definition.version,
        ),
        definition,
      ].slice(-500),
    );
    return definition;
  }
  delete(id: string) {
    const rows = this.definitions();
    if (!rows.some((row) => row.id === id)) throw new Error("工作流不存在");
    if (
      this.runs(id, 2000).some((run) =>
        ["running", "waiting"].includes(run.status),
      )
    )
      throw new Error("工作流正在运行，不能删除");
    this.writeDefinitions(rows.filter((row) => row.id !== id));
    this.writeRuns(
      this.runs(undefined, 2000).filter((run) => run.workflowId !== id),
    );
    const versions = readIntegrationJson<WorkflowDefinition[]>(
      this.versionsFile,
      [],
    );
    writeIntegrationJson(
      this.versionsFile,
      versions.filter((item) => item.id !== id),
    );
  }
  action(id: string, action: "run" | "enable" | "pause") {
    const rows = this.definitions(),
      definition = rows.find((row) => row.id === id);
    if (!definition) throw new Error("工作流不存在");
    if (action === "run") return this.start(id);
    definition.enabled = action === "enable";
    definition.updatedAt = now();
    this.writeDefinitions(rows);
    return definition;
  }
  start(
    id: string,
    onUpdate?: (run: WorkflowRun) => void,
    startNodeId?: string,
    resumedFromRunId?: string,
  ) {
    const definition = this.definitions().find((row) => row.id === id);
    if (!definition) throw new Error("工作流不存在");
    const entries = startNodeId
      ? [startNodeId]
      : definition.entryNodeIds?.length
        ? definition.entryNodeIds
        : [definition.entryNodeId];
    if (
      entries.some(
        (entry) => !definition.nodes.some((node) => node.id === entry),
      )
    )
      throw new Error("重试节点不存在");
    const entry = entries[0],
      run: WorkflowRun = {
        id: randomUUID(),
        workflowId: definition.id,
        workflowName: definition.name,
        workflowVersion: definition.version,
        status: "running",
        currentNodeId: entry,
        pendingNodeIds: entries.slice(1),
        nodeInputSignals: {},
        variables: {},
        nodeVariables: {},
        nodeRuns: [],
        agentTaskIds: [],
        startedAt: now(),
        ...(resumedFromRunId ? { resumedFromRunId } : {}),
      };
    this.writeRuns([...this.runs(undefined, 2000), run]);
    if (onUpdate) this.callbacks.set(run.id, onUpdate);
    run.executionRemainingMs = definition.timeoutMinutes * 60_000;
    this.resumeExecutionClock(run);
    this.persist(run);
    this.emit(run);
    void this.execute(definition, run.id, entry);
    return run;
  }
  retry(runId: string, nodeId: string, onUpdate?: (run: WorkflowRun) => void) {
    const previous = this.runs(undefined, 2000).find((run) => run.id === runId);
    if (!previous) throw new Error("工作流运行不存在");
    if (!["failed", "cancelled"].includes(previous.status))
      throw new Error("只能从失败或取消的运行重试");
    if (
      !previous.nodeRuns.some(
        (node) => node.nodeId === nodeId && node.status === "failed",
      )
    )
      throw new Error("只能从失败节点重试");
    return this.start(previous.workflowId, onUpdate, nodeId, previous.id);
  }
  cancel(runId: string) {
    const run = this.runs(undefined, 2000).find((row) => row.id === runId);
    if (!run) throw new Error("工作流运行不存在");
    if (!["running", "waiting"].includes(run.status)) return run;
    run.status = "cancelled";
    run.finishedAt = now();
    run.error = "用户取消了工作流";
    const node = [...run.nodeRuns]
      .reverse()
      .find((item) => item.status === "running" || item.status === "waiting");
    if (node) {
      node.status = "failed";
      node.error = "用户取消了此节点";
      node.finishedAt = now();
    }
    this.finish(run);
    return run;
  }
  private runDefinition(run: WorkflowRun) {
    return readIntegrationJson<WorkflowDefinition[]>(this.versionsFile, []).find(item=>item.id === run.workflowId && item.version === run.workflowVersion)
      || this.definitions().find(item=>item.id === run.workflowId && item.version === run.workflowVersion);
  }
  private pauseExecutionClock(run: WorkflowRun) {
    const timer = this.timeouts.get(run.id);
    if (timer) clearTimeout(timer);
    this.timeouts.delete(run.id);
    if (run.executionStartedAt) run.executionRemainingMs = Math.max(0,(run.executionRemainingMs || 0) - (Date.now()-Date.parse(run.executionStartedAt)));
    run.executionStartedAt = undefined;
  }
  private resumeExecutionClock(run: WorkflowRun) {
    if (this.timeouts.has(run.id)) return;
    run.executionStartedAt = now();
    const timer = setTimeout(()=>this.fail(run.id,'工作流执行超时，已停止'),Math.max(1,run.executionRemainingMs ?? 120*60_000));
    timer.unref?.(); this.timeouts.set(run.id,timer);
  }
  private scheduleApproval(run: WorkflowRun, nodeRun: WorkflowNodeRun) {
    const key = `${run.id}:${nodeRun.nodeId}`, previous = this.approvalTimers.get(key);
    if (previous) clearTimeout(previous);
    this.approvalTimers.delete(key);
    if (!nodeRun.approval?.deadline) return;
    const delay = Math.max(0,Date.parse(nodeRun.approval.deadline)-Date.now());
    const timer = setTimeout(()=>{
      this.approvalTimers.delete(key);
      const current = this.runs(undefined,2000).find(item=>item.id === run.id);
      const pending = current?.nodeRuns.find(item=>item.nodeId === nodeRun.nodeId && item.status === 'waiting');
      if (!current || !pending || !['running','waiting'].includes(current.status)) return;
      if (Date.parse(pending.approval!.deadline!) > Date.now()) return this.scheduleApproval(current,pending);
      this.completeApproval(current,pending,'timeout','等待超时');
    },Math.min(delay,2_147_000_000));
    timer.unref?.();this.approvalTimers.set(key,timer);
  }
  resolveApproval(runId: string, decision: 'approved'|'rejected', nodeId?: string, note = '') {
    if (!['approved','rejected'].includes(decision)) throw new Error('确认决定无效');
    const run = this.runs(undefined,2000).find(item=>item.id === runId);
    if (!run || !['running','waiting'].includes(run.status)) throw new Error('工作流当前未等待人工确认');
    const waiting = run.nodeRuns.filter(item=>item.type === 'approval' && item.status === 'waiting' && (!nodeId || item.nodeId === nodeId));
    if (waiting.length !== 1) throw new Error('请选择一个待确认节点，该节点可能已处理');
    const target = waiting[0];
    if (target.approval?.deadline && Date.parse(target.approval.deadline) <= Date.now()) {
      this.completeApproval(run,target,'timeout','等待超时');
      throw new Error('该确认已超时，不能重复处理');
    }
    return this.completeApproval(run,target,decision,text(note,'确认备注',1000,true));
  }
  private completeApproval(run: WorkflowRun, nodeRun: WorkflowNodeRun, decision: 'approved'|'rejected'|'timeout', note: string) {
    const definition = this.runDefinition(run), node = definition?.nodes.find(item=>item.id === nodeRun.nodeId);
    if (!definition || node?.type !== 'approval') { this.fail(run.id,'找不到本次运行的人工确认配置'); return run; }
    const timerKey = `${run.id}:${node.id}`, timer = this.approvalTimers.get(timerKey);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(timerKey);
    nodeRun.approval = {...nodeRun.approval!,decision,decidedAt:now(),note};
    nodeRun.finishedAt = now();
    this.trace(run,'info',`人工确认：${decision === 'approved' ? '批准' : decision === 'rejected' ? '拒绝' : '超时'}${note ? '；'+note : ''}`,node.id);
    if (decision === 'timeout' && nodeRun.approval.onTimeout === 'fail') {
      nodeRun.status = 'failed';nodeRun.error = '人工确认等待超时';this.persist(run);this.fail(run.id,nodeRun.error);return run;
    }
    const approved = decision === 'approved';
    nodeRun.status = 'succeeded';
    nodeRun.outputValue = approved ? 'approved' : 'rejected';
    nodeRun.summary = decision === 'timeout' ? '等待超时，进入拒绝分支' : approved ? node.config.approveLabel : node.config.rejectLabel;
    run.status = 'running';this.resumeExecutionClock(run);this.persist(run);
    const branch = node.branches?.[approved ? 0 : 1];
    if (!branch) { this.fail(run.id,'人工确认缺少对应输出分支');return run; }
    void this.advance(definition,run,node,true,branch);
    return run;
  }
  private trace(
    run: WorkflowRun,
    level: "info" | "warn" | "error",
    message: string,
    nodeId?: string,
  ) {
    run.logs = run.logs || [];
    run.logs.push({ at: now(), level, message, ...(nodeId ? { nodeId } : {}) });
    if (run.logs.length > 300) run.logs.splice(0, run.logs.length - 300);
    this.log?.(level, `工作流“${run.workflowName}”${message}`);
  }
  private inputPath(
    inputs: unknown,
    path: string,
  ): string | undefined {
    const value = this.inputValue(inputs, path);
    if (value === undefined) return undefined;
    if (value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  private inputValue(inputs: unknown, path: string): unknown {
    let value: unknown = inputs;
    for (const part of path.split(".")) {
      if (!part) return undefined;
      if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
      else if (value && typeof value === "object" && Object.hasOwn(value, part))
        value = (value as Record<string, unknown>)[part];
      else return undefined;
    }
    return value;
  }
  private scopedVariable(expression: string, definition: WorkflowDefinition, run: WorkflowRun) {
    const stored = expression.match(/^nodeVariables\.([^.]+)\.(.+)$/);
    const ref = stored ? {nodeId:stored[1],key:stored[2]} : variableReference(expression, definition.nodes);
    if (!ref) return undefined;
    const values = run.nodeVariables?.[ref.nodeId];
    if (!values || !Object.hasOwn(values, ref.key)) throw new Error(`数据变量引用“${expression}”尚未赋值或不存在`);
    return values[ref.key];
  }
  private templateReference(
    expression: string,
    definition: WorkflowDefinition,
    node: WorkflowNode,
    run: WorkflowRun,
  ): unknown {
    const variable = this.scopedVariable(expression, definition, run);
    if (variable !== undefined) return variable;
    const input = expression.match(/^inputs?\.(.+)$/);
    if (input) {
      const values = this.upstreamInputs(definition, node, run);
      if (Object.hasOwn(values, input[1].split(".")[0]))
        return this.inputValue(values, input[1]);
      const matches = Object.values(values)
        .map(value => this.inputValue(value, input[1]))
        .filter(value => value !== undefined);
      return matches.length === 1 ? matches[0] : undefined;
    }
    if (expression.startsWith("variables.")) return run.variables?.[expression.slice(10)];
    if (run.variables && Object.hasOwn(run.variables, expression)) return run.variables[expression];
    const output = expression.match(/^([^.]+)\.output(?:\.(.+))?$/);
    if (output && this.canReadNodeOutput(output[1], { definition, node }, run)) {
      const source = [...run.nodeRuns].reverse().find(item => item.nodeId === output[1]);
      if (source?.outputValue === undefined) return undefined;
      const value = workflowOutputData(source.outputValue);
      return output[2] ? this.inputValue(value, output[2]) : value;
    }
    const field = expression.match(/^([^.]+)\.(summary|status|error)$/);
    if (field && this.canReadNodeOutput(field[1], { definition, node }, run)) {
      const source = [...run.nodeRuns].reverse().find(item => item.nodeId === field[1]);
      return source?.[field[2] as "summary" | "status" | "error"];
    }
    return undefined;
  }
  private canReadNodeOutput(
    sourceId: string,
    scope?: { definition: WorkflowDefinition; node: WorkflowNode },
    run?: WorkflowRun,
  ) {
    if (!scope || !run) return true;
    return (run.nodeInputSignals?.[scope.node.id] || []).includes(sourceId);
  }
  private render(
    value: string,
    run: WorkflowRun,
    scope?: { definition: WorkflowDefinition; node: WorkflowNode },
  ) {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => {
      const name = key.trim();
      if (scope) {
        const variable = this.scopedVariable(name, scope.definition, run);
        if (variable !== undefined) return variable;
      }
      const inputPath = name.match(/^inputs?\.(.+)$/);
      if (inputPath && scope) {
        const inputs = this.upstreamInputs(scope.definition, scope.node, run);
        // Keep source-qualified references in saved workflows working as before.
        if (Object.hasOwn(inputs, inputPath[1].split(".")[0]))
          return this.inputPath(inputs, inputPath[1]) ?? _match;
        const matches = Object.values(inputs)
          .map(input => this.inputPath(input, inputPath[1]))
          .filter(value => value !== undefined);
        // Duplicate fields remain separate; use a source-qualified reference to disambiguate.
        return matches.length === 1 ? matches[0]! : _match;
      }
      if (name.startsWith("variables."))
        return run.variables?.[name.slice(10)] ?? _match;
      if (run.variables && name in run.variables) return run.variables[name];
      const outputPath = name.match(/^([^.]+)\.output(?:\.(.+))?$/);
      if (outputPath) {
        if (!this.canReadNodeOutput(outputPath[1], scope, run)) return _match;
        const node = run.nodeRuns.find((item) => item.nodeId === outputPath[1]);
        if (!node) return _match;
        if (!outputPath[2]) return node.outputValue ?? "";
        try {
          let value: unknown = JSON.parse(node.outputValue || "null");
          for (const part of outputPath[2].split(".")) {
            if (!part) return _match;
            if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
            else if (value && typeof value === "object")
              value = (value as Record<string, unknown>)[part];
            else return _match;
          }
          if (value === undefined || value === null) return "";
          return typeof value === "object" ? JSON.stringify(value) : String(value);
        } catch {
          return _match;
        }
      }
      const split = name.lastIndexOf(".");
      if (split > 0) {
        if (!this.canReadNodeOutput(name.slice(0, split), scope, run))
          return _match;
        const node = run.nodeRuns.find(
            (item) => item.nodeId === name.slice(0, split),
          ),
          field = name.slice(split + 1);
        if (node && ["summary", "output", "status", "error"].includes(field))
          return String(
            field === "output"
              ? (node.outputValue ?? "")
              : (node[field as "summary" | "status" | "error"] ?? ""),
          );
      }
      return _match;
    });
  }
  private outputTemplate(
    value: unknown,
    label: string,
  ): unknown {
    try {
      return parseWorkflowAiOutput(text(value, label, 4000));
    } catch (error) {
      throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private outputMatchesTemplate(template: unknown, output: unknown): boolean {
    if (typeof template === "string")
      return template === "" && typeof output === "string";
    if (
      !template ||
      typeof template !== "object" ||
      Array.isArray(template) ||
      !output ||
      typeof output !== "object" ||
      Array.isArray(output)
    )
      return false;
    const expected = Object.entries(template as Record<string, unknown>),
      actual = output as Record<string, unknown>;
    return (
      expected.length === Object.keys(actual).length &&
      expected.every(
        ([key, value]) =>
          key in actual && this.outputMatchesTemplate(value, actual[key]),
      )
    );
  }
  private compactJson(value: unknown, max = 3000) {
    const source = JSON.stringify(value, null, 2);
    return source.length > max
      ? source.slice(0, max) + "\n...（内容过长，已截断）"
      : source;
  }
  private objectOutput(value?: string): Record<string, unknown> | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
    return undefined;
  }
  private upstreamInputs(
    definition: WorkflowDefinition,
    node: WorkflowNode,
    run: WorkflowRun,
  ) {
    const inputs: Record<string, unknown> = {};
    for (const sourceId of run.nodeInputSignals?.[node.id] || []) {
      const source = definition.nodes.find((item) => item.id === sourceId),
        sourceInput: Record<string, unknown> = {};
      if (source?.type === "data")
        for (const assignment of source.config.assignments) {
          const name = assignment.name.trim();
          const values = run.nodeVariables?.[source.id] || run.variables;
          if (name && values && Object.hasOwn(values,name))
            sourceInput[name] = values[name];
        }
      const sourceRun = [...run.nodeRuns]
        .reverse()
        .find(
          (item) =>
            item.nodeId === sourceId &&
            (item.status === "succeeded" || item.status === "failed") &&
            item.outputValue !== undefined,
        );
      inputs[sourceId] = workflowOutputData(sourceRun?.outputValue, sourceInput);
    }
    return inputs;
  }
  private classificationInput(
    definition: WorkflowDefinition,
    node: Extract<WorkflowNode, { type: "ai-judge" }>,
    run: WorkflowRun,
  ) {
    const expression = node.config.judgeInput?.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1];
    return expression ? this.templateReference(expression, definition, node, run) : undefined;
  }
  private agentPrompt(
    definition: WorkflowDefinition,
    node: Extract<WorkflowNode, { type: "agent" | "ai-judge" }>,
    run: WorkflowRun,
  ) {
    const inputs = this.upstreamInputs(definition, node, run),
      inputEntries = Object.entries(inputs),
      inputPrompt = inputEntries.length
        ? inputEntries.map(([sourceId, value]) => {
            const sourceRun = [...run.nodeRuns].reverse().find(item => item.nodeId === sourceId);
            const label = `${sourceRun?.nodeName || sourceId} / ${sourceRun?.branchName || "输出"}`;
            return `上游来源：${label}（${sourceId}）\n输入 JSON：\n${this.compactJson(value)}`;
          }).join("\n\n")
        : "输入 JSON：\n{}",
      context = {
        variables: run.variables || {},
        previousNodes: run.nodeRuns
          .filter((item) => item.nodeId !== node.id || item.status !== "running")
          .map((item) => ({
            id: item.nodeId,
            name: item.nodeName,
            type: item.type,
            status: item.status,
            summary: item.summary,
            error: item.error,
            branchId: item.branchId,
            branchName: item.branchName,
            output: item.outputValue,
            outputJson: this.objectOutput(item.outputValue),
          })),
      },
      expanded = this.render(node.config.instruction, run, { definition, node });
    if (node.type === "ai-judge" && node.config.judgeMode === "classify") {
      const value = this.classificationInput(definition, node, run),
        branches = (node.branches || []).map((branch, index) => ({
          order: index + 1,
          id: branch.id,
          name: branch.name,
          condition: branch.condition,
          uncertain: branch.id === node.config.unknownBranchId,
        }));
      return `你是工作流分类器。仅根据给定输入判断，不查询新信息，不执行任务，也不改写原始输入。
判断问题：${expanded}
输入字段：${node.config.judgeInput}
输入内容：${this.compactJson(value === undefined ? null : value, 9000)}
可选分支：${this.compactJson(branches, 5000)}
按 order 从小到大选择第一条明确成立的条件；输入缺失、信息含糊或无法确定时，选择 uncertain 为 true 的分支。
只返回 JSON 对象，且只能包含 branchId 和 reason 两个字符串字段。reason 简短说明依据，不要输出原始输入或其他字段。`;
    }
    if (node.config.branchMode !== "ai")
      return `${expanded}\n\n${inputPrompt}\n\n工作流上下文：\n${this.compactJson(context)}`;
    const branches = (node.branches || []).map((branch, index) => ({
        order: index + 1,
        id: branch.id,
        name: branch.name,
        judgement: branch.condition,
        outputFormat: workflowAiGeneratedTemplate(this.outputTemplate(
          branch.outputValue,
          `Agent“${node.name}”分支“${branch.name}”的输出内容`,
        )),
      })),
      protocol = `你正在执行工作流 Agent 节点“${node.name}”。必须严格遵守以下协议：
1. 先完成“任务要求”，再只根据“输出分支”的 judgement 判断方式选择分支。
2. 按输出分支 order 从小到大评估；选择第一条判断方式成立的分支。不得改写、放宽、忽略判断方式，不得编造未配置分支。
3. 如果没有任何判断方式成立，且没有 judgement 明确表示“始终 / 总是 / always / 默认 / 兜底”的分支，返回 {"branchId":"__NO_MATCH__","output":{}}。
4. 最终回答只能是一个 JSON 对象，不能包含 Markdown、解释、代码块或额外文字。
5. JSON 对象只能包含 branchId 和 output 两个属性。branchId 必须是所选分支 id；output 必须严格匹配该分支 outputFormat：属性名、层级、属性数量完全一致，所有叶子值都必须是字符串。固定值和引用字段由程序自动填入，不要自行添加。数组中的生成字段以索引键表示，根级空字符串使用 $value 字段。如果 outputFormat 为空对象，则 output 返回 {}。`;
    if (protocol.length > 6000)
      throw new Error(`Agent“${node.name}”的分支配置过长`);
    const fixed = `${protocol}\n\n${inputPrompt}\n\n工作流上下文：\n${this.compactJson(context)}\n\n输出分支：\n${this.compactJson(branches, 7000)}\n\n任务要求：\n`,
      room = 15800 - fixed.length;
    if (room < 1000)
      throw new Error(`Agent“${node.name}”的分支配置过长，请减少分支或输出字段`);
    return (
      fixed +
      (expanded.length > room
        ? expanded.slice(0, room) + "\n...（任务要求过长，已截断）"
        : expanded)
    );
  }
  private aiDecision(
    source: string,
    node: Extract<WorkflowNode, { type: "agent" | "ai-judge" }>,
  ) {
    let response: unknown;
    try {
      response = JSON.parse(
        source
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim(),
      );
    } catch {
      throw new Error(
        'AI 返回的结果不是有效 JSON；应只返回 {"branchId":"分支 ID","output":{...}}',
      );
    }
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("AI 返回的结果必须是 JSON 对象");
    const value = response as Record<string, unknown>,
      keys = Object.keys(value).sort();
    if (keys.join(",") !== "branchId,output")
      throw new Error("AI 返回 JSON 只能包含 branchId 和 output 两个属性");
    if (value.branchId === "__NO_MATCH__")
      throw new Error("AI 严格判断后没有命中任何输出分支");
    if (typeof value.branchId !== "string")
      throw new Error("AI 返回的 branchId 必须是字符串");
    const branch = node.branches?.find((item) => item.id === value.branchId);
    if (!branch) throw new Error("AI 返回了不存在的输出分支");
    if (!value.output || typeof value.output !== "object" || Array.isArray(value.output))
      throw new Error("AI 返回的 output 必须是 JSON 对象");
    const template = this.outputTemplate(
      branch.outputValue,
      `Agent“${node.name}”分支“${branch.name}”的输出内容`,
    );
    if (!this.outputMatchesTemplate(workflowAiGeneratedTemplate(template), value.output))
      throw new Error(`AI 返回的输出不符合分支“${branch.name}”的 JSON 格式`);
    return { branch, output: value.output as Record<string, unknown> };
  }
  private aiClassification(
    source: string,
    node: Extract<WorkflowNode, { type: "ai-judge" }>,
  ) {
    let response: unknown;
    try {
      response = JSON.parse(source.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
    } catch {
      throw new Error('AI 判断应只返回 {"branchId":"分支 ID","reason":"判断理由"}');
    }
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("AI 判断结果必须是 JSON 对象");
    const value = response as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "branchId,reason" ||
      typeof value.branchId !== "string" || typeof value.reason !== "string" ||
      !value.reason.trim() || value.reason.length > 1000)
      throw new Error("AI 判断结果只能包含有效的 branchId 和 reason 字符串");
    const branchId = value.branchId === "__NO_MATCH__" ? node.config.unknownBranchId : value.branchId;
    const branch = node.branches?.find(item => item.id === branchId);
    if (!branch) throw new Error("AI 返回了不存在的输出分支");
    return { branch, reason: value.reason.trim() };
  }
  private async execute(
    definition: WorkflowDefinition,
    runId: string,
    nodeId: string,
  ): Promise<void> {
    const run = this.runs(undefined, 2000).find((row) => row.id === runId);
    if (!run || run.status !== "running") return;
    const node = definition.nodes.find((item) => item.id === nodeId);
    if (!node) return this.fail(runId, "工作流节点不存在：" + nodeId);
    run.currentNodeId = node.id;
    const nodeRun: WorkflowNodeRun = {
      nodeId: node.id,
      nodeName: node.name,
      type: node.type,
      status: "running",
      startedAt: now(),
    };
    run.nodeRuns.push(nodeRun);
    this.trace(run, "info", `开始执行节点“${node.name}”`, node.id);
    this.persist(run);
    try {
      if (node.type === "agent" || node.type === "ai-judge") {
        if (node.type === "ai-judge" && node.config.judgeMode === "classify" &&
            this.classificationInput(definition, node, run) === undefined) {
          const branch = node.branches!.find(item => item.id === node.config.unknownBranchId)!;
          nodeRun.status = "succeeded";
          nodeRun.summary = "判断输入缺失";
          nodeRun.outputValue = JSON.stringify({ result: null, reason: "判断输入缺失" });
          nodeRun.finishedAt = now();
          this.persist(run);
          return this.advance(definition, run, node, true, branch);
        }
        const legacyModel =
            node.config.modelSource === "specified"
              ? node.config.model
              : await this.currentModel?.(),
          wantsLocal =
            node.config.modelRef?.source === "local" ||
            (!node.config.modelRef &&
              node.config.modelSource !== "specified" &&
              this.isLocalModel?.());
        if (wantsLocal && this.activeAgents.size) {
          run.nodeRuns.pop();
          this.pendingLocalAgents.push({ definition, runId, nodeId });
          this.trace(run, "info", `本地模型繁忙，节点“${node.name}”已进入执行队列`, node.id);
          this.persist(run);
          return;
        }
        const prompt = this.agentPrompt(definition, node, run),
          plan = this.prepareModel
            ? await this.prepareModel(node.config.modelRef, legacyModel)
            : { model: legacyModel || node.config.model || "" },
          workspace = path.join(this.directory, "workspaces", definition.id);
        if (node.type === "ai-judge" && node.config.judgeMode === "classify" && this.classify) {
          const model = plan.model || legacyModel || node.config.model;
          if (!model) throw new Error("当前连接尚未选择模型；请先选择可用模型");
          const controller = new AbortController();
          this.classifierControllers.set(run.id, controller);
          if (plan.label)
            this.trace(run, "info", `节点“${node.name}”使用当前模型：${plan.label}`, node.id);
          try {
            const answer = await this.classify(model, plan.connection, prompt, controller.signal);
            const current = this.runs(undefined, 2000).find((item) => item.id === run.id);
            if (!current || current.status !== "running") return;
            const currentNode = [...current.nodeRuns].reverse().find((item) => item.nodeId === node.id && item.status === "running");
            if (!currentNode) return;
            const input = this.classificationInput(definition, node, current);
            const decision = this.aiClassification(answer, node);
            currentNode.status = "succeeded";
            currentNode.branchId = decision.branch.id;
            currentNode.branchName = decision.branch.name;
            currentNode.summary = decision.reason;
            currentNode.outputValue = JSON.stringify({ result: input ?? null, reason: decision.reason });
            currentNode.finishedAt = now();
            this.persist(current);
            await this.advance(definition, current, node, true, decision.branch);
          } finally {
            this.classifierControllers.delete(run.id);
          }
          return;
        }
        fs.mkdirSync(workspace, { recursive: true });
        const result = this.agent.start(
            {
              projectless: true,
              workspace,
              hidden: true,
              mode: node.config.mode,
              model: (() => {
                const resolved = plan.model || legacyModel || node.config.model;
                if (!resolved)
                  throw new Error(
                    "当前连接尚未选择模型；请在模型连接设置中选择可用模型后重试",
                  );
                return resolved;
              })(),
              ...(plan.connection ? { connectionOverride: plan.connection } : {}),
              prompt,
              maxSteps: node.config.maxSteps,
              execution: node.config.execution,
              fastMode: node.config.fastMode,
              approvalMode: node.config.approvalMode,
            },
            0,
            (task) => this.agentUpdate(definition, run.id, node, task),
          );
        if (plan.label)
          this.trace(
            run,
            "info",
            `节点“${node.name}”使用${plan.source === "local" ? "本地" : plan.source === "remote" ? "远程" : "当前"}模型：${plan.label}`,
            node.id,
          );
        nodeRun.agentTaskId = result.id;
        run.agentTaskIds.push(result.id);
        this.activeAgents.set(run.id, result.id);
        this.persist(run);
        return;
      }
      if (node.type === "judge" || node.type === "predicate" || node.type === "switch") {
        validateDecision(node);
        const resolve = (expression: string) => this.templateReference(expression, definition, node, run);
        let branchId: string;
        if (node.type === "switch") {
          const value = typedDecisionValue(decisionValue(node.config.value, resolve), node.config.kind);
          branchId = node.config.cases.find(item => typedDecisionValue(item.value, node.config.kind) === value)?.branchId || node.config.defaultBranchId;
        } else {
          const results = node.config.rules.map(rule => evaluateRule(rule, resolve));
          const matched = node.config.mode === "all" ? results.every(Boolean) : results.some(Boolean);
          branchId = node.branches![matched ? 0 : 1].id;
        }
        const branch = node.branches!.find(item => item.id === branchId)!;
        nodeRun.status = "succeeded";
        nodeRun.summary = `判断结果：${branch.name}`;
        nodeRun.finishedAt = now();
        this.persist(run);
        return this.advance(definition, run, node, true, branch);
      }
      if (node.type === "condition") {
        const source = run.nodeRuns.find(
            (item) => item.nodeId === node.config.sourceNodeId,
          ),
          matched = source?.status === node.config.operator;
        nodeRun.status = "succeeded";
        nodeRun.summary = matched ? "条件成立" : "条件不成立";
        nodeRun.finishedAt = now();
        this.persist(run);
        return this.advance(definition, run, node, matched);
      }
      if (node.type === "route") {
        const source = run.nodeRuns.find(
            (item) => item.nodeId === node.config.sourceNodeId,
          ),
          success = source?.status === "succeeded",
          branch = node.branches?.find((item) =>
            this.branchMatches(item, success, source, run),
          );
        nodeRun.status = "succeeded";
        nodeRun.summary = branch ? `路由到“${branch.name}”` : "没有匹配的路由";
        nodeRun.finishedAt = now();
        this.persist(run);
        return this.advance(definition, run, node, true, branch || null);
      }
      if (node.type === "data") {
        if ((node.branches?.length || 0) > 1)
          throw new Error(`数据变量节点“${node.name}”请保留一个输出分支，可连接多个下游节点`);
        run.variables = run.variables || {};
        run.nodeVariables ||= {};
        const values: Record<string,string> = Object.create(null);
        run.nodeVariables[node.id] = values;
        for (const assignment of node.config.assignments) {
          const value = this.render(assignment.value, run, { definition, node });
          values[assignment.name] = value;
          // Legacy global expressions keep their previous behavior.
          run.variables[assignment.name] = value;
        }
        nodeRun.status = "succeeded";
        nodeRun.summary = `已设置 ${node.config.assignments.length} 个变量`;
        nodeRun.finishedAt = now();
        this.persist(run);
        return this.advance(definition, run, node, true);
      }
      if (node.type === "join") {
        if (node.branches?.length !== 1)
          throw new Error(`汇合节点“${node.name}”必须有且只有一个输出分支，可连接多个下游节点`);
        const branch = node.branches?.[0];
        if (branch)
          nodeRun.outputValue = renderWorkflowJsonTemplate(branch.outputValue, expression =>
            this.templateReference(expression, definition, node, run), false,
          );
        nodeRun.status = "succeeded";
        nodeRun.summary = `已汇合 ${(run.nodeInputSignals?.[node.id] || []).length} 个输入`;
        nodeRun.finishedAt = now();
        this.persist(run);
        return this.advance(definition, run, node, true);
      }
      if (node.type === "approval") {
        nodeRun.status = 'waiting';
        nodeRun.summary = this.render(node.config.prompt,run,{definition,node});
        const wait = node.config.wait;
        const deadline = wait?.mode === 'duration' ? new Date(Date.now()+wait.durationMinutes!*60_000).toISOString() : wait?.mode === 'until' ? wait.deadline : undefined;
        nodeRun.approval = {title:this.render(node.config.title || node.name,run,{definition,node}),approveLabel:node.config.approveLabel,rejectLabel:node.config.rejectLabel,...(deadline ? {deadline} : {}),onTimeout:wait?.onTimeout || 'reject'};
        this.persist(run);this.scheduleApproval(run,nodeRun);
        return this.continueRun(definition,run);
      }
      if (node.type === "end") {
        const summary = this.render(node.config.summary,run,{definition,node}) || (node.config.status === 'succeeded' ? '成功结束' : '失败结束');
        const result = node.config.resultJson?.trim() ? renderWorkflowJsonTemplate(node.config.resultJson,expression=>this.templateReference(expression,definition,node,run),false) : undefined;
        nodeRun.status = node.config.status;nodeRun.summary = summary;nodeRun.outputValue = result;nodeRun.finishedAt = now();
        if (node.config.status === 'failed') nodeRun.error = summary;
        run.summary = summary;
        this.persist(run);
        const scope = node.config.scope || (node.config.status === 'failed' ? 'workflow' : 'path');
        if (scope === 'workflow') {
          run.status = node.config.status;run.finishedAt = now();
          if (run.status === 'failed') run.error = summary;
          else run.error = undefined;
          return this.finish(run);
        }
        return this.continueRun(definition,run);
      }
      if (!this.notify && node.config.fixedBranches) throw new Error("桌面通知服务不可用");
      const notified = this.notify?.(
        this.render(node.config.title, run, { definition, node }),
        this.render(node.config.body, run, { definition, node }),
      );
      if (notified === false) throw new Error("当前系统不支持桌面通知");
      nodeRun.status = "succeeded";
      nodeRun.summary = "系统通知已提交";
      nodeRun.finishedAt = now();
      this.persist(run);
      return this.advance(definition, run, node, true);
    } catch (error) {
      nodeRun.status = "failed";
      nodeRun.error = String(error);
      nodeRun.finishedAt = now();
      this.persist(run);
      return this.advance(definition, run, node, false);
    }
  }
  private agentUpdate(
    definition: WorkflowDefinition,
    runId: string,
    node: WorkflowNode,
    task: AgentTask,
  ) {
    if (["running", "waiting"].includes(task.status)) return;
    const run = this.runs(undefined, 2000).find((row) => row.id === runId);
    if (!run || run.status !== "running" || (node.type !== "agent" && node.type !== "ai-judge")) return;
    this.activeAgents.delete(runId);
    this.launchNextLocalAgent();
    const nodeRun = [...run.nodeRuns]
      .reverse()
      .find((item) => item.nodeId === node.id && item.status === "running");
    if (!nodeRun) return;
    const success = task.status === "completed",
      answer = [...task.events]
        .reverse()
        .find(
          (event) =>
            event.kind === "assistant" &&
            event.text &&
            !event.text.startsWith("本次模型未调用工具"),
        )
        ?.text || "";
    nodeRun.error = task.error || undefined;
    nodeRun.summary = answer.slice(0, 2000);
    if (success && node.type === "ai-judge" && node.config.judgeMode === "classify")
      try {
        const input = this.classificationInput(definition, node, run),
          decision = input === undefined
            ? { branch: node.branches!.find(branch => branch.id === node.config.unknownBranchId)!, reason: "判断输入缺失" }
            : this.aiClassification(answer, node);
        nodeRun.status = "succeeded";
        nodeRun.branchId = decision.branch.id;
        nodeRun.branchName = decision.branch.name;
        nodeRun.summary = decision.reason;
        nodeRun.outputValue = JSON.stringify({ result: input ?? null, reason: decision.reason });
        nodeRun.finishedAt = now();
        this.persist(run);
        void this.advance(definition, run, node, true, decision.branch);
        return;
      } catch (error) {
        this.agent.logModelConversation(task.id, error, this.log ? message=>this.log!("error", `[工作流 ${definition.name} / 节点 ${node.name} / 运行 ${run.id}] ${message}`) : undefined);
        nodeRun.status = "failed";
        nodeRun.error = String(error);
        nodeRun.finishedAt = now();
        this.persist(run);
        this.fail(run.id, String(error));
        return;
      }
    if (success && node.config.branchMode === "ai")
      try {
        const decision = this.aiDecision(answer, node);
        nodeRun.status = "succeeded";
        nodeRun.branchId = decision.branch.id;
        nodeRun.branchName = decision.branch.name;
        const template = this.outputTemplate(decision.branch.outputValue, `分支“${decision.branch.name}”的输出内容`);
        nodeRun.outputValue = JSON.stringify(assembleWorkflowAiOutput(template, decision.output,
          expression => this.templateReference(expression, definition, node, run)));
        nodeRun.summary = nodeRun.outputValue;
        nodeRun.finishedAt = now();
        this.persist(run);
        void this.advance(definition, run, node, true, decision.branch);
        return;
      } catch (error) {
        this.agent.logModelConversation(task.id, error, this.log ? message=>this.log!("error", `[工作流 ${definition.name} / 节点 ${node.name} / 运行 ${run.id}] ${message}`) : undefined);
        nodeRun.status = "failed";
        nodeRun.error = String(error);
        nodeRun.finishedAt = now();
        this.persist(run);
        this.fail(run.id, String(error));
        return;
      }
    nodeRun.status = success ? "succeeded" : "failed";
    if (success && node.type === "agent" && node.config.branchMode === "direct")
      nodeRun.outputValue = JSON.stringify({ result: answer });
    nodeRun.finishedAt = now();
    this.persist(run);
    void this.advance(definition, run, node, success,
      node.type === "agent" && node.config.branchMode === "direct"
        ? (success ? node.branches?.[0] : null)
        : undefined);
  }
  private launchNextLocalAgent() {
    if (this.activeAgents.size) return;
    while (this.pendingLocalAgents.length) {
      const next = this.pendingLocalAgents.shift()!;
      const run = this.runs(undefined, 2000).find((item) => item.id === next.runId);
      if (!run || run.status !== "running") continue;
      this.trace(run, "info", "本地模型已空闲，开始执行排队节点", next.nodeId);
      this.persist(run);
      void this.execute(next.definition, next.runId, next.nodeId);
      return;
    }
  }
  private incomingSources(definition: WorkflowDefinition, nodeId: string) {
    return [
      ...new Set(
        definition.nodes
          .filter((source) =>
            source.branches?.some((branch) =>
              branch.targetNodeIds?.includes(nodeId),
            ),
          )
          .map((source) => source.id),
      ),
    ];
  }
  private inputReady(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    node: WorkflowNode,
  ) {
    if (node.type === "ai-judge" && node.config.judgeMode === "classify") {
      const sourceId = node.config.judgeInput?.match(/^\{\{\s*input\.([^.{}\s]+)/)?.[1];
      return !!sourceId && (run.nodeInputSignals?.[node.id] || []).includes(sourceId);
    }
    const mode =
      node.type === "join"
        ? node.config.mode
        : (node.type === "agent" || node.type === "ai-judge")
          ? node.config.inputSignalMode || "all"
          : "any";
    if (mode === "any") return true;
    const expected = this.incomingSources(definition, node.id);
    if (expected.length < 2) return true;
    const received = new Set(run.nodeInputSignals?.[node.id] || []);
    return expected.every((source) => received.has(source));
  }
  private continueRun(definition: WorkflowDefinition, run: WorkflowRun) {
    const active = run.nodeRuns.find(item=>item.status === 'running');
    if (active) {
      const terminal = run.pendingNodeIds?.find(id=>definition.nodes.some(node=>node.id === id && node.type === 'end' && node.config.scope === 'workflow'));
      if (terminal) {run.pendingNodeIds = run.pendingNodeIds!.filter(id=>id !== terminal);this.persist(run);return this.execute(definition,run.id,terminal);}
      run.currentNodeId = active.nodeId;this.persist(run);return;
    }
    const queuedAgent = this.pendingLocalAgents.find(item=>item.runId === run.id);
    if (queuedAgent) { run.currentNodeId = queuedAgent.nodeId;this.persist(run);return; }
    while (run.pendingNodeIds?.length) {
      const next = run.pendingNodeIds.shift()!;
      if (run.nodeRuns.some((item) => item.nodeId === next)) continue;
      this.persist(run);
      return this.execute(definition, run.id, next);
    }
    const approval = run.nodeRuns.find(item=>item.type === 'approval' && item.status === 'waiting');
    if (approval) {
      run.status = 'waiting';run.currentNodeId = approval.nodeId;
      this.pauseExecutionClock(run);this.persist(run);return;
    }
    const waiting = definition.nodes.find(
      (node) =>
        (node.type === "agent" || node.type === "ai-judge" || node.type === "join") &&
        !run.nodeRuns.some((item) => item.nodeId === node.id) &&
        (run.nodeInputSignals?.[node.id]?.length || 0) > 0 &&
        !this.inputReady(definition, run, node),
    );
    if (waiting) {
      const received = new Set(run.nodeInputSignals?.[waiting.id] || []),
        expected = waiting.type === "ai-judge" && waiting.config.judgeMode === "classify"
          ? [waiting.config.judgeInput!.match(/^\{\{\s*input\.([^.{}\s]+)/)![1]]
          : this.incomingSources(definition, waiting.id),
        missing = expected
          .filter((source) => !received.has(source))
          .map(
            (id) => definition.nodes.find((node) => node.id === id)?.name || id,
          );
      return this.fail(
        run.id,
        `${waiting.type === "join" ? "汇合" : "Agent"}“${waiting.name}”正在等待全部输入，缺少：${missing.join("、")}`,
      );
    }
    const failedEnds = run.nodeRuns.filter(item=>item.type === 'end' && item.status === 'failed');
    run.status = failedEnds.length ? 'failed' : 'succeeded';
    if (failedEnds.length) run.error = failedEnds.map(item=>`${item.nodeName}：${item.summary}`).join('；');
    run.finishedAt = now();
    run.currentNodeId = undefined;
    run.summary =
      [...run.nodeRuns].reverse().find(item=>item.type === "end")?.summary ||
      [...run.nodeRuns]
        .reverse()
        .find((item) => item.outputValue || item.summary)?.outputValue ||
      [...run.nodeRuns].reverse().find((item) => item.summary)?.summary ||
      "工作流执行完成";
    this.finish(run);
  }
  private async advance(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    node: WorkflowNode,
    success: boolean,
    selectedBranch?: WorkflowBranch | null,
  ) {
    if (run.status !== "running") return;
    if ((node.type === "join" || node.type === "data" || isDecision(node.type)) && !success)
      return this.fail(run.id, run.nodeRuns.at(-1)?.error || `节点“${node.name}”输出失败`);
    const nodeRun = [...run.nodeRuns].reverse().find(item=>item.nodeId === node.id),
      branch =
        node.type === "notify" && node.config.fixedBranches
          ? node.branches?.[success ? 0 : 1]
          : node.type === "join" || node.type === "data"
          ? node.branches?.[0]
          : selectedBranch === null
          ? undefined
          : selectedBranch ||
            node.branches?.find((item) =>
              this.branchMatches(item, success, nodeRun, run),
            );
    if (branch && nodeRun) {
      nodeRun.branchId = branch.id;
      nodeRun.branchName = branch.name;
      if (
        branch.outputValue &&
        node.type !== "join" &&
        !((node.type === "agent" || node.type === "ai-judge") &&
          (node.config.branchMode === "ai" || node.config.branchMode === "direct"))
      ) {
        try {
          nodeRun.outputValue = renderWorkflowJsonTemplate(branch.outputValue,
            expression => this.templateReference(expression, definition, node, run), false);
        } catch (error) {
          nodeRun.status = "failed";
          nodeRun.error = String(error);
          this.persist(run);
          return this.fail(run.id, nodeRun.error);
        }
        if (node.type !== "notify") nodeRun.summary = nodeRun.outputValue;
      }
      const queued = new Set([
        ...(run.pendingNodeIds || []),
        ...run.nodeRuns.map((item) => item.nodeId),
      ]);
      run.pendingNodeIds = run.pendingNodeIds || [];
      run.nodeInputSignals = run.nodeInputSignals || {};
      for (const targetId of branch.targetNodeIds || []) {
        const signals = run.nodeInputSignals[targetId] || [];
        if (!signals.includes(node.id)) signals.push(node.id);
        run.nodeInputSignals[targetId] = signals;
        const target = definition.nodes.find((item) => item.id === targetId);
        if (
          target &&
          this.inputReady(definition, run, target) &&
          !queued.has(targetId)
        ) {
          run.pendingNodeIds.push(targetId);
          queued.add(targetId);
        }
      }
      this.persist(run);
    }
    if (node.branches?.length && !branch)
      return this.fail(run.id, `节点“${node.name}”没有命中任何分支`);
    if (!success && !branch)
      return this.fail(run.id, nodeRun?.error || `节点“${node.name}”执行失败`);
    return this.continueRun(definition, run);
  }
  private fail(runId: string, error: string) {
    const run = this.runs(undefined, 2000).find((row) => row.id === runId);
    if (!run || !["running", "waiting"].includes(run.status)) return;
    run.status = "failed";
    run.error = error;
    run.finishedAt = now();
    const node = [...run.nodeRuns]
      .reverse()
      .find((item) => item.status === "running");
    if (node) {
      node.status = "failed";
      node.error = error;
      node.finishedAt = now();
    }
    this.finish(run);
  }
  private persist(run: WorkflowRun) {
    const rows = this.runs(undefined, 2000);
    const index = rows.findIndex((row) => row.id === run.id);
    if (index >= 0) rows[index] = run;
    else rows.push(run);
    this.writeRuns(rows);
    this.emit(run);
  }
  private finish(run: WorkflowRun) {
    this.classifierControllers.get(run.id)?.abort();
    this.classifierControllers.delete(run.id);
    run.currentNodeId = undefined;
    run.pendingNodeIds = [];
    for (let index = this.pendingLocalAgents.length-1;index>=0;index--) if (this.pendingLocalAgents[index].runId === run.id) this.pendingLocalAgents.splice(index,1);
    for (const item of run.nodeRuns) if (item.status === 'running') {item.status = 'skipped';item.finishedAt = now();}
    this.persist(run);
    const agentId = this.activeAgents.get(run.id);
    this.activeAgents.delete(run.id);
    if (agentId) { try {this.agent.stop(agentId,0);} catch {} }
    this.launchNextLocalAgent();
    for (const [key,timer] of this.approvalTimers) if (key.startsWith(`${run.id}:`)) {clearTimeout(timer);this.approvalTimers.delete(key);}
    for (const item of run.nodeRuns) if (item.status === 'waiting') {item.status = 'skipped';item.finishedAt = now();}
    const timeout = this.timeouts.get(run.id);
    if (timeout) clearTimeout(timeout);
    this.timeouts.delete(run.id);
    this.activeAgents.delete(run.id);
    const level =
        run.status === "succeeded"
          ? "info"
          : run.status === "cancelled"
            ? "warn"
            : "error",
      message =
        run.status === "succeeded"
          ? "执行成功"
          : run.status === "cancelled"
            ? "已取消"
            : `执行失败${run.error ? "；" + run.error : ""}`;
    this.trace(run, level, message);
    this.persist(run);
    this.callbacks.delete(run.id);
  }
  private emit(run: WorkflowRun) {
    this.callbacks.get(run.id)?.(structuredClone(run));
  }
  private recover() {
    const rows = this.runs(undefined, 2000);
    let changed = false;
    for (const run of rows)
      if (["running", "waiting"].includes(run.status)) {
        if (run.status === 'waiting' && run.nodeRuns.some(item=>item.type === 'approval' && item.status === 'waiting') && this.runDefinition(run)) {
          for (const item of run.nodeRuns) if (item.type === 'approval' && item.status === 'waiting') this.scheduleApproval(run,item);
          continue;
        }
        run.status = "failed";
        run.error = "应用在执行期间关闭，结果未确认；不会自动重放。";
        run.finishedAt = now();
        changed = true;
      }
    if (changed) this.writeRuns(rows);
  }
  dispose() {
    for (const controller of this.classifierControllers.values()) controller.abort();
    this.classifierControllers.clear();
    for (const run of this.runs(undefined, 2000).filter((row) =>
      row.status === "running",
    ))
      this.cancel(run.id);
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
    this.callbacks.clear();
  }
}
