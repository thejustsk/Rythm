import type { Occurrence } from '@/engine/occurrences'
import { addDays } from '@/engine/recurrence'

export interface AgendaGroup {
  name: string
  items: Occurrence[]
}

/** v1.11.17: THE single agenda grouping — used by BOTH the Agenda view and
 *  the status-pill counters, so the pill numbers ALWAYS equal the number of
 *  rows actually rendered (the old counter counted every occurrence once,
 *  but the agenda (a) never renders past done/cancelled events — Overdue
 *  excludes them — and (b) repeats a multi-day event in every group it
 *  touches. Those two rules are now part of the same function). */
export function buildAgendaGroups(occs: Occurrence[], today: Date): AgendaGroup[] {
  const g = (name: string, fromOff: number, toOff: number): Occurrence[] => {
    const from = addDays(today, fromOff)
    const to = addDays(today, toOff + 1)
    // INCLUDE an event whenever ANY part (full or partial) falls inside the
    // group's days — multi-day events appear in every day they touch
    return occs
      .filter((o) => o.start.getTime() < to.getTime() && o.end.getTime() > from.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  const overdue = g('Overdue', -14, -1).filter((o) => o.event.status !== 'done' && o.event.status !== 'cancelled')
  const todayGroup = g('Today', 0, 0)
  const tomorrowGroup = g('Tomorrow', 1, 1)
  const weekGroup = g('This week', 2, 7)
  const laterGroup = g('Later', 8, 45)
  return [
    { name: 'Overdue', items: overdue },
    { name: 'Today', items: todayGroup },
    { name: 'Tomorrow', items: tomorrowGroup },
    { name: 'This week', items: weekGroup },
    { name: 'Later', items: laterGroup }
  ].filter((grp) => grp.items.length > 0)
}
