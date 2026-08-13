import { useMemo } from 'react'
import { useData, useUi, iso } from '@/state/store'
import { computeOccurrences } from '@/engine/occurrences'
import { addDays, startOfDay } from '@/engine/recurrence'
import { resolveEventColor } from '@/lib/colors'
import { daysBetween } from '@/lib/timegrid'
import { matchesSearch } from '@/lib/search'
import { fmtClock } from '@/lib/clock'

/** Agenda: grouped list — Overdue / Today / Tomorrow / This week / Later. */
export default function AgendaView() {
  const ui = useUi()
  const { events, labels } = useData()

  const groups = useMemo(() => {
    const today = startOfDay(new Date())
    const rangeStart = addDays(today, -14)
    const rangeEnd = addDays(today, 45)
    const occs = computeOccurrences(events, rangeStart, rangeEnd)

    const hidden = ui.hiddenLabels

    const filtered = occs.filter((o) => {
      if (hidden.has(o.event.labelId ?? '')) return false
      if (ui.statusFilter !== 'all' && o.event.status !== ui.statusFilter) return false
      if (!matchesSearch(o.event, labels, ui.search)) return false
      return true
    })

    const g = (name: string, dayOffsetFrom: number, dayOffsetTo: number) => {
      const from = addDays(today, dayOffsetFrom)
      const to = addDays(today, dayOffsetTo + 1)
      // INCLUDE an event whenever ANY part (full or partial) falls inside the
      // group's days — multi-day events appear in every day they touch
      return filtered
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
  }, [events, labels, ui.hiddenLabels, ui.statusFilter, ui.search])

  return (
    <div className="agenda-view">
      {groups.map((grp) => (
        <div key={grp.name} className="agenda-group">
          <div className="agenda-title">{grp.name}</div>
          {grp.items.map((o) => {
            const color = resolveEventColor(o.event, labels)
            const durDays = (o.end.getTime() - o.start.getTime()) / 86400000
            // multi-day = spans more than one CALENDAR day (e.g. 22:00→00:30)
            const multiday = daysBetween(o.start, o.end) >= 1
            const dateStr = o.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            return (
              <button key={o.key} className="agenda-row" onClick={() => ui.openEditor(o.eventId, o.originDate)}>
                <span className="agenda-date">{dateStr}</span>
                <span className="agenda-time">
                  {fmtClock(o.start, ui.clock24)}
                  <span className="muted">–{fmtClock(o.end, ui.clock24)}</span>
                </span>
                <span className="agenda-dot" style={{ background: color }} />
                <span className={`agenda-title-text${o.event.status === 'done' ? ' done' : ''}${o.event.status === 'cancelled' ? ' cancelled' : ''}`}>
                  {o.event.title}
                </span>
                {o.event.status === 'doing' && <span className="mini-badge doing">in progress</span>}
                {o.event.status === 'done' && <span className="mini-badge done">✓ done</span>}
                {o.event.status === 'cancelled' && <span className="mini-badge cancelled">✕ cancelled</span>}
                {multiday && <span className="mini-badge multiday">multi-day</span>}
                {multiday && <span className="muted agenda-days">+{durDays.toFixed(2)}d</span>}
              </button>
            )
          })}
        </div>
      ))}
      {groups.length === 0 && <div className="empty-state">Nothing here — try changing the filters above.</div>}
    </div>
  )
}
