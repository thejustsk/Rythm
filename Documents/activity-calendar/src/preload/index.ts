import { contextBridge, ipcRenderer } from 'electron'
import type { Api, CalendarEvent, EventInput, Label, ScoreRow, ScoreType, CoinTransaction } from '../shared/types'

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
  backups: {
    list: () => ipcRenderer.invoke('backups:list'),
    now: () => ipcRenderer.invoke('backups:now')
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    openBackupsFolder: () => ipcRenderer.invoke('app:openBackupsFolder'),
    getLaunchAtStartup: () => ipcRenderer.invoke('app:getLaunchAtStartup'),
    setLaunchAtStartup: (on: boolean) => ipcRenderer.invoke('app:setLaunchAtStartup', on)
  },
  coins: {
    scoreEvent: (eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null): Promise<{ earned: boolean; amount: number }> =>
      ipcRenderer.invoke('coins:scoreEvent', eventId, originDate, scoreType, amount, labelId),
    getScore: (eventId: string, originDate: string): Promise<ScoreRow | null> =>
      ipcRenderer.invoke('coins:getScore', eventId, originDate),
    clearScores: (eventId: string, originDate?: string) =>
      ipcRenderer.invoke('coins:clearScores', eventId, originDate),
    restoreScores: (rows: Array<{ eventId: string; originDate: string; scoreType: ScoreType; amount: number; labelId: string | null }>) =>
      ipcRenderer.invoke('coins:restoreScores', rows),
    revertScore: (eventId: string, originDate: string) =>
      ipcRenderer.invoke('coins:revertScore', eventId, originDate),
    restoreScore: (eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null) =>
      ipcRenderer.invoke('coins:restoreScore', eventId, originDate, scoreType, amount, labelId),
    checkIn: () => ipcRenderer.invoke('coins:checkIn'),
    allDoneCheck: (originDate: string) => ipcRenderer.invoke('coins:allDoneCheck', originDate),
    perfectWeek: () => ipcRenderer.invoke('coins:perfectWeek'),
    perfectMonth: () => ipcRenderer.invoke('coins:perfectMonth'),
    streakMilestone: () => ipcRenderer.invoke('coins:streakMilestone'),
    system: () => ipcRenderer.invoke('coins:system'),
    setSystem: (on: boolean) => ipcRenderer.invoke('coins:setSystem', on),
    stats: () => ipcRenderer.invoke('coins:stats'),
    balance: (): Promise<number> => ipcRenderer.invoke('coins:balance'),
    listTransactions: (): Promise<CoinTransaction[]> => ipcRenderer.invoke('coins:listTransactions')
  },
  milestones: {
    list: () => ipcRenderer.invoke('milestones:list'),
    create: (name: string, icon: string, cost: number, notes: string) =>
      ipcRenderer.invoke('milestones:create', name, icon, cost, notes),
    update: (id: string, patch: { name?: string; icon?: string; cost?: number; notes?: string }) =>
      ipcRenderer.invoke('milestones:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('milestones:remove', id),
    claim: (id: string) => ipcRenderer.invoke('milestones:claim', id),
    unclaim: (id: string) => ipcRenderer.invoke('milestones:unclaim', id)
  },
  notify: {
    getConfig: () => ipcRenderer.invoke('notify:getConfig'),
    setConfig: (cfg: { enabled: boolean; slots: string[]; leadMin: number }) =>
      ipcRenderer.invoke('notify:setConfig', cfg),
    test: () => ipcRenderer.invoke('notify:test'),
    resetDay: () => ipcRenderer.invoke('notify:resetDay'),
    onInApp: (cb: (d: { title: string; body: string }) => void) => {
      const listener = (_e: unknown, d: { title: string; body: string }) => cb(d)
      ipcRenderer.on('notify:inapp', listener)
      return () => ipcRenderer.removeListener('notify:inapp', listener)
    }
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
