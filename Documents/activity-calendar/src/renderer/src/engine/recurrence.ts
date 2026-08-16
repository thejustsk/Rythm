/**
 * Recurrence engine — pure, unit-testable, no Electron/React imports.
 * Supports a practical subset of RFC 5545:
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY
 *   INTERVAL=n, BYDAY=MO,TU,..., BYMONTHDAY=n, BYMONTH=n
 *   COUNT=n, UNTIL=yyyy-MM-dd
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RRule {
  freq: Freq
  interval: number
  byday?: string[]
  bymonthday?: number[]
  bymonth?: number[]
  count?: number
  /** inclusive 'yyyy-MM-dd' */
  until?: string
}

export const WEEKDAY_KEYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
export const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

const MAX_ITERATIONS = 5000

export function parseRRule(s: string): RRule | null {
  const parts: Record<string, string> = {}
  for (const piece of s.split(';')) {
    const i = piece.indexOf('=')
    if (i > 0) parts[piece.slice(0, i).toUpperCase()] = piece.slice(i + 1)
  }
  const freq = parts.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  const rule: RRule = { freq, interval: Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1) }
  if (parts.BYDAY) rule.byday = parts.BYDAY.split(',')
  if (parts.BYMONTHDAY)
    rule.bymonthday = parts.BYMONTHDAY.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
  if (parts.BYMONTH)
    rule.bymonth = parts.BYMONTH.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
  if (parts.COUNT) {
    const c = parseInt(parts.COUNT, 10)
    if (!isNaN(c)) rule.count = c
  }
  if (parts.UNTIL) rule.until = parts.UNTIL
  return rule
}

// --- pure local-wall-clock date helpers ---------------------------------

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function addMonths(d: Date, n: number): Date {
  const x = new Date(d)
  x.setMonth(x.getMonth() + n)
  return x
}

export function addYears(d: Date, n: number): Date {
  const x = new Date(d)
  x.setFullYear(x.getFullYear() + n)
  return x
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate()
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function mondayOf(d: Date): Date {
  const x = startOfDay(d)
  const dow = x.getDay() // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow
  x.setDate(x.getDate() + diff)
  return x
}

function dayMatches(rule: RRule, day: Date): boolean {
  if (rule.byday && !rule.byday.includes(WEEKDAY_KEYS[day.getDay()])) return false
  if (rule.bymonthday && !rule.bymonthday.includes(day.getDate())) return false
  if (rule.bymonth && !rule.bymonth.includes(day.getMonth() + 1)) return false
  return true
}

/**
 * Yields the occurrence *dates* (start-of-day) of a series, in order,
 * honouring COUNT/UNTIL. Guaranteed to terminate.
 * `from` (optional) fast-forwards the iteration to the first interval
 * overlapping that date — used by the views so a 3-year-old daily series
 * doesn't re-walk ~1000 days for every render (v1.11.18, audit #5). The
 * yielded SET is identical to iterating from the start (intersecting filters
 * are applied by the caller); COUNT series are never fast-forwarded so the
 * count cap stays exact.
 */
export function* iterateRule(rule: RRule, seriesStart: Date, from?: Date): Generator<Date> {
  const start = startOfDay(seriesStart)
  const untilMs = rule.until ? new Date(rule.until + 'T00:00:00').getTime() : Infinity
  // COUNT rules are NEVER fast-forwarded — the count cap must count matches
  // from the series START, so `from` is ignored entirely for them
  const fromMs = from && !rule.count ? startOfDay(from).getTime() : 0
  let emitted = 0

  const yieldIfMatch = (day: Date): boolean => {
    if (day.getTime() < start.getTime()) return false
    if (fromMs && day.getTime() < fromMs) return false
    if (!dayMatches(rule, day)) return false
    if (day.getTime() > untilMs) return false
    emitted++
    return true
  }

  // fast-forward helper (v1.11.18): first interval index that can contain a
  // day >= `from` — FLOOR so the interval overlapping `from` is never skipped
  // (the caller filters partial overlaps). COUNT rules stay exact → no jump.
  const idx0 = (numerator: number, denom: number): number => {
    if (!from || rule.count) return 0
    return Math.max(0, Math.floor(numerator / denom))
  }

  if (rule.freq === 'DAILY') {
    const k0 = idx0(from ? from.getTime() - start.getTime() : 0, 86400000 * rule.interval)
    for (let k = k0; k < MAX_ITERATIONS; k++) {
      const day = addDays(start, k * rule.interval)
      if (day.getTime() > untilMs) break
      if (yieldIfMatch(day)) yield day
      if (rule.count && emitted >= rule.count) break
    }
    return
  }

  if (rule.freq === 'WEEKLY') {
    const anchor = mondayOf(start)
    const byday = rule.byday ? [...rule.byday].sort((a, b) => WEEKDAY_INDEX[a] - WEEKDAY_INDEX[b]) : null
    const w0 = idx0(from ? from.getTime() - anchor.getTime() : 0, 7 * 86400000 * rule.interval)
    for (let w = w0; w < MAX_ITERATIONS; w++) {
      const weekStart = addDays(anchor, w * 7 * rule.interval)
      if (weekStart.getTime() > untilMs) break
      if (byday) {
        for (const key of byday) {
          const day = addDays(weekStart, WEEKDAY_INDEX[key] === 0 ? 6 : WEEKDAY_INDEX[key] - 1)
          if (day.getTime() > untilMs) break
          if (yieldIfMatch(day)) yield day
          if (rule.count && emitted >= rule.count) return
        }
      } else {
        const day = addDays(weekStart, start.getDay() === 0 ? 6 : start.getDay() - 1)
        if (day.getTime() > untilMs) break
        if (yieldIfMatch(day)) yield day
      }
      if (rule.count && emitted >= rule.count) return
    }
    return
  }

  if (rule.freq === 'MONTHLY') {
    const months = rule.bymonthday ?? [start.getDate()]
    const k0 = idx0(
      from ? from.getFullYear() * 12 + from.getMonth() - (start.getFullYear() * 12 + start.getMonth()) : 0,
      rule.interval
    )
    for (let k = k0; k < MAX_ITERATIONS; k++) {
      // compute target year/month without day-overflow (Jan 31 + 1 month must stay in Feb)
      const totalMonths = start.getFullYear() * 12 + start.getMonth() + k * rule.interval
      const year = Math.floor(totalMonths / 12)
      const month0 = totalMonths % 12
      if (rule.bymonth && !rule.bymonth.includes(month0 + 1)) continue
      const dim = daysInMonth(year, month0)
      const days = [...new Set(months)].sort((a, b) => a - b).filter((dnum) => dnum <= dim)
      for (const dnum of days) {
        const day = new Date(year, month0, dnum)
        if (day.getTime() > untilMs) break
        if (yieldIfMatch(day)) yield day
        if (rule.count && emitted >= rule.count) return
      }
      if (rule.count && emitted >= rule.count) return
    }
    return
  }

  // YEARLY
  const months = rule.bymonth ?? [start.getMonth() + 1]
  const days = rule.bymonthday ?? [start.getDate()]
  const k0 = idx0(from ? from.getFullYear() - start.getFullYear() : 0, rule.interval)
  for (let k = k0; k < MAX_ITERATIONS; k++) {
    const year = start.getFullYear() + k * rule.interval
    for (const month1 of [...months].sort((a, b) => a - b)) {
      const dim = daysInMonth(year, month1 - 1)
      for (const dnum of [...days].sort((a, b) => a - b)) {
        if (dnum > dim) continue
        const day = new Date(year, month1 - 1, dnum)
        if (day.getTime() > untilMs) break
        if (yieldIfMatch(day)) yield day
        if (rule.count && emitted >= rule.count) return
      }
    }
    if (rule.count && emitted >= rule.count) return
  }
}

const FREQ_LABEL: Record<Freq, string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year'
}

// ---------------------------------------------------------------------------
// Rule building (used by the Repeat editor UI) — pure and tested
// ---------------------------------------------------------------------------

export interface RepeatOptions {
  freq: Freq
  interval?: number
  byday?: string[]
  bymonthday?: number
  bymonth?: number
  endMode?: 'never' | 'until' | 'count'
  until?: string
  count?: number
}

export function buildRRule(o: RepeatOptions): string {
  const parts = [`FREQ=${o.freq}`]
  const interval = Math.max(1, o.interval ?? 1)
  if (interval > 1) parts.push(`INTERVAL=${interval}`)
  if (o.byday?.length) parts.push(`BYDAY=${[...new Set(o.byday)].join(',')}`)
  if (o.bymonth) parts.push(`BYMONTH=${o.bymonth}`)
  if (o.bymonthday) parts.push(`BYMONTHDAY=${o.bymonthday}`)
  if (o.endMode === 'until' && o.until) parts.push(`UNTIL=${o.until}`)
  if (o.endMode === 'count' && o.count) parts.push(`COUNT=${Math.max(1, o.count)}`)
  return parts.join(';')
}

/** The next n occurrence dates of a rule, starting at `from`. */
export function nextOccurrences(rrule: string, from: Date, n: number): Date[] {
  const rule = parseRRule(rrule)
  if (!rule) return []
  const out: Date[] = []
  for (const d of iterateRule(rule, from)) {
    out.push(d)
    if (out.length >= n) break
  }
  return out
}

/** Replace any ending of a rule with UNTIL=<date> (used by "delete upcoming"). */
export function rruleUntil(rrule: string, untilIso: string): string {
  const rule = parseRRule(rrule)
  if (!rule) return rrule
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byday?.length) parts.push(`BYDAY=${rule.byday.join(',')}`)
  if (rule.bymonth?.length) parts.push(`BYMONTH=${rule.bymonth.join(',')}`)
  if (rule.bymonthday?.length) parts.push(`BYMONTHDAY=${rule.bymonthday.join(',')}`)
  parts.push(`UNTIL=${untilIso}`)
  return parts.join(';')
}

/** Human-readable summary of a rule, e.g. "Every week on Mon, Wed, Fri". */
export function ruleToHuman(rrule: string | null | undefined): string {
  if (!rrule) return ''
  const rule = parseRRule(rrule)
  if (!rule) return rrule
  const every = rule.interval > 1 ? `Every ${rule.interval} ${FREQ_LABEL[rule.freq]}s` : `Every ${FREQ_LABEL[rule.freq]}`
  const parts = [every]
  if (rule.byday?.length) {
    const names = rule.byday.map((k) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][WEEKDAY_INDEX[k]])
    parts.push('on ' + names.join(', '))
  }
  if (rule.bymonthday?.length) parts.push('on day ' + rule.bymonthday.join(', '))
  if (rule.bymonth?.length) parts.push('in month ' + rule.bymonth.join(', '))
  if (rule.count) parts.push(`(${rule.count} times)`)
  if (rule.until) parts.push(`until ${rule.until}`)
  return parts.join(' ')
}
