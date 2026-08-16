/**
 * Pure notification-decision logic (no Electron imports — unit-testable).
 *
 * When notifications pop:
 *  1. MORNING SUMMARY — once per day, the first time the app opens: if there
 *     is at least one active (not done/cancelled) event today.
 *  2. SLOT REMINDERS — at each configured reminder time (e.g. 09:00): lists
 *     ALL PENDING events of the day (v1.11.13 — no 2h window anymore).
 *  3. STARTUP NEAR-EVENT — right after the app opens: if any active event
 *     starts within the configured lead time (e.g. 30 min).
 */
export const SLOT_WINDOW_MIN = 120

export interface NotifyOcc {
  title: string
  start: Date
  status: string
}

export interface Reminder {
  title: string
  body: string
}

const NL = '\n'

/** Active = not done and not cancelled. */
export function isActive(o: NotifyOcc): boolean {
  return o.status !== 'done' && o.status !== 'cancelled'
}

/** 1. Morning summary: active events today. */
export function morningSummary(occs: NotifyOcc[]): Reminder | null {
  const active = occs.filter(isActive)
  if (active.length === 0) return null
  const n = active.length
  return {
    title: 'Rhythm — Good morning ☀️',
    body: `You have ${n} activit${n === 1 ? 'y' : 'ies'} planned today.`
  }
}

/** 2. Slot reminder (v1.11.13): lists ALL PENDING events of the day — not
 *  just the next 2h. Format: "3 activities left today · 10:00 Deep work ·
 *  13:00 Lunch · 18:00 Gym" (up to MAX lines, oldest first). */
export function slotReminder(
  occs: NotifyOcc[],
  now: Date,
  _slotTime: Date,
  _windowMin: number = SLOT_WINDOW_MIN
): Reminder | null {
  const pending = occs
    .filter((o) => isActive(o) && o.start.getTime() >= now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  if (pending.length === 0) return null
  const hh = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const MAX = 5
  const lines = pending.slice(0, MAX).map((o) => `${hh(o.start)} ${o.title}`)
  const more = pending.length > MAX ? NL + '+' + (pending.length - MAX) + ' more' : ''
  const body = `${pending.length} activit${pending.length === 1 ? 'y' : 'ies'} left today${NL}${lines.join(NL)}${more}`
  return { title: 'Rhythm — Today', body }
}

/** 3. Startup near-event reminder: active event starting within leadMin. */
export function startupReminder(occs: NotifyOcc[], now: Date, leadMin: number): Reminder | null {
  const windowEnd = now.getTime() + leadMin * 60000
  const due = occs
    .filter((o) => isActive(o) && o.start.getTime() > now.getTime() && o.start.getTime() <= windowEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  if (due.length === 0) return null
  const first = due[0]
  const mins = Math.max(1, Math.round((first.start.getTime() - now.getTime()) / 60000))
  const hh = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const body =
    due.length === 1
      ? `${first.title} — ${hh(first.start)} (in ${mins} min)`
      : `${first.title} and ${due.length - 1} more — first at ${hh(first.start)} (in ${mins} min)`
  return { title: 'Rhythm — Upcoming', body }
}

/** Format a reminder for display (e.g. in-app toast). */
export function fmtReminder(r: Reminder): string {
  return `${r.title} — ${r.body}`
}
