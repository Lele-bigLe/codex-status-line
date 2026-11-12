import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  createCodexStatusApi,
  DESKTOP_COMMANDS,
  DESKTOP_EVENTS,
  type DesktopEvent,
  type DesktopEventPayload
} from '../shared/desktopApi'

const api = createCodexStatusApi({
  invoke: (command, ...args) => ipcRenderer.invoke(DESKTOP_COMMANDS[command], ...args),
  subscribe
})

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('codexStatus', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.codexStatus = api
}

function subscribe<K extends DesktopEvent>(
  event: K,
  listener: (payload: DesktopEventPayload<K>) => void
): () => void {
  const channel = DESKTOP_EVENTS[event]
  const wrappedListener = (
    _event: Electron.IpcRendererEvent,
    payload: DesktopEventPayload<K>
  ): void => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrappedListener)
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener)
  }
}
