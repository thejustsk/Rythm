/**
 * Search (item B.3): matches title + description + LABEL NAMES (parent chain).
 * Replaces the old title+description-only matching in every view.
 */
import type { CalendarEvent, Label } from '@shared/types'

/** 'yyyy-MM-dd' of the event's label id, or '' */
export function labelChain(labelId: string | null, labels: Label[]): string {
  if (!labelId) return ''
  const byId = new Map(labels.map((l) => [l.id, l]))
  const parts: string[] = []
  let cur = byId.get(labelId)
  let guard = 0
  while (cur && guard++ < 8) {
    parts.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join(' ')
}

/** The full text that search runs against for one event. */
export function searchableText(ev: CalendarEvent, labels: Label[]): string {
  return `${ev.title} ${ev.description} ${labelChain(ev.labelId, labels)}`.toLowerCase()
}

/** Case-insensitive substring match on title/description/label names. */
export function matchesSearch(ev: CalendarEvent, labels: Label[], q: string): boolean {
  const query = q.trim().toLowerCase()
  if (!query) return true
  return searchableText(ev, labels).includes(query)
}
