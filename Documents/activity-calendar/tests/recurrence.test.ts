import { describe, expect, it } from 'vitest'
import { parseRRule, iterateRule, ruleToHuman, isoDate, addDays, buildRRule, nextOccurrences, rruleUntil } from '../src/renderer/src/engine/recurrence'

const d = (y: number, m: number, day: number, hh = 9, mm = 0) => new Date(y, m - 1, day, hh, mm)
const dates = (gen: Generator<Date>) => Array.from(gen).map(isoDate)

describe('parseRRule', () => {
  it('parses a full weekly rule', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=2026-12-31')
    expect(r).toEqual({ freq: 'WEEKLY', interval: 1, byday: ['MO', 'WE', 'FR'], until: '2026-12-31' })
  })
  it('rejects unknown freq', () => {
    expect(parseRRule('FREQ=HOURLY')).toBeNull()
  })
  it('defaults interval to 1', () => {
    expect(parseRRule('FREQ=DAILY')!.interval).toBe(1)
  })
})

describe('DAILY', () => {
  it('yields every day', () => {
    const r = parseRRule('FREQ=DAILY')!
    expect(dates(iterateRule(r, d(2026, 8, 10))).slice(0, 3)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })
  it('honours INTERVAL=2', () => {
    const r = parseRRule('FREQ=DAILY;INTERVAL=2')!
    expect(dates(iterateRule(r, d(2026, 8, 10))).slice(0, 3)).toEqual(['2026-08-10', '2026-08-12', '2026-08-14'])
  })
  it('honours COUNT', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=3')!
    expect(dates(iterateRule(r, d(2026, 8, 10)))).toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })
  it('honours UNTIL (inclusive)', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=2026-08-12')!
    expect(dates(iterateRule(r, d(2026, 8, 10)))).toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })
  it('applies BYDAY filter', () => {
    const r = parseRRule('FREQ=DAILY;BYDAY=MO,WE,FR')!
    // 2026-08-10 is a Monday
    expect(dates(iterateRule(r, d(2026, 8, 10))).slice(0, 4)).toEqual([
      '2026-08-10',
      '2026-08-12',
      '2026-08-14',
      '2026-08-17'
    ])
  })
})

describe('WEEKLY', () => {
  it('keeps the start weekday when no BYDAY', () => {
    const r = parseRRule('FREQ=WEEKLY')!
    // 2026-08-10 Monday
    expect(dates(iterateRule(r, d(2026, 8, 10))).slice(0, 3)).toEqual(['2026-08-10', '2026-08-17', '2026-08-24'])
  })
  it('expands BYDAY within each week', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')!
    const out = dates(iterateRule(r, d(2026, 8, 10))).slice(0, 4)
    expect(out).toEqual(['2026-08-10', '2026-08-12', '2026-08-14', '2026-08-17'])
  })
  it('does not emit days before the series start', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')!
    // starts Wednesday
    expect(dates(iterateRule(r, d(2026, 8, 12))).slice(0, 3)).toEqual(['2026-08-12', '2026-08-13', '2026-08-14'])
  })
  it('INTERVAL=2 with BYDAY spans two weeks', () => {
    const r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR')!
    const out = dates(iterateRule(r, d(2026, 8, 10))) // Monday Aug 10
    expect(out.slice(0, 4)).toEqual(['2026-08-10', '2026-08-14', '2026-08-24', '2026-08-28'])
  })
})

describe('MONTHLY', () => {
  it('same day-of-month every month', () => {
    const r = parseRRule('FREQ=MONTHLY')!
    expect(dates(iterateRule(r, d(2026, 1, 15))).slice(0, 3)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
  })
  it('skips invalid days (Jan 31 has no Feb 31)', () => {
    const r = parseRRule('FREQ=MONTHLY')!
    const out = dates(iterateRule(r, d(2026, 1, 31))).slice(0, 3)
    expect(out).toEqual(['2026-01-31', '2026-03-31', '2026-05-31'])
  })
  it('handles leap-year February 29', () => {
    const r = parseRRule('FREQ=MONTHLY')!
    expect(dates(iterateRule(r, d(2024, 1, 29))).slice(0, 3)).toEqual(['2024-01-29', '2024-02-29', '2024-03-29'])
  })
  it('BYMONTHDAY=1 gives the 1st', () => {
    const r = parseRRule('FREQ=MONTHLY;BYMONTHDAY=1')!
    expect(dates(iterateRule(r, d(2026, 8, 10))).slice(0, 2)).toEqual(['2026-09-01', '2026-10-01'])
  })
})

describe('YEARLY', () => {
  it('same month/day every year', () => {
    const r = parseRRule('FREQ=YEARLY')!
    expect(dates(iterateRule(r, d(2025, 3, 14))).slice(0, 3)).toEqual(['2025-03-14', '2026-03-14', '2027-03-14'])
  })
  it('skips Feb 29 in non-leap years', () => {
    const r = parseRRule('FREQ=YEARLY')!
    expect(dates(iterateRule(r, d(2024, 2, 29))).slice(0, 2)).toEqual(['2024-02-29', '2028-02-29'])
  })
})

describe('ruleToHuman', () => {
  it('renders friendly text', () => {
    expect(ruleToHuman('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('Every week on Mon, Wed, Fri')
    expect(ruleToHuman('FREQ=DAILY;INTERVAL=2;COUNT=5')).toBe('Every 2 days (5 times)')
  })
})


describe('ruleToHuman is crash-proof', () => {
  it('handles null / undefined / empty (repeat set to None)', () => {
    expect(ruleToHuman(null)).toBe('')
    expect(ruleToHuman(undefined)).toBe('')
    expect(ruleToHuman('')).toBe('')
  })
})

describe('buildRRule', () => {
  it('weekly with weekdays', () => {
    expect(buildRRule({ freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
  })
  it('daily with interval', () => {
    expect(buildRRule({ freq: 'DAILY', interval: 2 })).toBe('FREQ=DAILY;INTERVAL=2')
  })
  it('count and until endings', () => {
    expect(buildRRule({ freq: 'WEEKLY', byday: ['MO'], endMode: 'count', count: 3 })).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=3')
    expect(buildRRule({ freq: 'DAILY', endMode: 'until', until: '2026-12-31' })).toBe('FREQ=DAILY;UNTIL=2026-12-31')
    expect(buildRRule({ freq: 'DAILY', endMode: 'never' })).toBe('FREQ=DAILY')
  })
  it('monthly and yearly', () => {
    expect(buildRRule({ freq: 'MONTHLY', bymonthday: 15 })).toBe('FREQ=MONTHLY;BYMONTHDAY=15')
    expect(buildRRule({ freq: 'YEARLY', bymonth: 3, bymonthday: 14 })).toBe('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14')
  })
  it('round-trips through parseRRule', () => {
    const s = buildRRule({ freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'], endMode: 'count', count: 8 })
    const r = parseRRule(s)!
    expect(r.freq).toBe('WEEKLY')
    expect(r.interval).toBe(2)
    expect(r.byday).toEqual(['MO', 'WE'])
    expect(r.count).toBe(8)
  })
})

describe('nextOccurrences', () => {
  it('returns the next n dates of a rule', () => {
    const out = nextOccurrences('FREQ=WEEKLY;BYDAY=MO,WE,FR', d(2026, 8, 10), 4)
    expect(out.map(isoDate)).toEqual(['2026-08-10', '2026-08-12', '2026-08-14', '2026-08-17'])
  })
  it('returns [] for an invalid rule', () => {
    expect(nextOccurrences('garbage', d(2026, 8, 10), 3)).toEqual([])
  })
})

describe('rruleUntil (delete upcoming)', () => {
  it('replaces COUNT with UNTIL', () => {
    expect(rruleUntil('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3', '2026-08-10')).toBe(
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=2026-08-10'
    )
  })
  it('keeps INTERVAL', () => {
    expect(rruleUntil('FREQ=DAILY;INTERVAL=2', '2026-08-10')).toBe('FREQ=DAILY;INTERVAL=2;UNTIL=2026-08-10')
  })
  it('keeps monthly parts in canonical order', () => {
    expect(rruleUntil('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14', '2026-08-10')).toBe(
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14;UNTIL=2026-08-10'
    )
  })
  it('the resulting rule stops before the UNTIL date (inclusive semantics)', () => {
    const r = rruleUntil('FREQ=DAILY', '2026-08-10')
    const rule = parseRRule(r)!
    const out = Array.from(iterateRule(rule, d(2026, 8, 8))).map(isoDate)
    expect(out).toEqual(['2026-08-08', '2026-08-09', '2026-08-10'])
  })
})

describe('iteration safety', () => {
  it('terminates when COUNT is satisfied', () => {
    const r = parseRRule('FREQ=YEARLY;COUNT=1000000;UNTIL=2030-01-01')!
    expect(dates(iterateRule(r, d(2026, 1, 1))).length).toBeLessThan(100)
  })
  it('addDays helper works across month boundaries', () => {
    expect(isoDate(addDays(d(2026, 8, 31), 1))).toBe('2026-09-01')
  })
})

describe('v1.11.18 fast-forward (audit #5)', () => {
  const fromIso = (iso: string) => new Date(iso + 'T00:00:00')

  it('DAILY: iterating from a later date yields exactly the same set', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=2026-12-31')!
    const full = dates(iterateRule(r, d(2026, 1, 1)))
    const fast = dates(iterateRule(r, d(2026, 1, 1), fromIso('2026-08-01')))
    expect(fast).toEqual(full.filter((x) => x >= '2026-08-01'))
    expect(fast.length).toBeGreaterThan(100) // still the whole tail, not truncated
  })

  it('DAILY with BYDAY: filtered subset identical', () => {
    const r = parseRRule('FREQ=DAILY;BYDAY=MO,WE,FR')!
    const full = dates(iterateRule(r, d(2026, 1, 1)))
    const fast = dates(iterateRule(r, d(2026, 1, 1), fromIso('2026-08-01')))
    expect(fast).toEqual(full.filter((x) => x >= '2026-08-01'))
  })

  it('WEEKLY with BYDAY from mid-week: the containing week is NOT skipped', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')!
    const full = dates(iterateRule(r, d(2026, 8, 1))) // Sat
    // from = Wednesday 2026-08-12 → Friday 08-14 must still appear
    const fast = dates(iterateRule(r, d(2026, 8, 1), fromIso('2026-08-12')))
    expect(fast).toEqual(full.filter((x) => x >= '2026-08-12'))
    expect(fast).toContain('2026-08-14')
  })

  it('WEEKLY INTERVAL=2: aligned to the interval', () => {
    const r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR')!
    const full = dates(iterateRule(r, d(2026, 1, 1)))
    const fast = dates(iterateRule(r, d(2026, 1, 1), fromIso('2026-05-01')))
    expect(fast).toEqual(full.filter((x) => x >= '2026-05-01'))
  })

  it('MONTHLY: subset identical', () => {
    const r = parseRRule('FREQ=MONTHLY;BYMONTHDAY=15')!
    const full = dates(iterateRule(r, d(2025, 1, 15)))
    const fast = dates(iterateRule(r, d(2025, 1, 15), fromIso('2026-03-01')))
    expect(fast).toEqual(full.filter((x) => x >= '2026-03-01'))
  })

  it('YEARLY: subset identical', () => {
    const r = parseRRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14')!
    const full = dates(iterateRule(r, d(2020, 3, 14)))
    const fast = dates(iterateRule(r, d(2020, 3, 14), fromIso('2024-01-01')))
    expect(fast).toEqual(full.filter((x) => x >= '2024-01-01'))
  })

  it('from before the series start → identical to no fast-forward', () => {
    const r = parseRRule('FREQ=DAILY')!
    const full = dates(iterateRule(r, d(2026, 8, 10))).slice(0, 5)
    const fast = dates(iterateRule(r, d(2026, 8, 10), fromIso('2026-01-01'))).slice(0, 5)
    expect(fast).toEqual(full)
  })

  it('from beyond UNTIL → empty', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=2026-08-15')!
    expect(dates(iterateRule(r, d(2026, 1, 1), fromIso('2026-09-01')))).toEqual([])
  })

  it('COUNT rules are NEVER fast-forwarded (count stays exact)', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=3')!
    const withFrom = dates(iterateRule(r, d(2026, 8, 10), fromIso('2026-08-30')))
    const without = dates(iterateRule(r, d(2026, 8, 10)))
    expect(withFrom).toEqual(without) // identical — no jump
    expect(withFrom).toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })
})
