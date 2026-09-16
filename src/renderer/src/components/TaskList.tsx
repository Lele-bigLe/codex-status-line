import { useEffect, useState } from 'react'
import type { LocaleCode } from '../../../shared/capsule'
import type { TaskRecord, TasksSnapshot } from '../../../shared/tasks'

const STATES = ['running', 'completed', 'interrupted', 'unknown'] as const

export function TaskList({
  snapshot,
  locale,
  notifications,
  pinned,
  active,
  onPin,
  onSettings,
  onClose
}: {
  snapshot: TasksSnapshot
  locale: LocaleCode
  notifications: boolean
  pinned: boolean
  active: boolean
  onPin: () => void
  onSettings: () => void
  onClose: () => void
}): React.JSX.Element {
  const en = locale === 'en-US'
  const labels = en
    ? { running: 'Running', completed: 'Ended', interrupted: 'Interrupted', unknown: 'Unknown' }
    : { running: '进行中', completed: '本轮结束', interrupted: '已中断', unknown: '状态未知' }
  const unknownHint = en
    ? 'No new task status has been received since monitoring was interrupted. No confirmation is needed.'
    : '监视中断后，尚未收到新的任务状态，无需手动确认。'
  const [expanded, setExpanded] = useState<string>()
  const [filter, setFilter] = useState<TaskRecord['status']>()
  const visibleTasks = snapshot.tasks.filter((task) => !filter || task.status === filter)
  const [issue, setIssue] = useState('')
  const [feedback, setFeedback] = useState('')
  const [pending, setPending] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  async function act(action: () => Promise<void>, message = ''): Promise<void> {
    setPending(true)
    setIssue('')
    setFeedback('')
    try {
      await action()
      setFeedback(message)
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  function elapsed(task: TaskRecord): string {
    const duration =
      task.status === 'running' && task.startedAt
        ? now - Date.parse(task.startedAt)
        : (task.durationMs ??
          (task.startedAt && task.status !== 'unknown'
            ? Date.parse(task.updatedAt) - Date.parse(task.startedAt)
            : undefined))
    if (duration === undefined || !Number.isFinite(duration) || duration < 0) return '—'
    const seconds = Math.floor(duration / 1000),
      minutes = Math.floor(seconds / 60)
    if (seconds < 60) return en ? `${seconds}s` : `${seconds} 秒`
    return minutes < 60
      ? en
        ? `${minutes}m ${seconds % 60}s`
        : `${minutes} 分 ${seconds % 60} 秒`
      : en
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  }
  return (
    <>
      <header className="monitor-header">
        <div className="monitor-heading">
          <span className="monitor-wordmark">Codex</span>
          <span>{en ? 'Tasks' : '任务监视'}</span>
        </div>
        <div className="monitor-window-actions">
          <button
            type="button"
            className="icon-button"
            aria-pressed={pinned}
            onClick={onPin}
            title={en ? 'Keep expanded' : '保持展开'}
            aria-label={en ? 'Keep expanded' : '保持展开'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M8 3h8l-1 7 4 4H5l4-4-1-7ZM12 14v7" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onSettings}
            title={en ? 'Settings' : '设置'}
            aria-label={en ? 'Settings' : '设置'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={en ? 'Hide' : '收起'}
            aria-label={en ? 'Hide' : '收起'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        </div>
      </header>
      <div className="monitor-summary" aria-label={en ? 'Session counts' : '会话状态统计'}>
        {STATES.map((status) => (
          <button
            type="button"
            className="monitor-stat"
            data-status={status}
            key={status}
            aria-pressed={filter === status}
            title={
              (status === 'unknown' ? `${unknownHint}\n` : '') +
              (en ? 'Click again to show all sessions' : '再次点击可取消筛选')
            }
            onClick={() => setFilter(filter === status ? undefined : status)}
          >
            <i aria-hidden="true" />
            <span>{labels[status]}</span>
            <strong>{snapshot.tasks.filter((task) => task.status === status).length}</strong>
          </button>
        ))}
      </div>
      <div className="monitor-scroll">
        {snapshot.issue || issue ? (
          <p className="settings-error" role="alert">
            {issue || snapshot.issue}
          </p>
        ) : null}
        {feedback ? (
          <p className="task-help" role="status">
            {feedback}
          </p>
        ) : null}
        {!visibleTasks.length ? (
          <div className="monitor-empty">
            <span aria-hidden="true">○</span>
            <h3>
              {filter
                ? en
                  ? 'No sessions in this state'
                  : '暂无此状态的会话'
                : en
                  ? 'Waiting for a session'
                  : '等待新的会话'}
            </h3>
            <p>
              {filter
                ? en
                  ? 'Click the selected status again to show all.'
                  : '再次点击已选状态，即可查看全部会话。'
                : snapshot.monitoring
                  ? en
                    ? 'New local Codex activity appears here.'
                    : '新的本机 Codex 活动会自动显示在这里。'
                  : en
                    ? 'Enable monitoring in Settings.'
                    : '可在设置中开启任务监视。'}
            </p>
          </div>
        ) : null}
        <ol className="monitor-list">
          {visibleTasks.map((task) => {
            const project =
              task.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || task.cwd
            const title = task.title || `${en ? 'Session' : '会话'} ${task.threadId.slice(-8)}`
            return (
              <li className="monitor-task" data-status={task.status} key={task.threadId}>
                <button
                  className="monitor-task-heading"
                  type="button"
                  aria-expanded={expanded === task.threadId}
                  onClick={() =>
                    setExpanded(expanded === task.threadId ? undefined : task.threadId)
                  }
                >
                  <span className="monitor-state-icon" aria-hidden="true">
                    {task.status === 'completed'
                      ? '✓'
                      : task.status === 'interrupted'
                        ? '×'
                        : task.status === 'running'
                          ? '·'
                          : '?'}
                  </span>
                  <strong title={title}>{title}</strong>
                  <span
                    className="monitor-status"
                    title={task.status === 'unknown' ? unknownHint : undefined}
                  >
                    {labels[task.status]}
                  </span>
                </button>
                <div className="monitor-task-meta">
                  <span className="monitor-project" title={task.cwd}>
                    {project}
                  </span>
                  <span className="monitor-meta-dot" aria-hidden="true">
                    ·
                  </span>
                  <span title={new Date(task.updatedAt).toLocaleString(locale)}>
                    {elapsed(task)}
                  </span>
                  <div className="monitor-row-actions">
                    <button
                      type="button"
                      aria-pressed={Boolean(task.muted)}
                      disabled={pending}
                      title={en ? 'Toggle session notifications' : '切换此会话的通知'}
                      onClick={() => {
                        void act(() => window.codexStatus.setTaskMuted(task.id, !task.muted))
                      }}
                    >
                      {task.muted ? (en ? 'Muted' : '已静音') : en ? 'Mute' : '静音'}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      title={en ? 'Remove from monitoring' : '移出监视，不影响 Codex 执行'}
                      onClick={() => {
                        void act(() => window.codexStatus.removeTask(task.id))
                      }}
                    >
                      {en ? 'Remove' : '移除'}
                    </button>
                  </div>
                </div>
                {expanded === task.threadId ? (
                  <div className="monitor-task-details">
                    {task.status === 'unknown' ? <p>{unknownHint}</p> : null}
                    {task.requestSummary ? <p>{task.requestSummary}</p> : null}
                    <p>{task.cwd}</p>
                    <p>
                      {en ? 'Updated ' : '更新于 '}
                      {new Date(task.updatedAt).toLocaleString(locale)}
                    </p>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        void act(
                          () => window.codexStatus.copyTaskSession(task.id),
                          en ? 'Session ID copied.' : '已复制会话 ID。'
                        )
                      }}
                    >
                      {en ? 'Copy session ID' : '复制会话 ID'}
                    </button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      </div>
      <footer className="monitor-footer">
        {snapshot.removed?.length ? (
          <details className="monitor-removed">
            <summary>
              {en ? 'Removed sessions' : '已移除的会话'} ({snapshot.removed.length})
            </summary>
            <div
              className="monitor-removed-list"
              role="region"
              aria-label={en ? 'Removed sessions' : '已移除的会话'}
            >
              {snapshot.removed.map((session) => (
                <div key={session.threadId}>
                  <span title={session.title}>{session.title}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      void act(() => window.codexStatus.restoreTask(session.threadId))
                    }}
                  >
                    {en ? 'Restore' : '恢复监视'}
                  </button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <span className={snapshot.monitoring ? 'is-online' : ''}>
          <i aria-hidden="true" />
          {snapshot.monitoring
            ? en
              ? 'Watching local activity'
              : '正在监视本机活动'
            : en
              ? 'Monitoring paused'
              : '监视已暂停'}
        </span>
        <span>
          {notifications
            ? en
              ? 'Notifications on'
              : '通知已开启'
            : en
              ? 'Notifications off'
              : '通知已关闭'}
        </span>
      </footer>
    </>
  )
}
