import { useMemo } from 'react'
import { useData, useUi, visibleLabelIds } from '@/state/store'
import { computeOccurrences } from '@/engine/occurrences'
import { addDays, startOfDay } from '@/engine/recurrence'
import { resolveEventColor } from '@/lib/colors'
import { daysBetween } from '@/lib/timegrid'
import { matchesSearch } from '@/lib/search'
import { fmtClock } from '@/lib/clock'
import { buildAgendaGroups } from '@/lib/agenda'

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
    const vis = visibleLabelIds(labels, hidden, ui.labelPhases)

    const filtered = occs.filter((o) => {
      const lid = o.event.labelId ?? ''
      if (lid && !vis.has(lid)) return false
      if (!lid && hidden.size > 0) return false
      if (ui.statusSel.size > 0 && !ui.statusSel.has(o.event.status)) return false
      if (!matchesSearch(o.event, labels, ui.search)) return false
      return true
    })

    // v1.11.17: the SHARED grouping — identical to the one the status-pill
    // counters use, so the numbers always match the rendered rows
    return buildAgendaGroups(filtered, today)
  }, [events, labels, ui.hiddenLabels, ui.statusSel, ui.search])

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
