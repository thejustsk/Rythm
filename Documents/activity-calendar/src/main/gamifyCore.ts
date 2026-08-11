/**
 * Gamification bonus core — pure, unit-tested. No DB, no Electron.
 * M10.2: daily check-in, "all planned done", perfect week.
 */

const pad2 = (n: number) => String(n).padStart(2, '0')
export const isoD = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
export const addDaysIso = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return isoD(d)
}

export const CHECKIN_BASE = 10
export const ALL_DONE_BONUS = 25
export const PERFECT_WEEK_BONUS = 100
export const CHECKIN_STREAK_MULTIPLIER_DAY = 7 // every 7-day streak → ×2

export interface CheckInResult {
  award: boolean
  streak: number
  amount: number
  multiplier: number
}

/**
 * Daily check-in state machine.
 * - same day → no award
 * - yesterday → streak continues (+1)
 * - any gap → streak resets to 1
 * - every 7th consecutive day → ×2
 */
export function checkInState(
  lastCheckIn: string | null,
  checkInStreak: number,
  today: string
): CheckInResult {
  if (lastCheckIn === today) return { award: false, streak: checkInStreak, amount: 0, multiplier: 1 }
  const streak = lastCheckIn === addDaysIso(today, -1) ? checkInStreak + 1 : 1
  const multiplier = streak % CHECKIN_STREAK_MULTIPLIER_DAY === 0 ? 2 : 1
  return { award: true, streak, amount: CHECKIN_BASE * multiplier, multiplier }
}

/** "All planned done (or cancelled)" for a day: every planned block resolved. */
export function allDoneCheck(planned: number, resolved: number): boolean {
  return planned > 0 && resolved === planned
}

export interface PerfectDay {
  hasDone: boolean
  hasMissed: boolean // had a planned block that is still todo/doing
  planned: number // how many planned blocks that day
}

/**
 * A perfect week = 7 days where every day is either a REST day (no planned
 * blocks — e.g. a break, which must not break the week) or the user completed
 * at least one planned block. A day only counts as missed when it had plans
 * and NOTHING was done (leftover todos on an otherwise active day don't block
 * the weekly all-done credit — that's what made it impossible in real life).
 */
export function perfectWeekCheck(days: PerfectDay[]): boolean {
  return days.length === 7 && days.every((d) => d.planned === 0 || d.hasDone)
}

/** ISO monday of a week (used as the once-per-week award key). */
export function weekKey(anyDayInWeek: string): string {
  const d = new Date(anyDayInWeek + 'T00:00:00')
  const dow = d.getDay()
  const mon = new Date(d)
  mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return isoD(mon)
}
