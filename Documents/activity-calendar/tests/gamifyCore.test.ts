import { describe, expect, it } from 'vitest'
import {
  checkInState, allDoneCheck, perfectWeekCheck, weekKey, addDaysIso,
  CHECKIN_BASE, ALL_DONE_BONUS, PERFECT_WEEK_BONUS
} from '../src/main/gamifyCore'

describe('checkInState', () => {
  it('awards once per day (same day → no award)', () => {
    const r = checkInState('2026-08-11', 3, '2026-08-11')
    expect(r.award).toBe(false)
    expect(r.amount).toBe(0)
  })
  it('continues the streak when yesterday', () => {
    const r = checkInState('2026-08-10', 3, '2026-08-11')
    expect(r.award).toBe(true)
    expect(r.streak).toBe(4)
    expect(r.amount).toBe(CHECKIN_BASE)
  })
  it('resets the streak after a gap', () => {
    const r = checkInState('2026-08-08', 5, '2026-08-11')
    expect(r.streak).toBe(1)
    expect(r.amount).toBe(CHECKIN_BASE)
  })
  it('doubles on the 7th consecutive day', () => {
    const r = checkInState('2026-08-10', 6, '2026-08-11')
    expect(r.streak).toBe(7)
    expect(r.amount).toBe(CHECKIN_BASE * 2)
  })
  it('first ever check-in starts at streak 1', () => {
    const r = checkInState(null, 0, '2026-08-11')
    expect(r.award).toBe(true)
    expect(r.streak).toBe(1)
  })
})

describe('allDoneCheck', () => {
  it('requires at least one planned block, all resolved', () => {
    expect(allDoneCheck(0, 0)).toBe(false)
    expect(allDoneCheck(2, 1)).toBe(false)
    expect(allDoneCheck(2, 2)).toBe(true)
  })
})

describe('perfectWeekCheck', () => {
  it('requires 7 days, each active-or-rest', () => {
    const good = Array.from({ length: 7 }, () => ({ hasDone: true, hasMissed: false, planned: 2 }))
    expect(perfectWeekCheck(good)).toBe(true)
    // leftover todos on an otherwise active day do NOT block the week
    const withLeftovers = [...good.slice(0, 6), { hasDone: true, hasMissed: true, planned: 2 }]
    expect(perfectWeekCheck(withLeftovers)).toBe(true)
    expect(perfectWeekCheck(good.slice(0, 6))).toBe(false)
  })
  it('REST days (no plans) do NOT break the week — the weekly all-done credit', () => {
    const withRest = [
      { hasDone: true, hasMissed: false, planned: 3 },
      { hasDone: true, hasMissed: false, planned: 2 },
      { hasDone: false, hasMissed: false, planned: 0 }, // rest day
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 4 },
      { hasDone: true, hasMissed: false, planned: 2 },
      { hasDone: true, hasMissed: false, planned: 2 }
    ]
    expect(perfectWeekCheck(withRest)).toBe(true)
  })
  it('a day with plans but nothing done still fails', () => {
    const days = [
      { hasDone: false, hasMissed: false, planned: 2 },
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 1 },
      { hasDone: true, hasMissed: false, planned: 1 }
    ]
    expect(perfectWeekCheck(days)).toBe(false)
  })
})

describe('helpers', () => {
  it('addDaysIso crosses month boundaries', () => {
    expect(addDaysIso('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDaysIso('2026-08-11', -1)).toBe('2026-08-10')
  })
  it('weekKey returns the ISO monday', () => {
    expect(weekKey('2026-08-13')).toBe('2026-08-10') // Thu → Mon
    expect(weekKey('2026-08-09')).toBe('2026-08-03') // Sun → previous Mon
  })
  it('bonus constants', () => {
    expect(ALL_DONE_BONUS).toBe(25)
    expect(PERFECT_WEEK_BONUS).toBe(100)
  })
})
