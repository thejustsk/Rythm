import { describe, expect, it } from 'vitest'
import { snap15, blockBox, layoutColumns, toMinutes, minutesToHM } from '../src/renderer/src/lib/timegrid'

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
