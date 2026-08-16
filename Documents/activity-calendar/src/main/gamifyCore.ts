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

/** v1.11.18 (audit): the ONE coin-rounding helper — 2 decimal places, used by
 *  every earner/ledger/stats calculation so they can never disagree. */
export function roundCoins(n: number): number {
  return Math.round(n * 100) / 100
}

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
  // v1.11.18 (audit): clock-tamper guard — if the stored check-in date is in
  // the FUTURE, the system clock was moved backward after a check-in. The
  // user already checked in for this day: grant NOTHING and never reset the
  // streak (ISO dates compare lexicographically == chronologically).
  if (lastCheckIn !== null && lastCheckIn > today) {
    return { award: false, streak: checkInStreak, amount: 0, multiplier: 1 }
  }
  const streak = lastCheckIn === addDaysIso(today, -1) ? checkInStreak + 1 : 1
  const multiplier = streak % CHECKIN_STREAK_MULTIPLIER_DAY === 0 ? 2 : 1
  return { award: true, streak, amount: CHECKIN_BASE * multiplier, multiplier }
}

/** "All planned done" for a day: every planned block is 'done' (cancelled
 *  does NOT count — matches the streak/perfect rules). */
export function allDoneCheck(planned: number, resolved: number): boolean {
  return planned > 0 && resolved === planned
}

export interface PerfectDay {
  planned: number // how many planned blocks that day
  done: number // how many of those are 'done'
}

/** A day counts toward a perfect week when it has NO plans (rest day) or at
 *  least ONE event is 'done' (the same logic as the streak — one done is
 *  enough; leftover todo/doing blocks on that day don't disqualify it). */
export function dayResolved(d: PerfectDay): boolean {
  return d.planned === 0 || d.done > 0
}

/**
 * PERFECT WEEK (new logic, cup 5): a Monday–Sunday series where every day with
 * at least one event is fully 'done' (rest days are fine) AND at least one day
 * has events — a week with no plans at all is NOT a perfect week.
 */
export function perfectWeekCheck(days: PerfectDay[]): boolean {
  if (days.length !== 7) return false
  const totalPlanned = days.reduce((s, d) => s + d.planned, 0)
  if (totalPlanned === 0) return false // no-plan week → not perfect
  return days.every(dayResolved)
}

/** ISO monday of a week (used as the once-per-week award key). */
export function weekKey(anyDayInWeek: string): string {
  const d = new Date(anyDayInWeek + 'T00:00:00')
  const dow = d.getDay()
  const mon = new Date(d)
  mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return isoD(mon)
}

/** Week-start ISO date containing the given day, honouring the user's
 *  first-day-of-week setting (1 = Monday, 0 = Sunday). Used by the
 *  perfect-week bonus so the AWARD matches what the calendar DISPLAYS. */
export function weekStartIso(anyDayInWeek: string, startDow: 1 | 0): string {
  const d = new Date(anyDayInWeek + 'T00:00:00')
  const dow = d.getDay()
  let diff: number
  if (startDow === 1) diff = dow === 0 ? -6 : 1 - dow
  else diff = dow === 0 ? 0 : -dow
  const out = new Date(d)
  out.setDate(out.getDate() + diff)
  return isoD(out)
}

/** First day of the month containing the given ISO date (award key). */
export function monthKey(anyDayInMonth: string): string {
  return anyDayInMonth.slice(0, 8) + '01'
}

/**
 * PERFECT MONTH (new logic): every day of the month belongs to a perfect week,
 * i.e. EVERY Monday–Sunday week that overlaps the month is a perfect week
 * (boundary weeks judged as whole weeks), and the month has at least one
 * planned day.
 */
export function perfectMonthCheck(
  monthStart: string, // YYYY-MM-DD (first of month)
  monthEnd: string, // YYYY-MM-DD (last of month)
  dayOf: (iso: string) => PerfectDay
): boolean {
  // EVERY day of the month must be either a rest day (no events planned) or
  // have at least ONE done event — AND no block of 7+ consecutive no-event
  // days may exist within the month (a whole empty week disqualifies it).
  let emptyRun = 0
  let anyPlanned = false
  for (let d = monthStart; d <= monthEnd; d = addDaysIso(d, 1)) {
    const day = dayOf(d)
    if (day.planned === 0) {
      emptyRun++
      if (emptyRun >= 7) return false // 7+ consecutive empty days → not perfect
      continue
    }
    emptyRun = 0
    anyPlanned = true
    if (day.done === 0) return false // a planned day with no done event → not perfect
  }
  return anyPlanned
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
