import fs from 'node:fs'
import path from 'node:path'
import type { Db } from './db/connection'
import { getDataDir } from './db/connection'

/** Automatic backups — M8. Copies the SQLite DB (via the safe SQLite backup
 *  API) into <dataDir>/backups, keeps the newest 14, and remembers the last
 *  backup time so a daily auto-backup only runs once per 24h. */
export const MAX_BACKUPS = 14

const DATE_RE = /^rhythm-backup-(\d{4}-\d{2}-\d{2}-\d{6})\.db$/

export interface BackupEntry {
  name: string
  size: number
  mtime: string
}

export function backupsDir(): string {
  return path.join(getDataDir(), 'backups')
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function listBackups(): BackupEntry[] {
  const dir = backupsDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return []
  }
  return fs
    .readdirSync(dir)
    .filter((f) => DATE_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { name: f, size: st.size, mtime: st.mtime.toISOString() }
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

export function pruneBackups(): number {
  const dir = backupsDir()
  const all = fs
    .readdirSync(dir)
    .filter((f) => DATE_RE.test(f))
    .sort()
    .reverse()
  for (const f of all.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(dir, f))
    } catch {
      /* ignore */
    }
  }
  return Math.min(all.length, MAX_BACKUPS)
}

export interface BackupResult {
  ok: boolean
  path: string | null
  count: number
  lastBackup: string | null
}

export async function backupNow(db: Db): Promise<BackupResult> {
  const dir = backupsDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `rhythm-backup-${stamp()}.db`
  const dest = path.join(dir, name)
  try {
    await db.backup(dest) // safe online backup via SQLite's backup API
    const count = pruneBackups()
    const iso = new Date().toISOString()
    db.prepare("INSERT INTO settings (key, value) VALUES ('lastBackup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(iso)
    db.prepare("INSERT INTO settings (key, value) VALUES ('lastBackupName', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name)
    return { ok: true, path: dest, count, lastBackup: iso }
  } catch (e) {
    console.error('[backup] failed:', e)
    return { ok: false, path: null, count: listBackups().length, lastBackup: null }
  }
}

/** Run at app start: backs up once per 24h when auto-backup is enabled. */
export async function runAutoBackup(db: Db): Promise<void> {
  try {
    const auto = db.prepare("SELECT value FROM settings WHERE key = 'autoBackup'").get() as { value: string } | undefined
    if (auto && auto.value === '0') return
    const last = db.prepare("SELECT value FROM settings WHERE key = 'lastBackup'").get() as { value: string } | undefined
    if (last && Date.now() - new Date(last.value).getTime() < 24 * 3600 * 1000) return
    const res = await backupNow(db)
    console.log('[backup] auto backup:', res.ok ? 'created ' + res.path : 'failed', '· stored', res.count)
  } catch (e) {
    console.error('[backup] auto backup error:', e)
  }
}
