import { describe, expect, it } from 'vitest'
import { buildAgendaGroups } from '../src/renderer/src/lib/agenda'
import type { Occurrence } from '../src/renderer/src/engine/occurrences'
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

const occ = (e: CalendarEvent): Occurrence => ({
  key: e.id,
  eventId: e.id,
  event: e,
  originDate: e.startLocal.slice(0, 10),
  start: new Date(e.startLocal + ':00'),
  end: new Date(e.endLocal + ':00')
})

// today = 2026-08-16 (Sunday) — matches the sandbox clock (MIDNIGHT, like the
// real agenda's startOfDay anchor)
const TODAY = new Date(2026, 7, 16, 0, 0, 0)

describe('buildAgendaGroups (v1.11.17 shared agenda grouping)', () => {
  it('never renders past done/cancelled events (Overdue excludes them)', () => {
    const pastDone = occ(ev('d1', '2026-08-15T09:00', '2026-08-15T10:00', { status: 'done' }))
    const pastCanc = occ(ev('c1', '2026-08-14T09:00', '2026-08-14T10:00', { status: 'cancelled' }))
    const pastTodo = occ(ev('t1', '2026-08-15T10:00', '2026-08-15T11:00'))
    const groups = buildAgendaGroups([pastDone, pastCanc, pastTodo], TODAY)
    const overdue = groups.find((g) => g.name === 'Overdue')
    expect(overdue?.items.map((o) => o.eventId)).toEqual(['t1'])
  })

  it('renders a multi-day event in EVERY group it touches (rows repeat)', () => {
    // 23:00 → 01:30 spans Today (16th) and Tomorrow (17th)
    const multi = occ(ev('m1', '2026-08-16T23:00', '2026-08-17T01:30'))
    const groups = buildAgendaGroups([multi], TODAY)
    const today = groups.find((g) => g.name === 'Today')
    const tomorrow = groups.find((g) => g.name === 'Tomorrow')
    expect(today?.items.some((o) => o.eventId === 'm1')).toBe(true)
    expect(tomorrow?.items.some((o) => o.eventId === 'm1')).toBe(true)
    // the SAME event yields TWO rows → a row counter sees 2, so the pill
    // counter must count 2 as well (both use this function)
    const totalRows = groups.reduce((s, g) => s + g.items.length, 0)
    expect(totalRows).toBe(2)
  })

  it('an event spanning Overdue→Today renders in both groups', () => {
    // yesterday 23:00 → today 01:00
    const span = occ(ev('s1', '2026-08-15T23:00', '2026-08-16T01:00'))
    const groups = buildAgendaGroups([span], TODAY)
    const overdue = groups.find((g) => g.name === 'Overdue')
    const today = groups.find((g) => g.name === 'Today')
    expect(overdue?.items.some((o) => o.eventId === 's1')).toBe(true)
    expect(today?.items.some((o) => o.eventId === 's1')).toBe(true)
  })

  it('sorts each group by start time', () => {
    const a = occ(ev('a', '2026-08-16T11:00', '2026-08-16T12:00'))
    const b = occ(ev('b', '2026-08-16T09:00', '2026-08-16T10:00'))
    const groups = buildAgendaGroups([a, b], TODAY)
    const today = groups.find((g) => g.name === 'Today')
    expect(today?.items.map((o) => o.eventId)).toEqual(['b', 'a'])
  })

  it('omits empty groups', () => {
    const groups = buildAgendaGroups([], TODAY)
    expect(groups).toEqual([])
  })
})
