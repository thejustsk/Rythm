import { useData, useUi } from '@/state/store'
import type { EventStatus } from '@shared/types'

const PILLS: Array<{ id: EventStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'todo', label: 'To Do' },
  { id: 'doing', label: 'In Progress' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' }
]

export default function StatusFilter() {
  const ui = useUi()
  const { events } = useData()
  const countOf = (s: EventStatus) => events.filter((e) => e.status === s).length

  return (
    <div className="status-pills">
      {PILLS.map((p) => (
        <button
          key={p.id}
          className={`pill${ui.statusFilter === p.id ? ' active' : ''}`}
          onClick={() => ui.setStatusFilter(p.id)}
        >
          {p.label}
          {p.id !== 'all' && <span className="pill-count">{countOf(p.id)}</span>}
        </button>
      ))}
    </div>
  )
}
