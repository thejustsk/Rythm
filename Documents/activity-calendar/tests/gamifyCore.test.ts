import { describe, expect, it } from 'vitest'
import {
  checkInState, allDoneCheck, perfectWeekCheck, weekKey, addDaysIso,
  CHECKIN_BASE, ALL_DONE_BONUS, PERFECT_WEEK_BONUS,
  defaultMilestoneCosts, streakAwardLevel, monthAwardLevel,
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

describe('streakAwardLevel (perfect week on 7-multiples)', () => {
  it('awards only on 7, 14, 21…', () => {
    expect(streakAwardLevel(0)).toBeNull()
    expect(streakAwardLevel(6)).toBeNull()
    expect(streakAwardLevel(7)).toBe(7)
    expect(streakAwardLevel(8)).toBeNull()
    expect(streakAwardLevel(14)).toBe(14)
    expect(streakAwardLevel(21)).toBe(21)
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
  it('monthAwardLevel (perfect month on 30-multiples)', () => {
    expect(monthAwardLevel(0)).toBeNull()
    expect(monthAwardLevel(29)).toBeNull()
    expect(monthAwardLevel(30)).toBe(30)
    expect(monthAwardLevel(60)).toBe(60)
  })
})
