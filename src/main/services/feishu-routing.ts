import type { TaskRecord, TasksSnapshot } from '../../shared/tasks'
import type { ExecutionThread, CodexPermissionMode } from '../../shared/feishu'
import { basename } from 'node:path'

export interface ProjectSessionSelection {
  scope: string
  cwd: string
  threadId: string
}

interface Selection {
  projects?: string[]
  sessions?: string[]
  cwd?: string
  threadId?: string
  revision?: number
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
  navigation?: boolean
  note?: string
  createCwd?: string
  sessionInfo?: string
  selects?: {
    kind: 'project' | 'session'
    options: { label: string; value: string }[]
    selected?: string
  }[]
  view?: 'switcher' | 'turn' | 'question' | 'approval' | 'details' | 'permissions'
}

export type RouteAction =
  | { kind: 'projects' | 'sessions' | 'current' }
  | { kind: 'project' | 'session' | 'details' | 'permissions' | 'new-session'; value: string }
  | { kind: 'permission'; value: CodexPermissionMode }
  | { kind: 'answer'; requestId: string; questionId: string; value: string }
  | { kind: 'approve'; requestId: string; value: 'accept' | 'decline' }
  | { kind: 'interrupt'; requestId: string }
  | { kind: 'answer-view'; page: number }

const STATUS_LABELS: Record<TaskRecord['status'], string> = {
  idle: '未开始',
  running: '进行中',
  completed: '本轮已结束',
  interrupted: '已中断',
  unknown: '状态未知'
}

export class FeishuRouter {
  private selections = new Map<string, Selection>()
  private bindings = new Map<string, string>()
  private lastSessions = new Map<string, Map<string, string>>()

  constructor(
    private snapshot: () => TasksSnapshot,
    private executionThreads: ExecutionThread[] = [],
    private canAuthorize = false,
    private canCreate = false,
    private mentionRequired = true,
    private memory?: {
      selections: ProjectSessionSelection[]
      remember: (selection: ProjectSessionSelection) => void
    }
  ) {
    for (const selection of memory?.selections ?? []) this.remember(selection, false)
  }

  private get help(): string {
    return `发送“项目列表”，在下拉框选择项目和会话。选定后直接${this.mentionRequired ? ' @机器人' : ''}发送文字。\n可通过“新建会话”创建会话，在“详情”中设置权限。文字命令仍支持：选择项目 1、会话列表、选择会话 1、新增会话、当前会话。`
  }

  setExecutionThreads(threads: ExecutionThread[]): void {
    this.executionThreads = threads
  }

  selectionVersion(scope: string): number {
    return this.selections.get(scope)?.revision ?? 0
  }

  private remember(selection: ProjectSessionSelection, persist = true): void {
    let projects = this.lastSessions.get(selection.scope)
    if (!projects) {
      projects = new Map()
      this.lastSessions.set(selection.scope, projects)
    }
    projects.delete(selection.cwd)
    projects.set(selection.cwd, selection.threadId)
    if (projects.size > 1000) projects.delete(projects.keys().next().value!)
    if (persist) this.memory?.remember(selection)
  }

  private picker(scope: string): RouteReply {
    const snapshot = this.snapshot()
    if (!snapshot.monitoring) return { text: '请先在电脑上开启本机任务监视。' }
    const tasks = snapshot.tasks.filter((task) => task.cwd)
    const selection = this.selections.get(scope) ?? {}
    this.selections.set(scope, selection)
    const remembered = this.lastSessions.get(scope)
    const visible = new Set(tasks.map((task) => task.cwd))
    const projects = [...new Set([
      ...[...(remembered?.keys() ?? [])].reverse().filter((cwd) => visible.has(cwd)),
      ...visible
    ])].slice(0, 30)
    selection.projects = projects
    const cwd = selection.cwd && visible.has(selection.cwd) ? selection.cwd : undefined
    const current = tasks.find((task) => task.threadId === selection.threadId && task.cwd === cwd)
    const sessions = cwd ? tasks.filter((task) => task.cwd === cwd) : []
    const recentThread = cwd ? remembered?.get(cwd) : undefined
    sessions.sort((a, b) => Number(b.threadId === recentThread) - Number(a.threadId === recentThread))
    const listed = sessions.slice(0, 30)
    selection.sessions = listed.map((task) => task.threadId)
    return {
      text: projects.length
        ? `项目列表\n${projects.map((project, index) => `${index + 1}. ${project}`).join('\n')}${cwd ? `\n项目：${cwd}\n${listed.map((task, index) => `${index + 1}. ${task.title || task.threadId} [${STATUS_LABELS[task.status]}]`).join('\n')}` : ''}`
        : '暂无可见项目。请先在 Codex 发起会话，等待任务监视发现该会话。',
      cardText: projects.length ? '' : '暂无可见项目。请先在电脑 Codex 中创建会话。',
      title: '切换会话',
      view: 'switcher',
      target: current,
      navigation: false,
      selects: [
        {
          kind: 'project',
          selected: cwd,
          options: projects.map((project) => {
            const name = basename(project) || project
            return {
              label: projects.some((other) => other !== project && basename(other) === name) ? project : name,
              value: project
            }
          })
        },
        ...(cwd ? [{
          kind: 'session' as const,
          selected: current?.threadId,
          options: listed.map((task) => {
            const title = Array.from(task.title || '未命名会话')
            return {
              label: `${title.slice(0, 32).join('')}${title.length > 32 ? '…' : ''} · ${task.threadId.slice(-8)} [${STATUS_LABELS[task.status]}]`,
              value: task.threadId
            }
          })
        }] : [])
      ],
      choices: [
        ...(cwd && this.canCreate ? [{ label: '新建会话', action: { kind: 'new-session' as const, value: cwd } }] : []),
        ...(current ? [{ label: '详情', action: { kind: 'details' as const, value: current.threadId } }] : [])
      ],
      note: current && this.canAuthorize && !this.executionThreads.some((grant) => grant.threadId === current.threadId)
        ? '此会话未授权执行，请在详情中选择权限。'
        : undefined
    }
  }

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
    if (input === '帮助') return { text: this.help }

    if (input === '项目列表' || input === '会话列表' || input === '当前会话') return this.picker(scope)
    const projectMatch = /^选择项目\s+([1-9]\d*)$/.exec(input)
    if (projectMatch) {
      const cwd = selection.projects?.[Number(projectMatch[1]) - 1]
      if (!cwd || !tasks.some((task) => task.cwd === cwd))
        return { text: '项目序号无效或项目已不可见，请重新发送“项目列表”。' }
      return this.act(scope, { kind: 'project', value: cwd })
    }
    const sessionMatch = /^选择会话\s+([1-9]\d*)$/.exec(input)
    if (sessionMatch) {
      const threadId = selection.sessions?.[Number(sessionMatch[1]) - 1]
      const target = tasks.find((task) => task.threadId === threadId && task.cwd === selection.cwd)
      if (!target) return { text: '会话序号无效或会话已不可见，请重新发送“会话列表”。' }
      return this.act(scope, { kind: 'session', value: target.threadId })
    }
    if (input === '新增会话' || input === '新建会话')
      return selection.cwd
        ? this.act(scope, { kind: 'new-session', value: selection.cwd })
        : { text: '请先选择项目，再新增会话。' }
    if (/^选择(项目|会话)/.test(input))
      return { text: '命令格式：选择项目 1 / 选择会话 1。请先获取对应列表。' }
    // 选择命令可回复菜单执行；普通回复仍须绑定，不能回退到当前会话。
    if (parentId) {
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
      ? { ...this.receipt(target), prompt: input }
      : { text: `已收到，尚未选择有效会话。\n${this.help}` }
  }

  act(scope: string, action: RouteAction): RouteReply {
    if (action.kind === 'projects') return this.route(scope, '项目列表')
    if (action.kind === 'sessions') return this.route(scope, '会话列表')
    if (action.kind === 'current') return this.route(scope, '当前会话')
    const snapshot = this.snapshot()
    if (!snapshot.monitoring) return { text: '请先开启本机任务监视。' }
    const selection = this.selections.get(scope) ?? {}
    if (action.kind === 'new-session') {
      if (!this.canCreate) return { text: '请先在电脑端开启 Codex 执行，再新增会话。' }
      if (!snapshot.tasks.some((task) => task.cwd === action.value))
        return { text: '该项目已不可见，请重新选择项目。' }
      return { text: '正在创建会话…', createCwd: action.value }
    }
    if (action.kind === 'project') {
      if (!snapshot.tasks.some((task) => task.cwd === action.value))
        return { text: '该项目已不可见，请重新发送“项目列表”。' }
      selection.cwd = action.value
      const remembered = this.lastSessions.get(scope)?.get(action.value)
      selection.threadId = snapshot.tasks.find((task) => task.threadId === remembered && task.cwd === action.value)?.threadId
      selection.sessions = undefined
      selection.revision = (selection.revision ?? 0) + 1
      this.selections.set(scope, selection)
      if (selection.threadId) this.remember({ scope, cwd: action.value, threadId: selection.threadId })
      const reply = this.picker(scope)
      return { ...reply, text: `已选择项目：${action.value}\n${reply.text}` }
    }
    if (action.kind === 'session' || action.kind === 'details' || action.kind === 'permissions') {
      const target = snapshot.tasks.find((task) => task.threadId === action.value && task.cwd)
      if (!target) return { text: '该会话已不可见，请重新选择。' }
      if (action.kind === 'session') {
        selection.cwd = target.cwd
        selection.threadId = target.threadId
        selection.revision = (selection.revision ?? 0) + 1
        this.selections.set(scope, selection)
        this.remember({ scope, cwd: target.cwd, threadId: target.threadId })
        return this.picker(scope)
      }
      return this.receipt(target, action.kind)
    }
    return { text: '无法识别该操作，请重新选择。' }
  }

  private receipt(target: TaskRecord, view?: 'details' | 'permissions'): RouteReply {
    const grant = this.executionThreads.find((item) => item.threadId === target.threadId)
    const permission = grant
      ? grant.permission === 'workspace-write' ? '项目写入 · 必要时审批' : '只读 · 必要时审批'
      : '未授权执行'
    const summary = `状态：${STATUS_LABELS[target.status]}\n权限：${permission}`
    const details = `项目：${target.cwd}\n会话：${target.title || '未命名会话'}\n会话 ID：${target.threadId}\n状态：${STATUS_LABELS[target.status]}\n权限：${permission}`
    const showPermissions = this.canAuthorize && (!grant || view === 'permissions')
    return {
      target,
      title: view === 'details' ? '会话详情' : view === 'permissions' ? '会话权限' : undefined,
      view,
      text: details,
      cardText: view === 'details' ? details : summary,
      note: showPermissions
        ? '只读不能修改文件；项目写入仅限当前项目，必要时仍需单次审批。'
        : view ? undefined : `直接${this.mentionRequired ? ' @机器人' : ''}发送文字即可继续。`,
      choices: showPermissions
        ? [
            { label: '授予只读', action: { kind: 'permission', value: 'read-only' } },
            { label: '允许修改项目', action: { kind: 'permission', value: 'workspace-write' } }
          ]
        : view === 'details' && this.canAuthorize
          ? [{ label: '会话权限', action: { kind: 'permissions', value: target.threadId } }]
          : undefined
    }
  }
}
