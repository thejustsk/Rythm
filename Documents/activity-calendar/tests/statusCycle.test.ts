import { describe, it, expect } from 'vitest'
import { nextStatus, targetRow } from '../src/renderer/src/lib/statusCycle'
import type { CalendarEvent } from '../src/shared/types'

const base = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1',
  title: 'T',
  description: '',
  startLocal: '2026-08-13T09:00',
  endLocal: '2026-08-13T10:00',
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
  ...over
})

describe('nextStatus (dot cycle)', () => {
  it('cycles todo → doing → done → todo', () => {
    expect(nextStatus('todo')).toBe('doing')
    expect(nextStatus('doing')).toBe('done')
    expect(nextStatus('done')).toBe('todo')
  })
  it('cancelled never cycles', () => {
    expect(nextStatus('cancelled')).toBe('cancelled')
  })
})

describe('targetRow', () => {
  it('single (non-recurring) event → single row', () => {
    const occ = { event: base({}), isOverride: false, key: 'e1|2026-08-13', eventId: 'e1', originDate: '2026-08-13', start: new Date(), end: new Date() }
    expect(targetRow(occ)).toEqual({ kind: 'single' })
  })
  it('recurring master → override row must be created', () => {
    const occ = { event: base({ rrule: 'FREQ=WEEKLY' }), isOverride: false, key: 'e1|2026-08-13', eventId: 'e1', originDate: '2026-08-13', start: new Date(), end: new Date() }
    expect(targetRow(occ)).toEqual({ kind: 'master', master: occ.event })
  })
  it('override rows are edited in place', () => {
    const occ = { event: base({ parentId: 'master', originDate: '2026-08-13' }), isOverride: true, key: 'o1|2026-08-13', eventId: 'o1', originDate: '2026-08-13', start: new Date(), end: new Date() }
    expect(targetRow(occ)).toEqual({ kind: 'override' })
  })
  it('child rows (parentId) edit in place too', () => {
    const occ = { event: base({ parentId: 'master' }), isOverride: false, key: 'o1|2026-08-13', eventId: 'o1', originDate: '2026-08-13', start: new Date(), end: new Date() }
    expect(targetRow(occ)).toEqual({ kind: 'override' })
  })
})
