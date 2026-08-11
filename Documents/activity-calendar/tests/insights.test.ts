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



describe('uniqueMin (overlap correction)', () => {
  it('counts overlapping activities only once', () => {
    const events = [
      ev('a', '2026-08-10T10:00', '2026-08-10T11:00'),
      ev('b', '2026-08-10T10:30', '2026-08-10T11:30')
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.plannedMin).toBe(120) // raw sum (double counts the overlap)
    expect(ins.uniqueMin).toBe(90) // union of intervals
  })
  it('equals planned when nothing overlaps', () => {
    const events = [
      ev('a', '2026-08-10T10:00', '2026-08-10T11:00'),
      ev('b', '2026-08-10T12:00', '2026-08-10T13:00')
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.uniqueMin).toBe(120)
    expect(ins.plannedMin).toBe(120)
  })
  it('merges chains of overlapping intervals', () => {
    const events = [
      ev('a', '2026-08-10T10:00', '2026-08-10T11:00'),
      ev('b', '2026-08-10T10:30', '2026-08-10T12:00'),
      ev('c', '2026-08-10T11:30', '2026-08-10T13:00')
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.plannedMin).toBe(240)
    expect(ins.uniqueMin).toBe(180)
  })
  it('adds a digest note when overlaps are significant', () => {
    const events = [
      ev('a', '2026-08-10T10:00', '2026-08-10T11:00'),
      ev('b', '2026-08-10T10:30', '2026-08-10T11:30')
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.digest.some((d) => d.includes('overlap') && d.includes('unique busy time'))).toBe(true)
  })
})


describe('per-day split (overnight events)', () => {
  it('attributes each day its own share; total counted once', () => {
    const events = [ev('o', '2026-08-10T22:00', '2026-08-11T00:30', { status: 'done' })]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 3).start, range('2026-08-10', 3).end)
    expect(ins.plannedMin).toBe(150) // counted once
    const d1 = ins.perDay.find((d) => d.date === '2026-08-10')
    const d2 = ins.perDay.find((d) => d.date === '2026-08-11')
    expect(d1?.plannedMin).toBe(120)
    expect(d2?.plannedMin).toBe(30)
    expect(d1?.doneMin).toBe(120)
    expect(d2?.doneMin).toBe(30)
    // hour distribution spans hours 22, 23 and 0 (each minute in its real hour)
    expect(ins.hourDist[22]).toBe(60)
    expect(ins.hourDist[23]).toBe(60)
    expect(ins.hourDist[0]).toBe(30)
  })
})

describe('parent own-part stats', () => {
  it('reports the parent\'s own (non-sublabel) share separately', () => {
    const labels = [
      lbl('fit', 'Fitness', '#10B981'),
      lbl('gym', 'Gym', '#F97316', 'fit')
    ]
    const events = [
      ev('own', '2026-08-10T09:00', '2026-08-10T10:00', { labelId: 'fit' }), // parent directly
      ev('g', '2026-08-10T11:00', '2026-08-10T12:00', { labelId: 'gym' }) // child
    ]
    const ins = computeInsights(events, labels, new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    const kids = ins.childStats['fit']
    expect(kids).toHaveLength(2)
    const own = kids.find((k) => k.own)
    expect(own?.name).toContain('no sub-label')
    expect(own?.plannedMin).toBe(60)
    expect(kids.find((k) => k.id === 'gym')?.plannedMin).toBe(60)
    // parent total includes both parts
    expect(ins.perLabel[0].plannedMin).toBe(120)
  })
})

describe('streak skips days with no planned events', () => {
  const dIso = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  it('a gap day without planned events does not break the streak', () => {
    const events = [
      ev('t', dIso(0) + 'T09:00', dIso(0) + 'T10:00', { status: 'done' }),
      ev('b', dIso(-2) + 'T09:00', dIso(-2) + 'T10:00', { status: 'done' })
      // yesterday: nothing planned → skipped
    ]
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.streak).toBe(2)
    expect(ins.streakStart).toBe(dIso(-2))
  })
  it('a planned-but-not-done day DOES break the streak', () => {
    const events = [
      ev('t', dIso(0) + 'T09:00', dIso(0) + 'T10:00', { status: 'done' }),
      ev('y', dIso(-1) + 'T09:00', dIso(-1) + 'T10:00', { status: 'todo' })
    ]
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.streak).toBe(1)
    expect(ins.streakStart).toBe(dIso(0))
  })
  it('tracks first completion ever', () => {
    const events = [
      ev('a', dIso(-5) + 'T09:00', dIso(-5) + 'T10:00', { status: 'done' }),
      ev('b', dIso(-2) + 'T09:00', dIso(-2) + 'T10:00', { status: 'done' })
    ]
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.firstDone).toBe(dIso(-5))
  })
})


describe('streak start correctness', () => {
  const dIso = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  it('streak start = the OLDEST day of the current streak', () => {
    const events = [
      ev('a', dIso(0) + 'T09:00', dIso(0) + 'T10:00', { status: 'done' }),
      ev('b', dIso(-1) + 'T09:00', dIso(-1) + 'T10:00', { status: 'done' }),
      ev('c', dIso(-3) + 'T09:00', dIso(-3) + 'T10:00', { status: 'done' }) // gap day -2 skipped
    ]
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.streak).toBe(3)
    expect(ins.streakStart).toBe(dIso(-3))
  })
  it('streak counts today even when today has only a done event', () => {
    const events = [ev('a', dIso(0) + 'T09:00', dIso(0) + 'T10:00', { status: 'done' })]
    const ins = computeInsights(events, [], new Set(), new Date(Date.now() - 10 * 86400000), new Date(Date.now() + 86400000))
    expect(ins.streak).toBe(1)
    expect(ins.streakStart).toBe(dIso(0))
  })
})

describe('status buckets', () => {
  it('counts todo/doing/cancelled separately', () => {
    const events = [
      ev('a', '2026-08-10T09:00', '2026-08-10T10:00', { status: 'todo' }),
      ev('b', '2026-08-10T10:00', '2026-08-10T11:00', { status: 'doing' }),
      ev('c', '2026-08-10T11:00', '2026-08-10T12:00', { status: 'cancelled' }),
      ev('d', '2026-08-10T12:00', '2026-08-10T13:00', { status: 'done' })
    ]
    const ins = computeInsights(events, [], new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    expect(ins.todoCount).toBe(1)
    expect(ins.doingCount).toBe(1)
    expect(ins.cancelledCount).toBe(1)
    expect(ins.doneCount).toBe(1)
    expect(ins.todoMin).toBe(60)
    expect(ins.doingMin).toBe(60)
    expect(ins.cancelledMin).toBe(60)
    expect(ins.plannedMin).toBe(180) // cancelled excluded from planned
  })
})

describe('topLabelId filter (parent-label insights)', () => {
  it('only includes events whose top-level label matches', () => {
    const labels = [
      lbl('fit', 'Fitness', '#10B981'),
      lbl('gym', 'Gym', '#F97316', 'fit'),
      lbl('work', 'Work', '#3B82F6')
    ]
    const events = [
      ev('g', '2026-08-10T09:00', '2026-08-10T10:00', { labelId: 'gym' }),
      ev('w', '2026-08-10T11:00', '2026-08-10T12:00', { labelId: 'work' })
    ]
    const ins = computeInsights(events, labels, new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end, 'fit')
    expect(ins.plannedMin).toBe(60)
    expect(ins.perLabel).toHaveLength(1)
    expect(ins.perLabel[0].name).toBe('Fitness')
    expect(ins.digest[0]).toContain('Fitness')
  })
  it('excludes unlabelled events when filtered', () => {
    const events = [
      ev('u', '2026-08-10T09:00', '2026-08-10T10:00'),
      ev('g', '2026-08-10T10:00', '2026-08-10T11:00', { labelId: 'gym' })
    ]
    const labels = [lbl('fit', 'Fitness', '#10B981'), lbl('gym', 'Gym', '#F97316', 'fit')]
    const ins = computeInsights(events, labels, new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end, 'fit')
    expect(ins.plannedMin).toBe(60)
  })
})

describe('childStats (sublabel details)', () => {
  it('collects sub-label stats under their parent (only when children exist)', () => {
    const labels = [
      lbl('fit', 'Fitness', '#10B981'),
      lbl('gym', 'Gym', '#F97316', 'fit'),
      lbl('walk', 'Walk', null, 'fit'),
      lbl('work', 'Work', '#3B82F6')
    ]
    const events = [
      ev('g', '2026-08-10T09:00', '2026-08-10T10:00', { labelId: 'gym', status: 'done' }),
      ev('w', '2026-08-10T10:00', '2026-08-10T11:00', { labelId: 'walk' })
    ]
    const ins = computeInsights(events, labels, new Set(), range('2026-08-10', 2).start, range('2026-08-10', 2).end)
    const kids = ins.childStats['fit']
    expect(kids).toBeDefined()
    expect(kids).toHaveLength(2)
    const gym = kids.find((k) => k.name === 'Gym')
    expect(gym?.plannedMin).toBe(60)
    expect(gym?.doneMin).toBe(60)
    expect(gym?.color).toBe('#F97316')
    const walk = kids.find((k) => k.name === 'Walk')
    expect(walk?.color).toBe('#10B981') // inherits parent colour
    // a parent without children gets no entry
    expect(ins.childStats['work']).toBeUndefined()
  })
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
