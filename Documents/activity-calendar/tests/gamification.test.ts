import { describe, expect, it } from 'vitest'
import { computeEarn, baseCoins, fmtCoins, SCORE_MULT } from '../src/renderer/src/lib/gamification'

describe('computeEarn', () => {
  it('on time = base × 1.0', () => {
    expect(computeEarn(60, 'on_time')).toBe(10)
    expect(computeEarn(90, 'on_time')).toBe(15)
  })
  it('late = base × 0.6', () => {
    expect(computeEarn(60, 'late')).toBe(6)
  })
  it('off schedule = base × 0.3', () => {
    expect(computeEarn(60, 'off_schedule')).toBe(3)
  })
  it('rounds to 2 dp', () => {
    expect(computeEarn(45, 'late')).toBe(4.5)
    expect(computeEarn(10, 'on_time')).toBe(1.67)
  })
  it('multipliers match the engine table', () => {
    expect(SCORE_MULT).toEqual({ on_time: 1, late: 0.6, off_schedule: 0.3 })
  })
})

describe('baseCoins & fmtCoins', () => {
  it('default rate = 10 coins/hour', () => {
    expect(baseCoins(60)).toBe(10)
    expect(baseCoins(30)).toBe(5)
  })
  it('formats integers plainly and decimals to 2 places', () => {
    expect(fmtCoins(10)).toBe('10')
    expect(fmtCoins(4.5)).toBe('4.50')
    expect(fmtCoins(1.67)).toBe('1.67')
  })
})
