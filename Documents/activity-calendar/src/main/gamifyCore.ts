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
export const PERFECT_MONTH_BONUS = 300
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

/** The growing milestone path: 100, 250, 500, 1000, 1500, 2500, 4000, then +2000 forever. */
export function defaultMilestoneCosts(count: number): number[] {
  const base = [100, 250, 500, 1000, 1500, 2500, 4000]
  const out: number[] = []
  let prev = 4000
  for (let i = 0; i < count; i++) {
    if (i < base.length) out.push(base[i])
    else {
      prev += 2000
      out.push(prev)
    }
  }
  return out
}

/**
 * Perfect-week reward fires when the current streak hits a multiple of 7
 * (7, 14, 21, …). Returns the streak level to award (or null).
 */
export function streakAwardLevel(streak: number): number | null {
  return streak > 0 && streak % 7 === 0 ? streak : null
}

/** Perfect month: a 30-day streak (30, 60, 90, …). Returns the level to award. */
export function monthAwardLevel(streak: number): number | null {
  return streak > 0 && streak % 30 === 0 ? streak : null
}

/** PERFECT WEEK catch-up: every 7-multiple level <= streak (7, 14, 21, …).
 *  Awards must not be missed when a check happens at a non-multiple streak
 *  (e.g. a jump 6 -> 8 skips the exact-7 check) — each unclaimed level pays
 *  out whenever a check finally runs. */
export function weekLevelsUpTo(streak: number): number[] {
  const out: number[] = []
  for (let l = 7; l <= streak; l += 7) out.push(l)
  return out
}

/** PERFECT MONTH catch-up: every 30-multiple level <= streak (30, 60, …). */
export function monthLevelsUpTo(streak: number): number[] {
  const out: number[] = []
  for (let l = 30; l <= streak; l += 30) out.push(l)
  return out
}

/** STREAK-MILESTONE catch-up: every milestone cost <= streak (5, 10, 20, …),
 *  so a jump that skips a lower milestone still pays it out. */
export function streakMilestoneLevelsUpTo(streak: number): number[] {
  const costs = defaultStreakCosts(80)
  return costs.filter((c) => c <= streak)
}

/** Streak-milestone path: 5, 10, 20, 30, 50, 75, then +25 forever. */
export function defaultStreakCosts(count: number): number[] {
  const base = [5, 10, 20, 30, 50, 75]
  const out: number[] = []
  let prev = 75
  for (let i = 0; i < count; i++) {
    if (i < base.length) out.push(base[i])
    else {
      prev += 25
      out.push(prev)
    }
  }
  return out
}

/** Highest streak milestone reached by `streak` (or null below the first, 5). */
export function streakMilestoneLevel(streak: number): number | null {
  if (streak < 5) return null
  const costs = defaultStreakCosts(80)
  let hit: number | null = null
  for (const c of costs) {
    if (c <= streak) hit = c
    else break
  }
  return hit
}

/**
 * The 4-stone window for the streak goal box: the recently-hit stone is the
 * SECOND stone (the FIRST stone for the very first milestone); for a streak
 * below the first milestone the window starts at the first stone.
 * Returns { stones, hitIndex, nextIndex }.
 */
export function streakWindow(streak: number): { stones: number[]; hitIndex: number; nextIndex: number } {
  const costs = defaultStreakCosts(80)
  let idx = -1
  for (let i = 0; i < costs.length; i++) {
    if (costs[i] <= streak) idx = i
    else break
  }
  if (idx < 0) return { stones: costs.slice(0, 4), hitIndex: -1, nextIndex: 0 }
  const start = idx === 0 ? 0 : idx - 1
  return { stones: costs.slice(start, start + 4), hitIndex: idx - start, nextIndex: idx - start + 1 }
}

/** Streak-milestone reward: milestone value × 2. */
export function streakMilestoneReward(level: number): number {
  return level * 2
}
