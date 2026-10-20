import type { CodexStatusApi } from './capsule'

export const DESKTOP_EVENTS = {
  onAutomationUpdated: 'codex-status:automation-updated',
  onFeishuStatusUpdated: 'codex-status:feishu-status-updated',
  onTaskWindowUpdated: 'codex-status:task-window-updated',
  onTasksUpdated: 'codex-status:tasks-updated',
  onSnapshotUpdated: 'codex-status:snapshot-updated',
  onPreferencesUpdated: 'codex-status:preferences-updated',
  onCommand: 'codex-status:command'
} as const

export type DesktopEvent = keyof typeof DESKTOP_EVENTS
export type DesktopCommand = Exclude<keyof CodexStatusApi, DesktopEvent>
export type DesktopCommandResult<K extends DesktopCommand> = Awaited<ReturnType<CodexStatusApi[K]>>
export type DesktopEventPayload<K extends DesktopEvent> = Parameters<
  Parameters<CodexStatusApi[K]>[0]
>[0]

export const DESKTOP_COMMANDS = {
  getAutomation: 'codex-status:get-automation',
  refreshAutomation: 'codex-status:refresh-automation',
  consumeResetCredit: 'codex-status:consume-reset-credit',
  saveSchedule: 'codex-status:save-schedule',
  setScheduleEnabled: 'codex-status:enable-schedule',
  deleteSchedule: 'codex-status:delete-schedule',
  getFeishuSettings: 'codex-status:get-feishu-settings',
  saveFeishuSettings: 'codex-status:save-feishu-settings',
  testFeishuNotification: 'codex-status:test-feishu-notification',
  setTaskMuted: 'codex-status:mute-task',
  removeTask: 'codex-status:remove-task',
  restoreTask: 'codex-status:restore-task',
  setTaskWindowPinned: 'codex-status:pin-task-window',
  getTasks: 'codex-status:get-tasks',
  copyTaskSession: 'codex-status:copy-task-session',
  bootstrap: 'codex-status:bootstrap',
  refreshStatus: 'codex-status:refresh',
  updateSettings: 'codex-status:update-settings',
  closePanel: 'codex-status:close-panel',
  openPanel: 'codex-status:open-panel',
  moveCapsuleWindow: 'codex-status:move-capsule-window',
  finishCapsuleWindowDrag: 'codex-status:finish-capsule-window-drag'
} as const satisfies Record<DesktopCommand, string>

export interface DesktopTransport {
  invoke<K extends DesktopCommand>(
    command: K,
    ...args: Parameters<CodexStatusApi[K]>
  ): Promise<DesktopCommandResult<K>>
  subscribe<K extends DesktopEvent>(
    event: K,
    listener: (payload: DesktopEventPayload<K>) => void
  ): () => void
}

export function createCodexStatusApi(transport: DesktopTransport): CodexStatusApi {
  const request =
    <K extends DesktopCommand>(command: K) =>
    (...args: Parameters<CodexStatusApi[K]>): Promise<DesktopCommandResult<K>> =>
      transport.invoke(command, ...args)

  return {
    getAutomation: request('getAutomation'),
    refreshAutomation: request('refreshAutomation'),
    consumeResetCredit: request('consumeResetCredit'),
    saveSchedule: request('saveSchedule'),
    setScheduleEnabled: request('setScheduleEnabled'),
    deleteSchedule: request('deleteSchedule'),
    getFeishuSettings: request('getFeishuSettings'),
    saveFeishuSettings: request('saveFeishuSettings'),
    testFeishuNotification: request('testFeishuNotification'),
    setTaskMuted: request('setTaskMuted'),
    removeTask: request('removeTask'),
    restoreTask: request('restoreTask'),
    setTaskWindowPinned: request('setTaskWindowPinned'),
    getTasks: request('getTasks'),
    copyTaskSession: request('copyTaskSession'),
    bootstrap: request('bootstrap'),
    refreshStatus: request('refreshStatus'),
    updateSettings: request('updateSettings'),
    closePanel: request('closePanel'),
    openPanel: request('openPanel'),
    moveCapsuleWindow: request('moveCapsuleWindow'),
    finishCapsuleWindowDrag: request('finishCapsuleWindowDrag'),
    onAutomationUpdated: (listener) => transport.subscribe('onAutomationUpdated', listener),
    onFeishuStatusUpdated: (listener) => transport.subscribe('onFeishuStatusUpdated', listener),
    onTaskWindowUpdated: (listener) => transport.subscribe('onTaskWindowUpdated', listener),
    onTasksUpdated: (listener) => transport.subscribe('onTasksUpdated', listener),
    onSnapshotUpdated: (listener) => transport.subscribe('onSnapshotUpdated', listener),
    onPreferencesUpdated: (listener) => transport.subscribe('onPreferencesUpdated', listener),
    onCommand: (listener) => transport.subscribe('onCommand', listener)
  }
}
