/**
 * Date helpers shared by the views: ISO week numbers (item B.8) and
 * first-day-of-week handling (Settings, item B.4).
 */

/** ISO 8601 week number (week 1 = the week containing the first Thursday). */
export function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/** Monday = 1, Sunday = 0 (JS getDay convention). */
export type WeekStart = 1 | 0

/** The date of the week start that contains `d` (Mon or Sun per startDow). */
export function weekStartOf(d: Date, startDow: WeekStart): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = out.getDay() // 0=Sun..6=Sat
  let diff: number
  if (startDow === 1) {
    diff = dow === 0 ? -6 : 1 - dow
  } else {
    diff = dow === 0 ? 0 : -dow
  }
  out.setDate(out.getDate() + diff)
  return out
}

/** Weekday names ordered to start at the configured first day. */
export function weekDayNames(startDow: WeekStart): string[] {
  const base = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  if (startDow === 0) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return base
}

/** Number of days to shift a Monday-start offset so it becomes startDow-first. */
export function startDowToOffset(startDow: WeekStart): number {
  return startDow === 0 ? 1 : 0
}
