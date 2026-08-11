import { contextBridge, ipcRenderer } from 'electron'
import type { Api, CalendarEvent, EventInput, Label } from '../shared/types'

const api: Api = {
  events: {
    list: (): Promise<CalendarEvent[]> => ipcRenderer.invoke('events:list'),
    get: (id: string) => ipcRenderer.invoke('events:get', id),
    create: (input: EventInput) => ipcRenderer.invoke('events:create', input),
    update: (id: string, patch: Partial<EventInput>) => ipcRenderer.invoke('events:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('events:remove', id)
  },
  labels: {
    list: (): Promise<Label[]> => ipcRenderer.invoke('labels:list'),
    create: (name: string, color: string | null, parentId: string | null) =>
      ipcRenderer.invoke('labels:create', name, color, parentId),
    update: (id: string, patch: Partial<{ name: string; color: string | null; sortOrder: number; archived: boolean }>) =>
      ipcRenderer.invoke('labels:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('labels:remove', id)
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value)
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, v: boolean) => cb(v)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
