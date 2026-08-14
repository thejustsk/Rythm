import { describe, it, expect } from 'vitest'
import {
  morningSummary,
  slotReminder,
  startupReminder,
  SLOT_WINDOW_MIN,
  fmtReminder
} from '../src/main/notifyCore'

const occ = (title: string, h: number, m = 0, status = 'todo'): { title: string; start: Date; status: string } => ({
  title,
  start: new Date(2026, 7, 14, h, m),
  status
})

describe('morningSummary', () => {
  it('summarizes active events today', () => {
    const r = morningSummary([occ('A', 9), occ('B', 10), occ('C', 11, 0, 'done')])
    expect(r).not.toBeNull()
    expect(r!.body).toContain('2 activities')
  })
  it('null when nothing active', () => {
    expect(morningSummary([occ('A', 9, 0, 'done'), occ('B', 10, 0, 'cancelled')])).toBeNull()
  })
  it('null when no events at all', () => {
    expect(morningSummary([])).toBeNull()
  })
})

describe('slotReminder', () => {
  const now = new Date(2026, 7, 14, 9, 0)
  it('reminds for events starting within 2h of the slot (10:00 → slot 09:00)', () => {
    const r = slotReminder([occ('Deep work', 10)], now, now)
    expect(r).not.toBeNull()
    expect(r!.title).toBe('Rhythm — Upcoming')
    expect(r!.body).toContain('Deep work')
    expect(r!.body).toContain('10:00')
    expect(r!.body).toContain('60 min')
  })
  it('combines multiple events with "and N more"', () => {
    const r = slotReminder([occ('A', 10), occ('B', 10, 30)], now, now)
    expect(r!.body).toContain('and 1 more')
  })
  it('ignores events further than 2h after the slot', () => {
    const r = slotReminder([occ('A', 12)], now, now)
    expect(r).toBeNull()
  })
  it('ignores done/cancelled events', () => {
    expect(slotReminder([occ('A', 10, 0, 'done')], now, now)).toBeNull()
  })
  it('respects a custom window', () => {
    const r = slotReminder([occ('A', 10)], now, now, 30)
    expect(r).toBeNull() // 10:00 is 60 min after 09:00 → outside a 30-min window
    const r2 = slotReminder([occ('A', 9, 20)], now, now, 30)
    expect(r2).not.toBeNull()
  })
  it('constant is 120 minutes (documented 2h window)', () => {
    expect(SLOT_WINDOW_MIN).toBe(120)
  })
})

describe('startupReminder', () => {
  it('reminds when an event starts within the lead time', () => {
    const now = new Date(2026, 7, 14, 9, 50)
    const r = startupReminder([occ('Standup', 10)], now, 30)
    expect(r).not.toBeNull()
    expect(r!.body).toContain('10 min')
  })
  it('null when nothing within the lead time', () => {
    const now = new Date(2026, 7, 14, 9, 0)
    expect(startupReminder([occ('Standup', 10)], now, 30)).toBeNull()
  })
})

describe('fmtReminder', () => {
  it('renders title — body', () => {
    expect(fmtReminder({ title: 'T', body: 'B' })).toBe('T — B')
  })
})
