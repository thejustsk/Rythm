import { describe, expect, it } from 'vitest'
import {
  checkInState, allDoneCheck, perfectWeekCheck, weekKey, addDaysIso,
  CHECKIN_BASE, ALL_DONE_BONUS, PERFECT_WEEK_BONUS,
  defaultMilestoneCosts, perfectWeekCheck, perfectMonthCheck, dayResolved,
  weekKey, monthKey, streakMilestoneLevelsUpTo,
  defaultStreakCosts, streakMilestoneLevel, streakMilestoneReward, streakWindow
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

describe('perfectWeekCheck (cup 5: every planned day has >=1 done, >=1 planned day)', () => {
  const full = (planned: number, done: number) => ({ planned, done })
  const goodWeek = [
    full(2, 1), full(1, 1), full(3, 3), full(0, 0), full(1, 1), full(2, 2), full(4, 1)
  ]
  it('a week where every planned day has at least one done is perfect', () => {
    expect(perfectWeekCheck(goodWeek)).toBe(true)
  })
  it('a day with SOME done and leftover todos still counts (streak logic)', () => {
    const days = [full(2, 1), full(1, 1), full(1, 1), full(0, 0), full(1, 1), full(1, 1), full(1, 1)]
    expect(perfectWeekCheck(days)).toBe(true)
  })
  it('REST days (no plans) do NOT break the week', () => {
    const withRest = [full(3, 3), full(2, 2), full(0, 0), full(1, 1), full(4, 4), full(2, 2), full(2, 2)]
    expect(perfectWeekCheck(withRest)).toBe(true)
  })
  it('a NO-PLAN week is NOT perfect', () => {
    const idle = Array.from({ length: 7 }, () => full(0, 0))
    expect(perfectWeekCheck(idle)).toBe(false)
  })
  it('a day with plans but NOTHING done fails', () => {
    const days = [full(2, 0), full(1, 1), full(1, 1), full(0, 0), full(1, 1), full(1, 1), full(1, 1)]
    expect(perfectWeekCheck(days)).toBe(false)
  })
  it('requires exactly 7 days', () => {
    expect(perfectWeekCheck(goodWeek.slice(0, 6))).toBe(false)
  })
})

describe('perfectMonthCheck (cup 5: every day of the month in a perfect week)', () => {
  it('a month fully covered by perfect weeks is a perfect month', () => {
    // June 2026: starts Monday 1, ends Tuesday 30 → weeks Mon1–Sun7, Mon8–Sun14,
    // Mon15–Sun21, Mon22–Sun28, Mon29–Sun Jul 5 (boundary includes July days)
    const weekDays = (mon: string) => {
      const all = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ planned: 1, done: 1 }))
      // make July 1-5 a rest stretch inside the boundary week — still perfect
      return all.map((d) => d)
    }
    expect(perfectMonthCheck('2026-06-01', '2026-06-30', weekDays)).toBe(true)
  })
  it('a month with a non-perfect week fails', () => {
    const weekDays = (mon: string) => {
      if (mon === '2026-06-15') return [0, 1, 2, 3, 4, 5, 6].map((i) => ({ planned: 1, done: i === 0 ? 0 : 1 }))
      return [0, 1, 2, 3, 4, 5, 6].map((i) => ({ planned: 1, done: 1 }))
    }
    expect(perfectMonthCheck('2026-06-01', '2026-06-30', weekDays)).toBe(false)
  })
  it('a month with NO planned days fails (idle month)', () => {
    const weekDays = () => [0, 1, 2, 3, 4, 5, 6].map((i) => ({ planned: 0, done: 0 }))
    expect(perfectMonthCheck('2026-06-01', '2026-06-30', weekDays)).toBe(false)
  })
})


describe('defaultMilestoneCosts (growing path)', () => {
  it('base path: 100…4000 then +2000 forever', () => {
    expect(defaultMilestoneCosts(8)).toEqual([100, 250, 500, 1000, 1500, 2500, 4000, 6000])
    expect(defaultMilestoneCosts(10)).toEqual([100, 250, 500, 1000, 1500, 2500, 4000, 6000, 8000, 10000])
  })
})


describe('streak milestones (5,10,20,30,50,75,+25)', () => {
  it('generates the path', () => {
    expect(defaultStreakCosts(9)).toEqual([5, 10, 20, 30, 50, 75, 100, 125, 150])
  })
  it('finds the highest reached milestone', () => {
    expect(streakMilestoneLevel(4)).toBeNull()
    expect(streakMilestoneLevel(5)).toBe(5)
    expect(streakMilestoneLevel(7)).toBe(5)
    expect(streakMilestoneLevel(10)).toBe(10)
    expect(streakMilestoneLevel(52)).toBe(50)
    expect(streakMilestoneLevel(120)).toBe(100)
  })
  it('reward = milestone x2', () => {
    expect(streakMilestoneReward(5)).toBe(10)
    expect(streakMilestoneReward(50)).toBe(100)
    expect(streakMilestoneReward(100)).toBe(200)
  })
  it('window: first milestone is the FIRST stone', () => {
    const w = streakWindow(5)
    expect(w.stones).toEqual([5, 10, 20, 30])
    expect(w.hitIndex).toBe(0)
    expect(w.nextIndex).toBe(1)
  })
  it('window: hit 50 → 30,50,75,100 (hit second)', () => {
    const w = streakWindow(50)
    expect(w.stones).toEqual([30, 50, 75, 100])
    expect(w.hitIndex).toBe(1)
  })
  it('window: hit 100 → 75,100,125,150', () => {
    const w = streakWindow(100)
    expect(w.stones).toEqual([75, 100, 125, 150])
    expect(w.hitIndex).toBe(1)
  })
  it('window: below first milestone starts at 5', () => {
    const w = streakWindow(3)
    expect(w.stones).toEqual([5, 10, 20, 30])
    expect(w.hitIndex).toBe(-1)
  })
})

describe('helpers', () => {
  it('monthKey returns the first of the month', () => {
    expect(monthKey('2026-08-13')).toBe('2026-08-01')
    expect(monthKey('2026-12-31')).toBe('2026-12-01')
  })
  it('dayResolved: rest days ok, at least one done otherwise (streak logic)', () => {
    expect(dayResolved({ planned: 0, done: 0 })).toBe(true)
    expect(dayResolved({ planned: 3, done: 3 })).toBe(true)
    expect(dayResolved({ planned: 3, done: 2 })).toBe(true) // some done → ok
    expect(dayResolved({ planned: 3, done: 1 })).toBe(true) // one done → ok
    expect(dayResolved({ planned: 2, done: 0 })).toBe(false)
  })
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
  it('CATCH-UP: streakMilestoneLevelsUpTo awards every milestone ≤ streak', () => {
    expect(streakMilestoneLevelsUpTo(4)).toEqual([])
    expect(streakMilestoneLevelsUpTo(5)).toEqual([5])
    expect(streakMilestoneLevelsUpTo(9)).toEqual([5])
    expect(streakMilestoneLevelsUpTo(12)).toEqual([5, 10])
    expect(streakMilestoneLevelsUpTo(55)).toEqual([5, 10, 20, 30, 50])
  })
})
