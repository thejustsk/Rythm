import { describe, it, expect } from 'vitest'
import { isoWeekNumber, weekStartOf, weekDayNames } from '../src/renderer/src/lib/dates'

describe('isoWeekNumber (ISO 8601)', () => {
  it('2026-01-01 (Thu) is week 1', () => {
    expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1)
  })
  it('2025-12-31 (Wed) belongs to week 1 of 2026', () => {
    expect(isoWeekNumber(new Date(2025, 11, 31))).toBe(1)
  })
  it('2026-01-05 (Mon) is week 2', () => {
    expect(isoWeekNumber(new Date(2026, 0, 5))).toBe(2)
  })
  it('2026-12-31 (Thu) is week 53', () => {
    expect(isoWeekNumber(new Date(2026, 11, 31))).toBe(53)
  })
  it('mid-year week is stable', () => {
    expect(isoWeekNumber(new Date(2026, 7, 13))).toBe(33)
  })
})

describe('weekStartOf', () => {
  it('Monday-start: Thu 2026-08-13 → Mon 2026-08-10', () => {
    expect(weekStartOf(new Date(2026, 7, 13), 1)).toEqual(new Date(2026, 7, 10))
  })
  it('Monday-start: Sun 2026-08-16 → Mon 2026-08-10', () => {
    expect(weekStartOf(new Date(2026, 7, 16), 1)).toEqual(new Date(2026, 7, 10))
  })
  it('Monday-start: Sun 2026-08-09 → Mon 2026-08-03', () => {
    expect(weekStartOf(new Date(2026, 7, 9), 1)).toEqual(new Date(2026, 7, 3))
  })
  it('Sunday-start: Thu 2026-08-13 → Sun 2026-08-09', () => {
    expect(weekStartOf(new Date(2026, 7, 13), 0)).toEqual(new Date(2026, 7, 9))
  })
  it('Sunday-start: Sun stays', () => {
    expect(weekStartOf(new Date(2026, 7, 9), 0)).toEqual(new Date(2026, 7, 9))
  })
})

describe('weekDayNames', () => {
  it('Monday-first order', () => {
    expect(weekDayNames(1)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })
  it('Sunday-first order', () => {
    expect(weekDayNames(0)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  })
})
