/**
 * Python Runtime Manager
 * 管理 Python Worker 进程池，负责 Skill 执行
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import type {
  ExecutionRequest,
  ExecutionResponse,
  WorkerInfo,
  WorkerStatus,
  RuntimeConfig,
  RuntimeStats,
  IpcMessage
} from '../../../shared/types/index.js'

type PendingRequest = {
  resolve: (value: ExecutionResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type Worker = {
  skillId: string
  process: ChildProcessWithoutNullStreams
  venvPath: string | null
  status: WorkerStatus
  pending: Map<string, PendingRequest>
  createdAt: number
  lastUsed: number
  stopping?: Promise<void>
}

export class PythonRuntimeManager {
  private workers = new Map<string, Worker>()
  private executionQueues = new Map<string, Promise<void>>()
  private disposed=false
  private cleanupTimer: NodeJS.Timeout
  private config: RuntimeConfig
  private stats = {
    totalExecutions: 0,
    totalElapsedMs: 0,
    totalErrors: 0
  }

  constructor(
    private dataDir: string,
    config?: Partial<RuntimeConfig>
  ) {
    this.config = {
      maxWorkers: config?.maxWorkers ?? 8,
      idleTimeout: config?.idleTimeout ?? 5 * 60 * 1000,  // 5 分钟
      defaultTimeout: config?.defaultTimeout ?? 60000,     // 60 秒
      pythonExecutable: config?.pythonExecutable,
      venvDir: config?.venvDir ?? path.join(dataDir, 'venvs')
    }

    // 确保 venv 目录存在
    fs.mkdirSync(this.config.venvDir!, { recursive: true })

    // 定期清理空闲 Worker
    this.cleanupTimer = setInterval(() => this.cleanupIdleWorkers(), 60000)
    this.cleanupTimer.unref()
  }

  /**
   * 执行 Skill Tool
   */
  async execute(
    request: ExecutionRequest,
    signal: AbortSignal
  ): Promise<ExecutionResponse> {
    // The Python protocol handles one request at a time. Serialize access to a
    // shared skill process so cancelling one caller cannot kill a peer's work.
    signal.throwIfAborted()
    if(this.disposed)throw new Error('Runtime disposed')
    const previous=this.executionQueues.get(request.skillId)??Promise.resolve()
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const tail=previous.then(()=>gate)
    this.executionQueues.set(request.skillId,tail)
    let abort!:()=>void
    const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason??new Error('Task cancelled'));signal.addEventListener('abort',abort,{once:true})})
    try{
      await Promise.race([previous,cancelled])
      signal.throwIfAborted()
      if(this.disposed)throw new Error('Runtime disposed')
      return await this.executeRequest(request,signal)
    }finally{
      signal.removeEventListener('abort',abort)
      void previous.then(()=>{release();if(this.executionQueues.get(request.skillId)===tail)this.executionQueues.delete(request.skillId)})
    }
  }

  private async executeRequest(request:ExecutionRequest,signal:AbortSignal):Promise<ExecutionResponse>{
    signal.throwIfAborted()

    const timeoutMs = request.timeout ?? this.config.defaultTimeout

    // 获取或创建 Worker
    let worker = this.workers.get(request.skillId)

    if (!worker || worker.status === 'error' || worker.status === 'stopped') {
      if(worker)await this.stopWorkerProcess(worker)
      worker = await this.createWorker(request,signal)
    }
    if(signal.aborted||this.disposed){await this.stopWorker(request.skillId);signal.throwIfAborted();throw new Error('Runtime disposed')}

    worker.lastUsed = Date.now()
    worker.status = 'busy'

    // 发送执行请求
    const requestId = randomUUID()
    let abort:(()=>void)|undefined,stopping:Promise<void>|undefined

    try {
      const response = await new Promise<ExecutionResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker!.pending.delete(requestId)
          worker!.status = 'error'
          stopping=this.stopWorker(request.skillId)
          reject(new Error(`Execution timeout: ${request.skillId}.${request.tool}`))
        }, timeoutMs)

        abort = () => {
          worker!.pending.delete(requestId)
          clearTimeout(timer)
          worker!.status = 'error'
          stopping=this.stopWorker(request.skillId)
          reject(new Error('Task cancelled'))
        }

        signal.addEventListener('abort', abort, { once: true })

        worker!.pending.set(requestId, { resolve, reject, timer })

        // 发送 JSON-RPC 请求
        const message: IpcMessage = {
          type: 'request',
          id: requestId,
          tool: request.tool,
          args: request.args,
          workspace: request.workspace,
          context: request.context
        }

        const line = JSON.stringify(message) + '\n'

        worker!.process.stdin.write(line, 'utf8', error => {
          if (error) {
            worker!.pending.delete(requestId)
            clearTimeout(timer)
            worker!.status = 'error'
            reject(new Error(`Failed to send request: ${error.message}`))
          }
        })
      })

      // 更新统计
      this.stats.totalExecutions++
      this.stats.totalElapsedMs += response.elapsedMs

      return response

    } catch (error) {
      this.stats.totalErrors++
      throw error
    } finally {
      if(abort)signal.removeEventListener('abort',abort)
      if(stopping)await stopping
      if(worker.status==='busy')worker.status='idle'
    }
  }

  /**
   * 创建 Worker 进程
   */
  private async createWorker(request: ExecutionRequest,signal:AbortSignal): Promise<Worker> {
    // 检查并发限制
    if (this.workers.size >= this.config.maxWorkers) {
      // 停止最久未使用的 Worker
      const oldestWorker = Array.from(this.workers.values())
        .filter(w => w.status === 'idle')
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]

      if (oldestWorker) {
        await this.stopWorker(oldestWorker.skillId)
      } else {
        throw new Error(`Worker pool exhausted (max: ${this.config.maxWorkers})`)
      }
    }

    // 准备 venv
    let venvPath: string | null = null
    let pythonExecutable = this.config.pythonExecutable ||
                          (process.platform === 'win32' ? 'python' : 'python3')

    if (request.venv) {
      venvPath = path.join(this.config.venvDir!, request.skillId)

      if (!fs.existsSync(venvPath)) {
        await this.createVenv(venvPath, request.skillPath)
      }

      pythonExecutable = path.join(
        venvPath,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      )
    }

    signal.throwIfAborted()
    if(this.disposed)throw new Error('Runtime disposed')

    // 启动进程
    const entryPath = path.join(request.skillPath, 'index.py')

    if (!fs.existsSync(entryPath)) {
      throw new Error(`Skill entry not found: ${entryPath}`)
    }

    const child = spawn(pythonExecutable, [entryPath, '--runtime-mode'], {
      cwd: request.skillPath,
      env: {
        ...process.env,
        SKILL_ID: request.skillId,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        VIRTUAL_ENV: venvPath || undefined
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    const worker: Worker = {
      skillId: request.skillId,
      process: child,
      venvPath,
      status: 'busy',
      pending: new Map(),
      createdAt: Date.now(),
      lastUsed: Date.now()
    }
    // Starting workers already own a process and must be visible to shutdown.
    this.workers.set(request.skillId,worker)

    // 处理 stdout（JSON-RPC 响应）
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')

        if (!line) continue

        // 忽略 Python Worker 启动时的 READY 消息
        if (line === 'READY') {
          console.log(`[Worker ${request.skillId}] Ready`)
          continue
        }

        try {
          const message: IpcMessage = JSON.parse(line)

          if (message.type === 'response') {
            const pending = worker.pending.get(message.id)

            if (pending) {
              clearTimeout(pending.timer)
              worker.pending.delete(message.id)

              if (message.error) {
                pending.reject(new Error(message.error))
              } else {
                pending.resolve({
                  output: message.output,
                  elapsedMs: message.elapsedMs
                })
              }
            }
          } else if (message.type === 'log') {
            console.log(`[Worker ${request.skillId}] ${message.message}`)
          }
        } catch (error) {
          console.error(`[Runtime] Failed to parse message:`, line, error)
        }
      }
    })

    // 处理 stderr
    child.stderr.on('data', (chunk: Buffer) => {
      console.error(`[Worker ${request.skillId}]`, chunk.toString('utf8'))
    })

    // 进程退出
    child.on('close', (code) => {
      console.log(`[Runtime] Worker exited: ${request.skillId}, code=${code}`)
      if(this.workers.get(request.skillId)===worker)this.workers.delete(request.skillId)

      // 拒绝所有待处理请求
      for (const [id, pending] of worker.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`Worker exited: code=${code}`))
      }
      worker.pending.clear()
    })

    child.on('error', (error) => {
      console.error(`[Runtime] Worker error: ${request.skillId}`, error)
      worker.status = 'error'
    })

    // Settle readiness on every terminal path and remove temporary listeners.
    try {
      await new Promise<void>((resolve, reject) => {
        const finish=(error?:Error)=>{
          clearTimeout(timer)
          child.stdout.off('data',onData)
          child.off('error',onError)
          child.off('close',onClose)
          signal.removeEventListener('abort',onAbort)
          if(error)reject(error);else resolve()
        }
        const onData=()=>finish()
        const onError=(error:Error)=>finish(error)
        const onClose=(code:number|null)=>finish(new Error(`Worker exited: code=${code}`))
        const onAbort=()=>finish(signal.reason??new Error('Task cancelled'))
        const timer=setTimeout(()=>finish(new Error('Worker startup timeout')),5000)
        child.stdout.once('data',onData)
        child.once('error',onError)
        child.once('close',onClose)
        signal.addEventListener('abort',onAbort,{once:true})
        if(signal.aborted)onAbort()
      })
      signal.throwIfAborted()
      if(this.disposed||worker.status==='stopped')throw new Error('Runtime disposed')
      worker.status='idle'
    } catch(error) {
      await this.stopWorkerProcess(worker)
      throw error
    }

    return worker
  }

  /**
   * 创建虚拟环境
   */
  private async createVenv(venvPath: string, skillPath: string): Promise<void> {
    console.log(`[Runtime] Creating venv: ${venvPath}`)

    const pythonExecutable = this.config.pythonExecutable || 'python3'

    // python -m venv <path>
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonExecutable, ['-m', 'venv', venvPath], {
        stdio: 'inherit'
      })

      child.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`venv creation failed: code=${code}`))
        }
      })

      child.on('error', reject)
    })

    // 安装依赖
    const requirementsPath = path.join(skillPath, 'requirements.txt')
    if (fs.existsSync(requirementsPath)) {
      console.log(`[Runtime] Installing dependencies: ${requirementsPath}`)

      const pipPath = path.join(
        venvPath,
        process.platform === 'win32' ? 'Scripts/pip.exe' : 'bin/pip'
      )

      await new Promise<void>((resolve, reject) => {
        const child = spawn(pipPath, ['install', '-r', requirementsPath], {
          stdio: 'inherit'
        })

        child.on('close', code => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`pip install failed: code=${code}`))
          }
        })

        child.on('error', reject)
      })
    }
  }

  /**
   * 停止 Worker
   */
  async stopWorker(skillId: string): Promise<void> {
    const worker = this.workers.get(skillId)
    if (!worker) return
    await this.stopWorkerProcess(worker)
  }

  private stopWorkerProcess(worker:Worker):Promise<void> {
    if(worker.stopping)return worker.stopping

    console.log(`[Runtime] Stopping worker: ${worker.skillId}`)

    if(this.workers.get(worker.skillId)===worker)this.workers.delete(worker.skillId)
    worker.status = 'stopped'

    // 拒绝所有待处理请求
    for (const [id, pending] of worker.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Worker stopped'))
    }
    worker.pending.clear()

    worker.stopping=new Promise<void>(resolve => {
      if(worker.process.pid===undefined||worker.process.exitCode!==null||worker.process.signalCode!==null){resolve();return}
      const timer = setTimeout(() => {
        worker.process.kill('SIGKILL')
        resolve()
      }, 3000)

      worker.process.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      worker.process.kill('SIGTERM')
    })
    return worker.stopping
  }

  /**
   * 停止所有 Workers
   */
  async stopAll(): Promise<void> {
    const skillIds = Array.from(this.workers.keys())
    await Promise.all(skillIds.map(id => this.stopWorker(id)))
  }

  /**
   * 清理空闲 Workers
   */
  async cleanupIdleWorkers(): Promise<void> {
    const now = Date.now()
    const toStop: string[] = []

    for (const [skillId, worker] of this.workers) {
      if (
        worker.status === 'idle' &&
        now - worker.lastUsed > this.config.idleTimeout
      ) {
        toStop.push(skillId)
      }
    }

    if (toStop.length > 0) {
      console.log(`[Runtime] Cleaning up ${toStop.length} idle workers`)
      await Promise.all(toStop.map(id => this.stopWorker(id)))
    }
  }

  /**
   * 获取 Worker 信息
   */
  getWorkerInfo(skillId: string): WorkerInfo | undefined {
    const worker = this.workers.get(skillId)
    if (!worker) return undefined

    return {
      skillId: worker.skillId,
      pid: worker.process.pid!,
      status: worker.status,
      venvPath: worker.venvPath,
      createdAt: worker.createdAt,
      lastUsed: worker.lastUsed,
      pendingTasks: worker.pending.size
    }
  }

  /**
   * 列出所有 Workers
   */
  listWorkers(): WorkerInfo[] {
    return Array.from(this.workers.keys())
      .map(id => this.getWorkerInfo(id))
      .filter((info): info is WorkerInfo => info !== undefined)
  }

  /**
   * 获取运行时统计
   */
  getStats(): RuntimeStats {
    const activeWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'busy'
    ).length

    const workersBySkill: Record<string, number> = {}
    for (const worker of this.workers.values()) {
      workersBySkill[worker.skillId] = (workersBySkill[worker.skillId] || 0) + 1
    }

    return {
      activeWorkers,
      totalExecutions: this.stats.totalExecutions,
      averageExecutionTime:
        this.stats.totalExecutions > 0
          ? this.stats.totalElapsedMs / this.stats.totalExecutions
          : 0,
      errorRate:
        this.stats.totalExecutions > 0
          ? this.stats.totalErrors / this.stats.totalExecutions
          : 0,
      workersBySkill
    }
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    this.disposed=true
    clearInterval(this.cleanupTimer)
    await this.stopAll()
    await Promise.allSettled([...this.executionQueues.values()])
    await this.stopAll()
    console.log('[Runtime] Disposed')
  }
}
