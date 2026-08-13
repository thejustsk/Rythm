/**
 * Windows notifications (item B.2 + user spec):
 *  - FIRST time the PC/app starts each day: a morning summary notification
 *    ("You have N activities today").
 *  - THEN during the user's selected time stamps (slots like 09:00 / 13:00 /
 *    18:00): a reminder for activities starting within the next X minutes.
 * Config lives in settings (notifEnabled / notifSlots / notifLead) and is
 * editable in Settings → Notifications.
 */
import { ipcMain, Notification } from 'electron'
import type { Db } from './db/connection'
import { parseRRule, iterateRule, isoDate } from '../renderer/src/engine/recurrence'

export interface NotifyConfig {
  enabled: boolean
  /** ['HH:mm', ...] */
  slots: string[]
  /** minutes before an event to remind */
  leadMin: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

export function readConfig(db: Db): NotifyConfig {
  const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as any)?.value
  const enabled = (get('notifEnabled') ?? '1') !== '0'
  let slots: string[] = ['09:00', '13:00', '18:00']
  try {
    const raw = get('notifSlots')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) slots = parsed.filter((s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s))
    }
  } catch {
    /* keep defaults */
  }
  const leadMin = Math.min(240, Math.max(0, parseInt(get('notifLead') ?? '30', 10) || 30))
  return { enabled, slots, leadMin }
}

export function writeConfig(db: Db, cfg: NotifyConfig): void {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  set.run('notifEnabled', cfg.enabled ? '1' : '0')
  set.run('notifSlots', JSON.stringify(cfg.slots.filter((s) => /^\d{2}:\d{2}$/.test(s))))
  set.run('notifLead', String(Math.min(240, Math.max(0, cfg.leadMin))))
}

function show(title: string, body: string): boolean {
  if (!Notification.isSupported()) return false
  try {
    new Notification({ title, body, silent: false }).show()
    return true
  } catch {
    return false
  }
}

/** All occurrences on a day (masters + overrides, exdates respected). */
function occsOnDay(db: Db, dayIso: string): Array<{ id: string; title: string; start: Date; end: Date; status: string }> {
  const out: Array<{ id: string; title: string; start: Date; end: Date; status: string }> = []
  const rows = db.prepare('SELECT * FROM events').all() as any[]
  const parseDT = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(s)
  }
  for (const e of rows) {
    if (e.parent_id) continue
    const exdates = new Set(JSON.parse(e.exdates || '[]'))
    const ov = db.prepare('SELECT * FROM events WHERE parent_id = ? AND origin_date = ?').get(e.id, dayIso) as any
    if (ov) {
      out.push({ id: ov.id, title: ov.title, start: parseDT(ov.start_local), end: parseDT(ov.end_local), status: ov.status })
      continue
    }
    if (e.rrule) {
      const rule = parseRRule(e.rrule)
      if (!rule) continue
      for (const day of iterateRule(rule, parseDT(e.start_local))) {
        const iso = isoDate(day)
        if (iso === dayIso) {
          if (!exdates.has(dayIso)) {
            out.push({ id: e.id, title: e.title, start: parseDT(e.start_local), end: parseDT(e.end_local), status: e.status })
          }
          break
        }
        if (iso > dayIso) break
      }
    } else if (e.start_local.slice(0, 10) === dayIso) {
      out.push({ id: e.id, title: e.title, start: parseDT(e.start_local), end: parseDT(e.end_local), status: e.status })
    }
  }
  return out
}

let timer: NodeJS.Timeout | null = null
/** Slots already fired today (in-memory; settings persist the day flag). */
const firedToday = new Set<string>()

function runCheck(db: Db): void {
  const cfg = readConfig(db)
  const now = new Date()
  const today = localDate(now)
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  if (cfg.enabled) {
    // ---- once per day: the morning summary (first time the PC is on) ----
    const dayKey = 'notifDay.' + today
    const done = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(dayKey)
    if (!done) {
      const occs = occsOnDay(db, today)
      const active = occs.filter((o) => o.status !== 'done' && o.status !== 'cancelled')
      if (active.length > 0) {
        const n = active.length
        show('Rhythm — Good morning ☀️', `You have ${n} activit${n === 1 ? 'y' : 'ies'} planned today.`)
      }
      set.run(dayKey, '1')
    }

    // ---- time-slot reminders: events starting within the lead window ----
    for (const slot of cfg.slots) {
      if (firedToday.has(slot)) continue
      const [sh, sm] = slot.split(':').map(Number)
      const slotMin = sh * 60 + sm
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (nowMin < slotMin) continue
      firedToday.add(slot)
      // events starting in (now, now + leadMin]
      const leadMs = cfg.leadMin * 60000
      const upcoming = occsOnDay(db, today)
        .filter((o) => {
          const t = o.start.getTime()
          return t > now.getTime() && t <= now.getTime() + leadMs && o.status !== 'done' && o.status !== 'cancelled'
        })
        .sort((a, b) => a.start.getTime() - b.start.getTime())
      if (upcoming.length > 0) {
        const first = upcoming[0]
        const mins = Math.max(1, Math.round((first.start.getTime() - now.getTime()) / 60000))
        const body =
          upcoming.length === 1
            ? `${first.title} — ${hhmm(first.start)} (in ${mins} min)`
            : `${first.title} and ${upcoming.length - 1} more — first at ${hhmm(first.start)} (in ${mins} min)`
        show('Rhythm — Upcoming', body)
      }
    }
  }
}

/** Start (or restart) the notifier. Safe to call on every app start. */
export function startNotifier(db: Db): void {
  if (timer) clearInterval(timer)
  runCheck(db) // immediate check (covers the "first time PC on" case)
  timer = setInterval(() => runCheck(db), 30000)
}

export function registerNotificationHandlers(db: Db): void {
  ipcMain.handle('notify:getConfig', () => readConfig(db))
  ipcMain.handle('notify:setConfig', (_e, cfg: NotifyConfig) => {
    writeConfig(db, cfg)
    return readConfig(db)
  })
  ipcMain.handle('notify:test', () => {
    const ok = show('Rhythm — Test notification', 'Notifications are working! 🎉')
    return { ok }
  })
  ipcMain.handle('notify:resetDay', () => {
    // dev/testing helper: allows the morning summary to fire again today
    const today = localDate(new Date())
    db.prepare('DELETE FROM settings WHERE key = ?').run('notifDay.' + today)
    firedToday.clear()
    return { ok: true }
  })
}
