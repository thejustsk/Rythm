/**
 * Windows notifications (item B.2 + user spec):
 *  - FIRST time the PC/app starts each day: a morning summary notification
 *    ("You have N activities today").
 *  - THEN during the user's selected time stamps (slots like 09:00 / 13:00 /
 *    18:00): a reminder for activities starting within the next X minutes.
 * Config lives in settings (notifEnabled / notifSlots / notifLead) and is
 * editable in Settings → Notifications.
 */
import { ipcMain, Notification, BrowserWindow } from 'electron'
import type { Db } from './db/connection'
import { parseRRule, iterateRule, isoDate } from '../renderer/src/engine/recurrence'
import { morningSummary, slotReminder, startupReminder } from './notifyCore'

export interface NotifyConfig {
  enabled: boolean
  /** ['HH:mm', ...] */
  slots: string[]
  /** minutes before an event to remind */
  leadMin: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

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

/** v1.11.2: ALWAYS surface a reminder inside the app too — even if Windows
 *  blocks or lacks OS toasts, the user still sees it. */
function broadcastInApp(title: string, body: string): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('notify:inapp', { title, body })
    }
  } catch (e) {
    console.log('[notify] in-app broadcast failed:', e)
  }
}

function show(title: string, body: string): { ok: boolean; reason: string } {
  broadcastInApp(title, body) // guaranteed visible, OS result is a bonus
  if (!Notification.isSupported()) {
    console.log('[notify] NOT supported on this system (in-app toast still shown)')
    return { ok: false, reason: 'unsupported' }
  }
  try {
    const n = new Notification({ title, body, silent: false })
    n.on('failed', (_e, error) => console.log('[notify] show failed:', error))
    n.on('click', () => console.log('[notify] clicked'))
    n.show()
    return { ok: true, reason: 'shown' }
  } catch (e) {
    console.log('[notify] error:', e)
    return { ok: false, reason: String(e) }
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
/** Startup near-event reminder fires once per app launch. */
let startupChecked = false
/** Day (yyyy-mm-dd) the last notifSlot-key cleanup ran — old keys are removed
 *  once per day so the settings table never grows unboundedly. */
let slotCleanupDay = ''

/** v1.11.3: events are read with their real start times (title + start +
 *  status) so the pure decision logic (notifyCore) can pick the due ones. */
function occsForNotify(db: Db, dayIso: string): Array<{ title: string; start: Date; status: string }> {
  return occsOnDay(db, dayIso).map((o) => ({ title: o.title, start: o.start, status: o.status }))
}

function runCheck(db: Db): void {
  const cfg = readConfig(db)
  const now = new Date()
  const today = localDate(now)
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  if (cfg.enabled) {
    const occs = occsForNotify(db, today)

    // ---- 1) once per day: the morning summary (first time the PC is on) ----
    const dayKey = 'notifDay.' + today
    const done = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(dayKey)
    if (!done) {
      const r = morningSummary(occs)
      if (r) show(r.title, r.body)
      set.run(dayKey, '1')
    }

    // ---- 3) once per launch: event starting within the lead time ----
    if (!startupChecked) {
      startupChecked = true
      const r = startupReminder(occs, now, cfg.leadMin)
      if (r) show(r.title, r.body)
    }

    // ---- 2) slot reminders ----
    // v1.11.18 (audit): "already fired" is persisted as `notifSlot.<date>.<slot>`
    // in the settings table — restarting the app mid-day can NEVER re-fire a
    // slot that already went off (the old in-memory Set was lost on restart),
    // and a new day starts clean because keys are date-scoped.
    if (slotCleanupDay !== today) {
      slotCleanupDay = today
      db.prepare("DELETE FROM settings WHERE key LIKE 'notifSlot.%' AND key NOT LIKE ?").run('notifSlot.' + today + '.%')
    }
    for (const slot of cfg.slots) {
      const slotKey = 'notifSlot.' + today + '.' + slot
      if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(slotKey)) continue
      const [sh, sm] = slot.split(':').map(Number)
      const slotMin = sh * 60 + sm
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (nowMin < slotMin) continue
      set.run(slotKey, '1') // persisted BEFORE firing — a crash mid-fire can't re-fire
      const slotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm)
      const r = slotReminder(occs, now, slotTime)
      if (r) show(r.title, r.body)
    }
  }
}

/** Start (or restart) the notifier. Safe to call on every app start. */
/** v1.11.7: called when the app is started by the Task Scheduler (--remind).
 *  Checks once for events starting within the lead time; shows an OS toast if
 *  any; the caller quits shortly after. */
export function runRemindOnce(db: Db): void {
  const cfg = readConfig(db)
  const now = new Date()
  const today = localDate(now)
  const occs = occsForNotify(db, today)
  const r = startupReminder(occs, now, cfg.leadMin)
  if (r) show(r.title, r.body)
  else console.log('[remind] nothing due — no toast')
}

export function startNotifier(db: Db): void {
  if (timer) clearInterval(timer)
  const cfg = readConfig(db)
  console.log('[notify] enabled=', cfg.enabled, 'slots=', JSON.stringify(cfg.slots), 'leadMin=', cfg.leadMin)
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
    console.log('[notify] test requested')
    const res = show('Rhythm — Test notification', 'Notifications are working! 🎉')
    console.log('[notify] test result:', JSON.stringify(res))
    return res
  })
  ipcMain.handle('notify:resetDay', () => {
    // dev/testing helper: allows the morning summary + slots to fire again today
    const today = localDate(new Date())
    db.prepare('DELETE FROM settings WHERE key = ?').run('notifDay.' + today)
    db.prepare("DELETE FROM settings WHERE key LIKE 'notifSlot." + today + ".%'").run()
    return { ok: true }
  })
  ipcMain.handle('notify:runNow', () => {
    // dev/testing helper: run one reminder check immediately (same as the
    // 30s tick) — used by the smoke suite to verify slot persistence
    runCheck(db)
    return { ok: true }
  })
}
