import { useMemo, useRef } from 'react'
import { useData, useUi, iso, visibleLabelIds } from '@/state/store'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import { addDays, startOfDay } from '@/engine/recurrence'
import EventBlock from '@/components/EventBlock'
import { useEdgeNav } from '@/lib/edgeNav'
import { matchesSearch } from '@/lib/search'
import { isoWeekNumber, weekDayNames, weekStartOf, type WeekStart } from '@/lib/dates'

/** Month grid — blocks as colourful chips, "+N more" per day. Week numbers
 *  (ISO 8601) sit in the left gutter (item B.8). */
export default function MonthView() {
  const ui = useUi()
  const { events, labels } = useData()
  const gridRef = useRef<HTMLDivElement>(null)
  const weekStart: WeekStart = ui.weekStart === 'sunday' ? 0 : 1
  const DAYS = weekDayNames(weekStart)

  const { cells, occs } = useMemo(() => {
    const first = new Date(ui.cursor.getFullYear(), ui.cursor.getMonth(), 1)
    const gridStart = weekStartOf(first, weekStart)
    const cells: Date[] = []
    for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i))
    const occs = computeOccurrences(events, gridStart, addDays(gridStart, 42))
    return { cells, occs }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, ui.cursor, weekStart])

  const filtered = useMemo(() => {
    const hidden = ui.hiddenLabels
    const vis = visibleLabelIds(labels, hidden, ui.labelPhases)
    return occs.filter((o) => {
      const lid = o.event.labelId ?? ''
      if (lid && !vis.has(lid)) return false
      if (!lid && hidden.size > 0) return false
      if (ui.statusFilter !== 'all' && o.event.status !== ui.statusFilter) return false
      if (!matchesSearch(o.event, labels, ui.search)) return false
      return true
    })
  }, [occs, ui.hiddenLabels, ui.statusFilter, ui.search, labels])

  const today = startOfDay(new Date())
  const MAX_CHIPS = 3

  // Apple-style: a strong wheel gesture flips the month (the grid itself
  // never scrolls).
  useEdgeNav(gridRef, {
    mode: 'fixed',
    onPrev: () => ui.navigate(-30),
    onNext: () => ui.navigate(30),
    blocked: () =>
      !!useUi.getState().editorKey ||
      !!useUi.getState().quickAdd ||
      useUi.getState().settingsOpen ||
      !!document.querySelector('.score-prompt')
  })

  // week numbers per row (row r starts at cells[r*7])
  const weekNums = useMemo(() => {
    const out: number[] = []
    for (let r = 0; r < 6; r++) out.push(isoWeekNumber(cells[r * 7]))
    return out
  }, [cells])

  return (
    <div className="month-view">
      <div className="month-head">
        <div className="month-gutter-head" />
        {DAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="month-body" ref={gridRef}>
        <div className="month-gutter">
          {weekNums.map((w, r) => (
            <div key={r} className="month-wknum" title={`ISO week ${w}`}>
              {w}
            </div>
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
                  {rest > 0 && (
                    <button className="more-btn" onClick={() => ui.setCursor(day)}>
                      +{rest} more
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
