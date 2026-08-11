import { useEffect, useMemo, useState } from 'react'
import { useData, useUi, iso } from '@/state/store'
import type { EventStatus, Label } from '@shared/types'
import { parseLocal } from '@/engine/occurrences'

const STATUSES: Array<{ id: EventStatus; label: string }> = [
  { id: 'todo', label: 'To Do' },
  { id: 'doing', label: 'In Progress' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' }
]

export function labelOptions(labels: Label[]): Array<{ id: string | null; name: string; indent: boolean }> {
  const parents = labels.filter((l) => !l.parentId)
  const opts: Array<{ id: string | null; name: string; indent: boolean }> = [{ id: null, name: 'No label', indent: false }]
  for (const p of parents) {
    opts.push({ id: p.id, name: p.name, indent: false })
    for (const c of labels.filter((l) => l.parentId === p.id)) {
      opts.push({ id: c.id, name: `↳ ${c.name}`, indent: true })
    }
  }
  return opts
}

/** Shared form used by QuickAdd and the full editor. */
export function EventFormFields({
  title,
  setTitle,
  start,
  setStart,
  end,
  setEnd,
  labelId,
  setLabelId,
  status,
  setStatus,
  description,
  setDescription
}: {
  title: string
  setTitle: (v: string) => void
  start: string
  setStart: (v: string) => void
  end: string
  setEnd: (v: string) => void
  labelId: string | null
  setLabelId: (v: string | null) => void
  status: EventStatus
  setStatus: (v: EventStatus) => void
  description?: string
  setDescription?: (v: string) => void
}) {
  const { labels } = useData()
  const opts = useMemo(() => labelOptions(labels), [labels])

  const shiftEnd = (v: string) => {
    const d = parseLocal(v)
    const endD = parseLocal(end)
    const dur = endD.getTime() - parseLocal(start).getTime()
    const p = (n: number) => String(n).padStart(2, '0')
    const newEnd = new Date(d.getTime() + (isNaN(dur) || dur <= 0 ? 3600000 : dur))
    setEnd(`${iso(newEnd)}T${p(newEnd.getHours())}:${p(newEnd.getMinutes())}`)
  }

  return (
    <>
      <input
        className="ef-title"
        autoFocus
        placeholder="Activity title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="ef-row">
        <label className="ef-label">
          Start
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              shiftEnd(e.target.value)
            }}
          />
        </label>
        <label className="ef-label">
          End
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <div className="ef-row">
        <label className="ef-label">
          Label
          <select value={labelId ?? ''} onChange={(e) => setLabelId(e.target.value || null)}>
            {opts.map((o) => (
              <option key={o.id ?? 'none'} value={o.id ?? ''}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ef-label">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus)}>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {description !== undefined && (
        <textarea
          className="ef-desc"
          placeholder="Notes…"
          rows={3}
          value={description}
          onChange={(e) => setDescription?.(e.target.value)}
        />
      )}
    </>
  )
}
