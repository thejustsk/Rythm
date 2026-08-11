import { ipcMain } from 'electron'
import type { Db } from '../db/connection'

export function registerSettingsHandlers(db: Db): void {
  ipcMain.handle('settings:get', (_e, key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row ? row.value : null
  })
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  })
}
