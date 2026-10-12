import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { TaskRecord } from '../../shared/tasks'
import type { RouteAction } from './feishu-routing'
import type {
  CodexPermissionMode,
  CodexRuntimeInfo,
  CodexSessionConfiguration
} from '../../shared/feishu'

export interface CodexOutput {
  text: string
  configuration?: CodexSessionConfiguration
  kind?: 'status' | 'progress' | 'answer' | 'completed'
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

export function discoverCodexExecutables(configured = ''): string[] {
  if (configured) {
    if (
      !isAbsolute(configured) ||
      !existsSync(configured) ||
      (process.platform === 'win32' && !configured.toLowerCase().endsWith('.exe'))
    ) {
      throw new Error('Codex 可执行文件路径无效，请选择原生 codex 可执行文件。')
    }
    return [configured]
  }
  const candidates: string[] = []
  const add = (file: string): void => {
    try {
      if (statSync(file).isFile()) {
        const path = realpathSync(file)
        if (!candidates.includes(path)) candidates.push(path)
      }
    } catch {
      /* 候选安装可能在更新时被移除，继续查找。 */
    }
  }
  const installed = (root: string, relative: string, prefix = ''): void => {
    try {
      const files = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => join(root, entry.name, relative))
        .flatMap((path) => {
          try {
            return [{ path, modified: statSync(path).mtimeMs }]
          } catch {
            return []
          }
        })
        .sort((a, b) => b.modified - a.modified)
      for (const file of files.slice(0, 6)) add(file.path)
    } catch {
      /* 未安装此版本来源。 */
    }
  }
  if (process.platform === 'win32') {
    installed(
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
        'OpenAI',
        'Codex',
        'bin'
      ),
      'codex.exe'
    )
  } else if (process.platform === 'darwin') {
    add('/Applications/Codex.app/Contents/Resources/codex')
    add(join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'))
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!directory) continue
    const native = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    add(native)
    if (process.platform !== 'win32') continue
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
      add(candidate)
    }
  }
  if (process.platform === 'win32')
    installed(
      join(homedir(), '.vscode', 'extensions'),
      join('bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe'),
      'openai.chatgpt-'
    )
  if (!candidates.length)
    throw new Error('未找到 Codex，请安装 Codex 或在消息接收设置中填写可执行文件的完整路径。')
  return candidates
}

export function resolveCodexExecutable(configured = ''): string {
  return discoverCodexExecutables(configured)[0]
}

class CodexProtocolError extends Error {}

function insideProject(file: string, cwd: string): boolean {
  if (!isAbsolute(file)) return false
  try {
    let ancestor = resolve(file)
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
    const actual = resolve(realpathSync(ancestor), relative(ancestor, resolve(file)))
    const path = relative(realpathSync(cwd), actual)
    return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  } catch {
    return false
  }
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
  private preparing = false
  private configuration: CodexSessionConfiguration = {}
  private createdThreadId?: string
  private generation = 0
  private fileChanges = new Map<
    string,
    { path: string; diff: string; kind: { type: string; move_path?: string | null } }[]
  >()

  constructor(
    private executable: string,
    private onIssue: (message: string) => void,
    private options: {
      permission?: CodexPermissionMode
      onRuntime?: (runtime: CodexRuntimeInfo) => void
      onTurn?: (turnId: string) => void
      onConfiguration?: (threadId: string, configuration: CodexSessionConfiguration) => void
    } = {}
  ) {}

  get running(): boolean {
    return Boolean(this.task)
  }

  setPermission(permission: CodexPermissionMode): void {
    if (this.running) throw new Error('请等待本轮结束后再更改权限。')
    this.options.permission = permission
  }

  async start(
    task: TaskRecord,
    text: string,
    emit: (output: CodexOutput) => Promise<void>
  ): Promise<void> {
    if (this.running) throw new Error('该会话正在处理，请先回答待答问题或等待本轮结束。')
    if (task.status === 'running' || task.status === 'unknown')
      throw new Error('会话正在其他窗口执行或状态未知，请等待其结束后再从飞书发起。')
    const reuseCreated = this.createdThreadId === task.threadId && Boolean(this.child)
    if (task.status === 'idle' && !reuseCreated)
      throw new Error(
        '此空会话的创建连接已关闭，尚无可恢复记录。请重新新增会话，授权后发送第一条文字需求。'
      )
    const generation = ++this.generation
    const ensureActive = (): void => {
      if (this.generation !== generation) throw new Error('Codex 执行已取消。')
    }
    this.task = task
    if (!reuseCreated) this.configuration = {}
    this.emit = emit
    this.closing = false
    this.runKey = randomUUID()
    this.completedItems.clear()
    this.fileChanges.clear()
    try {
      const candidates: (string | undefined)[] = reuseCreated
        ? [undefined]
        : discoverCodexExecutables(this.executable)
      let prepared = false
      for (const executable of candidates) {
        ensureActive()
        this.task = task
        this.preparing = true
        if (reuseCreated) {
          // 首轮前没有可供 thread/resume 读取的历史，直接使用创建时已加载的会话。
          prepared = true
          break
        }
        try {
          const runtime = executable ? await this.connect(executable, task.cwd) : undefined
          ensureActive()
          const resumed = (await this.request('thread/resume', {
            threadId: task.threadId,
            excludeTurns: true,
            approvalPolicy: 'untrusted',
            approvalsReviewer: 'user',
            sandbox: this.options.permission ?? 'read-only'
          })) as CodexSessionConfiguration & {
            thread?: { id: string; cwd: string; status?: { type: string } }
          }
          ensureActive()
          const cwdKey = (cwd: string): string =>
            process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
          if (
            resumed.thread?.id !== task.threadId ||
            typeof resumed.thread.cwd !== 'string' ||
            cwdKey(resumed.thread.cwd) !== cwdKey(task.cwd)
          )
            throw new Error('恢复的会话或项目与所选目标不一致，已停止提交。')
          if (resumed.thread.status?.type === 'active')
            throw new Error('该会话已有进行中的任务，请等待结束后再提交。')
          this.confirmConfiguration(task.threadId, resumed)
          if (runtime) this.options.onRuntime?.(runtime)
          prepared = true
          break
        } catch (error) {
          ensureActive()
          this.closeTransport()
          if (!(error instanceof CodexProtocolError) || executable === candidates.at(-1))
            throw error
        }
      }
      if (!prepared) throw new Error('没有能恢复此会话的兼容 Codex 程序。')
      ensureActive()
      this.preparing = false
      this.createdThreadId = undefined
      // 从这里开始禁止切换程序或自动重试，避免一次需求执行两遍。
      const result = (await this.request('turn/start', {
        threadId: task.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        sandboxPolicy:
          this.options.permission === 'workspace-write'
            ? {
                type: 'workspaceWrite',
                writableRoots: [task.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true
              }
            : { type: 'readOnly', networkAccess: false }
      })) as { turn?: { id: string } }
      if (!result.turn?.id) throw new Error('Codex 未返回轮次标识，送达状态未知，请勿重复提交。')
      this.turnId = result.turn.id
      this.options.onTurn?.(result.turn.id)
    } catch (error) {
      if (this.generation === generation) this.stop()
      throw error
    }
  }

  async check(): Promise<CodexRuntimeInfo> {
    if (this.running) throw new Error('当前有任务执行，不能在同一连接检查程序。')
    const candidates = discoverCodexExecutables(this.executable)
    for (const executable of candidates) {
      this.preparing = true
      try {
        return await this.connect(executable)
      } catch (error) {
        if (executable === candidates.at(-1)) throw error
      } finally {
        this.stop()
      }
    }
    throw new Error('没有可用的 Codex 程序。')
  }

  async create(cwd: string): Promise<TaskRecord> {
    if (this.running || this.child) throw new Error('当前连接正在使用，请稍后创建会话。')
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('项目目录不存在。')
    const generation = ++this.generation
    const ensureActive = (): void => {
      if (generation !== this.generation) throw new Error('创建会话已取消。')
    }
    this.preparing = true
    try {
      const candidates = discoverCodexExecutables(this.executable)
      for (const executable of candidates) {
        ensureActive()
        try {
          const runtime = await this.connect(executable, cwd)
          ensureActive()
          this.options.onRuntime?.(runtime)
          break
        } catch (error) {
          ensureActive()
          this.closeTransport()
          if (executable === candidates.at(-1)) throw error
        }
      }
      ensureActive()
      // thread/start 可能已创建会话；提交后不切换程序或重试，避免重复创建。
      const result = (await this.request('thread/start', {
        cwd,
        ephemeral: false,
        sandbox: 'read-only',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user'
      })) as CodexSessionConfiguration & { thread?: { id?: string; cwd?: string; name?: string } }
      ensureActive()
      const thread = result.thread
      const cwdKey = (value: string): string =>
        process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
      if (
        !thread?.id ||
        !/^[0-9a-f-]{36}$/i.test(thread.id) ||
        !thread.cwd ||
        cwdKey(thread.cwd) !== cwdKey(cwd)
      )
        throw new Error('Codex 返回的新会话无效或项目不一致，请在电脑端核对，勿重复创建。')
      this.confirmConfiguration(thread.id, result)
      // 空会话在首轮前不会落盘，保留原连接供第一条真实需求使用。
      this.createdThreadId = thread.id
      return {
        id: `${thread.id}:`,
        threadId: thread.id,
        turnId: '',
        cwd: thread.cwd,
        title: thread.name || '新会话',
        client: 'unknown',
        status: 'idle',
        updatedAt: new Date().toISOString()
      }
    } finally {
      if (generation === this.generation && !this.createdThreadId) this.stop()
    }
  }

  private async connect(executable: string, cwd?: string): Promise<CodexRuntimeInfo> {
    this.closing = false
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stderr.resume() // 不转发可能含本机配置和凭据的原始日志。
    child.on('error', () => {
      if (this.child === child) this.transportFailed('Codex 进程启动失败，请检查可执行文件路径。')
    })
    child.on('exit', () => {
      if (this.child === child && !this.closing)
        this.transportFailed('Codex 连接已断开，本轮状态未知；请检查电脑端后再继续，不要重复提交。')
    })
    child.stdin.on('error', () => {
      if (this.child === child) this.transportFailed('Codex 输入连接已断开。')
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child || this.closing) return
      try {
        this.receive(JSON.parse(line))
      } catch {
        this.transportFailed('Codex 协议响应无法处理，本轮已停止。')
      }
    })
    const initialized = (await this.request('initialize', {
      clientInfo: { name: 'codex_status_feishu', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })) as { userAgent?: string }
    this.write({ method: 'initialized' })
    return {
      executable,
      version:
        typeof initialized.userAgent === 'string'
          ? initialized.userAgent.slice(0, 200)
          : '版本信息未提供'
    }
  }

  private transportFailed(message: string): void {
    if (!this.preparing) {
      this.failed(message)
      return
    }
    if (this.createdThreadId) this.onIssue('空会话连接已断开，尚未发送首条需求的会话需要重新新增。')
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexProtocolError(message))
    }
    this.requests.clear()
    this.closeTransport()
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
    const configuredOutput = { ...output, configuration: { ...this.configuration } }
    this.outputQueue = this.outputQueue
      .then(() => emit(configuredOutput))
      .catch(() => {
        const issue = 'Codex 输出未确认送达飞书，请回电脑检查，避免重复提交。'
        if (runKey === this.runKey && !this.closing) this.failed(issue)
        else this.onIssue(issue)
      })
  }

  private confirmConfiguration(threadId: string, response: CodexSessionConfiguration): void {
    this.configuration = {
      model: typeof response.model === 'string' ? response.model : undefined,
      reasoningEffort:
        response.reasoningEffort === null || typeof response.reasoningEffort === 'string'
          ? response.reasoningEffort
          : undefined
    }
    this.options.onConfiguration?.(threadId, { ...this.configuration })
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
          new CodexProtocolError(
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
      if (this.turnId) this.options.onTurn?.(this.turnId)
      this.publish({
        kind: 'status',
        text: 'Codex 已开始处理。可点击“停止本轮”中断。',
        choices: [{ label: '停止本轮', action: { kind: 'interrupt', requestId: this.runKey } }]
      })
    } else if (message.method === 'item/started') {
      const item = params.item as {
        id?: string
        type?: string
        changes?: {
          path: string
          diff: string
          kind: { type: string; move_path?: string | null }
        }[]
      }
      if (item?.type === 'fileChange' && item.id && Array.isArray(item.changes))
        this.fileChanges.set(item.id, item.changes)
    } else if (message.method === 'item/completed') {
      const item = params.item as { id?: string; type?: string; text?: string; phase?: string }
      if (item?.id) this.fileChanges.delete(item.id)
      if (
        item?.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.id &&
        !this.completedItems.has(item.id)
      ) {
        this.completedItems.add(item.id)
        this.publish({
          kind: item.phase === 'commentary' ? 'progress' : 'answer',
          text: item.text
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
        kind: 'completed',
        text:
          turn?.status === 'completed'
            ? '本轮已结束。直接 @机器人发送下一条消息即可继续。'
            : turn?.status === 'interrupted'
              ? '本轮已停止。'
              : '本轮执行失败，请查看电脑端具体原因。'
      })
      this.stop()
    } else if (message.method === 'error' && params.willRetry === false) {
      this.publish({ kind: 'completed', text: 'Codex 报告执行错误，请查看电脑端具体原因。' })
    }
  }

  private serverRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (!this.task || params.threadId !== this.task.threadId) {
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
        this.interruptUnsupported()
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
    } else if (
      method === 'item/fileChange/requestApproval' &&
      this.options.permission === 'workspace-write' &&
      !params.grantRoot
    ) {
      const changes =
        typeof params.itemId === 'string' ? this.fileChanges.get(params.itemId) : undefined
      const reviewable =
        changes?.length &&
        changes.every(
          (change) =>
            typeof change.path === 'string' &&
            typeof change.diff === 'string' &&
            insideProject(change.path, this.task!.cwd) &&
            ['add', 'delete', 'update'].includes(change.kind?.type) &&
            (!change.kind.move_path || insideProject(change.kind.move_path, this.task!.cwd))
        )
      const details = reviewable
        ? changes
            .map(
              (change) =>
                `${change.kind.type} ${change.path}${change.kind.move_path ? ` → ${change.kind.move_path}` : ''}\n${change.diff}`
            )
            .join('\n\n')
        : ''
      if (!reviewable || !details || details.length > 24000) {
        this.write({ id, result: { decision: 'decline' } })
        this.publish({
          text: '文件修改缺少可完整审阅的差异，或超出项目目录，已拒绝；请在电脑端处理。'
        })
        this.interruptUnsupported()
        return
      }
      const key = randomUUID()
      this.approvals.set(key, id)
      this.publish({
        text: `Codex 请求修改项目文件\n${details}\n请完整核对上述差异后选择，仅批准本次。`,
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
      this.interruptUnsupported()
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
    return decision === 'accept' ? '已允许本次操作。' : '已拒绝本次操作。'
  }

  private interruptUnsupported(): void {
    const runKey = this.runKey
    void this.interrupt(runKey).catch(() => {
      if (runKey === this.runKey) this.stop()
    })
  }

  async interrupt(key?: string): Promise<void> {
    if (key && key !== this.runKey) throw new Error('该停止按钮属于已经结束的轮次。')
    if (!this.task || !this.turnId) throw new Error('当前没有可停止的轮次。')
    await this.request('turn/interrupt', { threadId: this.task.threadId, turnId: this.turnId })
  }

  stop(): void {
    this.generation += 1
    this.closeTransport()
  }

  private closeTransport(): void {
    this.closing = true
    this.child?.kill()
    this.child = undefined
    this.createdThreadId = undefined
    this.task = undefined
    this.turnId = undefined
    this.inputs.clear()
    this.approvals.clear()
    this.fileChanges.clear()
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex 连接已关闭。'))
    }
    this.requests.clear()
  }

  private failed(message: string): void {
    if (this.closing) return
    this.publish({ kind: 'completed', text: message })
    this.stop()
    this.onIssue(message)
  }
}
