import {
  app,
  clipboard,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import { watchFile, unwatchFile } from 'node:fs'
import { join, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import appIcon from '../../build/icon.png?asset'
import {
  CAPSULE_DOCK_THRESHOLD,
  CAPSULE_DOCK_EDGE_GAP,
  CAPSULE_EDGE_GAP,
  CAPSULE_UNDOCK_THRESHOLD,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  PANEL_WINDOW_SIZE,
  createEmptySnapshot,
  normalizeSettings,
  getCapsuleWindowSize,
  type CapsuleDragMovePayload,
  type DockEdge,
  type PanelView,
  type AppSettings,
  type PreferencesPayload,
  type RendererCommandPayload,
  type PersistedState,
  type RendererWindowRole,
  type UsageSnapshot,
  type WindowPreferences
} from '../shared/capsule'
import {
  collectUsageSnapshot,
  clearQuotaCache,
  readOfficialCodexCredentials,
  resolveCodexAuthPath
} from './services/quota'
import { loadPersistedState, savePersistedState } from './services/state'
import { createTrayBitmap, getTrayIconState } from './services/tray-icon'
import { TaskMonitor } from './services/tasks'
import {
  taskWindowBounds,
  taskNotificationContent,
  taskHoverExpanded,
  type TaskWindowState,
  type TasksSnapshot,
  type TaskRecord
} from '../shared/tasks'

function getAutoUpdater(): AppUpdater {
  const { autoUpdater } = electronUpdater
  return autoUpdater
}

const autoUpdater = getAutoUpdater()

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  refresh: 'codex-status:refresh',
  updateSettings: 'codex-status:update-settings',
  closePanel: 'codex-status:close-panel',
  openPanel: 'codex-status:open-panel',
  moveCapsuleWindow: 'codex-status:move-capsule-window',
  finishCapsuleWindowDrag: 'codex-status:finish-capsule-window-drag',
  snapshotUpdated: 'codex-status:snapshot-updated',
  preferencesUpdated: 'codex-status:preferences-updated',
  command: 'codex-status:command'
} as const

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tasksWindow: BrowserWindow | null = null
let taskWindowState: TaskWindowState = { expanded: false, pinned: false }
let taskAnchor: { x: number; y: number } | undefined
let taskHoverTimer: NodeJS.Timeout | undefined
let taskHoverSince = 0
let taskLastInside: boolean | undefined
let taskMovingUntil = 0
let tray: Tray | null = null
let trayMenuKey: string | undefined
let trayTooltip: string | undefined
let trayImageKey: string | undefined
let trayTimer: NodeJS.Timeout | undefined
let refreshTimer: NodeJS.Timeout | undefined
let persistTimer: NodeJS.Timeout | undefined
let refreshPromise: Promise<void> | undefined
let credentialRevision = 0
let currentAccountKey: string | undefined
let refreshQueued = false
let isCapsuleDragging = false
let watchedCodexAuthPath: string | undefined
let isCheckingForUpdates = false
let isQuitting = false
let currentPanelView: PanelView = 'details'
let persistedState: PersistedState = {
  settings: { ...DEFAULT_SETTINGS },
  window: { ...DEFAULT_WINDOW_PREFERENCES },
  panel: {}
}
let currentSnapshot: UsageSnapshot = createEmptySnapshot()
let taskMonitor: TaskMonitor
let taskChanges: Promise<void> = Promise.resolve()
let taskSnapshot: TasksSnapshot = { tasks: [], monitoring: false }
const taskNotifications = new Set<Notification>()

function updateTasks(snapshot: TasksSnapshot, completed: TaskRecord[]): void {
  const countChanged = taskSnapshot.tasks.length !== snapshot.tasks.length
  taskSnapshot = snapshot
  if (countChanged && taskWindowState.expanded) resizeTaskWindow(true)
  sendToRenderers('codex-status:tasks-updated', snapshot)
  refreshTrayMenu()
  if (!completed.length || !persistedState.settings.taskNotifications || isQuitting) return
  if (!Notification.isSupported()) return
  const english = persistedState.settings.locale === 'en-US'
  const notification = new Notification({
    ...taskNotificationContent(completed, english),
    silent: !persistedState.settings.taskNotificationSound,
    icon: appIcon
  })
  taskNotifications.add(notification)
  notification.on('click', () => openPanelWindow('tasks'))
  notification.on('close', () => taskNotifications.delete(notification))
  notification.on('failed', () => taskNotifications.delete(notification))
  notification.show()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.show()
      panelWindow.focus()
      return
    }

    if (persistedState.settings.displayMode === 'floating') {
      showWindow()
    } else {
      openPanelWindow('details')
    }
  })
}

function createCapsuleWindow(): BrowserWindow {
  const bounds = resolveCapsuleBounds(persistedState.window)

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    if (persistedState.settings.displayMode === 'floating') window.show()
  })

  window.on('move', () => {
    const bounds = window.getBounds()
    persistedState = {
      ...persistedState,
      window: {
        ...persistedState.window,
        x: bounds.x,
        y: bounds.y
      }
    }
    queuePersistState()
  })

  window.on('show', () => {
    refreshTrayMenu()
  })

  window.on('hide', () => {
    refreshTrayMenu()
  })

  window.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    window.hide()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(window, 'capsule')

  return window
}

function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...resolvePanelBounds(persistedState.panel.x, persistedState.panel.y),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('move', () => {
    const bounds = window.getBounds()
    persistedState = {
      ...persistedState,
      panel: {
        x: bounds.x,
        y: bounds.y
      }
    }
    queuePersistState()
  })

  window.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    window.hide()
  })

  window.on('closed', () => {
    panelWindow = null
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(window, 'panel')

  return window
}

function openTasksWindow(): void {
  panelWindow?.hide()
  if (tasksWindow && !tasksWindow.isDestroyed()) {
    resizeTaskWindow(taskWindowState.expanded)
    tasksWindow.showInactive()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  taskAnchor ??= { x: Math.round(area.x + (area.width - 280) / 2), y: area.y + 8 }
  taskWindowState = { expanded: false, pinned: false }
  const window = new BrowserWindow({
    ...taskWindowBounds(taskAnchor, area, false),
    roundedCorners: true,
    title: 'Codex Status · Tasks',
    show: false,
    frame: false,
    // 与额度状态条一致，避免 Windows 原生边框/阴影扩出折叠内容区域。
    thickFrame: false,
    hasShadow: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Windows 保持透明底层，避免系统 Acrylic 在应用圆角之外绘制矩形背景。
    visualEffectState: 'active',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  tasksWindow = window
  window.setMenu(null)
  const updateMaterial = (): void => resizeTaskWindow(taskWindowState.expanded)
  nativeTheme.on('updated', updateMaterial)
  window.on('ready-to-show', () => {
    resizeTaskWindow(taskWindowState.expanded)
    window.showInactive()
  })
  window.on('will-move', (_, bounds) => {
    taskAnchor = { x: bounds.x, y: bounds.y }
    taskMovingUntil = Date.now() + 600
  })
  window.on('hide', () => {
    taskWindowState.pinned = false
    resizeTaskWindow(false)
  })
  taskHoverTimer = setInterval(() => {
    if (!window.isVisible() || Date.now() < taskMovingUntil) return
    const point = screen.getCursorScreenPoint(),
      bounds = window.getBounds()
    // 命中区域与裁剪后的可见区域一致，避免窗口系统保留的边缘触发展开。
    const visible = taskWindowBounds(
      bounds,
      screen.getDisplayMatching(bounds).workArea,
      taskWindowState.expanded,
      taskSnapshot.tasks.length
    )
    const inside =
      point.x >= bounds.x &&
      point.x < bounds.x + visible.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + visible.height
    if (inside !== taskLastInside) {
      taskLastInside = inside
      taskHoverSince = Date.now()
    }
    const expanded = taskHoverExpanded(inside, taskWindowState, Date.now() - taskHoverSince)
    if (expanded !== taskWindowState.expanded) resizeTaskWindow(expanded)
  }, 100)
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    nativeTheme.removeListener('updated', updateMaterial)
    clearInterval(taskHoverTimer)
    tasksWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  loadRenderer(window, 'tasks')
}

function resizeTaskWindow(expanded: boolean): void {
  if (!tasksWindow || tasksWindow.isDestroyed() || !taskAnchor) return
  const area = screen.getDisplayNearestPoint(taskAnchor).workArea
  const bounds = taskWindowBounds(taskAnchor, area, expanded, taskSnapshot.tasks.length)
  const nativeGlass =
    expanded &&
    !nativeTheme.prefersReducedTransparency &&
    !nativeTheme.inForcedColorsMode &&
    process.platform === 'darwin'
  if (process.platform === 'darwin') tasksWindow.setVibrancy(nativeGlass ? 'under-window' : null)
  tasksWindow.setBounds(bounds)
  // 保留透明窗口的逐像素合成，圆角和收起高度由渲染层控制，不再用原生区域覆盖。
  taskWindowState.expanded = expanded
  taskWindowState.nativeGlass = nativeGlass
  taskLastInside = undefined
  tasksWindow.webContents.send('codex-status:task-window-updated', taskWindowState)
}

function loadRenderer(window: BrowserWindow, role: RendererWindowRole): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('window', role)
    window.loadURL(url.toString())
    return
  }

  window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: {
      window: role
    }
  })
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    const loadedState = await loadPersistedState()
    electronApp.setAppUserModelId('com.openai.codex-status')

    persistedState = {
      ...loadedState,
      settings: syncLaunchAtLoginPreference(loadedState.settings)
    }
    currentSnapshot = createEmptySnapshot()
    nativeTheme.themeSource = persistedState.settings.theme
    taskMonitor = new TaskMonitor(
      join(dirname(resolveCodexAuthPath()), 'sessions'),
      join(app.getPath('userData'), 'codex-status-tasks.json'),
      updateTasks
    )
    await taskMonitor.load()
    await taskMonitor.setEnabled(persistedState.settings.taskMonitoring)

    if (persistedState.settings.launchAtLogin !== loadedState.settings.launchAtLogin) {
      queuePersistState()
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    registerIpcHandlers()
    mainWindow = createCapsuleWindow()
    createTray()
    watchCodexAuthFile()
    void refreshStatus()

    app.on('activate', function () {
      if (persistedState.settings.displayMode === 'floating') {
        showWindow()
      } else {
        openPanelWindow('details')
      }
    })
  })
}

app.on('window-all-closed', () => {
  return
})

let tasksFlushed = false
app.on('before-quit', (event) => {
  if (taskMonitor && !tasksFlushed) {
    event.preventDefault()
    void taskChanges
      .then(() => taskMonitor.stop())
      .finally(() => {
        tasksFlushed = true
        app.quit()
      })
  }
  isQuitting = true
  clearInterval(trayTimer)
  clearRefreshTimer()
  clearCodexAuthWatcher()
})

function registerIpcHandlers(): void {
  ipcMain.handle('codex-status:mute-task', async (_, id: string, muted: boolean) => {
    if (typeof id === 'string' && typeof muted === 'boolean') await taskMonitor.setMuted(id, muted)
  })
  ipcMain.handle('codex-status:remove-task', async (_, id: string) => {
    if (typeof id === 'string') await taskMonitor.remove(id)
  })
  ipcMain.handle('codex-status:restore-task', async (_, threadId: string) => {
    if (typeof threadId === 'string') await taskMonitor.restore(threadId)
  })
  ipcMain.handle('codex-status:pin-task-window', (event, pinned: boolean) => {
    if (event.sender.id !== tasksWindow?.webContents.id || typeof pinned !== 'boolean') return
    taskWindowState.pinned = pinned
    resizeTaskWindow(pinned || taskWindowState.expanded)
  })
  ipcMain.handle('codex-status:get-tasks', () => taskSnapshot)
  ipcMain.handle('codex-status:copy-task-session', (_, id: string) => {
    const task = typeof id === 'string' ? taskMonitor.get(id) : undefined
    if (task) clipboard.writeText(task.threadId)
  })
  ipcMain.handle(CHANNELS.bootstrap, async (event) => {
    return {
      settings: persistedState.settings,
      window: persistedState.window,
      panel: persistedState.panel,
      snapshot: currentSnapshot,
      role: resolveRendererRole(event.sender.id),
      panelView: currentPanelView,
      taskWindow: taskWindowState
    }
  })

  ipcMain.handle(CHANNELS.refresh, async () => {
    if (!canRefreshStatus()) {
      return currentSnapshot
    }

    await refreshStatus()
    return currentSnapshot
  })

  ipcMain.handle(CHANNELS.updateSettings, async (_, patch: Partial<AppSettings>) => {
    const previousSettings = persistedState.settings
    const nextSettings = syncLaunchAtLoginPreference({
      ...persistedState.settings,
      ...patch
    })

    persistedState = {
      ...persistedState,
      settings: nextSettings
    }

    queuePersistState()
    nativeTheme.themeSource = nextSettings.theme
    if (previousSettings.taskMonitoring !== nextSettings.taskMonitoring) {
      taskChanges = taskChanges.then(() => taskMonitor.setEnabled(nextSettings.taskMonitoring))
      await taskChanges
    }
    syncRefreshTimer()
    if (previousSettings.capsuleScale !== nextSettings.capsuleScale) {
      syncCapsuleWindowBounds()
    }
    if (previousSettings.displayMode !== nextSettings.displayMode) {
      if (nextSettings.displayMode === 'floating') {
        showWindow()
      } else {
        mainWindow?.hide()
      }
    }
    refreshTrayMenu()
    broadcastPreferences()

    if (
      nextSettings.refreshMode === 'auto' &&
      canRefreshStatus() &&
      (previousSettings.refreshMode !== nextSettings.refreshMode ||
        previousSettings.refreshIntervalSeconds !== nextSettings.refreshIntervalSeconds)
    ) {
      void refreshStatus()
    }

    return createPreferencesPayload()
  })

  ipcMain.handle(CHANNELS.closePanel, async (event) => {
    if (event.sender.id === tasksWindow?.webContents.id) tasksWindow.hide()
    else panelWindow?.hide()
  })

  ipcMain.handle(CHANNELS.openPanel, async (_, view: PanelView) => {
    if (view === 'settings' && tasksWindow?.isVisible()) tasksWindow.hide()
    openPanelWindow(view === 'tasks' || view === 'settings' ? view : 'details')
  })

  ipcMain.handle(CHANNELS.moveCapsuleWindow, async (_, payload: CapsuleDragMovePayload) => {
    return moveCapsuleWindow(payload)
  })

  ipcMain.handle(CHANNELS.finishCapsuleWindowDrag, async () => {
    return finishCapsuleWindowDrag()
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(appIcon)
  tray = new Tray(image.isEmpty() ? appIcon : image.resize({ width: 32, height: 32 }))
  trayMenuKey = undefined
  trayTooltip = undefined
  trayImageKey = undefined
  tray.on('click', () => {
    if (persistedState.settings.displayMode === 'floating') {
      toggleWindowVisibility()
    } else {
      openDetailsFromTray()
    }
  })
  tray.on('mouse-enter', refreshTrayMenu)
  refreshTrayMenu()
  trayTimer = setInterval(refreshTrayMenu, 15000)
}

function refreshTrayMenu(): void {
  if (!tray || isQuitting) {
    return
  }

  if (process.platform === 'win32') {
    const { text, color } = getTrayIconState(currentSnapshot, persistedState.settings)
    const imageKey = `${text}:${color}`
    if (imageKey !== trayImageKey) {
      tray.setImage(
        nativeImage.createFromBitmap(createTrayBitmap(text, color), {
          width: 32,
          height: 32,
          scaleFactor: 2
        })
      )
      trayImageKey = imageKey
    }
  }

  const tooltip = buildTrayTooltip()
  if (tooltip !== trayTooltip) {
    tray.setToolTip(tooltip)
    trayTooltip = tooltip
  }
  const menuKey = JSON.stringify([
    persistedState.settings.locale,
    mainWindow?.isVisible() ?? false,
    canRefreshStatus(),
    isCheckingForUpdates
  ])
  if (menuKey === trayMenuKey) return

  const labels = getTrayLabels()
  const menuTemplate: MenuItemConstructorOptions[] = [
    {
      label: persistedState.settings.locale === 'en-US' ? 'Tasks' : '任务列表',
      click: () => openPanelWindow('tasks')
    },
    {
      label: labels.refresh,
      enabled: canRefreshStatus(),
      click: () => {
        void refreshStatus()
      }
    },
    {
      label: labels.toggle,
      click: () => {
        toggleWindowVisibility()
      }
    },
    {
      label: labels.details,
      click: () => {
        openDetailsFromTray()
      }
    },
    {
      label: labels.settings,
      click: () => {
        openSettingsFromTray()
      }
    },
    {
      label: labels.checkForUpdates,
      enabled: !isCheckingForUpdates,
      click: () => {
        void checkForUpdates()
      }
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        quitApp()
      }
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))
  trayMenuKey = menuKey
}

function getTrayLabels(): Record<
  'refresh' | 'toggle' | 'details' | 'settings' | 'checkForUpdates' | 'quit',
  string
> {
  if (persistedState.settings.locale === 'en-US') {
    return {
      refresh: 'Refresh',
      toggle: mainWindow?.isVisible() ? 'Hide Floating Window' : 'Show Floating Window',
      details: 'Details',
      settings: 'Settings',
      checkForUpdates: 'Check for Updates',
      quit: 'Quit'
    }
  }

  return {
    refresh: '刷新',
    toggle: mainWindow?.isVisible() ? '隐藏悬浮窗' : '显示悬浮窗',
    details: '详情',
    settings: '设置',
    checkForUpdates: '检查更新',
    quit: '退出'
  }
}

function buildTrayTooltip(): string {
  const windowTexts = currentSnapshot.rateLimits.map(formatTrayWindowText)
  const suffix = currentSnapshot.isRefreshing
    ? persistedState.settings.locale === 'en-US'
      ? ' · refreshing'
      : ' · 刷新中'
    : currentSnapshot.rateLimitSource === 'cache' ||
        Boolean(
          currentSnapshot.lastSuccessAt &&
          Date.now() - Date.parse(currentSnapshot.lastSuccessAt) >
            Math.max(90000, persistedState.settings.refreshIntervalSeconds * 2000)
        )
      ? persistedState.settings.locale === 'en-US'
        ? ' · saved data'
        : ' · 历史数据'
      : ''

  if (windowTexts.length === 0) {
    return persistedState.settings.locale === 'en-US'
      ? `Codex status unavailable${suffix}`
      : `Codex 暂无额度数据${suffix}`
  }

  const mode =
    persistedState.settings.percentageMode === 'used'
      ? persistedState.settings.locale === 'en-US'
        ? 'Used'
        : '已用'
      : persistedState.settings.locale === 'en-US'
        ? 'Remaining'
        : '剩余'
  return [`Codex · ${mode}${suffix}`, ...windowTexts].join('\n')
}

function formatTrayWindowText(windowState: UsageSnapshot['rateLimits'][number]): string {
  const percentage =
    persistedState.settings.percentageMode === 'used'
      ? windowState.usedPercent
      : windowState.remainingPercent

  const value = percentage === undefined ? '--' : `${Math.round(percentage)}%`
  const isEnglish = persistedState.settings.locale === 'en-US'
  const resetAt = windowState.resetsAt ? Date.parse(windowState.resetsAt) : NaN
  if (!Number.isFinite(resetAt)) {
    return `${windowState.label} ${value} · ${isEnglish ? 'Reset unknown' : '重置时间未知'}`
  }
  const minutes = Math.ceil((resetAt - Date.now()) / 60000)
  if (minutes <= 0) {
    return `${windowState.label} -- · ${isEnglish ? 'Awaiting reset confirmation' : '等待重置确认'}`
  }
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const countdown = `${days ? `${days}d ` : ''}${hours}h ${minutes % 60}m`
  const date = new Date(resetAt)
  const resetTime = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${windowState.label} ${value} · ${countdown} · ${isEnglish ? 'Reset' : '重置'} ${resetTime}`
}

function toggleWindowVisibility(): void {
  if (!mainWindow) {
    return
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
}

function showWindow(): void {
  if (!mainWindow) {
    return
  }

  const bounds = resolveCapsuleBounds(persistedState.window)
  setCapsuleBounds(bounds)
  mainWindow.show()
  mainWindow.focus()
}

function openSettingsFromTray(): void {
  openPanelWindow('settings')
}

function openDetailsFromTray(): void {
  openPanelWindow('details')
}

async function checkForUpdates(): Promise<void> {
  if (isCheckingForUpdates) {
    return
  }

  const isEnglish = persistedState.settings.locale === 'en-US'
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: isEnglish ? 'Check for Updates' : '检查更新',
      message: isEnglish
        ? 'Update checks are available in the installed app.'
        : '检查更新仅适用于已安装的正式版本。'
    })
    return
  }

  isCheckingForUpdates = true
  refreshTrayMenu()

  try {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    const update = await autoUpdater.checkForUpdates()
    if (!update) {
      throw new Error(isEnglish ? 'The updater is unavailable.' : '更新服务不可用。')
    }

    const currentVersion = app.getVersion()
    if (!update.isUpdateAvailable) {
      await dialog.showMessageBox({
        type: 'info',
        title: isEnglish ? 'Check for Updates' : '检查更新',
        message: isEnglish ? 'You are using the latest version.' : '当前已是最新版本。',
        detail: isEnglish ? `Current version: v${currentVersion}` : `当前版本：v${currentVersion}`
      })
      return
    }

    const latestVersion = update.updateInfo.version
    const result = await dialog.showMessageBox({
      type: 'info',
      title: isEnglish ? 'Update Available' : '发现新版本',
      message: isEnglish
        ? `Version v${latestVersion} is available.`
        : `发现新版本 v${latestVersion}。`,
      detail: isEnglish ? `Current version: v${currentVersion}` : `当前版本：v${currentVersion}`,
      buttons: isEnglish ? ['Update and Restart', 'Later'] : ['更新并重启', '稍后'],
      defaultId: 0,
      cancelId: 1
    })
    if (result.response !== 0) {
      return
    }

    new Notification({
      title: isEnglish ? 'Updating Codex Status' : '正在更新 Codex Status',
      body: isEnglish ? 'Downloading the update…' : '正在下载更新…',
      silent: true
    }).show()
    await autoUpdater.downloadUpdate()
    prepareToQuit()
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    if (!isQuitting) {
      dialog.showErrorBox(
        isEnglish ? 'Update Check Failed' : '检查更新失败',
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    isCheckingForUpdates = false
    if (!isQuitting) {
      refreshTrayMenu()
    }
  }
}

function prepareToQuit(): void {
  isQuitting = true
  clearInterval(trayTimer)
  clearRefreshTimer()
  clearCodexAuthWatcher()
  tray?.destroy()
  panelWindow?.destroy()
  tasksWindow?.destroy()
}

function quitApp(): void {
  prepareToQuit()
  app.quit()
}

function watchCodexAuthFile(): void {
  watchedCodexAuthPath = resolveCodexAuthPath()
  watchFile(watchedCodexAuthPath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
      return
    }

    credentialRevision += 1
    const revision = credentialRevision
    void readOfficialCodexCredentials().then((lookup) => {
      if (isQuitting || revision !== credentialRevision) return
      syncAccountIdentity(lookup.credentials?.key)
      void refreshStatus({ forceCredentialCheck: true })
    })
  })
}

function syncAccountIdentity(accountKey: string | undefined): void {
  if (currentAccountKey === accountKey) return
  currentAccountKey = accountKey
  clearQuotaCache()
  currentSnapshot = { ...createEmptySnapshot(), isRefreshing: true }
  broadcastSnapshot()
  refreshTrayMenu()
}

function clearCodexAuthWatcher(): void {
  if (!watchedCodexAuthPath) {
    return
  }

  unwatchFile(watchedCodexAuthPath)
  watchedCodexAuthPath = undefined
}

function syncRefreshTimer(): void {
  clearRefreshTimer()
  if (persistedState.settings.refreshMode !== 'auto' || !canRefreshStatus()) {
    return
  }

  refreshTimer = setInterval(() => {
    void refreshStatus()
  }, persistedState.settings.refreshIntervalSeconds * 1000)
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

async function refreshStatus(options: { forceCredentialCheck?: boolean } = {}): Promise<void> {
  if (refreshPromise) {
    if (options.forceCredentialCheck) refreshQueued = true
    return refreshPromise
  }

  if (!options.forceCredentialCheck && !canRefreshStatus() && currentSnapshot.generatedAt) {
    syncRefreshTimer()
    return
  }

  currentSnapshot = {
    ...currentSnapshot,
    isRefreshing: true
  }
  broadcastSnapshot()
  refreshTrayMenu()

  const revision = credentialRevision
  refreshPromise = (async () => {
    try {
      const lookup = await readOfficialCodexCredentials()
      if (revision !== credentialRevision) return
      syncAccountIdentity(lookup.credentials?.key)
      const nextSnapshot = await collectUsageSnapshot(lookup)
      if (revision === credentialRevision) currentSnapshot = nextSnapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (revision === credentialRevision)
        currentSnapshot = {
          ...createEmptySnapshot(),
          isRefreshing: false,
          issues: [message]
        }
    } finally {
      currentSnapshot = {
        ...currentSnapshot,
        isRefreshing: false
      }
      syncCapsuleWindowBounds()
      broadcastSnapshot()
      refreshTrayMenu()
      syncRefreshTimer()
      refreshPromise = undefined
      if (refreshQueued) {
        refreshQueued = false
        void refreshStatus({ forceCredentialCheck: true })
      }
    }
  })()

  return refreshPromise
}

function canRefreshStatus(): boolean {
  return currentSnapshot.canRefresh !== false
}

function syncCapsuleWindowBounds(): void {
  if (isCapsuleDragging) return
  setCapsuleBounds(resolveCapsuleBounds(persistedState.window))
}

function setCapsuleBounds(bounds: Rectangle): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const current = mainWindow.getBounds()
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  )
    return
  if (current.width === bounds.width && current.height === bounds.height) {
    mainWindow.setPosition(bounds.x, bounds.y, false)
  } else {
    mainWindow.setBounds(bounds, false)
  }
}

function broadcastSnapshot(): void {
  sendToRenderers(CHANNELS.snapshotUpdated, currentSnapshot)
}

function broadcastPreferences(): void {
  sendToRenderers(CHANNELS.preferencesUpdated, createPreferencesPayload())
}

function createPreferencesPayload(): PreferencesPayload {
  return {
    settings: persistedState.settings,
    window: persistedState.window,
    panel: persistedState.panel
  }
}

function syncLaunchAtLoginPreference(settings: AppSettings): AppSettings {
  const normalizedSettings = normalizeSettings(settings)

  if (!isLaunchAtLoginSupported()) {
    return {
      ...normalizedSettings,
      launchAtLogin: false
    }
  }

  app.setLoginItemSettings({
    openAtLogin: normalizedSettings.launchAtLogin
  })

  return {
    ...normalizedSettings,
    launchAtLogin: app.getLoginItemSettings().openAtLogin
  }
}

function isLaunchAtLoginSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function openPanelWindow(view: PanelView): void {
  if (view === 'tasks') {
    openTasksWindow()
    return
  }
  currentPanelView = view
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelWindow = createPanelWindow()
  } else {
    if (!panelWindow.isVisible()) {
      panelWindow.setBounds(resolvePanelBounds(persistedState.panel.x, persistedState.panel.y))
    }
    panelWindow.show()
    panelWindow.focus()
  }

  panelWindow.webContents.send(CHANNELS.command, {
    type: 'show-panel-view',
    panelView: currentPanelView
  } satisfies RendererCommandPayload)
}

function moveCapsuleWindow(payload: CapsuleDragMovePayload): WindowPreferences {
  if (!mainWindow) {
    return persistedState.window
  }

  isCapsuleDragging = true
  const nextPreferences = resolveDraggedCapsuleWindow(payload)
  applyCapsuleWindowPreferences(nextPreferences, true)
  return persistedState.window
}

function finishCapsuleWindowDrag(): WindowPreferences {
  isCapsuleDragging = false
  if (!mainWindow) {
    return persistedState.window
  }

  applyCapsuleWindowPreferences(resolveSettledCapsuleWindow(persistedState.window))
  broadcastPreferences()
  return persistedState.window
}

function applyCapsuleWindowPreferences(
  preferences: WindowPreferences,
  allowFloatingOrb = false
): void {
  const bounds = resolveCapsuleBounds(preferences, allowFloatingOrb)
  persistedState = {
    ...persistedState,
    window: {
      ...preferences,
      x: bounds.x,
      y: bounds.y
    }
  }
  setCapsuleBounds(bounds)
  queuePersistState()
}

function resolveDraggedCapsuleWindow(payload: CapsuleDragMovePayload): WindowPreferences {
  const currentBounds = mainWindow?.getBounds() ?? resolveCapsuleBounds(persistedState.window)
  const offsetX = clamp(
    getFiniteNumber(payload.offsetX, currentBounds.width / 2),
    0,
    currentBounds.width
  )
  const offsetY = clamp(
    getFiniteNumber(payload.offsetY, currentBounds.height / 2),
    0,
    currentBounds.height
  )
  const screenX = getFiniteNumber(payload.screenX, currentBounds.x + offsetX)
  const screenY = getFiniteNumber(payload.screenY, currentBounds.y + offsetY)
  const desiredX = Math.round(screenX - offsetX)
  const desiredY = Math.round(screenY - offsetY)
  const workArea = getTargetWorkArea(desiredX, desiredY)
  const workAreaRight = workArea.x + workArea.width
  const isDraggingOrb =
    persistedState.window.viewMode === 'orb' && Boolean(persistedState.window.dockEdge)
  const size = resolveCapsuleWindowSize(isDraggingOrb ? 'orb' : 'capsule')
  const x = clamp(
    desiredX,
    workArea.x + CAPSULE_DOCK_EDGE_GAP,
    workAreaRight - size.width - CAPSULE_DOCK_EDGE_GAP
  )
  const y = clamp(
    desiredY,
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - size.height - CAPSULE_EDGE_GAP
  )

  return {
    x,
    y,
    viewMode: isDraggingOrb ? 'orb' : 'capsule',
    dockEdge: isDraggingOrb ? persistedState.window.dockEdge : undefined
  }
}

function resolveSettledCapsuleWindow(preferences: WindowPreferences): WindowPreferences {
  if (preferences.viewMode === 'orb' && preferences.dockEdge) {
    return resolveSettledOrbWindow(preferences)
  }

  const capsuleBounds = resolveCapsuleBounds({
    ...preferences,
    viewMode: 'capsule',
    dockEdge: undefined
  })
  const workArea = getTargetWorkArea(capsuleBounds.x, capsuleBounds.y)
  const workAreaRight = workArea.x + workArea.width
  const capsuleSize = resolveCapsuleWindowSize('capsule')
  const orbSize = resolveCapsuleWindowSize('orb')
  const capsuleRight = capsuleBounds.x + capsuleSize.width
  let dockEdge: DockEdge | undefined

  if (capsuleBounds.x <= workArea.x + CAPSULE_DOCK_THRESHOLD) {
    dockEdge = 'left'
  } else if (capsuleRight >= workAreaRight - CAPSULE_DOCK_THRESHOLD) {
    dockEdge = 'right'
  }

  if (!dockEdge) {
    return {
      x: capsuleBounds.x,
      y: capsuleBounds.y,
      viewMode: 'capsule'
    }
  }

  const y = clamp(
    capsuleBounds.y + Math.round((capsuleSize.height - orbSize.height) / 2),
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - orbSize.height - CAPSULE_EDGE_GAP
  )

  return {
    x:
      dockEdge === 'left'
        ? workArea.x + CAPSULE_DOCK_EDGE_GAP
        : workAreaRight - orbSize.width - CAPSULE_DOCK_EDGE_GAP,
    y,
    viewMode: 'orb',
    dockEdge
  }
}

function resolveSettledOrbWindow(preferences: WindowPreferences): WindowPreferences {
  const orbBounds = resolveCapsuleBounds(preferences, true)
  const workArea = getTargetWorkArea(orbBounds.x, orbBounds.y)
  const workAreaRight = workArea.x + workArea.width
  const capsuleSize = resolveCapsuleWindowSize('capsule')
  const orbSize = resolveCapsuleWindowSize('orb')
  const orbRight = orbBounds.x + orbSize.width
  const keepsLeftDock =
    preferences.dockEdge === 'left' && orbBounds.x <= workArea.x + CAPSULE_UNDOCK_THRESHOLD
  const keepsRightDock =
    preferences.dockEdge === 'right' && orbRight >= workAreaRight - CAPSULE_UNDOCK_THRESHOLD

  if (keepsLeftDock || keepsRightDock) {
    return {
      x:
        preferences.dockEdge === 'left'
          ? workArea.x + CAPSULE_DOCK_EDGE_GAP
          : workAreaRight - orbSize.width - CAPSULE_DOCK_EDGE_GAP,
      y: orbBounds.y,
      viewMode: 'orb',
      dockEdge: preferences.dockEdge
    }
  }

  return {
    x: clamp(
      orbBounds.x + Math.round((orbSize.width - capsuleSize.width) / 2),
      workArea.x + CAPSULE_EDGE_GAP,
      workAreaRight - capsuleSize.width - CAPSULE_EDGE_GAP
    ),
    y: clamp(
      orbBounds.y + Math.round((orbSize.height - capsuleSize.height) / 2),
      workArea.y + CAPSULE_EDGE_GAP,
      workArea.y + workArea.height - capsuleSize.height - CAPSULE_EDGE_GAP
    ),
    viewMode: 'capsule'
  }
}

function resolveCapsuleBounds(
  windowPreferences: WindowPreferences,
  allowFloatingOrb = false
): Rectangle {
  const viewMode =
    windowPreferences.viewMode === 'orb' && (windowPreferences.dockEdge || allowFloatingOrb)
      ? windowPreferences.viewMode
      : 'capsule'
  const { width, height } = resolveCapsuleWindowSize(viewMode)
  const workArea = getTargetWorkArea(windowPreferences.x, windowPreferences.y)
  const fallbackX = workArea.x + workArea.width - width - 40
  const fallbackY = workArea.y + 36
  const maxX = Math.max(
    workArea.x + CAPSULE_EDGE_GAP,
    workArea.x + workArea.width - width - CAPSULE_EDGE_GAP
  )
  const maxY = Math.max(
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - height - CAPSULE_EDGE_GAP
  )
  const x =
    viewMode === 'orb' && windowPreferences.dockEdge === 'left' && !allowFloatingOrb
      ? workArea.x + CAPSULE_DOCK_EDGE_GAP
      : viewMode === 'orb' && windowPreferences.dockEdge === 'right' && !allowFloatingOrb
        ? workArea.x + workArea.width - width - CAPSULE_DOCK_EDGE_GAP
        : clamp(
            typeof windowPreferences.x === 'number' ? Math.round(windowPreferences.x) : fallbackX,
            viewMode === 'orb' ? workArea.x + CAPSULE_DOCK_EDGE_GAP : workArea.x + CAPSULE_EDGE_GAP,
            viewMode === 'orb' ? workArea.x + workArea.width - width - CAPSULE_DOCK_EDGE_GAP : maxX
          )

  return {
    x,
    y: clamp(
      typeof windowPreferences.y === 'number' ? Math.round(windowPreferences.y) : fallbackY,
      workArea.y + CAPSULE_EDGE_GAP,
      maxY
    ),
    width,
    height
  }
}

function resolveCapsuleWindowSize(viewMode: 'capsule' | 'orb'): {
  width: number
  height: number
} {
  return getCapsuleWindowSize(viewMode, persistedState.settings.capsuleScale)
}

function resolvePanelBounds(x?: number, y?: number): Rectangle {
  const width = PANEL_WINDOW_SIZE.width
  const height = PANEL_WINDOW_SIZE.height
  const workArea = getTargetWorkArea(x, y)
  const fallbackX = workArea.x + workArea.width - width - 40
  const fallbackY = workArea.y + 120
  const maxX = Math.max(workArea.x + 8, workArea.x + workArea.width - width - 8)
  const maxY = Math.max(workArea.y + 8, workArea.y + workArea.height - height - 8)

  return {
    x: clamp(typeof x === 'number' ? Math.round(x) : fallbackX, workArea.x + 8, maxX),
    y: clamp(typeof y === 'number' ? Math.round(y) : fallbackY, workArea.y + 8, maxY),
    width,
    height
  }
}

function sendToRenderers(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
  panelWindow?.webContents.send(channel, payload)
  tasksWindow?.webContents.send(channel, payload)
}

function resolveRendererRole(webContentsId: number): RendererWindowRole {
  if (tasksWindow?.webContents.id === webContentsId) return 'tasks'
  return panelWindow?.webContents.id === webContentsId ? 'panel' : 'capsule'
}

function getTargetWorkArea(x?: number, y?: number): Rectangle {
  if (typeof x === 'number' && typeof y === 'number') {
    return screen.getDisplayNearestPoint({ x, y }).workArea
  }
  return screen.getPrimaryDisplay().workArea
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function queuePersistState(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
  }

  persistTimer = setTimeout(() => {
    void savePersistedState(persistedState)
  }, 180)
}
