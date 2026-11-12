export interface TaskRecord {
  id: string
  threadId: string
  turnId: string
  cwd: string
  client: 'vscode' | 'cli' | 'unknown'
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'unknown'
  updatedAt: string
  title?: string
  startedAt?: string
  durationMs?: number
  requestSummary?: string
  muted?: boolean
}

export interface TaskNotificationRecord extends TaskRecord {
  answer?: string
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
  tasks: TaskNotificationRecord[],
  english: boolean,
  includeAnswer = false
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
  const details = (task: TaskNotificationRecord): string => {
    if (!includeAnswer) return task.requestSummary || ''
    const answer = Array.from(task.answer?.trim() || '')
    const truncated = answer.length > 1200
    const preview = answer.length
      ? `${answer.slice(0, 1200).join('')}${truncated ? '\n…' : ''}`
      : english ? 'No final answer captured for this turn.' : '未读取到本轮最终回答。'
    const answerLabel = truncated
      ? (english ? 'Answer (preview)' : '回答（预览）')
      : (english ? 'Answer' : '回答')
    const colon = english ? ':' : '：'
    const request = task.requestSummary || (english ? 'No request captured for this turn.' : '未读取到本轮需求。')
    return [
      `${english ? 'Request' : '需求'}${colon}\n${request}`,
      `${answerLabel}${colon}\n${preview}`
    ].join('\n\n')
  }
  if (tasks.length === 1)
    return { title: `${label(tasks[0])} · ${ended(tasks[0])}`, body: details(tasks[0]) }
  return {
    title: english ? `${tasks.length} Codex turns ended` : `${tasks.length} 个 Codex 轮次已结束`,
    body: tasks
      .slice(0, 3)
      .map((task) => {
        const heading = `${label(task)} · ${ended(task)}`
        return includeAnswer
          ? `${heading}\n${details(task)}`
          : `${heading}${task.requestSummary ? `：${task.requestSummary.slice(0, 100)}` : ''}`
      })
      .join(includeAnswer ? '\n\n' : '\n')
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
