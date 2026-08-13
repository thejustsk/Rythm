import { describe, it, expect } from 'vitest'
import { matchesSearch, searchableText, labelChain } from '../src/renderer/src/lib/search'
import type { CalendarEvent, Label } from '../src/shared/types'

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1',
  title: 'Deep work',
  description: 'Focus block',
  startLocal: '2026-08-13T09:00',
  endLocal: '2026-08-13T10:00',
  allDay: false,
  labelId: 'work',
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

const labels: Label[] = [
  { id: 'work', name: 'Work', color: '#0a84ff', parentId: 'job', sortOrder: 0, archived: 0 },
  { id: 'job', name: 'Job', color: null, parentId: null, sortOrder: 0, archived: 0 },
  { id: 'home', name: 'Home', color: '#34c759', parentId: null, sortOrder: 0, archived: 0 }
]

describe('labelChain', () => {
  it('includes the parent chain', () => {
    expect(labelChain('work', labels)).toBe('Job Work')
  })
  it('empty for no label', () => {
    expect(labelChain(null, labels)).toBe('')
  })
})

describe('searchableText', () => {
  it('title + description + label names', () => {
    const t = searchableText(ev({}), labels)
    expect(t).toContain('deep work')
    expect(t).toContain('focus block')
    expect(t).toContain('job work')
  })
})

describe('matchesSearch (item B.3)', () => {
  it('matches title (case-insensitive)', () => {
    expect(matchesSearch(ev({}), labels, 'DEEP')).toBe(true)
  })
  it('matches description', () => {
    expect(matchesSearch(ev({}), labels, 'focus')).toBe(true)
  })
  it('matches a LABEL NAME (new — was title+description only)', () => {
    expect(matchesSearch(ev({ title: 'X', description: '' }), labels, 'work')).toBe(true)
  })
  it('matches a PARENT label name', () => {
    expect(matchesSearch(ev({ title: 'X', description: '' }), labels, 'job')).toBe(true)
  })
  it('does not match unrelated labels', () => {
    expect(matchesSearch(ev({ title: 'X', description: '' }), labels, 'home')).toBe(false)
  })
  it('empty query matches everything', () => {
    expect(matchesSearch(ev({}), labels, '')).toBe(true)
  })
})
