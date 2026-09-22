import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { TaskRecord } from '../../shared/tasks'
import type { RouteAction } from './feishu-routing'

export interface CodexOutput {
  text: string
  choices?: { label: string; action: RouteAction }[]
  promptId?: string
  questionId?: string
}

interface Question {
  id: string
  question: string
  isSecret: boolean
  options?: { label: string; description: string }[] | null
}

interface PendingInput {
  rpcId: string | number
  questions: Question[]
  answers: Record<string, { answers: string[] }>
  index: number
}

export function resolveCodexExecutable(configured = ''): string {
  if (configured) {
    if (
      !isAbsolute(configured) ||
      !existsSync(configured) ||
      (process.platform === 'win32' && !configured.toLowerCase().endsWith('.exe'))
    ) {
      throw new Error('Codex 可执行文件路径无效，请选择原生 codex 可执行文件。')
    }
    return configured
  }
  if (process.platform !== 'win32') return 'codex'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!directory) continue
    const native = join(directory, 'codex.exe')
    if (existsSync(native)) return native
    const vendor = join(
      directory,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      `codex-win32-${arch}`,
      'vendor',
      target
    )
    for (const folder of ['bin', 'codex']) {
      const candidate = join(vendor, folder, 'codex.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('未找到 Codex CLI，请在消息接收设置中填写 codex.exe 的完整路径。')
}

// 每轮使用独立进程，结束后释放，下一轮从磁盘恢复最新上下文。
export class CodexSession {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 0
  private requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private inputs = new Map<string, PendingInput>()
  private approvals = new Map<string, string | number>()
  private task?: TaskRecord
  private turnId?: string
  private emit?: (output: CodexOutput) => Promise<void>
  private outputQueue = Promise.resolve()
  private completedItems = new Set<string>()
  private closing = false
  private runKey = ''

  constructor(
    private executable: string,
    private onIssue: (message: string) => void
  ) {}

  get running(): boolean {
    return Boolean(this.task)
  }

  async start(
    task: TaskRecord,
    text: string,
    emit: (output: CodexOutput) => Promise<void>
  ): Promise<void> {
    if (this.running) throw new Error('该测试会话正在处理，请先回答待答问题或等待本轮结束。')
    if (task.status === 'running' || task.status === 'unknown')
      throw new Error('会话正在其他窗口执行或状态未知，请等待其结束后再从飞书发起。')
    this.task = task
    this.emit = emit
    this.closing = false
    this.runKey = randomUUID()
    this.completedItems.clear()
    try {
      const child = spawn(resolveCodexExecutable(this.executable), ['app-server', '--stdio'], {
        cwd: task.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      child.stderr.resume() // 不转发可能含本机配置和凭据的原始日志。
      child.on('error', () => {
        if (this.child === child) this.failed('Codex 进程启动失败，请检查可执行文件路径。')
      })
      child.on('exit', () => {
        if (this.child === child && !this.closing)
          this.failed('Codex 连接已断开，本轮状态未知；请检查电脑端后再继续，不要重复提交。')
      })
      child.stdin.on('error', () => {
        if (this.child === child) this.failed('Codex 输入连接已断开。')
      })
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child !== child || this.closing) return
        try {
          this.receive(JSON.parse(line))
        } catch {
          this.failed('Codex 协议响应无法处理，本轮已停止。')
        }
      })
      await this.request('initialize', {
        clientInfo: { name: 'codex_status_feishu', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      })
      this.write({ method: 'initialized' })
      const resumed = (await this.request('thread/resume', {
        threadId: task.threadId,
        excludeTurns: true,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'read-only'
      })) as { thread?: { id: string; cwd: string; status?: { type: string } } }
      const cwdKey = (cwd: string): string =>
        process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
      if (resumed.thread?.id !== task.threadId || cwdKey(resumed.thread.cwd) !== cwdKey(task.cwd))
        throw new Error('恢复的会话或项目与所选目标不一致，已停止提交。')
      if (resumed.thread.status?.type === 'active')
        throw new Error('该会话已有进行中的任务，请等待结束后再提交。')
      const result = (await this.request('turn/start', {
        threadId: task.threadId,
        input: [{ type: 'text', text, text_elements: [] }]
      })) as { turn?: { id: string } }
      if (!result.turn?.id) throw new Error('Codex 未返回轮次标识，送达状态未知，请勿重复提交。')
      this.turnId = result.turn.id
    } catch (error) {
      this.stop()
      throw error
    }
  }

  private write(message: object): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 连接已关闭。')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Codex 请求超时（${method}），送达状态未知，请勿重复提交。`))
      }, 60000)
      this.requests.set(id, { resolve: resolveRequest, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.requests.delete(id)
        reject(error as Error)
      }
    })
  }

  private publish(output: CodexOutput): void {
    const emit = this.emit
    const runKey = this.runKey
    if (!emit) return
    this.outputQueue = this.outputQueue
      .then(() => emit(output))
      .catch(() => {
        const issue = 'Codex 输出未确认送达飞书，请回电脑检查，避免重复提交。'
        if (runKey === this.runKey && !this.closing) this.failed(issue)
        else this.onIssue(issue)
      })
  }

  private receive(message: {
    id?: string | number
    method?: string
    result?: unknown
    error?: { code?: number; message?: string }
    params?: Record<string, unknown>
  }): void {
    if (!message.method && typeof message.id === 'number') {
      const pending = this.requests.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.requests.delete(message.id)
      if (message.error)
        pending.reject(
          new Error(
            message.error.message?.includes('paginated_threads')
              ? '当前 Codex 可执行程序不支持此会话格式，请使用与该会话兼容的桌面版 Codex 程序。'
              : `Codex 请求被拒绝（${message.error.code ?? '未知错误'}），请检查本机会话与配置。`
          )
        )
      else pending.resolve(message.result)
      return
    }
    const params = message.params ?? {}
    if (message.id !== undefined && message.method) {
      this.serverRequest(message.id, message.method, params)
      return
    }
    if (params.threadId !== this.task?.threadId) return
    if (message.method === 'turn/started') {
      const turn = params.turn as { id?: string }
      this.turnId = turn?.id
      this.publish({
        text: 'Codex 已开始处理。可点击“停止本轮”中断。',
        choices: [{ label: '停止本轮', action: { kind: 'interrupt', requestId: this.runKey } }]
      })
    } else if (message.method === 'item/completed') {
      const item = params.item as { id?: string; type?: string; text?: string; phase?: string }
      if (
        item?.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.id &&
        !this.completedItems.has(item.id)
      ) {
        this.completedItems.add(item.id)
        this.publish({
          text: `${item.phase === 'commentary' ? 'Codex 进展' : 'Codex 回复'}\n${item.text}`
        })
      }
    } else if (message.method === 'serverRequest/resolved') {
      for (const [key, input] of this.inputs)
        if (input.rpcId === params.requestId) this.inputs.delete(key)
      for (const [key, rpcId] of this.approvals)
        if (rpcId === params.requestId) this.approvals.delete(key)
    } else if (message.method === 'turn/completed') {
      const turn = params.turn as { status?: string; error?: unknown }
      this.publish({
        text:
          turn?.status === 'completed'
            ? '本轮已结束。直接 @机器人发送下一条消息即可继续。'
            : turn?.status === 'interrupted'
              ? '本轮已停止。'
              : '本轮执行失败，请查看电脑端具体原因。'
      })
      this.stop()
    } else if (message.method === 'error' && params.willRetry === false) {
      this.publish({ text: 'Codex 报告执行错误，请查看电脑端具体原因。' })
    }
  }

  private serverRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (params.threadId !== this.task?.threadId) {
      this.write({ id, error: { code: -32601, message: 'Unsupported request' } })
      return
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = params.questions as Question[]
      if (
        !Array.isArray(questions) ||
        !questions.length ||
        questions.some(
          (q) => q.isSecret || typeof q.id !== 'string' || typeof q.question !== 'string'
        )
      ) {
        this.write({ id, result: { answers: {} } })
        this.publish({
          text: 'Codex 请求敏感信息或不支持的输入，请回电脑处理；未向群中展示该问题。'
        })
        void this.interrupt().catch(() => this.stop())
        return
      }
      const key = randomUUID()
      this.inputs.set(key, { rpcId: id, questions, answers: {}, index: 0 })
      this.ask(key)
    } else if (
      method === 'item/commandExecution/requestApproval' &&
      typeof params.command === 'string' &&
      params.command.length <= 6000 &&
      !params.networkApprovalContext
    ) {
      const key = randomUUID()
      this.approvals.set(key, id)
      this.publish({
        text: `Codex 请求执行命令\n目录：${String(params.cwd ?? this.task?.cwd)}\n${params.command}\n${typeof params.reason === 'string' ? params.reason : ''}\n请核对完整命令后选择，仅批准本次。`,
        choices: [
          { label: '允许本次', action: { kind: 'approve', requestId: key, value: 'accept' } },
          { label: '拒绝', action: { kind: 'approve', requestId: key, value: 'decline' } }
        ]
      })
    } else {
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      )
        this.write({ id, result: { decision: 'decline' } })
      else if (method === 'item/permissions/requestApproval')
        this.write({ id, result: { permissions: {}, scope: 'turn' } })
      else if (method === 'mcpServer/elicitation/request')
        this.write({ id, result: { action: 'decline' } })
      else this.write({ id, error: { code: -32601, message: 'Unsupported remote interaction' } })
      this.publish({ text: `Codex 请求暂不支持的交互（${method}）。未授权执行，请回电脑处理。` })
      void this.interrupt().catch(() => this.stop())
    }
  }

  private ask(key: string): void {
    const input = this.inputs.get(key)
    if (!input) return
    const question = input.questions[input.index]
    this.publish({
      text: `Codex 需要你回答（${input.index + 1}/${input.questions.length}）\n${question.question}\n${(question.options ?? []).map((option) => `${option.label}：${option.description}`).join('\n')}\n可点击选项，或回复这张卡片并 @机器人输入答案。`,
      promptId: key,
      questionId: question.id,
      choices: (question.options ?? []).map((option) => ({
        label: option.label,
        action: { kind: 'answer', requestId: key, questionId: question.id, value: option.label }
      }))
    })
  }

  answer(text: string, key?: string, questionId?: string): string {
    if (!key && this.inputs.size > 1)
      throw new Error('当前有多个问题，请回复对应的问题卡片并 @机器人作答。')
    const entry = key ? ([key, this.inputs.get(key)] as const) : this.inputs.entries().next().value
    if (!entry?.[1]) throw new Error('这个问题已结束或已过期，请查看最新问题。')
    const [requestKey, input] = entry
    const question = input.questions[input.index]
    if (questionId && questionId !== question.id)
      throw new Error('这个选项属于已回答的问题，请查看最新问题。')
    input.answers[question.id] = { answers: [text] }
    input.index += 1
    if (input.index < input.questions.length) this.ask(requestKey)
    else {
      this.write({ id: input.rpcId, result: { answers: input.answers } })
      this.inputs.delete(requestKey)
    }
    return '已提交你的回答。'
  }

  get awaitingInput(): boolean {
    return this.inputs.size > 0
  }

  approve(key: string, decision: 'accept' | 'decline'): string {
    const id = this.approvals.get(key)
    if (id === undefined) throw new Error('审批已结束或已过期。')
    this.write({ id, result: { decision } })
    this.approvals.delete(key)
    return decision === 'accept' ? '已允许本次命令。' : '已拒绝本次命令。'
  }

  async interrupt(key?: string): Promise<void> {
    if (key && key !== this.runKey) throw new Error('该停止按钮属于已经结束的轮次。')
    if (!this.task || !this.turnId) throw new Error('当前没有可停止的轮次。')
    await this.request('turn/interrupt', { threadId: this.task.threadId, turnId: this.turnId })
  }

  stop(): void {
    this.closing = true
    this.child?.kill()
    this.child = undefined
    this.task = undefined
    this.turnId = undefined
    this.inputs.clear()
    this.approvals.clear()
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex 连接已关闭。'))
    }
    this.requests.clear()
  }

  private failed(message: string): void {
    if (this.closing) return
    this.publish({ text: message })
    this.stop()
    this.onIssue(message)
  }
}
