export type PercentageMode = 'remaining' | 'used'
export type RefreshMode = 'auto' | 'manual'
export type LocaleCode = 'zh-CN' | 'en-US'
export type RateLimitSource = 'official' | 'cache' | 'none'
export type PanelView = 'details' | 'settings' | 'tasks'
export type RendererWindowRole = 'capsule' | 'panel' | 'tasks'
export type CapsuleViewMode = 'capsule' | 'orb'
export type DockEdge = 'left' | 'right'
export type RendererCommandType = 'show-panel-view'

export interface RateLimitWindowSnapshot {
  id: string
  label: string
  windowMinutes?: number
  usedPercent?: number
  remainingPercent?: number
  resetsAt?: string
  resetsInSeconds?: number
  observedAt?: string
}

export function selectPrimaryRateLimit(
  windows: RateLimitWindowSnapshot[]
): RateLimitWindowSnapshot | undefined {
  return (
    windows.find((window) => window.windowMinutes === 300 || window.label === '5h') ??
    windows.find((window) => window.windowMinutes === 10080 || window.label === '7d') ??
    windows[0]
  )
}

export interface UsageSnapshot {
  available: boolean
  isRefreshing: boolean
  canRefresh: boolean
  generatedAt?: string
  lastSuccessAt?: string
  account?: { label: string; workspace: string }
  authPath?: string
  rateLimits: RateLimitWindowSnapshot[]
  rateLimitSource: RateLimitSource
  sourceHost: string
  issues: string[]
  officialIssue?: string
}

export interface AppSettings {
  taskMonitoring: boolean
  taskNotifications: boolean
  taskNotificationSound: boolean
  theme: 'light' | 'dark'
  capsuleScale: number
  displayMode: 'floating' | 'tray'
  refreshMode: RefreshMode
  refreshIntervalSeconds: number
  percentageMode: PercentageMode
  locale: LocaleCode
  launchAtLogin: boolean
}

export interface WindowPreferences {
  x?: number
  y?: number
  viewMode: CapsuleViewMode
  dockEdge?: DockEdge
}

export interface PanelPreferences {
  x?: number
  y?: number
}

export interface PersistedState {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
}

export interface BootstrapPayload {
  feishuStatus: import('./feishu').FeishuStatus
  taskWindow: import('./tasks').TaskWindowState
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
  snapshot: UsageSnapshot
  role: RendererWindowRole
  panelView: PanelView
}

export interface PreferencesPayload {
  settings: AppSettings
  window: WindowPreferences
  panel: PanelPreferences
}

export interface CapsuleDragMovePayload {
  screenX: number
  screenY: number
  offsetX: number
  offsetY: number
}

export interface RendererCommandPayload {
  type: RendererCommandType
  panelView: PanelView
}

export interface CodexStatusApi {
  getFeishuReceiverStatus: () => Promise<import('./feishu').FeishuReceiverStatus>
  onFeishuReceiverUpdated: (listener: (status: import('./feishu').FeishuReceiverStatus) => void) => () => void
  getFeishuSettings: () => Promise<import('./feishu').FeishuSettings>
  saveFeishuSettings: (settings: import('./feishu').FeishuSettings) => Promise<import('./feishu').FeishuSettings>
  testFeishuNotification: () => Promise<void>
  onFeishuStatusUpdated: (listener: (status: import('./feishu').FeishuStatus) => void) => () => void
  setTaskMuted: (id: string, muted: boolean) => Promise<void>
  removeTask: (id: string) => Promise<void>
  restoreTask: (threadId: string) => Promise<void>
  setTaskWindowPinned: (pinned: boolean) => Promise<void>
  onTaskWindowUpdated: (listener: (state: import('./tasks').TaskWindowState) => void) => () => void
  getTasks: () => Promise<import('./tasks').TasksSnapshot>
  copyTaskSession: (id: string) => Promise<void>
  onTasksUpdated: (listener: (snapshot: import('./tasks').TasksSnapshot) => void) => () => void
  bootstrap: () => Promise<BootstrapPayload>
  refreshStatus: () => Promise<UsageSnapshot>
  updateSettings: (patch: Partial<AppSettings>) => Promise<PreferencesPayload>
  closePanel: () => Promise<void>
  openPanel: (view?: PanelView) => Promise<void>
  moveCapsuleWindow: (payload: CapsuleDragMovePayload) => Promise<WindowPreferences>
  finishCapsuleWindowDrag: () => Promise<WindowPreferences>
  onSnapshotUpdated: (listener: (snapshot: UsageSnapshot) => void) => () => void
  onPreferencesUpdated: (listener: (payload: PreferencesPayload) => void) => () => void
  onCommand: (listener: (payload: RendererCommandPayload) => void) => () => void
}

export const REFRESH_INTERVAL_OPTIONS = [15, 30, 60, 120] as const
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 30
export const MIN_REFRESH_INTERVAL_SECONDS = 5
export const MAX_REFRESH_INTERVAL_SECONDS = 600
export const CAPSULE_WINDOW_SIZE = {
  width: 200,
  height: 28
} as const

export const ORB_WINDOW_SIZE = {
  width: CAPSULE_WINDOW_SIZE.height,
  height: CAPSULE_WINDOW_SIZE.width
} as const

export function normalizeCapsuleScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(300, Math.max(100, Math.round(value)))
    : 100
}

export function getCapsuleWindowSize(viewMode: CapsuleViewMode, scale: number): { width: number; height: number } {
  const size = viewMode === 'orb' ? ORB_WINDOW_SIZE : CAPSULE_WINDOW_SIZE
  const factor = normalizeCapsuleScale(scale) / 100
  return { width: Math.ceil(size.width * factor), height: Math.ceil(size.height * factor) }
}

export const CAPSULE_EDGE_GAP = 0
export const CAPSULE_DOCK_EDGE_GAP = 0
export const CAPSULE_DOCK_THRESHOLD = 18
export const CAPSULE_UNDOCK_THRESHOLD = 42

export const PANEL_WINDOW_SIZE = {
  width: 480,
  height: 600
} as const

export const DEFAULT_SETTINGS: AppSettings = {
  taskMonitoring: true,
  taskNotifications: true,
  taskNotificationSound: false,
  theme: 'light',
  capsuleScale: 100,
  displayMode: 'tray',
  refreshMode: 'auto',
  refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
  percentageMode: 'remaining',
  locale: 'zh-CN',
  launchAtLogin: false
}

export const DEFAULT_WINDOW_PREFERENCES: WindowPreferences = {
  viewMode: 'capsule'
}

export const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {}

export function createEmptySnapshot(): UsageSnapshot {
  return {
    available: false,
    isRefreshing: false,
    canRefresh: true,
    rateLimits: [],
    rateLimitSource: 'none',
    sourceHost: 'No data',
    issues: []
  }
}

export function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  return {
    taskMonitoring: typeof input?.taskMonitoring === 'boolean' ? input.taskMonitoring : true,
    taskNotifications: typeof input?.taskNotifications === 'boolean' ? input.taskNotifications : true,
    taskNotificationSound: input?.taskNotificationSound === true,
    theme: input?.theme === 'dark' ? 'dark' : 'light',
    capsuleScale: normalizeCapsuleScale(input?.capsuleScale),
    displayMode:
      input?.displayMode === 'floating' || input?.displayMode === 'tray'
        ? input.displayMode
        : DEFAULT_SETTINGS.displayMode,
    refreshMode: isRefreshMode(input?.refreshMode)
      ? input.refreshMode
      : DEFAULT_SETTINGS.refreshMode,
    refreshIntervalSeconds: normalizeRefreshInterval(input?.refreshIntervalSeconds),
    percentageMode: isPercentageMode(input?.percentageMode)
      ? input.percentageMode
      : DEFAULT_SETTINGS.percentageMode,
    locale: isLocaleCode(input?.locale) ? input.locale : DEFAULT_SETTINGS.locale,
    launchAtLogin:
      typeof input?.launchAtLogin === 'boolean'
        ? input.launchAtLogin
        : DEFAULT_SETTINGS.launchAtLogin
  }
}

export function normalizeWindowPreferences(
  input: Partial<WindowPreferences> | undefined
): WindowPreferences {
  const viewMode = isCapsuleViewMode(input?.viewMode)
    ? input.viewMode
    : DEFAULT_WINDOW_PREFERENCES.viewMode
  const dockEdge = viewMode === 'orb' && isDockEdge(input?.dockEdge) ? input.dockEdge : undefined

  return {
    x: typeof input?.x === 'number' && Number.isFinite(input.x) ? Math.round(input.x) : undefined,
    y: typeof input?.y === 'number' && Number.isFinite(input.y) ? Math.round(input.y) : undefined,
    viewMode,
    dockEdge
  }
}

export function normalizePanelPreferences(
  input: Partial<PanelPreferences> | undefined
): PanelPreferences {
  return {
    x: typeof input?.x === 'number' && Number.isFinite(input.x) ? Math.round(input.x) : undefined,
    y: typeof input?.y === 'number' && Number.isFinite(input.y) ? Math.round(input.y) : undefined
  }
}

function normalizeRefreshInterval(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_REFRESH_INTERVAL_SECONDS
  }

  const normalized = Math.round(value as number)
  return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, normalized))
}

function isRefreshMode(value: unknown): value is RefreshMode {
  return value === 'auto' || value === 'manual'
}

function isPercentageMode(value: unknown): value is PercentageMode {
  return value === 'remaining' || value === 'used'
}

function isLocaleCode(value: unknown): value is LocaleCode {
  return value === 'zh-CN' || value === 'en-US'
}

function isCapsuleViewMode(value: unknown): value is CapsuleViewMode {
  return value === 'capsule' || value === 'orb'
}

function isDockEdge(value: unknown): value is DockEdge {
  return value === 'left' || value === 'right'
}
