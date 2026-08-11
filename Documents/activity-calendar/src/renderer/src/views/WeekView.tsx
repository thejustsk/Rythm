import { useMemo, useRef, useState } from 'react'
import { useData, useUi, iso } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import type { Occurrence } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import { blockBox, layoutClusters, snap15, toMinutes, minutesToHM, DAY_MINUTES, PX_PER_MIN } from '@/lib/timegrid'
import EventBlock from '@/components/EventBlock'

interface DragState {
  occ: Occurrence
  mode: 'move' | 'resize'
  startX: number
  startY: number
  origStartMin: number
  origEndMin: number
  origDayIdx: number
  curDayIdx: number
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

  const rangeStart = startOfDay(days[0])
  const rangeEnd = addDays(rangeStart, days.length)

  const occs = useMemo(
    () => computeOccurrences(events, rangeStart, rangeEnd),
    [events, rangeStart.getTime(), rangeEnd.getTime()]
  )

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
    ui.openQuickAdd(iso(day), `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`)
  }

  /** Persist a drag result. One-time → update in place. Recurring → one-off override. */
  const commitDrag = async (d: DragState) => {
    const ev = d.occ.event
    const day = days[d.curDayIdx]
    const startLocal = `${iso(day)}T${minutesToHM(d.curStartMin)}`
    const endLocal = `${iso(day)}T${minutesToHM(d.curEndMin)}`
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
      const cols = Array.from(gridRef.current!.querySelectorAll('.day-col')).map((c) => c.getBoundingClientRect())
      const dayIdx = Math.max(0, cols.findIndex((r) => ev.clientX >= r.left && ev.clientX < r.right))
      const st: DragState = {
        occ,
        mode,
        startX,
        startY,
        origStartMin: toMinutes(occ.start),
        origEndMin: toMinutes(occ.end),
        origDayIdx: dayIdx,
        curDayIdx: dayIdx,
        curStartMin: toMinutes(occ.start),
        curEndMin: toMinutes(occ.end)
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
      let next: DragState
      if (cur.mode === 'move') {
        const dur = cur.origEndMin - cur.origStartMin
        const newStart = Math.min(snap15(cur.origStartMin + dy / PX_PER_MIN), DAY_MINUTES - 15)
        let dayIdx = cur.origDayIdx
        if (gridRef.current) {
          const rects = Array.from(gridRef.current.querySelectorAll('.day-col')).map((c) => c.getBoundingClientRect())
          const hit = rects.findIndex((r) => ev.clientX >= r.left && ev.clientX < r.right)
          if (hit >= 0) dayIdx = hit
        }
        next = { ...cur, curStartMin: newStart, curEndMin: newStart + dur, curDayIdx: dayIdx }
      } else {
        const newEnd = Math.min(Math.max(snap15(cur.origEndMin + dy / PX_PER_MIN), cur.origStartMin + 15), DAY_MINUTES)
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
        d.curStartMin !== d.origStartMin || d.curEndMin !== d.origEndMin || d.curDayIdx !== d.origDayIdx
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
                {String(h).padStart(2, '0')}:00
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
                .map((o) => ({ item: o, startMin: toMinutes(o.start), endMin: toMinutes(o.end) }))
            )
            let colOccs = dayOccs.filter(
              (o) => !(drag && o.key === drag.occ.key && drag.curDayIdx !== dayIdx)
            )
            // cross-day drag: render the dragged block in the target column
            if (drag && drag.curDayIdx === dayIdx && drag.origDayIdx !== dayIdx) {
              colOccs = [...colOccs, drag.occ]
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
                    ? blockBox(drag!.curStartMin, drag!.curEndMin, PX_PER_MIN)
                    : blockBox(toMinutes(o.start), toMinutes(o.end), PX_PER_MIN)
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
  const day = days[d.curDayIdx]
  const mk = (mins: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60)
  return { ...o, start: mk(d.curStartMin), end: mk(d.curEndMin) }
}
