import { useEffect, useMemo, useRef, useState } from 'react'
import { useData, useUi, iso } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import type { Occurrence } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import { blockBox, blockBoxForDay, layoutClusters, snap15, snap15Rel, toMinutes, minutesToHM, localFromDayMinutes, relMinFrom, dayRelMins, DAY_MINUTES, PX_PER_MIN } from '@/lib/timegrid'
import EventBlock from '@/components/EventBlock'
import { useEdgeNav } from '@/lib/edgeNav'
import { matchesSearch } from '@/lib/search'
import { fmtHourLabel } from '@/lib/clock'

interface DragState {
  occ: Occurrence
  mode: 'move' | 'resize'
  startX: number
  startY: number
  origStartMin: number
  origEndMin: number
  /** the calendar day (Date at 00:00) the dragged span sits on — absolute,
   *  so dragging across week boundaries keeps working after a week shift */
  curDay: Date
  curStartMin: number
  curEndMin: number
}

interface Props {
  days: Date[]
}

/** Shared hour-grid: one column per day (WeekView) or a single column (DayView). */
export default function WeekView({ days }: Props) {
  const ui = useUi()
  const { events, labels } = useData()
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const lastDropRef = useRef(0)
  const lastEdgeNav = useRef(0)

  const rangeStart = startOfDay(days[0])
  const rangeEnd = addDays(rangeStart, days.length)

  const occs = useMemo(
    () => computeOccurrences(events, rangeStart, rangeEnd),
    [events, rangeStart.getTime(), rangeEnd.getTime()]
  )

  const filtered = useMemo(() => {
    const hidden = ui.hiddenLabels
    return occs.filter((o) => {
      if (hidden.has(o.event.labelId ?? '')) return false
      if (ui.statusFilter !== 'all' && o.event.status !== ui.statusFilter) return false
      if (!matchesSearch(o.event, labels, ui.search)) return false
      return true
    })
  }, [occs, ui.hiddenLabels, ui.statusFilter, ui.search, labels])

  const now = new Date()
  const nowMin = toMinutes(now)
  const todayKey = iso(now)

  const clickAt = (day: Date, e: React.MouseEvent) => {
    const container = gridRef.current!
    const rect = container.getBoundingClientRect()
    const head = container.querySelector('.week-head')
    const headH = head ? head.getBoundingClientRect().height : 0
    const y = e.clientY - rect.top - headH
    const mins = snap15(y / PX_PER_MIN)
    ui.openQuickAdd(
      iso(day),
      `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
      ui.defaultDuration
    )
  }

  /** Persist a drag result. One-time → update in place. Recurring → one-off override. */
  const commitDrag = async (d: DragState) => {
    const ev = d.occ.event
    const day = d.curDay
    // absolute minutes → local strings (handles overnight/multi-day ends)
    const startLocal = localFromDayMinutes(day, d.curStartMin)
    const endLocal = localFromDayMinutes(day, d.curEndMin)
    const data = useData.getState()
    const toasts = useToasts.getState()
    if (ev.rrule && !d.occ.isOverride) {
      await data.applyOverride(
        {
          title: ev.title,
          description: ev.description,
          startLocal,
          endLocal,
          allDay: ev.allDay,
          labelId: ev.labelId,
          colorOverride: ev.colorOverride,
          status: ev.status,
          rrule: null,
          exdates: [],
          parentId: ev.id,
          originDate: d.occ.originDate
        },
        ev.id,
        [...(ev.exdates ?? []), d.occ.originDate]
      )
      toasts.push({ message: `Moved "${ev.title}" (this occurrence)`, kind: 'info', duration: 2500 })
    } else {
      await data.updateEvent(ev.id, { startLocal, endLocal })
      toasts.push({ message: `Moved "${ev.title}" to ${minutesToHM(d.curStartMin)}`, kind: 'info', duration: 2500 })
    }
  }

  const startDrag = (e: React.PointerEvent, occ: Occurrence, mode: 'move' | 'resize') => {
    if (e.button !== 0 || !gridRef.current) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false

    const begin = (ev: PointerEvent) => {
      dragging = true
      const colEls = Array.from(gridRef.current!.querySelectorAll('.day-col'))
      const cols = colEls.map((c) => c.getBoundingClientRect())
      const dayIdx = Math.max(0, cols.findIndex((r) => ev.clientX >= r.left && ev.clientX < r.right))
      // Relative to the GRABBED day's midnight: for a multi-day event grabbed on
      // its 2nd day, the start is negative (the day before) — this keeps the
      // whole span intact when dragging/resizing (bug #3).
      const relStart = relMinFrom(days[dayIdx], occ.start)
      const relEnd = relMinFrom(days[dayIdx], occ.end)
      const dayOfCol = (el: Element) => new Date(el.getAttribute('data-day')! + 'T00:00:00')
      const st: DragState = {
        occ,
        mode,
        startX,
        startY,
        origStartMin: relStart,
        origEndMin: relEnd,
        curDay: dayOfCol(colEls[dayIdx]),
        curStartMin: relStart,
        curEndMin: relEnd
      }
      dragRef.current = st
      setDrag(st)
    }

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        // only start the drag after real movement (keeps click-to-edit working)
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
        begin(ev)
      }
      const cur = dragRef.current
      if (!cur) return
      const dy = ev.clientY - cur.startY
      // vertical auto-scroll while dragging near the top/bottom edges
      const bodyEl = gridRef.current
      if (bodyEl) {
        const br = bodyEl.getBoundingClientRect()
        const margin = 56
        if (ev.clientY < br.top + margin) bodyEl.scrollTop -= 18
        else if (ev.clientY > br.bottom - margin) bodyEl.scrollTop += 18
      }
      // horizontal: drag past the week's edge → shift the week (Apple-like)
      const colsNow = bodyEl ? Array.from(bodyEl.querySelectorAll('.day-col')) : []
      const rectsNow = colsNow.map((c) => c.getBoundingClientRect())
      const lastCol = rectsNow[rectsNow.length - 1]
      const firstCol = rectsNow[0]
      const navWeek = (delta: number) => {
        if (Date.now() - lastEdgeNav.current < 900) return
        lastEdgeNav.current = Date.now()
        ui.navigate(delta * 7)
      }
      if (lastCol && ev.clientX > lastCol.right + 24) navWeek(1)
      else if (firstCol && ev.clientX < firstCol.left - 24) navWeek(-1)
      const dayOfCol = (el: Element) => new Date(el.getAttribute('data-day')! + 'T00:00:00')
      let curDay = cur.curDay
      if (colsNow.length > 0) {
        const hit = rectsNow.findIndex((r) => ev.clientX >= r.left && ev.clientX < r.right)
        if (hit >= 0) curDay = dayOfCol(colsNow[hit])
      }
      let next: DragState
      if (cur.mode === 'move') {
        const dur = cur.origEndMin - cur.origStartMin
        // allow negatives (multi-day start before the grabbed day)
        let newStart = snap15Rel(cur.origStartMin + dy / PX_PER_MIN)
        if (cur.origStartMin >= 0) newStart = Math.min(newStart, DAY_MINUTES - 15)
        next = { ...cur, curStartMin: newStart, curEndMin: newStart + dur, curDay }
      } else {
        // allow resizing past midnight (overnight events): up to ~2 days
        const newEnd = Math.min(Math.max(snap15Rel(cur.origEndMin + dy / PX_PER_MIN), cur.origStartMin + 15), DAY_MINUTES + 1440)
        next = { ...cur, curEndMin: newEnd }
      }
      dragRef.current = next
      setDrag(next)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }

    const onUp = async () => {
      cleanup()
      const d = dragRef.current
      if (!dragging || !d) {
        dragRef.current = null
        setDrag(null)
        return
      }
      const moved =
        d.curStartMin !== d.origStartMin || d.curEndMin !== d.origEndMin || d.curDay.getTime() !== d.occ.start.getTime()
      if (!moved) {
        dragRef.current = null
        setDrag(null)
        return
      }
      lastDropRef.current = Date.now()
      try {
        // persist FIRST while the preview is still at the final position,
        // then release — the render after release already has the new data,
        // so the block never snaps back to the old spot (no blink).
        await commitDrag(d)
      } finally {
        dragRef.current = null
        setDrag(null)
      }
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        cleanup()
        dragging = false
        dragRef.current = null
        setDrag(null)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
  }

  const hourLabels: number[] = []
  for (let h = 0; h <= 24; h += 2) hourLabels.push(h)

  // Settings → General: start the grid scrolled at the configured hour (and
  // re-scroll live when the pref changes while the view is open)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    el.scrollTop = ui.dayStartHour * 60 * PX_PER_MIN
  }, [ui.dayStartHour])

  // Apple-style edge scrolling: at the bottom a hard scroll up pulls the next
  // day/week; at the top a hard scroll down pulls the previous one.
  const navStep = days.length === 1 ? 1 : 7
  useEdgeNav(gridRef, {
    mode: 'scroll',
    onPrev: () => ui.navigate(-navStep),
    onNext: () => ui.navigate(navStep),
    blocked: () =>
      !!useUi.getState().editorKey ||
      !!useUi.getState().quickAdd ||
      useUi.getState().settingsOpen ||
      !!document.querySelector('.score-prompt') ||
      !!dragRef.current
  })

  return (
    <div className="week-view">
      <div
        className="week-body"
        ref={gridRef}
        onClick={(e) => {
          if (Date.now() - lastDropRef.current < 500) return
          const target = e.target as HTMLElement
          const col = target.closest('.day-col')
          if (col) {
            const day = new Date(col.getAttribute('data-day')!)
            clickAt(day, e)
          }
        }}
      >
        {/* Sticky header lives INSIDE the scroll container so the day-name cells
            always line up with the day columns (scrollbar included). */}
        <div className="week-head">
          <div className="week-gutter" />
          {days.map((d) => {
            const key = iso(d)
            const isToday = key === todayKey
            const isCursor = key === iso(ui.cursor)
            return (
              <div key={key} className={`week-day-head${isToday ? ' today' : ''}${isCursor ? ' cursor' : ''}`} onClick={() => ui.setCursor(d)}>
                <span className="wd-name">{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                <span className={`wd-num${isToday ? ' today' : ''}`}>{d.getDate()}</span>
              </div>
            )
          })}
        </div>

        <div className="week-grid" style={{ height: 24 * 60 * PX_PER_MIN }}>
          <div className="week-gutter">
            {hourLabels.map((h) => (
              <div key={h} className="hour-label" style={{ top: h * 60 * PX_PER_MIN }}>
                {fmtHourLabel(h, ui.clock24)}
              </div>
            ))}
          </div>

          {days.map((day, dayIdx) => {
            const key = iso(day)
            const dayOccs = occurrencesForDay(filtered, day)
            // exclude the dragged occurrence from layout so neighbours don't jump;
            // split side-by-side only within overlapping clusters (issue 5)
            const layout = layoutClusters(
              dayOccs
                .filter((o) => !(drag && o.key === drag.occ.key))
                .map((o) => {
                  const rel = dayRelMins(day, o.start, o.end)
                  return { item: o, startMin: rel.startMin, endMin: rel.endMin }
                })
            )
            // during a drag the dragged occurrence is hidden from the normal
            // list and PREVIEW chunks are rendered on every column it spans —
            // so a multi-day event keeps BOTH visible parts while dragging
            // (no vanishing/popping back)
            let colOccs = dayOccs.filter((o) => !(drag && o.key === drag.occ.key))
            if (drag) {
              const mid = new Date(drag.curDay)
              mid.setHours(0, 0, 0, 0)
              const dStart = new Date(mid.getTime() + drag.curStartMin * 60000)
              const dEnd = new Date(mid.getTime() + drag.curEndMin * 60000)
              const thisDayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
              const thisDayEnd = new Date(thisDayStart.getTime() + 86400000)
              if (dStart.getTime() < thisDayEnd.getTime() && dEnd.getTime() > thisDayStart.getTime()) {
                colOccs = [...colOccs, drag.occ]
              }
            }
            return (
              <div key={key} className="day-col" data-day={key}>
                <div className="grid-lines">
                  {hourLabels.map((h) => (
                    <div key={h} className="grid-line" style={{ top: h * 60 * PX_PER_MIN }} />
                  ))}
                </div>
                {key === todayKey && (
                  <div className="now-line" style={{ top: nowMin * PX_PER_MIN }}>
                    <span className="now-dot" />
                  </div>
                )}
                {colOccs.map((o) => {
                  const isDragged = drag && o.key === drag.occ.key
                  const box = isDragged
                    ? (() => {
                        // preview clipped to THIS column (each day shows its own part)
                        const mid = new Date(drag!.curDay)
                        mid.setHours(0, 0, 0, 0)
                        return blockBoxForDay(
                          new Date(mid.getTime() + drag!.curStartMin * 60000),
                          new Date(mid.getTime() + drag!.curEndMin * 60000),
                          day,
                          PX_PER_MIN
                        )
                      })()
                    : blockBoxForDay(o.start, o.end, day, PX_PER_MIN)
                  const displayOcc = isDragged ? occWithDragTime(o, drag!, days) : o
                  return (
                    <div
                      key={o.key}
                      className={`eb-wrap${isDragged ? ' dragging' : ''}`}
                      style={{
                        top: box.top,
                        height: box.height,
                        left: `calc(${((isDragged ? 0 : layout.get(o)?.col ?? 0) / (isDragged ? 1 : layout.get(o)?.cols ?? 1)) * 100}% + 2px)`,
                        width: `calc(${100 / (isDragged ? 1 : layout.get(o)?.cols ?? 1)}% - 4px)`
                      }}
                    >
                      <EventBlock
                        occ={displayOcc}
                        box={{ width: '100%', height: '100%' }}
                        onClick={() => {
                          if (Date.now() - lastDropRef.current < 400) return
                          ui.openEditor(o.eventId, o.originDate)
                        }}
                        onDragStart={(e) => startDrag(e, o, 'move')}
                        onResizeStart={(e) => startDrag(e, o, 'resize')}
                      />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Live time labels while dragging (shows where the block will land). */
function occWithDragTime(o: Occurrence, d: DragState, days: Date[]): Occurrence {
  const day = d.curDay
  const mk = (mins: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60)
  return { ...o, start: mk(d.curStartMin), end: mk(d.curEndMin) }
}
