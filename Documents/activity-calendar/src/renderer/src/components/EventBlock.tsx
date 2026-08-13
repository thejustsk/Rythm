import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { Occurrence } from '@/engine/occurrences'
import { useData } from '@/state/store'
import { resolveEventColor, readableText } from '@/lib/colors'
import { PX_PER_MIN } from '@/lib/timegrid'
import { cycleOccurrenceStatus, nextStatus } from '@/lib/statusCycle'
import { useUi } from '@/state/store'
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

/** The colourful heart of the app: one activity block. */
function EventBlock({ occ, box, compact, onClick, onDragStart, onResizeStart }: Props) {
  const { labels } = useData()
  const clock24 = useUi((s) => s.clock24)
  const ev = occ.event
  const color = resolveEventColor(ev, labels)
  const text = readableText(color)
  const status = ev.status
  const cancelled = status === 'cancelled'
  const clickable = !cancelled

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
        {/* status colour dots (clickable cycle: todo → in progress → done →
            todo). Cancelled is NOT clickable — change it in the edit popup. */}
        <button
          type="button"
          className={`eb-dot ${status}${clickable ? ' clickable' : ''}`}
          title={
            cancelled
              ? 'Cancelled — change status in the edit dialog'
              : `Status: ${status} — click to mark ${nextStatus(status)}`
          }
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (!clickable) return
            void cycleOccurrenceStatus(occ)
          }}
        />
        {cancelled ? (
          <s className="eb-title">{ev.title}</s>
        ) : (
          <span className="eb-title">{ev.title}</span>
        )}
      </div>
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
