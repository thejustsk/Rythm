import { describe, it, expect } from 'vitest'
import {
  morningSummary,
  slotReminder,
  startupReminder,
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

describe('slotReminder (v1.11.13 — lists ALL pending today)', () => {
  const now = new Date(2026, 7, 14, 9, 0)
  it('lists every pending event of the day (not just the next 2h)', () => {
    const r = slotReminder([occ('Deep work', 10), occ('Lunch', 13), occ('Gym', 18)], now, now)
    expect(r).not.toBeNull()
    expect(r!.title).toBe('Rhythm — Today')
    expect(r!.body).toContain('3 activities left today')
    expect(r!.body).toContain('10:00 Deep work')
    expect(r!.body).toContain('13:00 Lunch')
    expect(r!.body).toContain('18:00 Gym')
  })
  it('events further than 2h away ARE included (the 2h window is gone)', () => {
    const r = slotReminder([occ('A', 18)], now, now)
    expect(r).not.toBeNull()
    expect(r!.body).toContain('18:00 A')
  })
  it('ignores done/cancelled events', () => {
    expect(slotReminder([occ('A', 10, 0, 'done'), occ('B', 11, 0, 'cancelled')], now, now)).toBeNull()
  })
  it('caps the list at 5 lines and shows "+N more"', () => {
    const r = slotReminder(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t, i) => occ(t, 10 + i)),
      now,
      now
    )
    expect(r!.body).toContain('+2 more')
    expect(r!.body).toContain('10:00 a')
    expect(r!.body).toContain('14:00 e')
  })
  it('null when everything is already past', () => {
    expect(slotReminder([occ('A', 8)], now, now)).toBeNull() // 8:00 < 9:00 now
  })
})

describe('startupReminder', () => {
  it('reminds when an event starts within the lead time', () => {
    const now = new Date(2026, 7, 14, 9, 50)
    const r = startupReminder([occ('Standup', 10)], now, 30)
    expect(r).not.toBeNull()
    expect(r!.body).toContain('Standup')
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
