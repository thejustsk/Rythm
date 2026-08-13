import { describe, expect, it } from 'vitest'
import { snap15, snap15Rel, blockBox, blockBoxForDay, layoutColumns, layoutClusters, toMinutes, minutesToHM, toAbsEndMin, localFromDayMinutes, relMinFrom, dayRelMins, minutesOnDay } from '../src/renderer/src/lib/timegrid'

describe('snap15', () => {
  it('rounds to the nearest 15', () => {
    expect(snap15(0)).toBe(0)
    expect(snap15(7)).toBe(0)
    expect(snap15(8)).toBe(15)
    expect(snap15(61)).toBe(60)
    expect(snap15(67)).toBe(60)
    expect(snap15(68)).toBe(75)
  })
  it('never negative', () => {
    expect(snap15(-5)).toBe(0)
  })
})

describe('blockBox', () => {
  const px = 0.55
  it('positions by minutes', () => {
    expect(blockBox(6 * 60, 7 * 60, px)).toEqual({ top: 198, height: 33 })
  })
  it('clamps to day bounds', () => {
    const b = blockBox(-30, 25, px, 0, 24 * 60)
    expect(b.top).toBe(0)
    expect(b.height).toBeGreaterThanOrEqual(10)
  })
  it('enforces a minimum height', () => {
    expect(blockBox(60, 61, px).height).toBe(10)
  })
})

describe('layoutColumns', () => {
  it('puts non-overlapping items in one column', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 60, endMin: 120 }
    ]
    const m = layoutColumns(items)
    expect(m.get('a')).toEqual({ col: 0, cols: 1 })
    expect(m.get('b')).toEqual({ col: 0, cols: 1 })
  })
  it('side-by-side for overlapping', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 120 },
      { item: 'b', startMin: 30, endMin: 90 }
    ]
    const m = layoutColumns(items)
    expect(m.get('a')!.cols).toBe(2)
    expect(m.get('b')!.cols).toBe(2)
    expect(m.get('a')!.col).not.toBe(m.get('b')!.col)
  })
  it('a third overlapping block gets its own column', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 120 },
      { item: 'b', startMin: 30, endMin: 90 },
      { item: 'c', startMin: 60, endMin: 180 }
    ]
    const m = layoutColumns(items)
    expect(m.get('a')!.cols).toBe(3)
    expect(m.get('c')!.col).toBe(2)
  })
  it('reuses a column after an item ends', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 30, endMin: 90 },
      { item: 'c', startMin: 70, endMin: 120 }
    ]
    const m = layoutColumns(items)
    expect(m.get('c')!.col).toBe(0)
    expect(m.get('c')!.cols).toBe(2)
  })
})

describe('layoutClusters (split only overlapping)', () => {
  it('non-overlapping items each keep full width', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 70, endMin: 130 },
      { item: 'c', startMin: 140, endMin: 200 }
    ]
    const m = layoutClusters(items)
    expect(m.get('a')).toEqual({ col: 0, cols: 1 })
    expect(m.get('b')).toEqual({ col: 0, cols: 1 })
    expect(m.get('c')).toEqual({ col: 0, cols: 1 })
  })

  it('only the overlapping pair splits; the standalone stays full width', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 30, endMin: 90 },
      { item: 'c', startMin: 120, endMin: 180 }
    ]
    const m = layoutClusters(items)
    expect(m.get('a')!.cols).toBe(2)
    expect(m.get('b')!.cols).toBe(2)
    expect(m.get('a')!.col).not.toBe(m.get('b')!.col)
    expect(m.get('c')).toEqual({ col: 0, cols: 1 }) // untouched by the split
  })

  it('a chain of overlaps forms one cluster with three columns', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 30, endMin: 90 },
      { item: 'c', startMin: 60, endMin: 120 }
    ]
    const m = layoutClusters(items)
    expect(m.get('a')!.cols).toBe(2)
    expect(m.get('b')!.cols).toBe(2)
    expect(m.get('c')!.cols).toBe(2)
    // c reuses column 0 after a ends
    expect(m.get('c')!.col).toBe(0)
    expect(m.get('b')!.col).not.toBe(m.get('a')!.col)
  })

  it('two separate clusters split independently', () => {
    const items = [
      { item: 'a', startMin: 0, endMin: 60 },
      { item: 'b', startMin: 30, endMin: 90 },
      { item: 'c', startMin: 200, endMin: 260 },
      { item: 'd', startMin: 230, endMin: 290 }
    ]
    const m = layoutClusters(items)
    expect(m.get('a')!.cols).toBe(2)
    expect(m.get('c')!.cols).toBe(2)
    expect(m.get('d')!.col).not.toBe(m.get('c')!.col)
  })

  it('empty input → empty result', () => {
    expect(layoutClusters([]).size).toBe(0)
  })
})




describe('minutesOnDay (today-part of multi-day events)', () => {
  it('splits an overnight event: only today\'s share', () => {
    const day = new Date(2026, 7, 11)
    const start = new Date(2026, 7, 11, 22, 0)
    const end = new Date(2026, 7, 12, 0, 30)
    expect(minutesOnDay(start, end, day)).toBe(120)
    expect(minutesOnDay(start, end, new Date(2026, 7, 12))).toBe(30)
  })
  it('a whole-day event inside the day returns its full length', () => {
    const day = new Date(2026, 7, 11)
    expect(minutesOnDay(new Date(2026, 7, 11, 9, 0), new Date(2026, 7, 11, 10, 0), day)).toBe(60)
  })
  it('an event fully outside the day contributes 0', () => {
    const day = new Date(2026, 7, 11)
    expect(minutesOnDay(new Date(2026, 7, 13, 9, 0), new Date(2026, 7, 13, 10, 0), day)).toBe(0)
  })
})

describe('multi-day relative helpers', () => {
  const d1 = new Date(2026, 7, 11) // Aug 11
  const d2 = new Date(2026, 7, 12)
  it('relMinFrom: start before the grabbed day is NEGATIVE', () => {
    const start = new Date(2026, 7, 11, 22, 0)
    expect(relMinFrom(d2, start)).toBe(-120)
    expect(relMinFrom(d2, new Date(2026, 7, 12, 0, 30))).toBe(30)
    expect(relMinFrom(d1, start)).toBe(1320)
  })
  it('snap15Rel allows negatives (multi-day start)', () => {
    expect(snap15Rel(-125)).toBe(-120)
    expect(snap15Rel(33)).toBe(30)
  })
  it('dayRelMins clamps a multi-day span into one column', () => {
    const start = new Date(2026, 7, 11, 22, 0)
    const end = new Date(2026, 7, 12, 0, 30)
    const day2 = dayRelMins(d2, start, end)
    expect(day2).toEqual({ startMin: 0, endMin: 30 })
    const day1 = dayRelMins(d1, start, end)
    expect(day1.startMin).toBe(1320)
    expect(day1.endMin).toBe(1440)
  })
})

describe('overnight / multi-day helpers', () => {
  it('toAbsEndMin counts overflow into the next day', () => {
    const start = new Date(2026, 7, 11, 22, 0)
    const end = new Date(2026, 7, 12, 0, 30)
    expect(toAbsEndMin(start, end)).toBe(30 + 1440)
  })
  it('localFromDayMinutes shifts the date past midnight', () => {
    expect(localFromDayMinutes(new Date(2026, 7, 11), 1530)).toBe('2026-08-12T01:30')
    expect(localFromDayMinutes(new Date(2026, 7, 11), 1380)).toBe('2026-08-11T23:00')
  })
  it('blockBoxForDay renders the overnight portion on day 2 from the top', () => {
    const occStart = new Date(2026, 7, 11, 22, 0)
    const occEnd = new Date(2026, 7, 12, 0, 30)
    const day2 = new Date(2026, 7, 12)
    const box = blockBoxForDay(occStart, occEnd, day2, 0.55)
    expect(box.top).toBe(0)
    expect(box.height).toBeCloseTo(30 * 0.55)
  })
  it('blockBoxForDay clamps the first day to midnight', () => {
    const occStart = new Date(2026, 7, 11, 22, 0)
    const occEnd = new Date(2026, 7, 12, 0, 30)
    const day1 = new Date(2026, 7, 11)
    const box = blockBoxForDay(occStart, occEnd, day1, 0.55)
    expect(box.top).toBeCloseTo(22 * 60 * 0.55)
    expect(box.height).toBeCloseTo(2 * 60 * 0.55)
  })
  it('a day outside the span yields a stub box', () => {
    const occStart = new Date(2026, 7, 11, 22, 0)
    const occEnd = new Date(2026, 7, 12, 0, 30)
    const box = blockBoxForDay(occStart, occEnd, new Date(2026, 7, 13), 0.55)
    expect(box.height).toBeGreaterThanOrEqual(10)
  })
})

describe('helpers', () => {
  it('toMinutes', () => {
    expect(toMinutes(new Date(2026, 7, 10, 9, 30))).toBe(570)
  })
  it('minutesToHM', () => {
    expect(minutesToHM(0)).toBe('00:00')
    expect(minutesToHM(570)).toBe('09:30')
    expect(minutesToHM(1440)).toBe('24:00')
  })
})
