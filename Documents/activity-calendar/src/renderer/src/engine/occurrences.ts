/**
 * Expands stored events into concrete occurrences within a time range,
 * applying exdates (skipped days) and overrides (edited single occurrences).
 */
import type { CalendarEvent } from '@shared/types'
import { iterateRule, parseRRule, isoDate, startOfDay } from './recurrence'

export interface Occurrence {
  /** stable key for selection: `${eventId}|${originDate}` */
  key: string
  eventId: string
  /** which calendar day this occurrence belongs to ('yyyy-MM-dd') */
  originDate: string
  start: Date
  end: Date
  event: CalendarEvent
  isOverride: boolean
}

/** Parse 'YYYY-MM-DDTHH:MM' as local wall-clock time. */
export function parseLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (!m) return new Date(s)
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
}

export function fmtHM(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function intersects(occStart: Date, occEnd: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return occStart.getTime() < rangeEnd.getTime() && occEnd.getTime() > rangeStart.getTime()
}

export function computeOccurrences(
  events: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date
): Occurrence[] {
  const overrides = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    if (e.parentId) {
      const arr = overrides.get(e.parentId) ?? []
      arr.push(e)
      overrides.set(e.parentId, arr)
    }
  }

  const out: Occurrence[] = []
  const pushOcc = (ev: CalendarEvent, start: Date, end: Date, isOverride: boolean) => {
    // Stable key: an override uses the master's id so React reuses the same DOM
    // node when a recurring occurrence is edited/dragged (no blink).
    const base = isOverride && ev.parentId ? ev.parentId : ev.id
    out.push({
      key: `${base}|${isoDate(start)}`,
      eventId: ev.id,
      originDate: isoDate(start),
      start,
      end,
      event: ev,
      isOverride
    })
  }

  for (const e of events) {
    if (e.parentId) continue
    const exdates = new Set(e.exdates ?? [])
    const start = parseLocal(e.startLocal)
    const end = parseLocal(e.endLocal)
    const dur = end.getTime() - start.getTime()

    const addForDay = (day: Date) => {
      const origin = isoDate(day)
      // A one-off override wins over both the series occurrence and an exdate
      const ov = (overrides.get(e.id) ?? []).find((o) => o.originDate === origin)
      if (ov) {
        const os = parseLocal(ov.startLocal)
        const oe = parseLocal(ov.endLocal)
        if (intersects(os, oe, rangeStart, rangeEnd)) pushOcc(ov, os, oe, true)
        return
      }
      if (exdates.has(origin)) return
      const occStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes())
      const occEnd = new Date(occStart.getTime() + dur)
      if (intersects(occStart, occEnd, rangeStart, rangeEnd)) pushOcc(e, occStart, occEnd, false)
    }

    if (e.rrule) {
      const rule = parseRRule(e.rrule)
      if (!rule) {
        if (intersects(start, end, rangeStart, rangeEnd)) pushOcc(e, start, end, false)
      } else {
        for (const day of iterateRule(rule, start)) addForDay(day)
      }
    } else {
      if (intersects(start, end, rangeStart, rangeEnd)) pushOcc(e, start, end, false)
    }
  }

  out.sort((a, b) => a.start.getTime() - b.start.getTime())
  return out
}

/** Occurrences that intersect the given calendar day. */
export function occurrencesForDay(occs: Occurrence[], day: Date): Occurrence[] {
  const s = startOfDay(day)
  const e = new Date(s.getTime() + 86400000)
  return occs.filter((o) => o.start.getTime() < e.getTime() && o.end.getTime() > s.getTime())
}
