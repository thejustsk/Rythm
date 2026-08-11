import { useMemo, useState } from 'react'
import { useData, useUi, hiddenLabelIds } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { computeOccurrences, occurrencesForDay } from '@/engine/occurrences'
import { startOfDay, addDays } from '@/engine/recurrence'
import { LABEL_PALETTE, labelColor } from '@/lib/colors'
import type { Label } from '@shared/types'
import MiniMonth from './MiniMonth'

type Glyph = 'none' | 'tick' | 'cross' | 'minus'

export default function Sidebar() {
  const { labels, events } = useData()
  const ui = useUi()
  const toasts = useToasts.getState()

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [addingSub, setAddingSub] = useState<string | null>(null)
  const [subName, setSubName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [paletteFor, setPaletteFor] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const hidden = ui.hiddenLabels

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

  /** Selection glyph for a row: tick (selected), minus (partial parent), none (unselected, dimmed). */
  const glyphFor = (l: Label): 'tick' | 'plus' | null => {
    // default: everything selected → empty circles, no glyphs anywhere
    if (ui.hiddenLabels.size === 0) return null
    if (l.parentId) {
      // child: selected → green tick, else nothing
      return hidden.has(l.id) ? null : 'tick'
    }
    // parent
    const kids = labels.filter((c) => c.parentId === l.id)
    const selfSel = !hidden.has(l.id)
    if (kids.length === 0) return selfSel ? 'tick' : null
    const anyKidSel = kids.some((k) => !hidden.has(k.id))
    const allKidsSel = kids.every((k) => !hidden.has(k.id))
    if (selfSel && allKidsSel) return 'tick'
    if (anyKidSel) return 'plus'
    return null
  }

  const clickRow = (l: Label) => {
    if (paletteFor) setPaletteFor(null)
    const next = new Set(ui.hiddenLabels)
    const pristine = next.size === 0 // all selected
    const allIds = labels.map((x) => x.id)
    if (l.parentId) {
      if (pristine) {
        // FIRST click = solo-select this child (others dimmed)
        allIds.forEach((id) => next.add(id))
        next.delete(l.id)
      } else if (next.has(l.id)) {
        next.delete(l.id) // show
      } else {
        next.add(l.id) // hide
      }
    } else {
      const kids = labels.filter((c) => c.parentId === l.id)
      const group = [l.id, ...kids.map((k) => k.id)]
      if (pristine) {
        // FIRST click = solo-select the whole group (parent + all children)
        allIds.forEach((id) => next.add(id))
        group.forEach((id) => next.delete(id))
      } else {
        const allSel = group.every((id) => !next.has(id))
        if (allSel) {
          // fully selected → deselect the whole group
          group.forEach((id) => next.add(id))
        } else {
          // partial (blue plus) or none → select the whole group
          group.forEach((id) => next.delete(id))
        }
      }
    }
    // safety: never leave everything hidden — snap back to all-selected
    if (next.size >= labels.length) next.clear()
    ui.setHiddenLabels([...next])
  }

  const submitLabel = async () => {
    const n = name.trim()
    if (n) {
      try {
        const color = LABEL_PALETTE[labels.length % LABEL_PALETTE.length]
        await useData.getState().createLabel(n, color, null)
        toasts.push({ message: `Label "${n}" created`, kind: 'info', duration: 2000 })
      } catch (e) {
        toasts.push({ message: String((e as Error).message ?? e), kind: 'danger', duration: 3000 })
      }
    }
    setName('')
    setAdding(false)
  }

  const submitSub = async (parentId: string) => {
    const n = subName.trim()
    if (n) {
      try {
        await useData.getState().createLabel(n, null, parentId)
        toasts.push({ message: `Sub-label "${n}" created`, kind: 'info', duration: 2000 })
      } catch (e) {
        toasts.push({ message: String((e as Error).message ?? e), kind: 'danger', duration: 3000 })
      }
    }
    setSubName('')
    setAddingSub(null)
  }

  const startRename = (l: Label) => {
    setRenamingId(l.id)
    setRenameValue(l.name)
  }

  const commitRename = async (l: Label) => {
    const n = renameValue.trim()
    if (n && n !== l.name) {
      try {
        await useData.getState().updateLabel(l.id, { name: n })
        toasts.push({ message: `Renamed to "${n}"`, kind: 'info', duration: 2000 })
      } catch (e) {
        toasts.push({ message: String((e as Error).message ?? e), kind: 'danger', duration: 3000 })
      }
    }
    setRenamingId(null)
  }

  const armDelete = (id: string) => {
    setConfirmDelete(id)
    window.setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 3500)
  }

  /** Delete with full undo: restores the label, its sub-labels, and re-attaches events. */
  const doDelete = async (l: Label) => {
    const children = labels.filter((c) => c.parentId === l.id)
    await useData.getState().removeLabel(l.id)
    // drop any hidden state for the deleted label and its children
    const removedIds = new Set([l.id, ...children.map((c) => c.id)])
    ui.setHiddenLabels([...ui.hiddenLabels].filter((id) => !removedIds.has(id)))
    setConfirmDelete(null)
    toasts.push({
      message: `Label "${l.name}" deleted (events kept, unlabelled)`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: async () => {
        if (l.parentId) {
          // a sub-label: the parent still exists — only recreate this label
          const nc = await useData.getState().createLabel(l.name, l.color, l.parentId)
          for (const e of events) {
            if (e.labelId === l.id) await useData.getState().updateEvent(e.id, { labelId: nc.id })
          }
        } else {
          // a top-level label: recreate it + its children, then re-attach events
          const created = await useData.getState().createLabel(l.name, l.color, null)
          const idMap = new Map<string, string>([[l.id, created.id]])
          for (const c of children) {
            const nc = await useData.getState().createLabel(c.name, c.color, created.id)
            idMap.set(c.id, nc.id)
          }
          for (const e of events) {
            if (e.labelId && idMap.has(e.labelId)) {
              await useData.getState().updateEvent(e.id, { labelId: idMap.get(e.labelId)! })
            }
          }
        }
        toasts.push({ message: `Label "${l.name}" restored`, kind: 'info', duration: 2000 })
      }
    })
  }

  const setColor = async (l: Label, color: string | null) => {
    await useData.getState().updateLabel(l.id, { color })
    setPaletteFor(null)
  }

  const rowFor = (l: Label, sub = false) => {
    const glyph = glyphFor(l)
    return (
      <div
        key={l.id}
        className={`label-row${sub ? ' sub' : ''}${hidden.has(l.id) ? ' hidden' : ''}`}
        onClick={() => clickRow(l)}
      >
        <span className={`lb-check${glyph ? ' ' + glyph : ''}`}>
          {glyph === 'tick' && (
            <svg viewBox="0 0 12 12">
              <path d="M2.5 6.5 5 9 9.5 3.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {glyph === 'plus' && (
            <svg viewBox="0 0 12 12">
              <path d="M3 6h6M6 3v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span
          className="label-dot"
          style={{ background: labelColor(l, labels) }}
          title={l.color ? 'Change colour' : 'Change colour (inherits parent)'}
          onClick={(e) => {
            e.stopPropagation()
            setPaletteFor(paletteFor === l.id ? null : l.id)
          }}
        />
        {renamingId === l.id ? (
          <input
            autoFocus
            className="rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(l)
              if (e.key === 'Escape') setRenamingId(null)
            }}
            onBlur={() => void commitRename(l)}
          />
        ) : (
          <span className="label-name" title="Double-click to rename" onDoubleClick={() => startRename(l)}>
            {l.name}
          </span>
        )}
        <span className="label-actions">
          <button className="la-btn" title="Rename" onClick={(e) => { e.stopPropagation(); startRename(l) }}>
            ✎
          </button>
          {!sub && (
            <button
              className="la-btn"
              title="Add sub-label"
              onClick={(e) => {
                e.stopPropagation()
                setAddingSub(addingSub === l.id ? null : l.id)
              }}
            >
              ＋
            </button>
          )}
          <button
            className={`la-btn del${confirmDelete === l.id ? ' armed' : ''}`}
            title={confirmDelete === l.id ? 'Click again to delete' : 'Delete label'}
            onClick={(e) => {
              e.stopPropagation()
              if (confirmDelete === l.id) void doDelete(l)
              else armDelete(l.id)
            }}
          >
            {confirmDelete === l.id ? 'Delete?' : '🗑'}
          </button>
        </span>
        {paletteFor === l.id && (
          <div className="palette-popover" onClick={(e) => e.stopPropagation()}>
            {l.parentId && (
              <button
                className="swatch inherit"
                title="Inherit parent colour"
                onClick={() => void setColor(l, null)}
              >
                A
              </button>
            )}
            {LABEL_PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch${l.color === c ? ' sel' : ''}`}
                style={{ background: c }}
                onClick={() => void setColor(l, c)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="side-section">
        <MiniMonth cursor={ui.cursor} onChange={(d) => ui.setCursor(d)} />
      </div>

      <div className="side-section grow">
        <div className="side-title-row">
          <div className="side-title">Labels</div>
          {ui.hiddenLabels.size > 0 && (
            <button className="all-chip" onClick={() => ui.setHiddenLabels([])}>
              All
            </button>
          )}
        </div>
        <div className="label-tree">
          {parents.length === 0 && <div className="side-empty">No labels yet — add your first below.</div>}
          {parents.map((l) => (
            <div key={l.id} className="label-group">
              {rowFor(l)}
              {addingSub === l.id && (
                <div className="add-label-inline sub">
                  <input
                    autoFocus
                    value={subName}
                    placeholder="Sub-label name…"
                    onChange={(e) => setSubName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitSub(l.id)
                      if (e.key === 'Escape') setAddingSub(null)
                    }}
                  />
                  <button onClick={() => void submitSub(l.id)}>Add</button>
                </div>
              )}
              {childrenOf(l.id).map((c) => rowFor(c, true))}
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
                if (e.key === 'Enter') void submitLabel()
                if (e.key === 'Escape') {
                  setName('')
                  setAdding(false)
                }
              }}
            />
            <button onClick={() => void submitLabel()}>Add</button>
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
