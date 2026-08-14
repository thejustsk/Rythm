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

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Date + time field honouring the 12/24h setting (v1.11.1 — the create/edit
 *  widgets now follow Settings → General → Clock). Internal value stays
 *  'yyyy-MM-ddTHH:mm'; 12h mode renders hour/minute selects + AM/PM toggle. */
function DTField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const clock24 = useUi((s) => s.clock24)
  const date = value.slice(0, 10) || new Date().toISOString().slice(0, 10)
  const hm = value.length >= 16 ? value.slice(11, 16) : '09:00'
  const h = parseInt(hm.slice(0, 2), 10) || 9
  const m = parseInt(hm.slice(3, 5), 10) || 0
  const set = (d: string, hh: number, mm: number) => onChange(`${d}T${pad2(hh)}:${pad2(mm)}`)
  const hour12 = h % 12 === 0 ? 12 : h % 12
  const ampm = h >= 12 ? 'PM' : 'AM'
  const minutes = useMemo(() => {
    const opts = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
    if (m % 5 !== 0 && !opts.includes(m)) opts.push(m)
    return opts.sort((a, b) => a - b)
  }, [m])

  return (
    <label className="ef-label">
      {label}
      <span className="ef-dt">
        <input
          type="date"
          className="ef-date"
          value={date}
          onChange={(e) => e.target.value && set(e.target.value, h, m)}
        />
        {clock24 ? (
          <input
            type="time"
            className="ef-time"
            value={hm}
            onChange={(e) => {
              const [hh, mm] = e.target.value.split(':').map(Number)
              if (!isNaN(hh) && !isNaN(mm)) set(date, hh, mm)
            }}
          />
        ) : (
          <>
            <select
              className="ef-time-h"
              value={hour12}
              aria-label={`${label} hour`}
              onChange={(e) => {
                const hh = Number(e.target.value)
                set(date, ampm === 'PM' ? (hh === 12 ? 12 : hh + 12) : hh === 12 ? 0 : hh, m)
              }}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((hh) => (
                <option key={hh} value={hh}>
                  {hh}
                </option>
              ))}
            </select>
            <select
              className="ef-time-m"
              value={m}
              aria-label={`${label} minute`}
              onChange={(e) => set(date, h, Number(e.target.value))}
            >
              {minutes.map((mm) => (
                <option key={mm} value={mm}>
                  {pad2(mm)}
                </option>
              ))}
            </select>
            <button type="button" className="ef-ampm" onClick={() => set(date, h >= 12 ? h - 12 : h + 12, m)}>
              {ampm}
            </button>
          </>
        )}
      </span>
    </label>
  )
}

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
      <div className="ef-times">
        <DTField label="Start" value={start} onChange={(v) => { setStart(v); shiftEnd(v) }} />
        <DTField label="End" value={end} onChange={setEnd} />
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
