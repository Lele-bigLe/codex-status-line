import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../build/icon-1.png?asset'
import trayIcon from '../../build/icon-2.png?asset'
import {
  CAPSULE_DOCK_THRESHOLD,
  CAPSULE_DOCK_EDGE_GAP,
  CAPSULE_EDGE_GAP,
  CAPSULE_WINDOW_SIZE,
  CAPSULE_UNDOCK_THRESHOLD,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_PREFERENCES,
  ORB_WINDOW_SIZE,
  PANEL_WINDOW_SIZE,
  createEmptySnapshot,
  normalizeSettings,
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
import { collectUsageSnapshot } from './services/quota'
import { loadPersistedState, savePersistedState } from './services/state'

const CHANNELS = {
  bootstrap: 'codex-status:bootstrap',
  refresh: 'codex-status:refresh',
  updateSettings: 'codex-status:update-settings',
  closePanel: 'codex-status:close-panel',
  moveCapsuleWindow: 'codex-status:move-capsule-window',
  finishCapsuleWindowDrag: 'codex-status:finish-capsule-window-drag',
  snapshotUpdated: 'codex-status:snapshot-updated',
  preferencesUpdated: 'codex-status:preferences-updated',
  command: 'codex-status:command'
} as const

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let refreshTimer: NodeJS.Timeout | undefined
let persistTimer: NodeJS.Timeout | undefined
let refreshPromise: Promise<void> | undefined
let isQuitting = false
let currentPanelView: PanelView = 'details'
let persistedState: PersistedState = {
  settings: { ...DEFAULT_SETTINGS },
  window: { ...DEFAULT_WINDOW_PREFERENCES },
  panel: {}
}
let currentSnapshot: UsageSnapshot = createEmptySnapshot()

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

    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow()
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
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: appIcon } : {}),
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
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: appIcon } : {}),
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
    syncRefreshTimer()
    void refreshStatus()

    app.on('activate', function () {
      if (mainWindow === null) {
        mainWindow = createCapsuleWindow()
        refreshTrayMenu()
        return
      }

      showWindow()
    })
  })
}

app.on('window-all-closed', () => {
  return
})

app.on('before-quit', () => {
  isQuitting = true
  clearRefreshTimer()
})

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.bootstrap, async (event) => {
    return {
      settings: persistedState.settings,
      window: persistedState.window,
      panel: persistedState.panel,
      snapshot: currentSnapshot,
      role: resolveRendererRole(event.sender.id),
      panelView: currentPanelView
    }
  })

  ipcMain.handle(CHANNELS.refresh, async () => {
    await refreshStatus()
    return currentSnapshot
  })

  ipcMain.handle(CHANNELS.updateSettings, async (_, patch: Partial<AppSettings>) => {
    const nextSettings = syncLaunchAtLoginPreference({
      ...persistedState.settings,
      ...patch
    })

    persistedState = {
      ...persistedState,
      settings: nextSettings
    }

    queuePersistState()
    syncRefreshTimer()
    refreshTrayMenu()
    broadcastPreferences()

    if (persistedState.settings.refreshMode === 'auto') {
      void refreshStatus()
    }

    return createPreferencesPayload()
  })

  ipcMain.handle(CHANNELS.closePanel, async () => {
    panelWindow?.hide()
  })

  ipcMain.handle(CHANNELS.moveCapsuleWindow, async (_, payload: CapsuleDragMovePayload) => {
    return moveCapsuleWindow(payload)
  })

  ipcMain.handle(CHANNELS.finishCapsuleWindowDrag, async () => {
    return finishCapsuleWindowDrag()
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIcon)
  tray = new Tray(image.isEmpty() ? trayIcon : image.resize({ width: 16, height: 16 }))
  tray.on('click', () => {
    toggleWindowVisibility()
  })
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) {
    return
  }

  const labels = getTrayLabels()
  const menuTemplate: MenuItemConstructorOptions[] = [
    {
      label: labels.refresh,
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
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        quitApp()
      }
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))
  tray.setToolTip(buildTrayTooltip())
}

function getTrayLabels(): Record<'refresh' | 'toggle' | 'details' | 'settings' | 'quit', string> {
  if (persistedState.settings.locale === 'en-US') {
    return {
      refresh: 'Refresh',
      toggle: 'Show/Hide',
      details: 'Details',
      settings: 'Settings',
      quit: 'Quit'
    }
  }

  return {
    refresh: '刷新',
    toggle: '显示/隐藏',
    details: '详情',
    settings: '设置',
    quit: '退出'
  }
}

function buildTrayTooltip(): string {
  const primaryText = formatTrayWindowText(currentSnapshot.rateLimits.primary)
  const secondaryText = formatTrayWindowText(currentSnapshot.rateLimits.secondary)
  const suffix = currentSnapshot.isRefreshing
    ? persistedState.settings.locale === 'en-US'
      ? ' · refreshing'
      : ' · 刷新中'
    : ''

  if (!primaryText && !secondaryText) {
    return persistedState.settings.locale === 'en-US'
      ? `Codex status unavailable${suffix}`
      : `Codex 暂无额度数据${suffix}`
  }

  const segments = ['Codex']
  if (primaryText) {
    segments.push(primaryText)
  }
  if (secondaryText) {
    segments.push(secondaryText)
  }

  return `${segments.join('  ')}${suffix}`
}

function formatTrayWindowText(
  windowState: UsageSnapshot['rateLimits']['primary']
): string | undefined {
  if (!windowState) {
    return undefined
  }

  const percentage =
    persistedState.settings.percentageMode === 'used'
      ? windowState.usedPercent
      : windowState.remainingPercent

  return percentage === undefined
    ? `${windowState.label} --`
    : `${windowState.label} ${Math.round(percentage)}%`
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
  mainWindow.setBounds(bounds)
  mainWindow.show()
  mainWindow.focus()
}

function openSettingsFromTray(): void {
  openPanelWindow('settings')
}

function openDetailsFromTray(): void {
  openPanelWindow('details')
}

function quitApp(): void {
  isQuitting = true
  clearRefreshTimer()
  tray?.destroy()
  panelWindow?.destroy()
  app.quit()
}

function syncRefreshTimer(): void {
  clearRefreshTimer()
  if (persistedState.settings.refreshMode !== 'auto') {
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

async function refreshStatus(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise
  }

  currentSnapshot = {
    ...currentSnapshot,
    isRefreshing: true
  }
  broadcastSnapshot()
  refreshTrayMenu()

  refreshPromise = (async () => {
    try {
      currentSnapshot = await collectUsageSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      currentSnapshot = {
        ...currentSnapshot,
        isRefreshing: false,
        issues: Array.from(new Set([message, ...currentSnapshot.issues])).slice(0, 6)
      }
    } finally {
      currentSnapshot = {
        ...currentSnapshot,
        isRefreshing: false
      }
      broadcastSnapshot()
      refreshTrayMenu()
      refreshPromise = undefined
    }
  })()

  return refreshPromise
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

  const nextPreferences = resolveDraggedCapsuleWindow(payload)
  applyCapsuleWindowPreferences(nextPreferences, true)
  return persistedState.window
}

function finishCapsuleWindowDrag(): WindowPreferences {
  if (!mainWindow) {
    return persistedState.window
  }

  applyCapsuleWindowPreferences(resolveSettledCapsuleWindow(persistedState.window))
  broadcastPreferences()
  return persistedState.window
}

function applyCapsuleWindowPreferences(preferences: WindowPreferences, allowFloatingOrb = false): void {
  const bounds = resolveCapsuleBounds(preferences, allowFloatingOrb)
  persistedState = {
    ...persistedState,
    window: {
      ...preferences,
      x: bounds.x,
      y: bounds.y
    }
  }
  mainWindow?.setBounds(bounds)
  queuePersistState()
}

function resolveDraggedCapsuleWindow(payload: CapsuleDragMovePayload): WindowPreferences {
  const currentBounds = mainWindow?.getBounds() ?? resolveCapsuleBounds(persistedState.window)
  const offsetX = clamp(getFiniteNumber(payload.offsetX, currentBounds.width / 2), 0, currentBounds.width)
  const offsetY = clamp(getFiniteNumber(payload.offsetY, currentBounds.height / 2), 0, currentBounds.height)
  const screenX = getFiniteNumber(payload.screenX, currentBounds.x + offsetX)
  const screenY = getFiniteNumber(payload.screenY, currentBounds.y + offsetY)
  const desiredX = Math.round(screenX - offsetX)
  const desiredY = Math.round(screenY - offsetY)
  const workArea = getTargetWorkArea(desiredX, desiredY)
  const workAreaRight = workArea.x + workArea.width
  const isDraggingOrb = persistedState.window.viewMode === 'orb' && Boolean(persistedState.window.dockEdge)
  const size = isDraggingOrb ? ORB_WINDOW_SIZE : CAPSULE_WINDOW_SIZE
  const x = clamp(desiredX, workArea.x + CAPSULE_DOCK_EDGE_GAP, workAreaRight - size.width - CAPSULE_DOCK_EDGE_GAP)
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
  const capsuleRight = capsuleBounds.x + CAPSULE_WINDOW_SIZE.width
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
    capsuleBounds.y + Math.round((CAPSULE_WINDOW_SIZE.height - ORB_WINDOW_SIZE.height) / 2),
    workArea.y + CAPSULE_EDGE_GAP,
    workArea.y + workArea.height - ORB_WINDOW_SIZE.height - CAPSULE_EDGE_GAP
  )

  return {
    x:
      dockEdge === 'left'
        ? workArea.x + CAPSULE_DOCK_EDGE_GAP
        : workAreaRight - ORB_WINDOW_SIZE.width - CAPSULE_DOCK_EDGE_GAP,
    y,
    viewMode: 'orb',
    dockEdge
  }
}

function resolveSettledOrbWindow(preferences: WindowPreferences): WindowPreferences {
  const orbBounds = resolveCapsuleBounds(preferences, true)
  const workArea = getTargetWorkArea(orbBounds.x, orbBounds.y)
  const workAreaRight = workArea.x + workArea.width
  const orbRight = orbBounds.x + ORB_WINDOW_SIZE.width
  const keepsLeftDock = preferences.dockEdge === 'left' && orbBounds.x <= workArea.x + CAPSULE_UNDOCK_THRESHOLD
  const keepsRightDock = preferences.dockEdge === 'right' && orbRight >= workAreaRight - CAPSULE_UNDOCK_THRESHOLD

  if (keepsLeftDock || keepsRightDock) {
    return {
      x:
        preferences.dockEdge === 'left'
          ? workArea.x + CAPSULE_DOCK_EDGE_GAP
          : workAreaRight - ORB_WINDOW_SIZE.width - CAPSULE_DOCK_EDGE_GAP,
      y: orbBounds.y,
      viewMode: 'orb',
      dockEdge: preferences.dockEdge
    }
  }

  return {
    x: clamp(
      orbBounds.x + Math.round((ORB_WINDOW_SIZE.width - CAPSULE_WINDOW_SIZE.width) / 2),
      workArea.x + CAPSULE_EDGE_GAP,
      workAreaRight - CAPSULE_WINDOW_SIZE.width - CAPSULE_EDGE_GAP
    ),
    y: clamp(
      orbBounds.y + Math.round((ORB_WINDOW_SIZE.height - CAPSULE_WINDOW_SIZE.height) / 2),
      workArea.y + CAPSULE_EDGE_GAP,
      workArea.y + workArea.height - CAPSULE_WINDOW_SIZE.height - CAPSULE_EDGE_GAP
    ),
    viewMode: 'capsule'
  }
}

function resolveCapsuleBounds(windowPreferences: WindowPreferences, allowFloatingOrb = false): Rectangle {
  const viewMode =
    windowPreferences.viewMode === 'orb' && (windowPreferences.dockEdge || allowFloatingOrb)
      ? windowPreferences.viewMode
      : 'capsule'
  const { width, height } = viewMode === 'orb' ? ORB_WINDOW_SIZE : CAPSULE_WINDOW_SIZE
  const workArea = getTargetWorkArea(windowPreferences.x, windowPreferences.y)
  const fallbackX = workArea.x + workArea.width - width - 40
  const fallbackY = workArea.y + 36
  const maxX = Math.max(workArea.x + CAPSULE_EDGE_GAP, workArea.x + workArea.width - width - CAPSULE_EDGE_GAP)
  const maxY = Math.max(workArea.y + CAPSULE_EDGE_GAP, workArea.y + workArea.height - height - CAPSULE_EDGE_GAP)
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
}

function resolveRendererRole(webContentsId: number): RendererWindowRole {
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
