import type { TaskRecord, TasksSnapshot } from '../../shared/tasks'

interface Selection {
  projects?: string[]
  sessions?: string[]
  cwd?: string
  threadId?: string
}

export interface RouteReply {
  text: string
  target?: TaskRecord
  cardText?: string
  choices?: { label: string; action: RouteAction }[]
  prompt?: string
  promptId?: string
  questionId?: string
  title?: string
}

export type RouteAction =
  | { kind: 'projects' | 'sessions' | 'current' }
  | { kind: 'project' | 'session'; value: string }
  | { kind: 'answer'; requestId: string; questionId: string; value: string }
  | { kind: 'approve'; requestId: string; value: 'accept' | 'decline' }
  | { kind: 'interrupt'; requestId: string }

const HELP =
  '点击下方“切换项目”，再点选项目和会话即可。选定后直接 @机器人发送文字，无需引用旧消息。\n启用 Codex 执行后，仅配置的测试会话会真正处理需求。\n也支持文字命令：项目列表、选择项目 1、会话列表、选择会话 1、当前会话。只列出本机任务监视中可见的会话。'

const STATUS_LABELS: Record<TaskRecord['status'], string> = {
  running: '进行中',
  completed: '本轮已结束',
  interrupted: '已中断',
  unknown: '状态未知'
}

export class FeishuRouter {
  private selections = new Map<string, Selection>()
  private bindings = new Map<string, string>()

  constructor(
    private snapshot: () => TasksSnapshot,
    private executionThreadId?: string
  ) {}

  bind(scope: string, messageId: string, threadId?: string): void {
    if (threadId) this.bindings.set(`${scope}:${messageId}`, threadId)
    else this.bindings.delete(`${scope}:${messageId}`)
    if (this.bindings.size > 1000) this.bindings.delete(this.bindings.keys().next().value!)
  }

  route(scope: string, text: string, parentId?: string): RouteReply {
    const snapshot = this.snapshot()
    if (!snapshot.monitoring)
      return { text: '已收到。请先在电脑上开启本机任务监视，再进行会话定位。' }
    const tasks = snapshot.tasks.filter((task) => task.cwd)
    const selection = this.selections.get(scope) ?? {}
    this.selections.set(scope, selection)
    const input = text.trim()
    if (input === '帮助') return { text: HELP }

    if (input === '项目列表') {
      selection.projects = [...new Set(tasks.map((task) => task.cwd))].sort().slice(0, 30)
      return {
        text: selection.projects.length
          ? `项目列表\n${selection.projects.map((cwd, index) => `${index + 1}. ${cwd}`).join('\n')}\n发送“选择项目 序号”。（最多显示 30 项）`
          : '暂无可见项目。请先在 Codex 发起会话，等待任务监视发现该会话。',
        cardText: selection.projects.length ? '点击项目，下一步选择会话。' : undefined,
        choices: selection.projects.map((cwd, index) => ({
          label: `${index + 1}. ${cwd}`,
          action: { kind: 'project', value: cwd }
        }))
      }
    }
    const projectMatch = /^选择项目\s+([1-9]\d*)$/.exec(input)
    if (projectMatch) {
      const cwd = selection.projects?.[Number(projectMatch[1]) - 1]
      if (!cwd || !tasks.some((task) => task.cwd === cwd))
        return { text: '项目序号无效或项目已不可见，请重新发送“项目列表”。' }
      return this.act(scope, { kind: 'project', value: cwd })
    }
    if (input === '会话列表') {
      if (!selection.cwd) return { text: '请先发送“项目列表”，再选择项目。' }
      const sessions = tasks.filter((task) => task.cwd === selection.cwd).slice(0, 30)
      selection.sessions = sessions.map((task) => task.threadId)
      return {
        text: sessions.length
          ? `项目：${selection.cwd}\n${sessions.map((task, index) => `${index + 1}. ${task.title || task.threadId} [${STATUS_LABELS[task.status]}]`).join('\n')}\n发送“选择会话 序号”。（最多显示 30 项）`
          : '该项目暂无可见会话。',
        cardText: `项目：${selection.cwd}\n${sessions.length ? '点击选择会话。' : '暂无可见会话。'}`,
        choices: sessions.map((task, index) => ({
          label: `${index + 1}. ${task.title || task.threadId} [${STATUS_LABELS[task.status]}]`,
          action: { kind: 'session', value: task.threadId }
        }))
      }
    }
    const sessionMatch = /^选择会话\s+([1-9]\d*)$/.exec(input)
    if (sessionMatch) {
      const threadId = selection.sessions?.[Number(sessionMatch[1]) - 1]
      const target = tasks.find((task) => task.threadId === threadId && task.cwd === selection.cwd)
      if (!target) return { text: '会话序号无效或会话已不可见，请重新发送“会话列表”。' }
      return this.act(scope, { kind: 'session', value: target.threadId })
    }
    if (/^新建/.test(input))
      return { text: '当前阶段只测试消息接收与已有会话定位，尚未创建或执行 Codex 会话。' }
    if (/^选择(项目|会话)/.test(input))
      return { text: '命令格式：选择项目 1 / 选择会话 1。请先获取对应列表。' }
    // 选择命令可回复菜单执行；普通回复仍须绑定，不能回退到当前会话。
    if (parentId && input !== '当前会话') {
      const threadId = this.bindings.get(`${scope}:${parentId}`)
      const target = tasks.find((task) => task.threadId === threadId)
      return target
        ? { ...this.receipt(target), prompt: input }
        : {
            text: '已收到，但这条被回复消息没有有效的会话绑定。请发送“会话列表”并重新选择；旧通知、重启前或其他用户的回执不能用于定位。'
          }
    }
    const target = tasks.find(
      (task) => task.threadId === selection.threadId && task.cwd === selection.cwd
    )
    return target
      ? { ...this.receipt(target), ...(input !== '当前会话' ? { prompt: input } : {}) }
      : { text: `已收到，尚未选择有效会话。\n${HELP}` }
  }

  act(scope: string, action: RouteAction): RouteReply {
    if (action.kind === 'projects') return this.route(scope, '项目列表')
    if (action.kind === 'sessions') return this.route(scope, '会话列表')
    if (action.kind === 'current') return this.route(scope, '当前会话')
    const snapshot = this.snapshot()
    if (!snapshot.monitoring) return { text: '请先开启本机任务监视。' }
    const selection = this.selections.get(scope) ?? {}
    if (action.kind === 'project') {
      if (!snapshot.tasks.some((task) => task.cwd === action.value))
        return { text: '该项目已不可见，请点击“切换项目”重新选择。' }
      selection.cwd = action.value
      selection.threadId = undefined
      selection.sessions = undefined
      this.selections.set(scope, selection)
      const reply = this.route(scope, '会话列表')
      return { ...reply, text: `已选择项目：${action.value}\n${reply.text}` }
    }
    if (action.kind === 'session') {
      const target = snapshot.tasks.find((task) => task.threadId === action.value && task.cwd)
      if (!target) return { text: '该会话已不可见，请重新选择。' }
      selection.cwd = target.cwd
      selection.threadId = target.threadId
      this.selections.set(scope, selection)
      return this.receipt(target)
    }
    return { text: '无法识别该操作，请重新选择。' }
  }

  private receipt(target: TaskRecord): RouteReply {
    return {
      target,
      text: `已收到 · 会话定位成功\n项目：${target.cwd}\n会话：${target.title || target.threadId}\n会话 ID：${target.threadId}\n状态：${STATUS_LABELS[target.status]}\n直接 @机器人发送文字即可继续，无需引用旧消息。\n${target.threadId === this.executionThreadId ? '此测试会话已启用 Codex 执行，下一条需求将提交处理。' : '此会话仅验证定位，不提交给 Codex。'}`
    }
  }
}
