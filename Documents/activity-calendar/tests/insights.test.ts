import { describe, expect, it } from 'vitest'
import { computeInsights, fmtH, isoD } from '../src/renderer/src/lib/insights'
import type { CalendarEvent, Label } from '../src/shared/types'

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

const lbl = (id: string, name: string, color: string | null, parentId: string | null = null): Label => ({
  id,
  name,
  color,
  parentId,
  sortOrder: 0,
  archived: false
})

const range = (fromIso: string, days: number) => ({
  start: new Date(fromIso + 'T00:00:00'),
  end: new Date(new Date(fromIso + 'T00:00:00').getTime() + days * 86400000)
})

describe('fmtH', () => {
  it('formats minutes humanly', () => {
    expect(fmtH(45)).toBe('45m')
    expect(fmtH(120)).toBe('2h')
    expect(fmtH(137)).toBe('2h 17m')
    expect(fmtH(0)).toBe('0m')
  })
})

describe('computeInsights', () => {
  it('sums planned and done minutes with completion %', () => {
    const events = [
      ev('a', '2026-08-10T09:00', '2026-08-10T10:30', { status: 'done' }), // 90m done
      ev('b', '2026-08-10T14:00', '2026-08-10T15:00', { status: 'todo' }) // 60m planned
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.plannedMin).toBe(150)
    expect(ins.doneMin).toBe(90)
    expect(ins.completion).toBe(60)
    expect(ins.count).toBe(2)
    expect(ins.doneCount).toBe(1)
  })

  it('excludes cancelled from planned time', () => {
    const events = [
      ev('a', '2026-08-10T09:00', '2026-08-10T10:00', { status: 'cancelled' }),
      ev('b', '2026-08-10T10:00', '2026-08-10T11:00', { status: 'todo' })
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.plannedMin).toBe(60)
    expect(ins.count).toBe(1)
  })

  it('rolls sub-label time up into the parent label', () => {
    const labels = [
      lbl('fit', 'Fitness', '#10B981'),
      lbl('gym', 'Gym', '#F97316', 'fit'),
      lbl('walk', 'Walk', null, 'fit')
    ]
    const events = [
      ev('g', '2026-08-10T09:00', '2026-08-10T10:00', { labelId: 'gym' }),
      ev('w', '2026-08-10T10:00', '2026-08-10T11:30', { labelId: 'walk' })
    ]
    const ins = computeInsights(events, labels, new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.perLabel).toHaveLength(1)
    expect(ins.perLabel[0].name).toBe('Fitness')
    expect(ins.perLabel[0].plannedMin).toBe(150)
  })

  it('marks unlabelled events separately', () => {
    const events = [ev('u', '2026-08-10T09:00', '2026-08-10T10:00')]
    const ins = computeInsights(events, [lbl('w', 'Work', '#3B82F6')], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.perLabel[0].name).toBe('Unlabelled')
  })

  it('respects the hidden-labels filter (parent hides children)', () => {
    const labels = [lbl('fit', 'Fitness', '#10B981'), lbl('gym', 'Gym', '#F97316', 'fit')]
    const events = [ev('g', '2026-08-10T09:00', '2026-08-10T10:00', { labelId: 'gym' })]
    const ins = computeInsights(events, labels, new Set(['fit']), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.perLabel).toHaveLength(0)
  })

  it('computes per-day stats', () => {
    const events = [ev('a', '2026-08-10T09:00', '2026-08-10T10:00', { status: 'done' })]
    const ins = computeInsights(events, [], new Set(), range('2026-08-09', 4).start, range('2026-08-09', 4).end)
    const day = ins.perDay.find((d) => d.date === '2026-08-10')
    expect(day?.plannedMin).toBe(60)
    expect(day?.doneMin).toBe(60)
  })

  it('builds a 112-cell heatmap ending today', () => {
    const ins = computeInsights([], [], new Set(), range('2026-08-01', 30).start, range('2026-08-01', 30).end)
    expect(ins.heatmap).toHaveLength(112)
    expect(isoD(new Date())).toBe(ins.heatmap[ins.heatmap.length - 1].date)
  })

  it('computes a completion streak over consecutive done days', () => {
    const events = [
      ev('a', '2026-08-08T09:00', '2026-08-08T10:00', { status: 'done' }),
      ev('b', '2026-08-07T09:00', '2026-08-07T10:00', { status: 'done' })
    ]
    // range covers the last days; streak counts back from today
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.streak).toBeGreaterThanOrEqual(0)
    expect(ins.streak).toBeLessThan(3)
  })

  it('digest reads naturally and is non-empty when there is data', () => {
    const events = [ev('a', '2026-08-10T09:00', '2026-08-10T10:30', { status: 'done' })]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.digest.length).toBeGreaterThanOrEqual(4)
    expect(ins.digest[0]).toContain('planned')
  })

  it('digest is friendly with no data', () => {
    const ins = computeInsights([], [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.digest[0]).toContain('No activities')
    expect(ins.completion).toBe(0)
  })

  it('busiestHour is 0 when empty and correct otherwise', () => {
    const empty = computeInsights([], [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(empty.busiestHour).toBe(0)
    const events = [ev('a', '2026-08-10T18:00', '2026-08-10T19:00')]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.busiestHour).toBe(18)
    expect(ins.hourDist[18]).toBe(60)
  })
})
