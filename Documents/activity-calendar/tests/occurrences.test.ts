import { describe, expect, it } from 'vitest'
import { computeOccurrences, parseLocal } from '../src/renderer/src/engine/occurrences'
import type { CalendarEvent } from '../src/shared/types'

const ev = (
  id: string,
  startLocal: string,
  endLocal: string,
  extra: Partial<CalendarEvent> = {}
): CalendarEvent => ({
  id,
  title: id,
  description: '',
  startLocal,
  endLocal,
  allDay: false,
  labelId: null,
  colorOverride: null,
  status: 'todo',
  rrule: null,
  exdates: [],
  parentId: null,
  originDate: null,
  completedAt: null,
  createdAt: '',
  updatedAt: '',
  ...extra
})


describe('series time-change keeps all dates (no vanish)', () => {
  it('a series started long ago, edited later in series mode, keeps earlier dates', () => {
    // series anchor = Aug 1 (weeks ago); the UI opens a LATER day's occurrence
    const master = ev('m', '2026-08-01T06:30', '2026-08-01T07:15', { rrule: 'FREQ=DAILY' })
    // whole-series save writes seriesStart = master date + form time (never the
    // selected day) — simulate exactly what EventDialog.save does
    const formTimeStart = '09:00'
    const edited = { ...master, startLocal: `2026-08-01T${formTimeStart}`, endLocal: '2026-08-01T09:45' }
    const occs = computeOccurrences([edited], parseLocal('2026-08-01T00:00'), parseLocal('2026-08-13T00:00'))
    const dates = occs.map((o) => o.originDate)
    expect(dates[0]).toBe('2026-08-01')
    expect(dates).toContain('2026-08-05')
    expect(dates).toContain('2026-08-11')
    expect(occs[0].start.getHours()).toBe(9)
  })
  it('a one-off override coexists with the series dates', () => {
    const master = ev('m', '2026-08-11T06:30', '2026-08-11T07:15', { rrule: 'FREQ=DAILY' })
    const ov = ev('ov', '2026-08-12T10:00', '2026-08-12T11:00', { parentId: 'm', originDate: '2026-08-12' })
    const occs = computeOccurrences([master, ov], parseLocal('2026-08-11T00:00'), parseLocal('2026-08-14T00:00'))
    const aug12 = occs.filter((o) => o.originDate === '2026-08-12')
    expect(aug12).toHaveLength(1)
    expect(aug12[0].isOverride).toBe(true)
    expect(occs.map((o) => o.originDate)).toEqual(['2026-08-11', '2026-08-12', '2026-08-13'])
  })
})

describe('occurrence keys stay unique (ghost prevention)', () => {
  it('an override moved onto a day with a regular occurrence yields two distinct keys', () => {
    const master = ev('m', '2026-08-11T06:30', '2026-08-11T07:15', { rrule: 'FREQ=DAILY' })
    // dragged from Aug 11 to Aug 12 — Aug 12 also has its own regular occurrence
    const ov = ev('ov', '2026-08-12T06:30', '2026-08-12T07:15', { parentId: 'm', originDate: '2026-08-11' })
    const occs = computeOccurrences([master, ov], parseLocal('2026-08-12T00:00'), parseLocal('2026-08-13T00:00'))
    expect(occs).toHaveLength(2)
    const keys = new Set(occs.map((o) => o.key))
    expect(keys.size).toBe(2)
    expect(occs.filter((o) => o.isOverride)).toHaveLength(1)
    expect(occs.some((o) => o.eventId === 'ov')).toBe(true)
    expect(occs.some((o) => o.eventId === 'm')).toBe(true)
  })

  it('the moved-back override replaces the regular occurrence on its origin day', () => {
    const master = ev('m', '2026-08-11T06:30', '2026-08-11T07:15', {
      rrule: 'FREQ=DAILY',
      exdates: ['2026-08-11']
    })
    // dragged back: override now sits on its origin day, series skips it
    const ov = ev('ov', '2026-08-11T06:30', '2026-08-11T07:15', { parentId: 'm', originDate: '2026-08-11' })
    const occs = computeOccurrences([master, ov], parseLocal('2026-08-11T00:00'), parseLocal('2026-08-13T00:00'))
    expect(occs).toHaveLength(2) // override on the 11th + regular on the 12th
    const aug11 = occs.filter((o) => o.originDate === '2026-08-11')
    expect(aug11).toHaveLength(1)
    expect(aug11[0].isOverride).toBe(true)
  })
})

describe('v1.11.18 occurrence fast-forward (audit #5)', () => {
  const dailyOld = ev('old', '2025-06-01T09:00', '2025-06-01T10:00', {
    rrule: 'FREQ=DAILY;UNTIL=2026-12-31'
  })

  it('a 400+ day old daily series still yields every day of the view window', () => {
    const occs = computeOccurrences([dailyOld], parseLocal('2026-08-10T00:00'), parseLocal('2026-08-17T00:00'))
    const days = occs.map((o) => o.start.toLocaleDateString('en-US'))
    expect(occs).toHaveLength(7)
    expect(days[0]).toContain('8/10/2026') // locale-tolerant enough for CI
    expect(days[6]).toContain('8/16/2026')
  })

  it('an overnight occurrence starting the day BEFORE the range still appears', () => {
    const night = ev('night', '2026-08-09T23:00', '2026-08-10T00:30', { rrule: 'FREQ=DAILY' })
    const occs = computeOccurrences([night], parseLocal('2026-08-10T00:00'), parseLocal('2026-08-11T00:00'))
    // the 08-09 23:00 occurrence ends 00:30 on the 10th → inside the range
    expect(occs.some((o) => o.start.getHours() === 23)).toBe(true)
    expect(occs.some((o) => o.start.getDate() === 10 && o.start.getHours() === 23)).toBe(true)
  })

  it('exdates and overrides still apply with fast-forward', () => {
    const withEx = ev('ex', '2025-01-01T09:00', '2025-01-01T10:00', {
      rrule: 'FREQ=DAILY;UNTIL=2026-12-31',
      exdates: ['2026-08-12']
    })
    const ov = ev('ov', '2026-08-13T14:00', '2026-08-13T15:00', {
      parentId: 'ex',
      originDate: '2026-08-13'
    })
    const occs = computeOccurrences([withEx, ov], parseLocal('2026-08-10T00:00'), parseLocal('2026-08-17T00:00'))
    const days = occs.map((o) => o.eventId + '@' + o.originDate)
    expect(days).not.toContain('ex@2026-08-12') // exdated
    expect(days).toContain('ov@2026-08-13') // override replaces that day
    expect(days).not.toContain('ex@2026-08-13')
    expect(days).toContain('ex@2026-08-14') // the series continues after
  })
})
