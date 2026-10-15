export interface TaskRecord {
  id: string
  threadId: string
  turnId: string
  cwd: string
  client: 'vscode' | 'cli' | 'unknown'
  status: 'running' | 'waiting_input' | 'completed' | 'interrupted' | 'unknown'
  updatedAt: string
  title?: string
  startedAt?: string
  durationMs?: number
  requestSummary?: string
  pendingQuestions?: { callId: string; text: string; asynchronous: boolean }[]
  endedAt?: string
  muted?: boolean
}

export interface TasksSnapshot {
  tasks: TaskRecord[]
  monitoring: boolean
  issue?: string
  removed?: { threadId: string; title: string }[]
}

export interface TaskWindowState {
  expanded: boolean
  pinned: boolean
  nativeGlass?: boolean
}

export function taskNotificationContent(
  tasks: TaskRecord[],
  english: boolean
): { title: string; body: string } {
  const brief = (value: string, limit: number): string => {
    const characters = Array.from(value.replace(/\s+/g, ' ').trim())
    return characters.length > limit
      ? `${characters.slice(0, limit - 1).join('')}…`
      : characters.join('')
  }
  const label = (task: TaskRecord): string =>
    brief(
      task.title ||
        task.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ||
        task.threadId.slice(-8),
      28
    )
  const status = (task: TaskRecord): string =>
    task.status === 'waiting_input'
      ? english
        ? 'Awaiting your answer'
        : '等待你回答'
      : task.status === 'interrupted'
        ? english
          ? 'Interrupted'
          : '已中断'
        : english
          ? 'Turn ended'
          : '本轮结束'
  const summary = (task: TaskRecord, limit = 60): string => {
    const questions = task.status === 'waiting_input' ? task.pendingQuestions : undefined
    const more = questions && questions.length > 1
      ? english
        ? ` (+${questions.length - 1} more)`
        : `（另有 ${questions.length - 1} 个问题）`
      : ''
    return brief(questions?.[0]?.text || task.requestSummary || '', limit - Array.from(more).length) + more
  }
  if (tasks.length === 1)
    return { title: `${label(tasks[0])} · ${status(tasks[0])}`, body: summary(tasks[0]) }
  const waiting = tasks.some((task) => task.status === 'waiting_input')
  return {
    title: waiting
      ? english
        ? `${tasks.length} Codex session updates · Answers needed`
        : `${tasks.length} 个 Codex 会话有更新 · 有问题待回答`
      : english
        ? `${tasks.length} Codex turns ended`
        : `${tasks.length} 个 Codex 轮次已结束`,
    body: [...tasks]
      .sort((a, b) => Number(b.status === 'waiting_input') - Number(a.status === 'waiting_input'))
      .slice(0, 3)
      .map(
        (task) =>
          `${label(task)} · ${status(task)}${summary(task, 40) ? `：${summary(task, 40)}` : ''}`
      )
      .join('\n')
  }
}

export function taskHoverExpanded(
  inside: boolean,
  state: TaskWindowState,
  elapsedMs: number
): boolean {
  if (state.pinned) return true
  return inside ? state.expanded || elapsedMs >= 180 : state.expanded && elapsedMs < 450
}

export function taskWindowBounds(
  anchor: { x: number; y: number },
  area: { x: number; y: number; width: number; height: number },
  expanded: boolean,
  taskCount = 4
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(expanded ? 360 : 280, area.width)
  const count = Number.isFinite(taskCount) ? Math.max(0, Math.floor(taskCount)) : 4
  const height = Math.min(
    expanded ? Math.min(480, Math.max(300, 220 + Math.min(count, 4) * 70)) : 32,
    area.height
  )
  return {
    width,
    height,
    x: Math.min(Math.max(anchor.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(anchor.y, area.y), area.y + area.height - height)
  }
}
