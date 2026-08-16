import type { EventStatus } from '@shared/types'

/** v1.11.16: multi-select status filter. An EMPTY set = "All" (no filter).
 *  Selecting every status is the same as All, so it normalizes to empty. */
export const ALL_STATUSES: EventStatus[] = ['todo', 'doing', 'done', 'cancelled']

export function toggleStatusSel(sel: ReadonlySet<EventStatus>, s: EventStatus): Set<EventStatus> {
  const next = new Set(sel)
  if (next.has(s)) next.delete(s)
  else next.add(s)
  // all four selected == nothing filtered → back to All
  if (next.size === ALL_STATUSES.length) return new Set()
  return next
}

export const statusLabelOf = (s: EventStatus): string =>
  s === 'todo' ? 'To Do' : s === 'doing' ? 'In Progress' : s === 'done' ? 'Done' : 'Cancelled'
