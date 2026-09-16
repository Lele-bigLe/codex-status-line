export interface TaskRecord {
  id: string
  threadId: string
  turnId: string
  cwd: string
  client: 'vscode' | 'cli' | 'unknown'
  status: 'running' | 'completed' | 'interrupted' | 'unknown'
  updatedAt: string
  title?: string
  startedAt?: string
  durationMs?: number
  requestSummary?: string
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
  const label = (task: TaskRecord): string =>
    task.title ||
    task.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ||
    task.threadId.slice(-8)
  const ended = (task: TaskRecord): string =>
    task.status === 'interrupted'
      ? english
        ? 'Interrupted'
        : '已中断'
      : english
        ? 'Turn ended'
        : '本轮结束'
  if (tasks.length === 1)
    return { title: `${label(tasks[0])} · ${ended(tasks[0])}`, body: tasks[0].requestSummary || '' }
  return {
    title: english ? `${tasks.length} Codex turns ended` : `${tasks.length} 个 Codex 轮次已结束`,
    body: tasks
      .slice(0, 3)
      .map(
        (task) =>
          `${label(task)} · ${ended(task)}${task.requestSummary ? `：${task.requestSummary.slice(0, 100)}` : ''}`
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
