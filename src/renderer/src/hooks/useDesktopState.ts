import { useEffect, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  createEmptySnapshot,
  type AppSettings,
  type CodexStatusApi,
  type DesktopCapabilities,
  type PanelView,
  type RendererWindowRole,
  type UsageSnapshot,
  type WindowPreferences
} from '../../../shared/capsule'
import { DEFAULT_FEISHU_STATUS, type FeishuStatus } from '../../../shared/feishu'
import type { TasksSnapshot, TaskWindowState } from '../../../shared/tasks'

export function useDesktopState(api: CodexStatusApi) {
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
  const [capabilities, setCapabilities] = useState<DesktopCapabilities>({
    tasks: false,
    automation: false,
    feishu: false,
    launchAtLogin: false
  })
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>({ ...DEFAULT_FEISHU_STATUS })

  useEffect(() => {
    let active = true
    const received = {
      snapshot: false,
      preferences: false,
      command: false,
      tasks: false,
      taskWindow: false,
      feishuStatus: false
    }

    // 先订阅再读取；初始化响应不能覆盖其间已经收到的新状态。
    const subscriptions = [
      api.onSnapshotUpdated((value) => {
        if (!active) return
        received.snapshot = true
        setSnapshot(value)
      }),
      api.onPreferencesUpdated((value) => {
        if (!active) return
        received.preferences = true
        setSettings(value.settings)
        setWindowPreferences(value.window)
      }),
      api.onCommand((value) => {
        if (!active || value.type !== 'show-panel-view') return
        received.command = true
        setPanelView(value.panelView)
      }),
      api.onTasksUpdated((value) => {
        if (!active) return
        received.tasks = true
        setTasks(value)
      }),
      api.onTaskWindowUpdated((value) => {
        if (!active) return
        received.taskWindow = true
        setTaskWindow(value)
      }),
      api.onFeishuStatusUpdated((value) => {
        if (!active) return
        received.feishuStatus = true
        setFeishuStatus(value)
      })
    ]

    void api
      .bootstrap()
      .then((value) => {
        if (!active) return
        // 兼容仍在运行旧主进程的 Electron 开发窗口。
        const capabilities =
          value.capabilities ??
          (window.electron
            ? { tasks: true, automation: true, feishu: true, launchAtLogin: true }
            : undefined)
        if (!capabilities)
          throw new Error('桌面能力信息缺失，请重新打开应用 / Missing desktop capabilities')
        if (!received.snapshot) setSnapshot(value.snapshot)
        if (!received.preferences) {
          setSettings(value.settings)
          setWindowPreferences(value.window)
        }
        if (!received.command) setPanelView(value.panelView)
        if (!received.taskWindow)
          setTaskWindow(value.taskWindow ?? { expanded: false, pinned: false })
        if (!received.feishuStatus && value.feishuStatus) setFeishuStatus(value.feishuStatus)
        setCapabilities(capabilities)
        setWindowRole(value.role)
        setReady(true)
        if (capabilities.tasks) {
          void api
            .getTasks()
            .then((tasks) => {
              if (active && !received.tasks) setTasks(tasks)
            })
            .catch(() => {
              if (active && !received.tasks) {
                setTasks({
                  tasks: [],
                  monitoring: false,
                  issue: '任务列表读取失败 / Could not load tasks'
                })
              }
            })
        }
      })
      .catch((error) => {
        if (!active) return
        const issue = error instanceof Error ? error.message : String(error)
        setSnapshot((previous) => ({
          ...previous,
          issues: Array.from(new Set([issue, ...previous.issues])).slice(0, 6)
        }))
        setReady(true)
      })

    return () => {
      active = false
      subscriptions.forEach((unsubscribe) => unsubscribe())
    }
  }, [api])

  return {
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
  }
}
