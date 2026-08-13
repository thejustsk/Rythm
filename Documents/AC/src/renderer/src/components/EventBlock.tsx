import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Occurrence } from '@/engine/occurrences'
import { useData } from '@/state/store'
import { resolveEventColor, readableText } from '@/lib/colors'
import { fmtHM } from '@/engine/occurrences'
import { PX_PER_MIN } from '@/lib/timegrid'

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
export default function EventBlock({ occ, box, compact, onClick, onDragStart, onResizeStart }: Props) {
  const { labels } = useData()
  const ev = occ.event
  const color = resolveEventColor(ev, labels)
  const text = readableText(color)
  const status = ev.status

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
            done has NO dot — it's already struck through and dimmed. */}
        {status !== 'done' && <span className={`eb-dot ${status}`} />}
        {status === 'cancelled' ? (
          <s className="eb-title">{ev.title}</s>
        ) : (
          <span className="eb-title">{ev.title}</span>
        )}
      </div>
      {!compact && (
        <span className="eb-time">
          {fmtHM(occ.start)}–{fmtHM(occ.end)}
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
