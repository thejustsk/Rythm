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
