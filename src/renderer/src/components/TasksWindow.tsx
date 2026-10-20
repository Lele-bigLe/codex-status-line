import type { AppSettings } from '../../../shared/capsule'
import type { FeishuStatus } from '../../../shared/feishu'
import type { TasksSnapshot, TaskWindowState } from '../../../shared/tasks'
import { COPY } from '../copy'
import { CloseIcon } from './Icons'
import { TaskList } from './TaskList'

export function TasksWindow({
  settings,
  tasks,
  taskWindow,
  feishuStatus,
  onClose,
  onIssue
}: {
  settings: AppSettings
  tasks: TasksSnapshot
  taskWindow: TaskWindowState
  feishuStatus: FeishuStatus
  onClose: () => void
  onIssue: (error: unknown) => void
}): React.JSX.Element {
  const copy = COPY[settings.locale]
  const english = settings.locale === 'en-US'
  const runningCount = tasks.tasks.filter((task) => task.status === 'running').length
  const waitingCount = tasks.tasks.filter((task) => task.status === 'waiting_input').length
  const current =
    tasks.tasks.find((task) => task.status === 'waiting_input') ??
    tasks.tasks.find((task) => task.status === 'running') ??
    tasks.tasks[0]
  const taskLabel = !tasks.monitoring
    ? english
      ? 'Monitoring paused'
      : '监视已暂停'
    : waitingCount
      ? current?.title ||
        current?.pendingQuestions?.[0]?.text ||
        (english ? 'Awaiting your answer' : '等待你回答')
      : runningCount
        ? current?.title || current?.requestSummary || (english ? 'Task running' : '任务执行中')
        : !current
          ? english
            ? 'Waiting for tasks'
            : '等待新任务'
          : current.status === 'completed'
            ? english
              ? 'Turn ended'
              : '本轮已结束'
            : current.status === 'interrupted'
              ? english
                ? 'Interrupted'
                : '任务已中断'
              : english
                ? 'Status unknown'
                : '状态未知'
  const summaryTitle =
    waitingCount && tasks.monitoring
      ? `${english ? `${waitingCount} awaiting input` : `${waitingCount} 个会话待回答`} · ${current?.pendingQuestions?.map((question) => question.text).join('\n') || taskLabel}`
      : runningCount && tasks.monitoring
        ? `${english ? `${runningCount} running` : `${runningCount} 个任务进行中`} · ${taskLabel}`
        : current?.title || taskLabel

  return (
    <div
      className="app-shell app-shell--tasks"
      data-theme={settings.theme}
      data-native-glass={Boolean(taskWindow.nativeGlass)}
    >
      {!taskWindow.expanded ? (
        <div className="monitor-peek" data-status={current?.status ?? 'unknown'}>
          <span
            className="monitor-peek-drag"
            title={english ? 'Drag to move' : '拖动移动'}
            aria-hidden="true"
          >
            <svg viewBox="0 0 10 14" fill="currentColor">
              <circle cx="3" cy="3" r="1" />
              <circle cx="7" cy="3" r="1" />
              <circle cx="3" cy="7" r="1" />
              <circle cx="7" cy="7" r="1" />
              <circle cx="3" cy="11" r="1" />
              <circle cx="7" cy="11" r="1" />
            </svg>
          </span>
          <button
            className="monitor-peek-summary"
            type="button"
            title={summaryTitle}
            onClick={() => {
              void window.codexStatus.setTaskWindowPinned(true).catch(onIssue)
            }}
          >
            <i aria-hidden="true" />
            <strong>
              {waitingCount && tasks.monitoring
                ? english
                  ? 'Needs input'
                  : '待回答'
                : runningCount && tasks.monitoring
                  ? english
                    ? 'Running'
                    : '进行中'
                  : 'Codex'}
            </strong>
            <span>{taskLabel}</span>
          </button>
          <button
            className="monitor-peek-close"
            type="button"
            onClick={onClose}
            aria-label={copy.close}
            title={copy.close}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}
      <section className="panel panel--tasks monitor-popup" hidden={!taskWindow.expanded}>
        <TaskList
          snapshot={tasks}
          locale={settings.locale}
          notifications={settings.taskNotifications || feishuStatus.enabled}
          active={taskWindow.expanded}
          pinned={taskWindow.pinned}
          onPin={() => {
            void window.codexStatus.setTaskWindowPinned(!taskWindow.pinned).catch(onIssue)
          }}
          onClose={onClose}
          onSettings={() => {
            void window.codexStatus.openPanel('settings').catch(onIssue)
          }}
        />
      </section>
    </div>
  )
}
