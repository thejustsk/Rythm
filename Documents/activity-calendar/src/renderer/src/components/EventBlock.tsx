import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { Occurrence } from '@/engine/occurrences'
import { useData, useUi } from '@/state/store'
import { resolveEventColor, readableText } from '@/lib/colors'
import { PX_PER_MIN } from '@/lib/timegrid'
import { cycleOccurrenceStatus, nextStatus } from '@/lib/statusCycle'
import { fmtClock } from '@/lib/clock'

interface Props {
  occ: Occurrence
  /** pixel box (week/day views) */
  box?: CSSProperties
  /** compact chip (month view) */
  compact?: boolean
  onClick?: () => void
  onDragStart?: (e: ReactPointerEvent) => void
  onResizeStart?: (e: ReactPointerEvent) => void
}

/** The colourful heart of the app: one activity block. The status SWITCH in
 *  the top-right corner (day/week views) cycles todo → in progress → done →
 *  todo for THIS occurrence only. */
function EventBlock({ occ, box, compact, onClick, onDragStart, onResizeStart }: Props) {
  const { labels } = useData()
  const clock24 = useUi((s) => s.clock24)
  const ev = occ.event
  const color = resolveEventColor(ev, labels)
  const text = readableText(color)
  const status = ev.status
  const cancelled = status === 'cancelled'

  const cls = ['eb']
  if (status === 'done') cls.push('done')
  if (status === 'cancelled') cls.push('cancelled')
  if (compact) cls.push('compact')
  // very short blocks: always show the title, drop the time line
  const blockPx = ((occ.end.getTime() - occ.start.getTime()) / 60000) * PX_PER_MIN
  if (!compact && blockPx > 0 && blockPx < 32) cls.push('tiny')

  const style: CSSProperties = { ...box }
  style.background = color
  style.color = text

  return (
    <div
      className={cls.join(' ')}
      style={style}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      onPointerDown={onDragStart}
      title={`${ev.title} · ${status}`}
    >
      <div className="eb-title-row">
        {/* status colour dots: todo=grey, doing=blue, cancelled=red.
            done has NO dot — it's struck through and dimmed. (v1.11.1: the
            dots are passive again; use the corner switch to change status.) */}
        {status !== 'done' && (
          <span
            className={`eb-dot ${status}`}
            title={`Status: ${status} — change it with the switch (top-right)`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {cancelled ? (
          <s className="eb-title">{ev.title}</s>
        ) : (
          <span className="eb-title">{ev.title}</span>
        )}
      </div>
      {/* v1.11.1: status switch (day/week only) — top-right corner of the
          block; cycles todo → doing → done → todo, THIS occurrence only.
          Cancelled blocks have no switch (edit dialog only). */}
      {!compact && !cancelled && (
        <button
          type="button"
          className={`eb-switch ${status}`}
          title={`Status: ${status} — click to mark ${nextStatus(status)}`}
          aria-label={`Change status (currently ${status})`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void cycleOccurrenceStatus(occ)
          }}
        >
          <span className={`eb-switch-dot ${status}`} />
        </button>
      )}
      {!compact && (
        <span className="eb-time">
          {fmtClock(occ.start, clock24)}–{fmtClock(occ.end, clock24)}
        </span>
      )}
      {!compact && onResizeStart && (
        <div
          className="eb-resize"
          onPointerDown={(e) => {
            e.stopPropagation()
            onResizeStart(e)
          }}
        />
      )}
    </div>
  )
}

export default memo(EventBlock)
