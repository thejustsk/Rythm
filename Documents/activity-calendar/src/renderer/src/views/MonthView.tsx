import { useMemo } from 'react'
import { useData, useUi, iso } from '@/state/store'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import { addDays, startOfDay } from '@/engine/recurrence'
import EventBlock from '@/components/EventBlock'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Month grid — blocks as colourful chips, "+N more" per day. */
export default function MonthView() {
  const ui = useUi()
  const { events, labels } = useData()

  const { cells, occs } = useMemo(() => {
    const first = new Date(ui.cursor.getFullYear(), ui.cursor.getMonth(), 1)
    const gridStart = addDays(first, 1 - (first.getDay() === 0 ? 7 : first.getDay()))
    const cells: Date[] = []
    for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i))
    const occs = computeOccurrences(events, gridStart, addDays(gridStart, 42))
    return { cells, occs }
  }, [events, ui.cursor])

  const filtered = useMemo(() => {
    const hidden = new Set<string>()
    for (const l of labels) {
      if (ui.hiddenLabels.has(l.id) || (l.parentId && ui.hiddenLabels.has(l.parentId))) hidden.add(l.id)
    }
    return occs.filter((o) => {
      if (hidden.has(o.event.labelId ?? '')) return false
      if (ui.statusFilter !== 'all' && o.event.status !== ui.statusFilter) return false
      if (ui.search && !(o.event.title + ' ' + o.event.description).toLowerCase().includes(ui.search.toLowerCase())) return false
      return true
    })
  }, [occs, ui.hiddenLabels, ui.statusFilter, ui.search, labels])

  const today = startOfDay(new Date())
  const MAX_CHIPS = 3

  return (
    <div className="month-view">
      <div className="month-head">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="month-grid">
        {cells.map((day, i) => {
          const dayOccs = occurrencesForDay(filtered, day)
          const isToday = iso(day) === iso(today)
          const isCursor = iso(day) === iso(ui.cursor)
          const other = day.getMonth() !== ui.cursor.getMonth()
          const shown = dayOccs.slice(0, MAX_CHIPS)
          const rest = dayOccs.length - shown.length
          return (
            <div
              key={i}
              className={`day-cell${isToday ? ' today' : ''}${isCursor ? ' cursor' : ''}${other ? ' dim' : ''}`}
              onClick={() => ui.openQuickAdd(iso(day), '09:00')}
            >
              <div className="day-num">{day.getDate()}</div>
              <div className="day-chips" onClick={(e) => e.stopPropagation()}>
                {shown.map((o) => (
                  <EventBlock key={o.key} occ={o} compact onClick={() => ui.openEditor(o.eventId, o.originDate)} />
                ))}
                {rest > 0 && <button className="more-btn" onClick={() => ui.setCursor(day)}>+{rest} more</button>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
