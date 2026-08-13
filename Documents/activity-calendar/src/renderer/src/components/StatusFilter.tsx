import { useMemo } from 'react'
import { useData, useUi } from '@/state/store'
import { computeOccurrences } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import type { EventStatus } from '@shared/types'

const PILLS: Array<{ id: EventStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'todo', label: 'To Do' },
  { id: 'doing', label: 'In Progress' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' }
]

/** The visible time window for the current view — counts are scoped to it
 *  (day = that day, week = Mon–Sun, month = the month, agenda = everything). */
function periodOf(view: string, cursor: Date): { start: Date; end: Date } {
  const start = startOfDay(cursor)
  if (view === 'week') {
    const dow = start.getDay()
    const mon = addDays(start, dow === 0 ? -6 : 1 - dow)
    return { start: mon, end: addDays(mon, 7) }
  }
  if (view === 'month') {
    return {
      start: new Date(cursor.getFullYear(), cursor.getMonth(), 1),
      end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }
  return { start, end: addDays(start, 1) }
}

export default function StatusFilter() {
  const ui = useUi()
  const { events } = useData()

  const counts = useMemo(() => {
    const c = { todo: 0, doing: 0, done: 0, cancelled: 0 }
    if (ui.view === 'agenda') {
      // agenda shows everything — count each event once
      for (const e of events) {
        const st = e.status as EventStatus
        if (st in c) c[st]++
      }
      return c
    }
    const { start, end } = periodOf(ui.view, ui.cursor)
    for (const o of computeOccurrences(events, start, end)) {
      const st = o.event.status as EventStatus
      if (st in c) c[st]++
    }
    return c
  }, [events, ui.view, ui.cursor])

  const countOf = (s: EventStatus) => counts[s]

  return (
    <div className="status-pills">
      {PILLS.map((p) => (
        <button
          key={p.id}
          className={`pill${ui.statusFilter === p.id ? ' active' : ''}`}
          onClick={() => ui.setStatusFilter(p.id)}
        >
          {p.label}
          {p.id !== 'all' && <span className="pill-count">{countOf(p.id)}</span>}
        </button>
      ))}
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
