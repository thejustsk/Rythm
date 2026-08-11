import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

/** Where the SQLite file lives. Defaults to Documents/ActivityCalendar (outside the app folder). */
export function getDataDir(): string {
  if (process.env.AC_DATA_DIR) return process.env.AC_DATA_DIR
  try {
    return path.join(app.getPath('documents'), 'ActivityCalendar')
  } catch {
    return app.getPath('userData')
  }
}

export function openDatabase(): Db {
  const dir = getDataDir()
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, 'activity-calendar.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
