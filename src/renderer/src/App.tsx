import { useEffect, useState } from 'react'
import appIcon from '../../../build/icon.png'
import type { AppSettings } from '../../shared/capsule'
import { useDesktopState } from './hooks/useDesktopState'
import { COPY } from './copy'
import { AutomationPanel } from './components/AutomationPanel'
import { CapsuleWindow } from './components/CapsuleWindow'
import { CloseIcon } from './components/Icons'
import { GlassBackdrop } from './components/GlassBackdrop'
import { GlassMaterial } from './components/GlassMaterial'
import { OverviewPanel } from './components/OverviewPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { TasksWindow } from './components/TasksWindow'

function App(): React.JSX.Element {
  const {
    taskWindow,
    tasks,
    snapshot,
    setSnapshot,
    settings,
    setSettings,
    windowPreferences,
    setWindowPreferences,
    windowRole,
    panelView,
    setPanelView,
    ready,
    capabilities,
    feishuStatus
  } = useDesktopState(window.codexStatus)
  const [now, setNow] = useState(Date.now)
  const [settingsIssue, setSettingsIssue] = useState(false)

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
    <div className="app-shell app-shell--panel app-shell--glass" data-theme={settings.theme}>
      <GlassBackdrop />
      <section className={'panel panel--glass panel--' + panelView}>
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
        <nav className="panel__nav glass-surface" aria-label={copy.details}>
          <GlassMaterial radius={18} />
          <button
            className={panelView === 'details' ? 'glass-surface' : undefined}
            type="button"
            aria-pressed={panelView === 'details'}
            onClick={openDetails}
          >
            {panelView === 'details' ? <GlassMaterial radius={12} /> : null}
            <span>{copy.overview}</span>
          </button>
          {capabilities.tasks ? (
            <button
              className="panel__tasks-link"
              type="button"
              onClick={() => {
                void window.codexStatus.openPanel('tasks').catch(recordSnapshotIssue)
              }}
            >
              {settings.locale === 'en-US' ? 'Tasks ↗' : '任务 ↗'}
            </button>
          ) : null}
          {capabilities.automation ? (
            <button
              className={panelView === 'schedules' ? 'glass-surface' : undefined}
              type="button"
              aria-pressed={panelView === 'schedules'}
              onClick={() => setPanelView('schedules')}
            >
              {panelView === 'schedules' ? <GlassMaterial radius={12} /> : null}
              <span>{settings.locale === 'en-US' ? 'Schedules' : '定时任务'}</span>
            </button>
          ) : null}
          <button
            className={panelView === 'settings' ? 'glass-surface' : undefined}
            type="button"
            aria-pressed={panelView === 'settings'}
            onClick={openSettings}
          >
            {panelView === 'settings' ? <GlassMaterial radius={12} /> : null}
            <span>{copy.settings}</span>
          </button>
        </nav>
        {panelView === 'details' ? (
          <OverviewPanel
            automation={capabilities.automation}
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
            capabilities={capabilities}
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
