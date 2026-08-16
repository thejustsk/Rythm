import { useMemo } from 'react'
import { useData, useUi, visibleLabelIds } from '@/state/store'
import { computeOccurrences } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import type { EventStatus } from '@shared/types'
import type { CalendarEvent } from '@shared/types'

import { T } from '@/lib/strings'
import { weekStartOf, type WeekStart } from '@/lib/dates'
import { toggleStatusSel } from '@/lib/statusSel'
import { matchesSearch } from '@/lib/search'
import { buildAgendaGroups } from '@/lib/agenda'
import type { Phase } from '@/lib/labelSelect'
import type { Label } from '@shared/types'

const PILLS: Array<{ id: EventStatus | 'all'; label: string }> = [
  { id: 'all', label: T.statuses.all },
  { id: 'todo', label: T.statuses.todo },
  { id: 'doing', label: T.statuses.doing },
  { id: 'done', label: T.statuses.done },
  { id: 'cancelled', label: T.statuses.cancelled }
]

/** The visible time window for the current view — counts are scoped to it
 *  (day = that day, week = Mon–Sun, month = the month, agenda = the whole
 *  agenda range -14…+45 days around today). */
function periodOf(view: string, cursor: Date, weekStart: WeekStart): { start: Date; end: Date } {
  const start = startOfDay(cursor)
  if (view === 'week') {
    const wk = weekStartOf(start, weekStart)
    return { start: wk, end: addDays(wk, 7) }
  }
  if (view === 'month') {
    return {
      start: new Date(cursor.getFullYear(), cursor.getMonth(), 1),
      end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }
  if (view === 'agenda') {
    const today = startOfDay(new Date())
    return { start: addDays(today, -14), end: addDays(today, 46) }
  }
  return { start, end: addDays(start, 1) }
}

/** v1.11.16: the pill numbers are the ACTUAL data — same occurrences the view
 *  renders, after the same label-filter + search (the status selection itself
 *  never changes the counts, so every pill shows its true total). */
function countOccurrences(
  view: string,
  cursor: Date,
  weekStart: WeekStart,
  events: CalendarEvent[],
  labels: Label[],
  hidden: Set<string>,
  phases: Record<string, Phase>,
  search: string
): { todo: number; doing: number; done: number; cancelled: number } {
  const c = { todo: 0, doing: 0, done: 0, cancelled: 0 }
  const { start, end } = periodOf(view, cursor, weekStart)
  const vis = visibleLabelIds(labels, hidden, phases)
  const occs = computeOccurrences(events, start, end)
  const filtered = occs.filter((o) => {
    const lid = o.event.labelId ?? ''
    if (lid && !vis.has(lid)) return false
    if (!lid && hidden.size > 0) return false // no label + filter active → hidden
    if (!matchesSearch(o.event, labels, search)) return false
    return true
  })
  if (view === 'agenda') {
    // v1.11.17: the AGENDA numbers are the number of ROWS actually rendered —
    // same grouping function as the view (past done/cancelled events are
    // never rendered by the agenda, multi-day events repeat per group)
    for (const grp of buildAgendaGroups(filtered, startOfDay(new Date()))) {
      for (const o of grp.items) {
        const st = o.event.status as EventStatus
        if (st in c) c[st]++
      }
    }
    return c
  }
  for (const o of filtered) {
    const st = o.event.status as EventStatus
    if (st in c) c[st]++
  }
  return c
}

export default function StatusFilter() {
  const ui = useUi()
  const { events, labels } = useData()

  const counts = useMemo(
    () =>
      countOccurrences(
        ui.view,
        ui.cursor,
        ui.weekStart === 'sunday' ? 0 : 1,
        events,
        labels,
        ui.hiddenLabels,
        ui.labelPhases,
        ui.search
      ),
    [events, labels, ui.view, ui.cursor, ui.weekStart, ui.hiddenLabels, ui.labelPhases, ui.search]
  )

  const countOf = (s: EventStatus) => counts[s]
  const sel = ui.statusSel

  return (
    <div className="status-pills">
      {PILLS.map((p) => {
        const active = p.id === 'all' ? sel.size === 0 : sel.has(p.id)
        return (
          <button
            key={p.id}
            className={`pill${active ? ' active' : ''}`}
            title={p.id === 'all' ? 'Show all statuses' : 'Toggle this status (multi-select — pick several together)'}
            onClick={() =>
              p.id === 'all' ? ui.setStatusSel(new Set()) : ui.setStatusSel(toggleStatusSel(sel, p.id))
            }
          >
            {p.label}
            {p.id !== 'all' && <span className="pill-count">{countOf(p.id)}</span>}
          </button>
        )
      })}
      <div className="searchbox pill-search">
        <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <input
          placeholder="Search"
          value={ui.search}
          onChange={(e) => ui.setSearch(e.target.value)}
        />
      </div>
      <button className="btn primary new-btn" onClick={() => ui.openQuickAdd()}>
        ＋ New
      </button>
    </div>
  )
}
