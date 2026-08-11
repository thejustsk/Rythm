import { useMemo, useState } from 'react'
import { useData, useUi, hiddenLabelIds } from '@/state/store'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import { labelColor } from '@/lib/colors'
import { LABEL_PALETTE } from '@/lib/colors'
import MiniMonth from './MiniMonth'

export default function Sidebar() {
  const { labels, events } = useData()
  const ui = useUi()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const hidden = hiddenLabelIds(labels, ui.hiddenLabels)

  const todayStats = useMemo(() => {
    const day = startOfDay(new Date())
    const occs = computeOccurrences(events, day, addDays(day, 1))
    const forDay = occurrencesForDay(occs, day)
    const hours = forDay.reduce((s, o) => s + (o.end.getTime() - o.start.getTime()) / 3600000, 0)
    const done = forDay.filter((o) => o.event.status === 'done').length
    return { count: forDay.length, hours, done }
  }, [events])

  const parents = labels.filter((l) => !l.parentId)
  const childrenOf = (id: string) => labels.filter((l) => l.parentId === id)

  const submitLabel = () => {
    const n = name.trim()
    if (n) {
      const color = LABEL_PALETTE[labels.length % LABEL_PALETTE.length]
      void useData.getState().createLabel(n, color, null)
    }
    setName('')
    setAdding(false)
  }

  return (
    <aside className="sidebar">
      <div className="side-section">
        <MiniMonth cursor={ui.cursor} onChange={(d) => ui.setCursor(d)} />
      </div>

      <div className="side-section grow">
        <div className="side-title">Labels</div>
        <div className="label-tree">
          {parents.map((l) => (
            <div key={l.id}>
              <label className="label-row">
                <input
                  type="checkbox"
                  checked={!hidden.has(l.id)}
                  onChange={() => ui.toggleLabelHidden(l.id)}
                />
                <span className="label-dot" style={{ background: labelColor(l, labels) }} />
                <span className="label-name">{l.name}</span>
              </label>
              {childrenOf(l.id).map((c) => (
                <label key={c.id} className="label-row sub">
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.id)}
                    onChange={() => ui.toggleLabelHidden(c.id)}
                  />
                  <span className="label-dot" style={{ background: labelColor(c, labels) }} />
                  <span className="label-name">{c.name}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        {adding ? (
          <div className="add-label-inline">
            <input
              autoFocus
              value={name}
              placeholder="Label name…"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitLabel()
                if (e.key === 'Escape') {
                  setName('')
                  setAdding(false)
                }
              }}
            />
            <button onClick={submitLabel}>Add</button>
          </div>
        ) : (
          <button className="add-label-btn" onClick={() => setAdding(true)}>
            ＋ Add label
          </button>
        )}
      </div>

      <div className="side-section today-card">
        <div className="side-title">Today</div>
        <div className="today-stats">
          <span className="today-count">{todayStats.count}</span> blocks
          <span className="dot-sep">·</span>
          <span className="today-hours">{todayStats.hours.toFixed(1)}h</span> planned
          <span className="dot-sep">·</span>
          <span className="today-done">{todayStats.done} done</span>
        </div>
      </div>
    </aside>
  )
}
