import { useEffect, useState } from 'react'
import { useTrash } from '@/state/trash'
import { useData } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { fmtClock } from '@/lib/clock'
import { useUi } from '@/state/store'

/**
 * Trash (v1.11.14) — deleted events kept as fixed-height cards, coloured by
 * their label, connected chronologically by a vertical thread. Each card has
 * Restore (as series or single occurrence) and permanent Delete.
 */
export default function TrashView() {
  const trash = useTrash()
  const toasts = useToasts.getState()
  const ui = useUi()
  const { labels } = useData()
  const [q, setQ] = useState('')

  // v1.11.15: search within deleted items (title/description)
  const items = q.trim()
    ? trash.items.filter((i) => (i.master.title + ' ' + (i.master.description ?? '')).toLowerCase().includes(q.trim().toLowerCase()))
    : trash.items

  useEffect(() => {
    void trash.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const colorOf = (labelId: string | null): string => {
    if (!labelId) return 'var(--text-3)'
    const l = labels.find((x) => x.id === labelId)
    if (!l) return 'var(--text-3)'
    if (l.color) return l.color
    const p = labels.find((x) => x.id === l.parentId)
    return p?.color ?? 'var(--text-3)'
  }

  const restore = async (id: string, title: string, mode: 'series' | 'single', payload: { master: any; children: any[] }) => {
    const ok = await trash.restore(id, mode)
    if (ok) {
      toasts.push({
        message: `Restored "${title}"${mode === 'series' ? ' (series)' : ''}`,
        kind: 'info',
        duration: 5000,
        actionLabel: 'Undo',
        onAction: async () => {
          await window.api.events.remove(payload.master.id)
          for (const c of payload.children) await window.api.events.remove(c.id)
          await window.api.trash.add(id, payload)
          await trash.load()
          void useData.getState().load()
          toasts.push({ message: `"${title}" moved back to trash`, kind: 'info', duration: 3000 })
        }
      })
      void useData.getState().load()
    } else {
      toasts.push({ message: 'Restore failed', kind: 'danger', duration: 3500 })
    }
  }

  const purge = async (id: string, title: string, payload: { master: any; children: any[] }) => {
    await trash.purge(id)
    toasts.push({
      message: `"${title}" deleted forever`,
      kind: 'info',
      duration: 5000,
      actionLabel: 'Undo',
      onAction: async () => {
        await window.api.trash.add(id, payload)
        await trash.load()
        toasts.push({ message: `"${title}" back in trash`, kind: 'info', duration: 3000 })
      }
    })
  }

  return (
    <div className="trash-view">
      <div className="trash-head">
        <div className="trash-title">🗑️ Trash — deleted activities</div>
        <div className="searchbox trash-search">
          <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <input placeholder="Search deleted…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {trash.items.length > 0 && (
          <button
            className="btn sm danger"
            onClick={() => {
              const snapshot = trash.items
              void trash.empty()
              toasts.push({
                message: 'Trash emptied',
                kind: 'info',
                duration: 5000,
                actionLabel: 'Undo',
                onAction: async () => {
                  for (const t of snapshot) await window.api.trash.add(t.id, { master: t.master, children: t.children })
                  await trash.load()
                  toasts.push({ message: 'Trash restored', kind: 'info', duration: 3000 })
                }
              })
            }}
          >
            Empty trash
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="empty-state">Trash is empty — deleted activities will appear here.</div>
      ) : (
        <div className="trash-timeline">
          {items.map((item, i) => {
            const color = colorOf(item.master.labelId)
            const isSeries = !!item.master.rrule && item.children.length > 0
            const isOverride = !!item.master.parentId
            const when = new Date(item.deletedAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
            return (
              <div key={item.id} className="trash-card" style={{ borderLeftColor: color }}>
                <div className="trash-thread" />
                <div className="trash-card-top">
                  <span className="trash-card-title" style={{ color }}>
                    {item.master.title}
                  </span>
                  <span className="trash-card-meta">
                    {isSeries ? 'series' : isOverride ? 'one occurrence' : 'single'} · deleted {when}
                  </span>
                </div>
                <div className="trash-card-when">
                  {fmtClock(new Date(item.master.startLocal), ui.clock24)} –{' '}
                  {fmtClock(new Date(item.master.endLocal), ui.clock24)}
                  {item.children.length > 0 && <span className="muted"> · {item.children.length} changes</span>}
                </div>
                <div className="trash-card-actions">
                  {isSeries ? (
                    <>
                      <button className="btn sm" onClick={() => void restore(item.id, item.master.title, 'series', { master: item.master, children: item.children })}>
                        Restore series
                      </button>
                      <button className="btn sm" onClick={() => void restore(item.id, item.master.title, 'single', { master: item.master, children: item.children })}>
                        Restore single
                      </button>
                    </>
                  ) : (
                    <button className="btn sm" onClick={() => void restore(item.id, item.master.title, 'single', { master: item.master, children: item.children })}>
                      Restore
                    </button>
                  )}
                  <button className="btn sm danger" onClick={() => void purge(item.id, item.master.title, { master: item.master, children: item.children })}>
                    Delete forever
                  </button>
                </div>
                {i < items.length - 1 && <div className="trash-link" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
