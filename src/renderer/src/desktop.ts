import {
  createCodexStatusApi,
  DESKTOP_EVENTS,
  type DesktopCommandResult,
  type DesktopEventPayload,
  type DesktopTransport
} from '../../shared/desktopApi'

interface TauriApi {
  core: { invoke<T>(command: string, args: Record<string, unknown>): Promise<T> }
  event: {
    listen<T>(event: string, listener: (event: { payload: T }) => void): Promise<() => void>
  }
  window: { getCurrentWindow(): { startDragging(): Promise<void> } }
}

export function installDesktopApi(): void {
  if (window.codexStatus) return
  const native = (window as Window & { __TAURI__?: TauriApi }).__TAURI__
  if (!native) throw new Error('请从桌面应用打开 / Open this page from the desktop app')

  const pending = new Set<Promise<void>>()
  const failed = new Set<symbol>()
  const transport: DesktopTransport = {
    async invoke(command, ...args) {
      await Promise.all([...pending])
      if (failed.size)
        throw new Error('桌面事件连接失败，请重新打开应用 / Could not connect desktop events')
      return native.core.invoke<DesktopCommandResult<typeof command>>('desktop_request', {
        request: { command, args }
      })
    },
    subscribe(event, listener) {
      const id = Symbol(event)
      let disposed = false
      let unsubscribe: (() => void) | undefined
      const registration = native.event
        .listen<DesktopEventPayload<typeof event>>(DESKTOP_EVENTS[event], ({ payload }) => {
          if (!disposed) listener(payload)
        })
        .then((dispose) => {
          if (disposed) dispose()
          else unsubscribe = dispose
        })
        .catch(() => {
          if (!disposed) failed.add(id)
        })
        .finally(() => {
          pending.delete(registration)
        })
      pending.add(registration)
      return () => {
        disposed = true
        failed.delete(id)
        unsubscribe?.()
      }
    }
  }
  window.codexStatus = createCodexStatusApi(transport)
  document.documentElement.dataset.desktop = 'tauri'

  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    if (!event.target.closest('.panel__topbar, .monitor-header, .monitor-peek-drag')) return
    if (event.target.closest('button, input, select, a')) return
    event.preventDefault()
    void native.window
      .getCurrentWindow()
      .startDragging()
      .catch(() => {})
  })
}
