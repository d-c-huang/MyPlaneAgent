/**
 * Capability Registry
 * 能力注册中心，统一管理所有可用能力（Skill Tools + MCP Tools）
 */

import type {
  Capability,
  CapabilityExecutionRequest,
  CapabilityExecutionResult,
  CapabilityQueryOptions,
  CapabilityStats
} from '../../../shared/types/index.js'
import type { SkillPlatform } from './skill-platform.js'
import type { MCPAdapter } from './mcp-adapter.js'
import { validateToolArguments } from './execution-guards.js'
import {ExecutionRuntime} from './execution-runtime.js'
import {searchRegion} from '../search-engines.js'
import type {SearchHealth} from '../search-health.js'
import {capabilityFingerprint} from './tool-surface.js'
import type {CapabilityAdmission} from '../../../shared/types/capability.js'

export class CapabilityRegistry {
  private executionRuntime=new ExecutionRuntime()
  setExecutionRuntime(runtime:ExecutionRuntime){this.executionRuntime=runtime}
  executeFileCheck(request:CapabilityExecutionRequest,signal:AbortSignal,check:()=>Promise<CapabilityExecutionResult>) {
    const capability:Capability={name:'runtime.check_file',category:'runtime',description:'宿主机文件验收',parameters:{type:'object'},source:{type:'builtin'},runtime:'builtin',permissions:['fileSystem:read']}
    return this.executionRuntime.execute(capability,{...request,capability:capability.name},signal,check)
  }
  private searchHealth?:SearchHealth
  setSearchHealth(health:SearchHealth){this.searchHealth=health}
  private capabilities = new Map<string, Capability>()
  private revisions=new Map<string,number>()
  private nextRevision=0
  admit(capability:Capability):CapabilityAdmission|undefined{
    const current=this.capabilities.get(capability.name)
    if(!current||!this.available(capability.name)||capabilityFingerprint(current)!==capabilityFingerprint(capability))return
    return {revision:this.revisions.get(capability.name)!,fingerprint:capabilityFingerprint(current)}
  }
  private available(name:string):boolean{try{return this.builtinHandlers.get(name)?.available()!==false}catch{return false}}
  private admissionChanged():CapabilityExecutionResult{return {success:false,outcome:'failed',failureCode:'conflict',admissionRejected:true,error:'工具定义或提供者已变化，本次未调用新提供者；请使用本轮最新工具列表重新生成调用。',elapsedMs:0}}
  private builtinHandlers = new Map<string, {run:(args:Record<string,unknown>,signal:AbortSignal,workspace?:string,request?:CapabilityExecutionRequest)=>Promise<unknown>;available:()=>boolean}>()
  registerBuiltin(capability:Capability,run:(args:Record<string,unknown>,signal:AbortSignal,workspace?:string,request?:CapabilityExecutionRequest)=>Promise<unknown>,available:()=>boolean=()=>true){
    this.register(capability);this.builtinHandlers.set(capability.name,{run,available})
  }

  constructor(
    private skillPlatform: SkillPlatform,
    private mcpAdapter?: MCPAdapter
  ) {}

  /**
   * 初始化：从 Skill Platform 和 MCP Adapter 加载能力
   */
  async initialize(): Promise<void> {
    console.log('[CapabilityRegistry] Initializing...')

    // 从 Skills 加载能力
    await this.loadFromSkills()

    // 从 MCP 加载能力
    if (this.mcpAdapter) {
      await this.loadFromMCP()
    }

    console.log(`[CapabilityRegistry] Loaded ${this.capabilities.size} capabilities`)
  }

  /**
   * 从 MCP Adapter 加载能力
   */
  async loadFromMCP(): Promise<void> {
    if (!this.mcpAdapter) return

    const mcpCapabilities = this.mcpAdapter.getAllCapabilities()

    for (const capability of mcpCapabilities) {
      this.register(capability)
    }
  }

  refreshMCP(): void {
    const incoming=new Map((this.mcpAdapter?.getAllCapabilities()||[]).map(capability=>[capability.name,capability]))
    for (const [name, capability] of this.capabilities) {
      if (capability.source.type === 'mcp'&&!incoming.has(name))this.unregister(name)
    }
    for (const capability of incoming.values()){
      const current=this.capabilities.get(capability.name)
      if(!current||capabilityFingerprint(current)!==capabilityFingerprint(capability))this.register(capability)
    }
  }

  /**
   * 从 Skill Platform 加载能力
   */
  async loadFromSkills(): Promise<void> {
    const tools = this.skillPlatform.getAllTools()

    for (const { skillId, skillName, category, tool } of tools) {
      const skill = this.skillPlatform.get(skillId)
      if (!skill) continue

      const capabilityName = `${category}.${tool.name}`

      this.register({
        name: capabilityName,
        category,
        description: `[${skillName}] ${tool.description}`,
        parameters: tool.parameters,
        returns: tool.returns,
        source: {
          type: 'skill',
          skillId
        },
        runtime: 'python-native',
        permissions: this.extractPermissions(skill.manifest.permissions),
        examples: tool.examples,
        tags: [skillId, category, ...(tool.risk !== 'read' ? ['requires-approval', `risk:${tool.risk || 'high'}`] : [])]
      })
    }
  }

  /**
   * 提取权限列表
   */
  private extractPermissions(permissions: any): string[] {
    const perms: string[] = []

    if (permissions.fileSystem?.read) {
      perms.push('fileSystem:read')
    }
    if (permissions.fileSystem?.write) {
      perms.push('fileSystem:write')
    }
    if (permissions.network) {
      perms.push('network')
    }
    if (permissions.process) {
      perms.push('process')
    }

    return perms
  }

  /**
   * 注册能力
   */
  register(capability: Capability): void {
    if (this.capabilities.has(capability.name)) {
      console.warn(`[CapabilityRegistry] Overwriting capability: ${capability.name}`)
    }

    this.capabilities.set(capability.name, capability)
    this.builtinHandlers.delete(capability.name)
    this.revisions.set(capability.name,++this.nextRevision)
    console.log(`[CapabilityRegistry] Registered: ${capability.name}`)
  }

  /**
   * 取消注册能力
   */
  unregister(name: string): void {
    if (this.capabilities.delete(name)) {
      this.builtinHandlers.delete(name)
      this.revisions.delete(name)
      console.log(`[CapabilityRegistry] Unregistered: ${name}`)
    }
  }

  /**
   * 获取能力
   */
  get(name: string): Capability | undefined {
    return this.capabilities.get(name)
  }

  /**
   * 列出能力
   */
  list(options?: CapabilityQueryOptions): Capability[] {
    let capabilities = Array.from(this.capabilities.values()).filter(capability=>this.available(capability.name))

    // 按分类过滤
    if (options?.category) {
      capabilities = capabilities.filter(c => c.category === options.category)
    }

    // 按运行时过滤
    if (options?.runtime) {
      capabilities = capabilities.filter(c => c.runtime === options.runtime)
    }

    // 按标签过滤
    if (options?.tags && options.tags.length > 0) {
      capabilities = capabilities.filter(c =>
        options.tags!.some(tag => c.tags?.includes(tag))
      )
    }

    // 关键词搜索
    if (options?.search) {
      const search = options.search.toLowerCase()
      capabilities = capabilities.filter(c =>
        c.name.toLowerCase().includes(search) ||
        c.description.toLowerCase().includes(search) ||
        c.category.toLowerCase().includes(search)
      )
    }

    return capabilities
  }

  /**
   * 按分类分组
   */
  groupByCategory(): Record<string, Capability[]> {
    const groups: Record<string, Capability[]> = {}

    for (const capability of this.capabilities.values()) {
      if (!groups[capability.category]) {
        groups[capability.category] = []
      }
      groups[capability.category].push(capability)
    }

    return groups
  }

  /**
   * 执行能力
   */
  async execute(
    request: CapabilityExecutionRequest,
    signal: AbortSignal
  ): Promise<CapabilityExecutionResult> {
    const capability = this.capabilities.get(request.capability)

    if (!capability) {
      if(request.admission)return this.admissionChanged()
      return {
        success: false,
        error: `Capability not found: ${request.capability}`,
        elapsedMs: 0
      }
    }

    const admission=request.admission??this.admit(capability)
    const matches=()=>{
      const current=this.capabilities.get(capability.name)
      return !!admission&&!!current&&this.available(capability.name)&&this.revisions.get(capability.name)===admission.revision&&capabilityFingerprint(current)===admission.fingerprint
    }
    const changed=()=>this.admissionChanged()
    if(!matches())return changed()
    // Own the arguments and execution envelope before resource queues or user callbacks yield.
    const executionRequest={...request,args:structuredClone(request.args),context:request.context?{...request.context}:undefined,execution:request.execution?{...request.execution}:undefined,admission:{...admission!}}
    const definition=structuredClone(capability)
    return this.executionRuntime.execute(definition,executionRequest,signal,()=>matches()?this.executeDirect(definition,executionRequest,signal,matches):Promise.resolve(changed()))
  }

  private async executeDirect(capability:Capability,request:CapabilityExecutionRequest,signal:AbortSignal,admitted:()=>boolean):Promise<CapabilityExecutionResult> {
    const startTime = Date.now()

    try {
      signal.throwIfAborted()
      validateToolArguments(capability.parameters, request.args)
      let output: unknown

      // 根据运行时路由执行
      if (capability.runtime === 'python-native') {
        // 通过 Skill Platform 执行
        if (capability.source.type !== 'skill') {
          throw new Error('Invalid source type for python-native runtime')
        }

        const [category, toolName] = request.capability.split('.')

        output = await this.skillPlatform.executeTool(
          capability.source.skillId,
          toolName,
          request.args,
          signal,
          request.workspace,
          capability.source.skillId==='agent-tools'&&toolName==='web_search'?{...request.context,searchRouting:this.searchHealth?.routing(searchRegion())??searchRegion()}:request.context
        )

      } else if (capability.runtime === 'mcp') {
        // 通过 MCP Adapter 执行
        if (!this.mcpAdapter) {
          throw new Error('MCP Adapter not available')
        }

        return await this.mcpAdapter.execute(request, signal)

      } else if (capability.runtime === 'builtin') {
        const handler=this.builtinHandlers.get(capability.name)
        if(!handler||!handler.available())throw new Error('插件未启用或能力不可用')
        signal.throwIfAborted()
        if(!admitted())return this.admissionChanged()
        output=await handler.run(request.args,signal,request.workspace,request)
        signal.throwIfAborted()

      } else {
        throw new Error(`Unknown runtime: ${capability.runtime}`)
      }

      if(request.capability==='agent.web_search')this.searchHealth?.observe(output)
      return {
        success: true,
        output,
        elapsedMs: Date.now() - startTime,
        metadata: {
          runtime: capability.runtime,
          source: capability.source
        }
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startTime,
        metadata: {
          runtime: capability.runtime,
          source: capability.source
        }
      }
    }
  }

  /**
   * 重新加载能力（从 Skill Platform）
   */
  async reload(): Promise<void> {
    console.log('[CapabilityRegistry] Reloading capabilities...')

    // 清除所有 Skill 来源的能力
    const toRemove: string[] = []
    for (const [name, capability] of this.capabilities) {
      if (capability.source.type === 'skill') {
        toRemove.push(name)
      }
    }

    for (const name of toRemove) {
      this.unregister(name)
    }

    // 重新加载
    await this.loadFromSkills()

    console.log(`[CapabilityRegistry] Reloaded ${this.capabilities.size} capabilities`)
  }

  /**
   * 获取统计信息
   */
  getStats(): CapabilityStats {
    const capabilities = this.list()

    const byCategory: Record<string, number> = {}
    const byRuntime: Record<string, number> = {}
    const bySource: Record<string, number> = {}

    for (const capability of capabilities) {
      // 按分类统计
      byCategory[capability.category] = (byCategory[capability.category] || 0) + 1

      // 按运行时统计
      byRuntime[capability.runtime] = (byRuntime[capability.runtime] || 0) + 1

      // 按来源统计
      const sourceKey = capability.source.type === 'skill'
        ? `skill:${capability.source.skillId}`
        : capability.source.type === 'mcp'
        ? `mcp:${capability.source.serverId}`
        : 'builtin'

      bySource[sourceKey] = (bySource[sourceKey] || 0) + 1
    }

    return {
      total: capabilities.length,
      byCategory,
      byRuntime: byRuntime as Record<any, number>,
      bySource
    }
  }

  /**
   * 检查能力是否存在
   */
  has(name: string): boolean {
    return this.capabilities.has(name)
  }

  /**
   * 查找相似能力（模糊匹配）
   */
  findSimilar(query: string, limit = 5): Capability[] {
    const queryLower = query.toLowerCase()
    const scored: Array<{ capability: Capability; score: number }> = []

    for (const capability of this.capabilities.values()) {
      let score = 0

      // 名称完全匹配
      if (capability.name.toLowerCase() === queryLower) {
        score += 100
      }
      // 名称包含
      else if (capability.name.toLowerCase().includes(queryLower)) {
        score += 50
      }

      // 描述包含
      if (capability.description.toLowerCase().includes(queryLower)) {
        score += 20
      }

      // 分类匹配
      if (capability.category.toLowerCase() === queryLower) {
        score += 30
      }

      if (score > 0) {
        scored.push({ capability, score })
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.capability)
  }
}
