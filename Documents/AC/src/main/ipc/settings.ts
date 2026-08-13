import { ipcMain, shell, app } from 'electron'
import type { Db } from '../db/connection'
import { getDataDir } from '../db/connection'
import { backupNow, listBackups, backupsDir } from '../backup'

export function registerSettingsHandlers(db: Db): void {
  ipcMain.handle('settings:get', (_e, key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row ? row.value : null
  })
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  })

  // ---- backups (M8) ----
  ipcMain.handle('backups:list', () => listBackups())
  ipcMain.handle('backups:now', () => backupNow(db))

  // ---- app info / folders (M8) ----
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: getDataDir(),
    backupsDir: backupsDir()
  }))
  ipcMain.handle('app:openDataFolder', async () => {
    await shell.openPath(getDataDir())
  })
  ipcMain.handle('app:openBackupsFolder', async () => {
    await shell.openPath(backupsDir())
  })
}
