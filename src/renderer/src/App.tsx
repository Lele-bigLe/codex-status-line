import { useEffect, useRef, useState, type CSSProperties } from 'react'
import appIcon from '../../../build/icon.png'
import { TaskList } from './components/TaskList'
import { FeishuReceiverSettings } from './components/FeishuReceiverSettings'
import type { TasksSnapshot, TaskWindowState } from '../../shared/tasks'
import {
  DEFAULT_FEISHU_SETTINGS,
  DEFAULT_FEISHU_STATUS,
  type FeishuSettings,
  type FeishuStatus
} from '../../shared/feishu'
import {
  CAPSULE_WINDOW_SIZE,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  REFRESH_INTERVAL_OPTIONS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  createEmptySnapshot,
  getCapsuleWindowSize,
  normalizeCapsuleScale,
  selectPrimaryRateLimit,
  type AppSettings,
  type CapsuleDragMovePayload,
  type LocaleCode,
  type PanelView,
  type PercentageMode,
  type RateLimitWindowSnapshot,
  type RendererWindowRole,
  type UsageSnapshot,
  type WindowPreferences
} from '../../shared/capsule'

const DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS = 40
const CAPSULE_CLICK_DRAG_DISTANCE = 5
const MANUAL_REFRESH_FEEDBACK_MS = 680

interface CapsulePointerState {
  pointerId: number
  originScreenX: number
  originScreenY: number
  offsetX: number
  offsetY: number
  hasDragged: boolean
}

const COPY = {
  'zh-CN': {
    noData: '无数据',
    refresh: '刷新',
    source: '来源',
    lastRefresh: '最近刷新',
    settings: '设置',
    details: '详情',
    close: '收起',
    done: '完成',
    back: '返回详情',
    reset: '重置',
    refreshMode: '刷新模式',
    refreshInterval: '刷新间隔',
    customInterval: '自定义秒数',
    custom: '自定义',
    percentageMode: '百分比口径',
    displayMode: '显示方式',
    theme: '界面主题',
    lightTheme: '浅色',
    darkTheme: '深色',
    settingsIntro: '常规设置自动保存；飞书配置需点击保存。',
    capsuleScale: '悬浮窗大小',
    capsuleScaleHint: '文字和状态条等比例缩放，支持 100–300%。',
    floatingMode: '悬浮状态条',
    trayMode: '托盘点击详情',
    language: '语种',
    launchAtLogin: '开机自启动',
    groupRefresh: '刷新',
    groupDisplay: '显示',
    groupGeneral: '通用',
    auto: '自动',
    manual: '手动',
    enabled: '开启',
    disabled: '关闭',
    remaining: '剩余',
    used: '已使用',
    officialSource: '官方接口',
    cacheSource: '历史数据',
    emptySource: '无数据',
    fallbackTitle: '同步暂不可用',
    fallbackBody: '保留此账号最近一次官方结果，仅供参考；自动刷新开启时会继续重试。',
    unavailableTitle: '暂无可用额度数据',
    unavailableBody: '请确认 Codex 已登录，下方可查看凭据路径和同步原因。',
    path: '凭据路径',
    overview: '额度概览',
    account: '监测账号',
    unknownAccount: '尚未识别账号',
    workspace: '工作区',
    syncing: '同步中',
    synced: '已同步',
    stale: '历史数据',
    disconnected: '未连接',
    diagnostics: '连接信息',
    lastSuccess: '数据更新于',
    noWindow: '当前未返回额度窗口',
    noWindowBody: '官方请求已成功，窗口将按实际返回展示。',
    capsuleHint: '点击刷新 · 拖动移动 · 箭头查看详情',
    pendingReset: '等待重置确认',
    saveError: '设置未保存，请重试',
    today: '今天',
    yesterday: '昨天'
  },
  'en-US': {
    noData: 'No data',
    refresh: 'Refresh',
    source: 'Source',
    lastRefresh: 'Last refresh',
    settings: 'Settings',
    details: 'Details',
    close: 'Close',
    done: 'Done',
    back: 'Back to details',
    reset: 'reset',
    refreshMode: 'Refresh mode',
    refreshInterval: 'Refresh interval',
    customInterval: 'Custom seconds',
    custom: 'Custom',
    percentageMode: 'Metric mode',
    displayMode: 'Display mode',
    theme: 'Theme',
    lightTheme: 'Light',
    darkTheme: 'Dark',
    settingsIntro: 'General settings save automatically. Save Feishu settings separately.',
    capsuleScale: 'Floating window size',
    capsuleScaleHint: 'Scale text and bar together, from 100% to 300%.',
    floatingMode: 'Floating bar',
    trayMode: 'Tray details',
    language: 'Language',
    launchAtLogin: 'Open at login',
    groupRefresh: 'Refresh',
    groupDisplay: 'Display',
    groupGeneral: 'General',
    auto: 'Auto',
    manual: 'Manual',
    enabled: 'Enabled',
    disabled: 'Disabled',
    remaining: 'Remaining',
    used: 'Used',
    officialSource: 'Official API',
    cacheSource: 'Saved data',
    emptySource: 'No data',
    fallbackTitle: 'Sync unavailable',
    fallbackBody:
      'Showing this account’s last official result for reference. Auto refresh will keep retrying.',
    unavailableTitle: 'Quota data unavailable',
    unavailableBody:
      'Check that Codex is signed in. Connection details below show the credential path and sync issue.',
    path: 'Credential path',
    overview: 'Quota overview',
    account: 'Monitoring account',
    unknownAccount: 'Account not identified',
    workspace: 'Workspace',
    syncing: 'Syncing',
    synced: 'Synced',
    stale: 'Saved data',
    disconnected: 'Disconnected',
    diagnostics: 'Connection details',
    lastSuccess: 'Data updated',
    noWindow: 'No quota windows returned',
    noWindowBody: 'The request succeeded. Windows follow the official response.',
    capsuleHint: 'Click to refresh · Drag to move · Arrow for details',
    pendingReset: 'Awaiting reset confirmation',
    saveError: 'Settings were not saved. Please retry.',
    today: 'Today',
    yesterday: 'Yesterday'
  }
} as const

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
  const [settingsCategory, setSettingsCategory] = useState<'general' | 'appearance' | 'tasks' | 'feishu' | 'receiver'>('general')
  const [customRefreshInput, setCustomRefreshInput] = useState(
    String(DEFAULT_SETTINGS.refreshIntervalSeconds)
  )
  const [capsulePointerActive, setCapsulePointerActive] = useState(false)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const [ready, setReady] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [settingsIssue, setSettingsIssue] = useState(false)
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>({ ...DEFAULT_FEISHU_STATUS })
  const [feishuSettings, setFeishuSettings] = useState<FeishuSettings>({ ...DEFAULT_FEISHU_SETTINGS })
  const [savedFeishuSettings, setSavedFeishuSettings] = useState<FeishuSettings>({ ...DEFAULT_FEISHU_SETTINGS })
  const [feishuLoaded, setFeishuLoaded] = useState(false)
  const [feishuBusy, setFeishuBusy] = useState<'save' | 'test' | undefined>()
  const [feishuIssue, setFeishuIssue] = useState('')
  const capsulePointerRef = useRef<CapsulePointerState | null>(null)
  const dragFrameRef = useRef<number | undefined>(undefined)
  const pendingDragRef = useRef<CapsuleDragMovePayload | undefined>(undefined)
  const dragRequestRef = useRef<Promise<void> | undefined>(undefined)
  const dragFinishingRef = useRef(false)
  const manualRefreshTimerRef = useRef<number | undefined>(undefined)

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
    void window.codexStatus.getTasks().then((payload) => {
      if (active && !tasksReceived) setTasks(payload)
    }).catch(() => {
      if (active) setTasks({ tasks: [], monitoring: false, issue: '任务列表读取失败 / Could not load tasks' })
    })

    void window.codexStatus
      .bootstrap()
      .then((payload) => {
        if (!active) {
          return
        }

        setSnapshot(payload.snapshot)
        if (!feishuStatusReceived) setFeishuStatus(payload.feishuStatus)
        if (!taskWindowReceived) setTaskWindow(payload.taskWindow ?? { expanded: false, pinned: false })
        setSettings(payload.settings)
        setWindowPreferences(payload.window)
        setWindowRole(payload.role)
        setPanelView(payload.panelView)
        setCustomRefreshInput(String(payload.settings.refreshIntervalSeconds))
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
      setCustomRefreshInput(String(payload.settings.refreshIntervalSeconds))
    })

    const disposeCommand = window.codexStatus.onCommand((payload) => {
      if (payload.type !== 'show-panel-view') {
        return
      }

      setPanelView(payload.panelView)
    })

    return () => {
      active = false
      if (dragFrameRef.current !== undefined) window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = undefined
      pendingDragRef.current = undefined
      if (manualRefreshTimerRef.current !== undefined) {
        window.clearTimeout(manualRefreshTimerRef.current)
      }
      disposeSnapshot()
      disposeFeishuStatus()
      disposeTasks()
      disposeTaskWindow()
      disposePreferences()
      disposeCommand()
    }
  }, [])

  useEffect(() => {
    if (!ready || windowRole !== 'panel' || panelView !== 'settings') return
    let active = true
    setFeishuLoaded(false)
    setFeishuIssue('')
    void window.codexStatus.getFeishuSettings().then((value) => {
      if (!active) return
      setFeishuSettings(value)
      setSavedFeishuSettings(value)
      setFeishuLoaded(true)
    }).catch(() => {
      if (active) setFeishuIssue('飞书配置读取失败，请重新打开设置 / Could not load Feishu settings')
    })
    return () => { active = false }
  }, [ready, windowRole, panelView])

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

  const copy = COPY[settings.locale]
  const feishuDirty = (Object.keys(DEFAULT_FEISHU_SETTINGS) as (keyof FeishuSettings)[])
    .some(key => feishuSettings[key] !== savedFeishuSettings[key])
  const canRefresh = snapshot.canRefresh !== false
  const fixedRefreshValues = REFRESH_INTERVAL_OPTIONS.map((option) => String(option))
  const isCustomRefreshInterval = !fixedRefreshValues.includes(
    String(settings.refreshIntervalSeconds)
  )
  const intervalControlValue = isCustomRefreshInterval
    ? 'custom'
    : String(settings.refreshIntervalSeconds)
  const canEditCustomRefresh = settings.refreshMode === 'auto' && isCustomRefreshInterval
  const sourceLabel =
    snapshot.rateLimitSource === 'official'
      ? copy.officialSource
      : snapshot.rateLimitSource === 'cache'
        ? copy.cacheSource
        : copy.emptySource
  const sourceValue = snapshot.sourceHost
  const isStale =
    snapshot.rateLimitSource === 'cache' ||
    Boolean(
      snapshot.lastSuccessAt &&
      (now - Date.parse(snapshot.lastSuccessAt) >
        Math.max(90000, settings.refreshIntervalSeconds * 2000) ||
        snapshot.rateLimits.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now))
    )
  const statusLabel = snapshot.isRefreshing
    ? copy.syncing
    : isStale
      ? copy.stale
      : snapshot.rateLimitSource === 'official'
        ? copy.synced
        : copy.disconnected
  const fallbackBanner =
    snapshot.rateLimitSource === 'cache' && snapshot.officialIssue
      ? {
          title: copy.fallbackTitle,
          body: copy.fallbackBody
        }
      : snapshot.rateLimitSource === 'none' && snapshot.issues.length > 0
        ? {
            title: copy.unavailableTitle,
            body: copy.unavailableBody
          }
        : undefined
  const rateLimitWindows = snapshot.rateLimits
  const rateLimitCount = rateLimitWindows.length
  const primaryWindow = selectPrimaryRateLimit(rateLimitWindows)
  const capsuleDisplayPercent =
    settings.percentageMode === 'used' ? primaryWindow?.usedPercent : primaryWindow?.remainingPercent
  const capsuleTone = resolveMetricTone(capsuleDisplayPercent, settings.percentageMode)
  const capsuleViewMode = windowPreferences.viewMode
  const capsuleClassName = [
    'capsule',
    `capsule--${capsuleViewMode}`,
    `capsule--${capsuleTone}`,
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    isStale ? 'is-stale' : '',
    capsulePointerActive ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

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
    if (!canRefresh || snapshot.isRefreshing) {
      return
    }

    showManualRefreshFeedback()

    try {
      await window.codexStatus.refreshStatus()
    } catch (error) {
      recordSnapshotIssue(error)
    }
  }

  function showManualRefreshFeedback(): void {
    setManualRefreshActive(true)
    if (manualRefreshTimerRef.current !== undefined) {
      window.clearTimeout(manualRefreshTimerRef.current)
    }

    manualRefreshTimerRef.current = window.setTimeout(() => {
      setManualRefreshActive(false)
      manualRefreshTimerRef.current = undefined
    }, MANUAL_REFRESH_FEEDBACK_MS)
  }

  function handleCapsulePointerDown(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || dragFinishingRef.current || capsulePointerRef.current) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    capsulePointerRef.current = {
      pointerId: event.pointerId,
      originScreenX: event.screenX,
      originScreenY: event.screenY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      hasDragged: false
    }
    setCapsulePointerActive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleCapsulePointerMove(event: React.PointerEvent<HTMLElement>): void {
    const pointerState = capsulePointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return
    }

    const distance = Math.hypot(
      event.screenX - pointerState.originScreenX,
      event.screenY - pointerState.originScreenY
    )
    if (distance < CAPSULE_CLICK_DRAG_DISTANCE && !pointerState.hasDragged) {
      return
    }

    pointerState.hasDragged = true
    event.preventDefault()

    pendingDragRef.current = {
      screenX: event.screenX,
      screenY: event.screenY,
      offsetX: pointerState.offsetX,
      offsetY: pointerState.offsetY
    }
    scheduleDragMove()
  }

  function scheduleDragMove(): void {
    if (dragFrameRef.current !== undefined || dragRequestRef.current) return
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = undefined
      const payload = pendingDragRef.current
      pendingDragRef.current = undefined
      if (!payload) return
      // 每帧只发最新位置,且最多一个在途请求;移动坐标无需驱动 React 渲染。
      dragRequestRef.current = window.codexStatus
        .moveCapsuleWindow(payload)
        .then(() => undefined)
        .catch(recordSnapshotIssue)
        .finally(() => {
          dragRequestRef.current = undefined
          if (pendingDragRef.current && !dragFinishingRef.current) scheduleDragMove()
        })
    })
  }

  function handleCapsulePointerUp(event: React.PointerEvent<HTMLElement>): void {
    void finishCapsulePointer(event, true)
  }

  function handleCapsulePointerCancel(event: React.PointerEvent<HTMLElement>): void {
    void finishCapsulePointer(event, false)
  }

  async function finishCapsulePointer(
    event: React.PointerEvent<HTMLElement>,
    shouldRefreshOnClick: boolean
  ): Promise<void> {
    const pointerState = capsulePointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    capsulePointerRef.current = null
    setCapsulePointerActive(false)

    if (pointerState.hasDragged) {
      dragFinishingRef.current = true
      if (dragFrameRef.current !== undefined) window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = undefined
      if (shouldRefreshOnClick) {
        pendingDragRef.current = {
          screenX: event.screenX,
          screenY: event.screenY,
          offsetX: pointerState.offsetX,
          offsetY: pointerState.offsetY
        }
      }
      try {
        await dragRequestRef.current
        const payload = pendingDragRef.current
        pendingDragRef.current = undefined
        if (payload) await window.codexStatus.moveCapsuleWindow(payload).catch(recordSnapshotIssue)
        const nextWindowPreferences = await window.codexStatus.finishCapsuleWindowDrag()
        setWindowPreferences(nextWindowPreferences)
      } catch (error) {
        recordSnapshotIssue(error)
      } finally {
        dragFinishingRef.current = false
      }
      return
    }

    if (shouldRefreshOnClick && canRefresh) {
      void handleRefresh()
    }
  }

  function handleCapsuleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    if (!canRefresh) {
      return
    }

    event.preventDefault()
    void handleRefresh()
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

  async function saveFeishuSettings(): Promise<void> {
    setFeishuBusy('save')
    setFeishuIssue('')
    try {
      const value = await window.codexStatus.saveFeishuSettings(feishuSettings)
      setFeishuSettings(value)
      setSavedFeishuSettings(value)
    } catch (error) {
      setFeishuIssue(error instanceof Error ? error.message : '飞书配置保存失败 / Could not save Feishu settings')
    } finally {
      setFeishuBusy(undefined)
    }
  }

  async function testFeishuNotification(): Promise<void> {
    setFeishuBusy('test')
    setFeishuIssue('')
    try {
      await window.codexStatus.testFeishuNotification()
    } catch {
      setFeishuIssue('无法发送测试通知，请重试 / Could not send the test notification')
    } finally {
      setFeishuBusy(undefined)
    }
  }

  function commitCustomRefreshInterval(): void {
    if (!canEditCustomRefresh) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const parsed = Number.parseInt(customRefreshInput, 10)
    if (!Number.isFinite(parsed)) {
      setCustomRefreshInput(String(settings.refreshIntervalSeconds))
      return
    }

    const normalized = normalizeCustomRefreshInterval(parsed)
    setCustomRefreshInput(String(normalized))
    if (normalized !== settings.refreshIntervalSeconds) {
      void handleSettingsPatch({ refreshIntervalSeconds: normalized })
    }
  }

  function selectRefreshInterval(value: string): void {
    if (value === 'custom') {
      const parsed = Number.parseInt(customRefreshInput, 10)
      const candidate = Number.isFinite(parsed)
        ? normalizeCustomRefreshInterval(parsed)
        : DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
      const nextValue = isFixedRefreshInterval(candidate)
        ? DEFAULT_CUSTOM_REFRESH_INTERVAL_SECONDS
        : candidate

      setCustomRefreshInput(String(nextValue))
      void handleSettingsPatch({ refreshIntervalSeconds: nextValue })
      return
    }

    const nextValue = Number(value)
    setCustomRefreshInput(String(nextValue))
    void handleSettingsPatch({
      refreshIntervalSeconds: nextValue
    })
  }

  if (!ready) {
    return <div className="app-shell" />
  }

  if (windowRole === 'capsule') {
    return (
      <div className="app-shell app-shell--capsule" data-theme={settings.theme}>
        <main
          className={`widget widget--${capsuleViewMode}`}
          style={
            {
              '--status-bar-width': `${CAPSULE_WINDOW_SIZE.width}px`,
              '--status-bar-height': `${CAPSULE_WINDOW_SIZE.height}px`,
              zoom: settings.capsuleScale / 100
            } as CSSProperties
          }
        >
          <section
            aria-label={`${statusLabel}. ${settings.percentageMode === 'used' ? copy.used : copy.remaining}. ${rateLimitWindows.map((window) => `${window.label} ${(settings.percentageMode === 'used' ? window.usedPercent : window.remainingPercent) ?? '--'}%`).join(', ')}. ${copy.refresh}`}
            aria-busy={snapshot.isRefreshing}
            title={`${snapshot.account?.label ?? copy.unknownAccount} · ${statusLabel}\n${settings.percentageMode === 'used' ? copy.used : copy.remaining}\n${copy.capsuleHint}`}
            className={capsuleClassName}
            onKeyDown={handleCapsuleKeyDown}
            onPointerCancel={handleCapsulePointerCancel}
            onPointerDown={handleCapsulePointerDown}
            onPointerMove={handleCapsulePointerMove}
            onPointerUp={handleCapsulePointerUp}
            role={canRefresh ? 'button' : undefined}
            tabIndex={canRefresh ? 0 : -1}
          >
            <div className="status-line" aria-hidden="true">
              <strong>{primaryWindow?.label ?? '--'}</strong>
              <span className="status-line__separator">|</span>
              <span title={formatAbsoluteDate(primaryWindow?.resetsAt, settings.locale)}>
                {formatCapsuleResetTime(primaryWindow?.resetsAt, settings.locale)}
              </span>
              <span className="status-line__separator">|</span>
              <strong className="status-line__value">
                {capsuleDisplayPercent === undefined ? '--' : Math.round(capsuleDisplayPercent) + '%'}
              </strong>
            </div>
          </section>
          <button
            className="capsule__details"
            type="button"
            aria-label={copy.details}
            title={copy.details}
            onClick={() => {
              void window.codexStatus.openPanel().catch(recordSnapshotIssue)
            }}
          >
            <ChevronRightIcon />
          </button>
        </main>
      </div>
    )
  }

  if (windowRole === 'tasks') {
    const runningCount = tasks.tasks.filter(task => task.status === 'running').length
    const current = tasks.tasks.find(task => task.status === 'running') ?? tasks.tasks[0]
    const taskLabel = !tasks.monitoring ? (settings.locale === 'en-US' ? 'Monitoring paused' : '监视已暂停')
      : runningCount ? (current?.title || current?.requestSummary || (settings.locale === 'en-US' ? 'Task running' : '任务执行中'))
      : !current ? (settings.locale === 'en-US' ? 'Waiting for tasks' : '等待新任务')
      : current.status === 'completed' ? (settings.locale === 'en-US' ? 'Turn ended' : '本轮已结束')
      : current.status === 'interrupted' ? (settings.locale === 'en-US' ? 'Interrupted' : '任务已中断')
      : (settings.locale === 'en-US' ? 'Status unknown' : '状态未知')
    return (
      <div className="app-shell app-shell--tasks" data-theme={settings.theme} data-native-glass={Boolean(taskWindow.nativeGlass)}>
        {!taskWindow.expanded ? <div className="monitor-peek" data-status={current?.status ?? 'unknown'}>
          <span className="monitor-peek-drag" title={settings.locale === 'en-US' ? 'Drag to move' : '拖动移动'} aria-hidden="true"><svg viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/><circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/><circle cx="3" cy="11" r="1"/><circle cx="7" cy="11" r="1"/></svg></span>
          <button className="monitor-peek-summary" type="button" title={runningCount && tasks.monitoring ? `${settings.locale === 'en-US' ? `${runningCount} running` : `${runningCount} 个任务进行中`} · ${taskLabel}` : current?.title || taskLabel} onClick={() => {
            void window.codexStatus.setTaskWindowPinned(true).catch(recordSnapshotIssue)
          }}><i aria-hidden="true"/><strong>{runningCount && tasks.monitoring ? (settings.locale === 'en-US' ? 'Running' : '进行中') : 'Codex'}</strong><span>{taskLabel}</span></button>
          <button className="monitor-peek-close" type="button" onClick={closePanel} aria-label={copy.close} title={copy.close}><CloseIcon /></button>
        </div> : null}
        <section className="panel panel--tasks monitor-popup" hidden={!taskWindow.expanded}>
          <TaskList snapshot={tasks} locale={settings.locale} notifications={settings.taskNotifications || feishuStatus.enabled}
            active={taskWindow.expanded} pinned={taskWindow.pinned} onPin={() => {
              void window.codexStatus.setTaskWindowPinned(!taskWindow.pinned).catch(recordSnapshotIssue)
            }}
            onClose={closePanel} onSettings={() => {
              void window.codexStatus.openPanel('settings').catch(recordSnapshotIssue)
            }} />
        </section>
      </div>
    )
  }

  return (
    <div className="app-shell app-shell--panel" data-theme={settings.theme}>
      <section className={`panel panel--${panelView}`}>
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
          <button className="panel__tasks-link" type="button" onClick={() => {
            void window.codexStatus.openPanel('tasks').catch(recordSnapshotIssue)
          }}>
            {settings.locale === 'en-US' ? 'Tasks ↗' : '任务 ↗'}
          </button>
          <button type="button" aria-pressed={panelView === 'settings'} onClick={openSettings}>
            {copy.settings}
          </button>
        </nav>
        {panelView === 'details' ? (
          <div className="panel__body panel__body--details">
            <div className="panel__content">
              <div className="panel__header panel__header--details account-card">
                <div>
                  <p className="panel__eyebrow">{copy.account}</p>
                  <h2 className="panel__account" title={snapshot.account?.label}>
                    {snapshot.account?.label ?? copy.unknownAccount}
                  </h2>
                  {snapshot.account ? (
                    <p className="panel__workspace">
                      {copy.workspace} {snapshot.account.workspace}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`sync-status ${isStale || snapshot.rateLimitSource === 'none' ? 'sync-status--warning' : ''}`}
                  role="status"
                >
                  {statusLabel}
                </span>
              </div>

              <div className="quota-heading">
                <h3>{copy.overview}</h3>
                <span>{settings.percentageMode === 'used' ? copy.used : copy.remaining}</span>
              </div>
              {rateLimitCount > 0 ? (
                <div
                  className={`quota-grid${rateLimitCount === 1 ? ' quota-grid--single' : ''} ${isStale ? 'quota-grid--stale' : ''}`}
                >
                  {rateLimitWindows.map((windowState) => (
                    <QuotaCard
                      key={windowState.id}
                      locale={settings.locale}
                      modeLabel={settings.percentageMode === 'used' ? copy.used : copy.remaining}
                      percentageMode={settings.percentageMode}
                      windowState={windowState}
                      now={now}
                    />
                  ))}
                </div>
              ) : (
                <div className="quota-empty" role="status">
                  <ClockIcon />
                  <h3>
                    {snapshot.isRefreshing
                      ? copy.syncing
                      : snapshot.rateLimitSource === 'official'
                        ? copy.noWindow
                        : copy.unavailableTitle}
                  </h3>
                  <p>
                    {snapshot.rateLimitSource === 'official'
                      ? copy.noWindowBody
                      : copy.unavailableBody}
                  </p>
                </div>
              )}

              {fallbackBanner && rateLimitCount > 0 ? (
                <div className="fallback-card">
                  <div className="fallback-card__icon">
                    <AlertIcon />
                  </div>
                  <div className="fallback-card__content">
                    <p className="fallback-card__title">{fallbackBanner.title}</p>
                    <p className="fallback-card__body">{fallbackBanner.body}</p>
                    {snapshot.officialIssue ? (
                      <p className="fallback-card__body">{snapshot.officialIssue}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <details className="connection-details" open={snapshot.rateLimitSource === 'none'}>
                <summary>
                  {copy.diagnostics}
                  <span>{sourceLabel}</span>
                </summary>
                <dl>
                  <div>
                    <dt>{copy.source}</dt>
                    <dd>{sourceValue}</dd>
                  </div>
                  <div>
                    <dt>{copy.lastRefresh}</dt>
                    <dd>{formatAbsoluteDate(snapshot.generatedAt, settings.locale)}</dd>
                  </div>
                  <div>
                    <dt>{copy.path}</dt>
                    <dd>{snapshot.authPath ?? '--'}</dd>
                  </div>
                </dl>
                {snapshot.issues.map((issue) => (
                  <p className="connection-details__issue" key={issue}>
                    {issue}
                  </p>
                ))}
              </details>
            </div>

            <div className="panel__footer">
              <div className="sync-caption">
                <span>{copy.lastSuccess}</span>
                <strong title={formatAbsoluteDate(snapshot.lastSuccessAt, settings.locale)}>
                  {formatRelativeDate(snapshot.lastSuccessAt, settings.locale) ?? '--'}
                </strong>
              </div>
              <button
                className="ghost-button ghost-button--accent"
                disabled={!canRefresh || snapshot.isRefreshing}
                onClick={() => {
                  void handleRefresh()
                }}
                type="button"
              >
                <HistoryIcon />
                <span>{snapshot.isRefreshing ? copy.syncing : copy.refresh}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="panel__body panel__body--settings">
            <nav className="settings-categories" aria-label={settings.locale === 'en-US' ? 'Settings categories' : '设置分类'}>
              {([
                ['general', settings.locale === 'en-US' ? 'General' : '通用'],
                ['appearance', settings.locale === 'en-US' ? 'Appearance' : '外观'],
                ['tasks', settings.locale === 'en-US' ? 'Tasks' : '任务通知'],
                ['feishu', settings.locale === 'en-US' ? 'Feishu' : '飞书通知'],
                ['receiver', settings.locale === 'en-US' ? 'Receive' : '消息接收']
              ] as const).map(([category, label]) => <button key={category} type="button"
                aria-pressed={settingsCategory === category} aria-controls="settings-content"
                onClick={() => setSettingsCategory(category)}>{label}
                {(category === 'feishu' || category === 'receiver') && feishuDirty ? <i aria-label={settings.locale === 'en-US' ? 'Unsaved changes' : '有未保存修改'} /> : null}
              </button>)}
            </nav>
            <div className="panel__content" id="settings-content" key={settingsCategory}>
              <div className="panel__header">
                <p className="panel__intro">{copy.settingsIntro}</p>
              </div>

              {settingsIssue ? (
                <p className="settings-error" role="alert">
                  {copy.saveError}
                </p>
              ) : null}

              <div className="settings-list">
                <div className="settings-section" hidden={settingsCategory !== 'tasks'}>
                  <p className="settings-section__title">{settings.locale === 'en-US' ? 'Tasks & notifications' : '任务与通知'}</p>
                  {([
                    ['taskMonitoring', settings.locale === 'en-US' ? 'Monitor local tasks' : '本机任务监视'],
                    ['taskNotifications', settings.locale === 'en-US' ? 'Desktop notifications' : '桌面完成通知'],
                    ['taskNotificationSound', settings.locale === 'en-US' ? 'Desktop notification sound' : '桌面通知声音']
                  ] as const).map(([key, label]) => <div className="setting-row" key={key}>
                    <span>{label}</span>
                    <ToggleSwitch checked={settings[key]} label={label} offLabel={copy.disabled} onLabel={copy.enabled}
                      onChange={(checked) => { void handleSettingsPatch({ [key]: checked }) }} />
                  </div>)}
                  <p className="task-help">{settings.locale === 'en-US' ? 'Desktop notifications require OS permission and show the title and request summary. Desktop and Feishu notifications have separate switches. Muted or removed sessions do not notify; historical results are not replayed.' : '桌面通知需系统允许，会显示标题和本轮需求摘要。桌面与飞书通知分别开关；静音或移除的会话不提醒，重启监视不补发历史通知。'}</p>
                </div>
                <div className="settings-section" hidden={settingsCategory !== 'feishu'}>
                  <p className="settings-section__title">{settings.locale === 'en-US' ? 'Feishu mobile notifications' : '飞书手机通知'}</p>
                  <fieldset className="feishu-fields" disabled={!feishuLoaded || Boolean(feishuBusy)}
                    aria-busy={Boolean(feishuBusy)} aria-label={settings.locale === 'en-US' ? 'Feishu settings' : '飞书配置'}>
                    <div className="setting-row">
                      <span>{settings.locale === 'en-US' ? 'Notify when turns end' : '轮次结束时推送'}</span>
                      <ToggleSwitch checked={feishuSettings.enabled}
                        label={settings.locale === 'en-US' ? 'Feishu notifications' : '飞书通知'}
                        offLabel={copy.disabled} onLabel={copy.enabled}
                        onChange={(enabled) => setFeishuSettings({ ...feishuSettings, enabled })} />
                    </div>
                    <div className="setting-row">
                      <span>{settings.locale === 'en-US' ? 'Mention everyone in notifications' : '通知时 @所有人'}</span>
                      <ToggleSwitch checked={feishuSettings.mentionAll}
                        label={settings.locale === 'en-US' ? 'Mention everyone in notifications' : '通知时 @所有人'}
                        offLabel={copy.disabled} onLabel={copy.enabled}
                        onChange={(mentionAll) => setFeishuSettings({ ...feishuSettings, mentionAll })} />
                    </div>
                    <p className="task-help">{settings.locale === 'en-US'
                      ? 'For a personal notification group, enable this to mention yourself without a user ID. The group must allow the bot to mention everyone. Test notifications also mention everyone.'
                      : '个人通知群可开启，无需填写用户 ID；群内需允许机器人 @所有人，测试通知也会 @所有人。'}</p>
                    <label className="feishu-field">
                      <span>{settings.locale === 'en-US' ? 'Webhook URL' : 'Webhook 地址'}</span>
                      <span className="inline-input inline-input--secret">
                        <input type="password" autoComplete="off" spellCheck={false} maxLength={512}
                          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                          value={feishuSettings.webhook}
                          onChange={(event) => setFeishuSettings({ ...feishuSettings, webhook: event.target.value })} />
                      </span>
                    </label>
                    <label className="feishu-field">
                      <span>{settings.locale === 'en-US' ? 'Signing secret (optional)' : '签名密钥（可选）'}</span>
                      <span className="inline-input inline-input--secret">
                        <input type="password" autoComplete="new-password" spellCheck={false} maxLength={256}
                          placeholder={settings.locale === 'en-US' ? 'Required if signature verification is enabled' : '机器人开启签名校验时必填'}
                          value={feishuSettings.secret}
                          onChange={(event) => setFeishuSettings({ ...feishuSettings, secret: event.target.value })} />
                      </span>
                    </label>
                    <div className="feishu-actions">
                      <button className="ghost-button" type="button" disabled={feishuDirty || !savedFeishuSettings.webhook}
                        onClick={() => { void testFeishuNotification() }}>
                        {feishuBusy === 'test' ? (settings.locale === 'en-US' ? 'Sending…' : '发送中…')
                          : (settings.locale === 'en-US' ? 'Send test notification' : '发送测试通知')}
                      </button>
                    </div>
                  </fieldset>
                  <p className="task-help">{settings.locale === 'en-US'
                    ? 'Credentials are encrypted on this computer. Enabling sends titles and request summaries to your Feishu group. Keep Codex Status running and task monitoring on; the desktop Feishu app need not be signed in.'
                    : '地址与密钥加密保存在本机；开启后会将标题和需求摘要发送到指定飞书群。需保持本应用运行并开启任务监视，电脑飞书无需登录。'}</p>
                  {feishuStatus.enabled && !settings.taskMonitoring ? <p className="settings-error" role="status">
                    {settings.locale === 'en-US' ? 'Task monitoring is paused; automatic notifications are paused too.' : '任务监视已关闭，自动推送也已暂停。'}
                  </p> : null}
                  <p className={`task-help${feishuStatus.phase === 'failed' ? ' settings-error' : ''}`} role="status">
                    {feishuStatus.phase === 'sending' ? (settings.locale === 'en-US' ? 'Sending to Feishu…' : '正在发送到飞书…')
                      : feishuStatus.phase === 'sent' ? (settings.locale === 'en-US' ? 'Accepted by Feishu; check your phone.' : '飞书已接收，请检查手机通知。')
                      : feishuStatus.phase === 'failed' ? feishuStatus.issue
                      : (settings.locale === 'en-US' ? 'No notifications sent with this configuration yet.' : '当前配置尚未发送通知。')}
                    {feishuStatus.updatedAt ? ` · ${new Date(feishuStatus.updatedAt).toLocaleTimeString(settings.locale)}` : ''}
                  </p>
                  {feishuIssue ? <p className="settings-error" role="alert">{feishuIssue}</p> : null}
                </div>
                <div className="settings-section" hidden={settingsCategory !== 'receiver'}>
                  <fieldset className="feishu-fields" disabled={!feishuLoaded || Boolean(feishuBusy)}
                    aria-busy={Boolean(feishuBusy)} aria-label={settings.locale === 'en-US' ? 'Message reception settings' : '消息接收设置'}>
                    <FeishuReceiverSettings settings={feishuSettings} onChange={setFeishuSettings} english={settings.locale === 'en-US'} />
                  </fieldset>
                  {feishuIssue ? <p className="settings-error" role="alert">{feishuIssue}</p> : null}
                </div>
                <div className="settings-section" hidden={settingsCategory !== 'general'}>
                  <p className="settings-section__title">{copy.groupRefresh}</p>
                  <SettingField label={copy.refreshMode}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          refreshMode: value as AppSettings['refreshMode']
                        })
                      }}
                      options={[
                        { label: copy.auto, value: 'auto' },
                        { label: copy.manual, value: 'manual' }
                      ]}
                      value={settings.refreshMode}
                    />
                  </SettingField>

                  <SettingField label={copy.refreshInterval}>
                    <div className="setting-stack">
                      <SegmentedControl
                        disabled={settings.refreshMode === 'manual'}
                        onChange={selectRefreshInterval}
                        options={[
                          ...REFRESH_INTERVAL_OPTIONS.map((option) => ({
                            label: `${option}s`,
                            value: String(option)
                          })),
                          { label: copy.custom, value: 'custom' }
                        ]}
                        value={intervalControlValue}
                      />
                      {intervalControlValue === 'custom' ? (
                        <label
                          className={`inline-input ${canEditCustomRefresh ? 'is-active' : 'is-disabled'}`}
                        >
                          <span>{copy.customInterval}</span>
                          <input
                            disabled={!canEditCustomRefresh}
                            max={MAX_REFRESH_INTERVAL_SECONDS}
                            min={MIN_REFRESH_INTERVAL_SECONDS}
                            onBlur={commitCustomRefreshInterval}
                            onChange={(event) => {
                              setCustomRefreshInput(event.target.value)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.currentTarget.blur()
                              }
                            }}
                            step={1}
                            type="number"
                            value={customRefreshInput}
                          />
                          <em>s</em>
                        </label>
                      ) : null}
                    </div>
                  </SettingField>
                </div>

                <div className="settings-section" hidden={settingsCategory !== 'appearance'}>
                  <p className="settings-section__title">{copy.groupDisplay}</p>
                  <SettingField label={copy.theme}>
                    <SegmentedControl
                      value={settings.theme}
                      options={[
                        { label: copy.lightTheme, value: 'light' },
                        { label: copy.darkTheme, value: 'dark' }
                      ]}
                      onChange={(value) => {
                        void handleSettingsPatch({ theme: value as AppSettings['theme'] })
                      }}
                    />
                  </SettingField>
                  <SettingField label={copy.displayMode}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({ displayMode: value as AppSettings['displayMode'] })
                      }}
                      options={[
                        { label: copy.floatingMode, value: 'floating' },
                        { label: copy.trayMode, value: 'tray' }
                      ]}
                      value={settings.displayMode}
                    />
                  </SettingField>

                  <SettingField label={copy.capsuleScale}>
                    <div className="setting-stack">
                      <SegmentedControl
                        value={String(settings.capsuleScale)}
                        options={[100, 125, 150, 200].map((scale) => ({ label: `${scale}%`, value: String(scale) }))}
                        onChange={(value) => { void handleSettingsPatch({ capsuleScale: Number(value) }) }}
                      />
                      <label className="inline-input inline-input--scale">
                        <input
                          key={settings.capsuleScale}
                          type="number"
                          aria-label={copy.capsuleScale}
                          min={100}
                          max={300}
                          step={1}
                          defaultValue={settings.capsuleScale}
                          onBlur={(event) => {
                            const value = event.currentTarget.valueAsNumber
                            const scale = Number.isFinite(value) ? normalizeCapsuleScale(value) : settings.capsuleScale
                            event.currentTarget.value = String(scale)
                            if (scale !== settings.capsuleScale) void handleSettingsPatch({ capsuleScale: scale })
                          }}
                          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                        />
                        <em>%</em>
                      </label>
                      <p className="quota-card__date">
                        {copy.capsuleScaleHint}{' '}
                        {getCapsuleWindowSize('capsule', settings.capsuleScale).width} × {getCapsuleWindowSize('capsule', settings.capsuleScale).height}
                      </p>
                    </div>
                  </SettingField>

                  <SettingField label={copy.percentageMode}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          percentageMode: value as PercentageMode
                        })
                      }}
                      options={[
                        { label: copy.remaining, value: 'remaining' },
                        { label: copy.used, value: 'used' }
                      ]}
                      value={settings.percentageMode}
                    />
                  </SettingField>

                  <SettingField label={copy.language}>
                    <SegmentedControl
                      onChange={(value) => {
                        void handleSettingsPatch({
                          locale: value as LocaleCode
                        })
                      }}
                      options={[
                        { label: '简中', value: 'zh-CN' },
                        { label: 'English', value: 'en-US' }
                      ]}
                      value={settings.locale}
                    />
                  </SettingField>
                </div>

                <div className="settings-section" hidden={settingsCategory !== 'general'}>
                  <p className="settings-section__title">{copy.groupGeneral}</p>
                  <div className="setting-row">
                    <span>{copy.launchAtLogin}</span>
                    <ToggleSwitch
                      checked={settings.launchAtLogin}
                      label={copy.launchAtLogin}
                      offLabel={copy.disabled}
                      onChange={(checked) => {
                        void handleSettingsPatch({ launchAtLogin: checked })
                      }}
                      onLabel={copy.enabled}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="panel__footer">
              <button className="ghost-button" onClick={openDetails} type="button">
                <ChevronLeftIcon />
                <span>{copy.back}</span>
              </button>
              {settingsCategory === 'feishu' || settingsCategory === 'receiver' ? <button
                className="ghost-button ghost-button--accent" type="button"
                disabled={!feishuLoaded || Boolean(feishuBusy) || !feishuDirty}
                onClick={() => { void saveFeishuSettings() }}>
                {feishuBusy === 'save' ? (settings.locale === 'en-US' ? 'Saving…' : '保存中…')
                  : feishuDirty ? (settings.locale === 'en-US' ? 'Save settings' : '保存配置')
                  : (settings.locale === 'en-US' ? 'Saved' : '已保存')}
              </button> : <button
                className="ghost-button ghost-button--accent"
                onClick={closePanel}
                type="button"
              >
                <span>{copy.done}</span>
                <ChevronRightIcon />
              </button>}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function QuotaCard({
  locale,
  modeLabel,
  percentageMode,
  windowState,
  now
}: {
  locale: LocaleCode
  modeLabel: string
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
  now: number
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState?.usedPercent : windowState?.remainingPercent
  const tone = resolveMetricTone(displayPercent, percentageMode)
  const progressStyle = createMetricProgressStyle(displayPercent)

  return (
    <div className={`quota-card quota-card--${tone}`} style={progressStyle}>
      <div className="quota-card__head">
        <span className="quota-card__label">{formatWindowLabel(windowState, locale)}</span>
        <span className="quota-card__mode">{modeLabel}</span>
      </div>
      <div className="quota-card__value">
        {displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}
      </div>
      <span className="quota-card__progress" aria-hidden="true">
        <span />
      </span>
      <p className="quota-card__reset">
        {formatQuotaResetHint(
          windowState.resetsAt
            ? Math.max(0, (Date.parse(windowState.resetsAt) - now) / 1000)
            : undefined,
          locale
        )}
      </p>
      <p className="quota-card__date">{formatAbsoluteDate(windowState.resetsAt, locale)}</p>
    </div>
  )
}

function formatQuotaResetHint(seconds: number | undefined, locale: LocaleCode): string {
  if (seconds === 0) return COPY[locale].pendingReset
  const duration = formatRelativeDuration(seconds, locale, locale === 'zh-CN')
  if (!duration) {
    return '--'
  }

  return locale === 'zh-CN' ? `${duration}重置` : `resets in ${duration}`
}

function formatWindowLabel(windowState: RateLimitWindowSnapshot, locale: LocaleCode): string {
  if (!windowState.windowMinutes) return windowState.label
  const minutes = windowState.windowMinutes
  return locale === 'en-US'
    ? windowState.label
    : minutes >= 1440
      ? `${minutes / 1440} 天`
      : minutes >= 60
        ? `${minutes / 60} 小时`
        : `${minutes} 分钟`
}

function SettingField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-field" role="group" aria-label={label}>
      <span className="setting-field__label">{label}</span>
      {children}
    </div>
  )
}

function SegmentedControl({
  value,
  options,
  onChange,
  disabled
}: {
  value: string
  options: Array<{ label: string; value: string }>
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`segmented ${disabled ? 'is-disabled' : ''}`}>
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ToggleSwitch({
  checked,
  onChange,
  onLabel,
  offLabel,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  onLabel: string
  offLabel: string
  label: string
}): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      aria-label={`${label}: ${checked ? onLabel : offLabel}`}
      className={`toggle-switch ${checked ? 'is-checked' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="toggle-switch__track" aria-hidden="true">
        <span className="toggle-switch__thumb" />
      </span>
    </button>
  )
}

function createMetricProgressStyle(displayPercent: number | undefined): CSSProperties {
  const progress =
    displayPercent === undefined || !Number.isFinite(displayPercent)
      ? 0
      : Math.min(100, Math.max(0, displayPercent))

  return { '--metric-progress': `${progress}%` } as CSSProperties
}

function resolveMetricTone(
  displayPercent: number | undefined,
  percentageMode: PercentageMode
): 'positive' | 'warning' | 'danger' | 'muted' {
  if (displayPercent === undefined) {
    return 'muted'
  }

  const goodScore = percentageMode === 'remaining' ? displayPercent : 100 - displayPercent
  if (goodScore >= 65) {
    return 'positive'
  }
  if (goodScore >= 35) {
    return 'warning'
  }
  return 'danger'
}

function formatAbsoluteDate(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const sameDay = isSameDay(date, now)

  if (locale === 'zh-CN') {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)

    if (sameDay) {
      return `${COPY['zh-CN'].today} ${time}`
    }

    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  }

  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)

  if (sameDay) {
    return `${COPY['en-US'].today}, ${time}`
  }

  return sameYear
    ? `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)}, ${time}`
    : `${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}, ${time}`
}

function formatRelativeDuration(
  value: number | undefined,
  locale: LocaleCode,
  withSuffix = false
): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const totalSeconds = Math.max(0, Math.floor(value))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (locale === 'zh-CN') {
    const parts: string[] = []
    if (days > 0) {
      parts.push(`${days}天`)
    }
    if (hours > 0) {
      parts.push(`${hours}小时`)
    }
    if (minutes > 0 || parts.length === 0) {
      parts.push(`${minutes}分`)
    }
    return `${parts.slice(0, 2).join('')}${withSuffix ? '后' : ''}`
  }

  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`)
  }
  return parts.slice(0, 2).join(' ')
}

function formatRelativeDate(value: string | undefined, locale: LocaleCode): string | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSeconds < 60) {
    return locale === 'zh-CN' ? '刚刚' : 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return locale === 'zh-CN' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return locale === 'zh-CN' ? `${diffHours}小时前` : `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  return locale === 'zh-CN' ? `${diffDays}天前` : `${diffDays}d ago`
}

function formatCapsuleResetTime(value: string | undefined, locale: LocaleCode): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)

  if (isSameDay(date, now)) {
    return time
  }

  const monthDay = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric'
  }).format(date)
  return `${monthDay} ${time}`
}

function normalizeCustomRefreshInterval(value: number): number {
  return Math.min(
    MAX_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(value))
  )
}

function isFixedRefreshInterval(value: number): boolean {
  return REFRESH_INTERVAL_OPTIONS.some((option) => option === value)
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.85"
      />
    </svg>
  )
}

function ClockIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7.5v5l3 2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function HistoryIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M4.5 12A7.5 7.5 0 1 0 7 6.42M4.5 4.5v4h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
      <path
        d="M12 8.25V12l2.75 1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function AlertIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M11.13 4.64 4.37 17.5A1 1 0 0 0 5.25 19h13.5a1 1 0 0 0 .88-1.5L12.87 4.64a1 1 0 0 0-1.74 0Z"
        fill="currentColor"
        opacity="0.12"
      />
      <path
        d="M12 9v4.5M12 16.75h.01M11.13 4.64 4.37 17.5A1 1 0 0 0 5.25 19h13.5a1 1 0 0 0 .88-1.5L12.87 4.64a1 1 0 0 0-1.74 0Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m14 6-6 6 6 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m9 5 7 7-7 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.85"
      />
    </svg>
  )
}

export default App
