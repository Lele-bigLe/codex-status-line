import { useEffect, useState } from 'react'
import appIcon from '../../../build/icon.png'
import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  createEmptySnapshot,
  type AppSettings,
  type PanelView,
  type RendererWindowRole,
  type UsageSnapshot,
  type WindowPreferences
} from '../../shared/capsule'
import { DEFAULT_FEISHU_STATUS, type FeishuStatus } from '../../shared/feishu'
import type { TasksSnapshot, TaskWindowState } from '../../shared/tasks'
import { COPY } from './copy'
import { AutomationPanel } from './components/AutomationPanel'
import { CapsuleWindow } from './components/CapsuleWindow'
import { CloseIcon } from './components/Icons'
import { OverviewPanel } from './components/OverviewPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { TasksWindow } from './components/TasksWindow'

function App(): React.JSX.Element {
  const [taskWindow, setTaskWindow] = useState<TaskWindowState>({ expanded: false, pinned: false })
  const [tasks, setTasks] = useState<TasksSnapshot>({ tasks: [], monitoring: false })
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => createEmptySnapshot())
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })
  const [windowPreferences, setWindowPreferences] = useState<WindowPreferences>({
    ...DEFAULT_WINDOW_PREFERENCES
  })
  const [windowRole, setWindowRole] = useState<RendererWindowRole>('capsule')
  const [panelView, setPanelView] = useState<PanelView>('details')
  const [ready, setReady] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [settingsIssue, setSettingsIssue] = useState(false)
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>({ ...DEFAULT_FEISHU_STATUS })

  useEffect(() => {
    let active = true
    let feishuStatusReceived = false
    const disposeFeishuStatus = window.codexStatus.onFeishuStatusUpdated((status) => {
      feishuStatusReceived = true
      setFeishuStatus(status)
    })
    let taskWindowReceived = false
    const disposeTaskWindow = window.codexStatus.onTaskWindowUpdated((state) => {
      taskWindowReceived = true
      setTaskWindow(state)
    })
    let tasksReceived = false
    const disposeTasks = window.codexStatus.onTasksUpdated((payload) => {
      tasksReceived = true
      setTasks(payload)
    })
    void window.codexStatus
      .getTasks()
      .then((payload) => {
        if (active && !tasksReceived) setTasks(payload)
      })
      .catch(() => {
        if (active)
          setTasks({
            tasks: [],
            monitoring: false,
            issue: '任务列表读取失败 / Could not load tasks'
          })
      })

    void window.codexStatus
      .bootstrap()
      .then((payload) => {
        if (!active) {
          return
        }

        setSnapshot(payload.snapshot)
        if (!feishuStatusReceived) setFeishuStatus(payload.feishuStatus)
        if (!taskWindowReceived)
          setTaskWindow(payload.taskWindow ?? { expanded: false, pinned: false })
        setSettings(payload.settings)
        setWindowPreferences(payload.window)
        setWindowRole(payload.role)
        setPanelView(payload.panelView)
        setReady(true)
      })
      .catch((error) => {
        if (!active) {
          return
        }

        setSnapshot({
          ...createEmptySnapshot(),
          issues: [error instanceof Error ? error.message : String(error)]
        })
        setReady(true)
      })

    const disposeSnapshot = window.codexStatus.onSnapshotUpdated((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })

    const disposePreferences = window.codexStatus.onPreferencesUpdated((payload) => {
      setSettings(payload.settings)
      setWindowPreferences(payload.window)
    })

    const disposeCommand = window.codexStatus.onCommand((payload) => {
      if (payload.type !== 'show-panel-view') {
        return
      }

      setPanelView(payload.panelView)
    })

    return () => {
      active = false
      disposeSnapshot()
      disposeFeishuStatus()
      disposeTasks()
      disposeTaskWindow()
      disposePreferences()
      disposeCommand()
    }
  }, [])

  useEffect(() => {
    const updateClock = (): void => {
      if (!document.hidden) setNow(Date.now())
    }
    const timer = window.setInterval(updateClock, 15000)
    document.addEventListener('visibilitychange', updateClock)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', updateClock)
    }
  }, [])

  function openDetails(): void {
    setPanelView('details')
  }

  function openSettings(): void {
    setPanelView('settings')
  }

  function closePanel(): void {
    setPanelView('details')
    void window.codexStatus.closePanel()
  }

  async function handleRefresh(): Promise<void> {
    if (snapshot.canRefresh === false || snapshot.isRefreshing) {
      return
    }

    try {
      await window.codexStatus.refreshStatus()
    } catch (error) {
      recordSnapshotIssue(error)
    }
  }

  function recordSnapshotIssue(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    setSnapshot((previous) => ({
      ...previous,
      isRefreshing: false,
      issues: Array.from(new Set([message, ...previous.issues])).slice(0, 6)
    }))
  }

  async function handleSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
    setSettingsIssue(false)
    const previousSettings = settings
    setSettings({
      ...settings,
      ...patch
    })

    try {
      const payload = await window.codexStatus.updateSettings(patch)
      setSettings(payload.settings)
    } catch {
      setSettings(previousSettings)
      setSettingsIssue(true)
    }
  }

  if (!ready) return <div className="app-shell" />

  if (windowRole === 'capsule') {
    return (
      <CapsuleWindow
        settings={settings}
        snapshot={snapshot}
        windowPreferences={windowPreferences}
        now={now}
        onPreferencesChange={setWindowPreferences}
        onRefresh={handleRefresh}
        onIssue={recordSnapshotIssue}
      />
    )
  }

  if (windowRole === 'tasks') {
    return (
      <TasksWindow
        settings={settings}
        tasks={tasks}
        taskWindow={taskWindow}
        feishuStatus={feishuStatus}
        onClose={closePanel}
        onIssue={recordSnapshotIssue}
      />
    )
  }

  const copy = COPY[settings.locale]
  return (
    <div className="app-shell app-shell--panel" data-theme={settings.theme}>
      <section className={'panel panel--' + panelView}>
        <header className="panel__topbar">
          <span className="panel__brand">
            <img src={appIcon} alt="" width={26} height={26} />
            Codex <span>Status</span>
          </span>
          <button
            className="icon-button"
            onClick={closePanel}
            type="button"
            aria-label={copy.close}
          >
            <CloseIcon />
          </button>
        </header>
        <nav className="panel__nav" aria-label={copy.details}>
          <button type="button" aria-pressed={panelView === 'details'} onClick={openDetails}>
            {copy.overview}
          </button>
          <button
            className="panel__tasks-link"
            type="button"
            onClick={() => {
              void window.codexStatus.openPanel('tasks').catch(recordSnapshotIssue)
            }}
          >
            {settings.locale === 'en-US' ? 'Tasks ↗' : '任务 ↗'}
          </button>
          <button
            type="button"
            aria-pressed={panelView === 'schedules'}
            onClick={() => setPanelView('schedules')}
          >
            {settings.locale === 'en-US' ? 'Schedules' : '定时任务'}
          </button>
          <button type="button" aria-pressed={panelView === 'settings'} onClick={openSettings}>
            {copy.settings}
          </button>
        </nav>
        {panelView === 'details' ? (
          <OverviewPanel
            settings={settings}
            snapshot={snapshot}
            now={now}
            onRefresh={handleRefresh}
          />
        ) : panelView === 'schedules' ? (
          <div className="panel__body panel__body--settings">
            <div className="panel__content">
              <AutomationPanel view="schedules" locale={settings.locale} now={now} />
            </div>
          </div>
        ) : (
          <SettingsPanel
            settings={settings}
            settingsIssue={settingsIssue}
            feishuStatus={feishuStatus}
            onSettingsChange={handleSettingsPatch}
            onBack={openDetails}
            onClose={closePanel}
          />
        )}
      </section>
    </div>
  )
}

export default App
