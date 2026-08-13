import { describe, it, expect } from 'vitest'
import { edgeDecision, isHardWheel } from '../src/renderer/src/lib/edgeNav'

describe('isHardWheel', () => {
  it('strong gestures are hard', () => {
    expect(isHardWheel(150)).toBe(true)
    expect(isHardWheel(-150)).toBe(true)
  })
  it('gentle scrolls are not', () => {
    expect(isHardWheel(50)).toBe(false)
    expect(isHardWheel(-20)).toBe(false)
  })
})

describe('edgeDecision', () => {
  it('scroll mode: at the top, hard downward wheel → prev', () => {
    expect(edgeDecision(0, 600, 3000, -150, 'scroll')).toBe('prev')
  })
  it('scroll mode: at the top, downward wheel (inverted delta) → prev', () => {
    expect(edgeDecision(0, 600, 3000, 150, 'scroll')).toBe(null)
  })
  it('scroll mode: at the bottom, hard upward wheel → next', () => {
    expect(edgeDecision(2400, 600, 3000, 150, 'scroll')).toBe('next')
  })
  it('scroll mode: mid-list, hard wheel does nothing', () => {
    expect(edgeDecision(1200, 600, 3000, 150, 'scroll')).toBe(null)
  })
  it('scroll mode: gentle wheel at an edge does nothing', () => {
    expect(edgeDecision(0, 600, 3000, 40, 'scroll')).toBe(null)
  })
  it('fixed mode (month): strong wheel flips', () => {
    expect(edgeDecision(0, 0, 0, 150, 'fixed')).toBe('next')
    expect(edgeDecision(0, 0, 0, -150, 'fixed')).toBe('prev')
  })
  it('fixed mode: gentle wheel does nothing', () => {
    expect(edgeDecision(0, 0, 0, 60, 'fixed')).toBe(null)
  })
})
