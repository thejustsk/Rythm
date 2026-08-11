import { useUi } from '@/state/store'

const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'insights', label: 'Insights' }
] as const

export default function Toolbar({ minimal = false }: { minimal?: boolean }) {
  const ui = useUi()

  if (minimal) {
    // Insights view: premium heading (shining blue) + only the view switcher
    return (
      <div className="toolbar minimal">
        <div className="tb-left">
          <span className="premium-heading" title="Premium feature">
            <span className="ph-icon">✦</span> Insights
          </span>
        </div>
        <div className="tb-right">
          <div className="segmented">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`seg-btn${ui.view === v.id ? ' active' : ''}`}
                onClick={() => ui.setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="toolbar">
      <div className="tb-left">
        <button className="icon-btn" title="Previous" onClick={() => ui.navigate(ui.view === 'month' ? -30 : ui.view === 'week' ? -7 : -1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="icon-btn" title="Next" onClick={() => ui.navigate(ui.view === 'month' ? 30 : ui.view === 'week' ? 7 : 1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="btn today-btn" onClick={ui.goToday}>Today</button>
        <div className="tb-title">{titleFor(ui.view, ui.cursor)}</div>
      </div>

      <div className="tb-right">
        <div className="segmented">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`seg-btn${ui.view === v.id ? ' active' : ''}`}
              onClick={() => ui.setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="searchbox">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <input
            placeholder="Search"
            value={ui.search}
            onChange={(e) => ui.setSearch(e.target.value)}
          />
        </div>
        <button className="btn primary new-btn" onClick={() => ui.openQuickAdd()}>
          ＋ New
        </button>
      </div>
    </div>
  )
}

function titleFor(view: string, cursor: Date): string {
  const month = cursor.toLocaleString('en-US', { month: 'long' })
  if (view === 'month') return `${month} ${cursor.getFullYear()}`
  if (view === 'day') return cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  if (view === 'week') {
    const start = new Date(cursor)
    const dow = start.getDay()
    const monday = new Date(start)
    monday.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1))
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `${fmt(monday)} – ${fmt(sunday)}`
  }
  if (view === 'insights') return 'Insights'
  return 'Agenda'
}
