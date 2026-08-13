import { useUi } from '@/state/store'
import Coin from './Coin'

const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'insights', label: 'Insights' },
  { id: 'coins', label: 'Rhythm Coins' }
] as const

/** Tab icon for a view: coins get the coin (money-flip loop when the Coins tab
 *  is ACTIVE, static otherwise); insights gets the twinkle ✦ (shines when the
 *  Insights tab is ACTIVE, static otherwise). */
function SegIcon({ id, active }: { id: string; active: boolean }) {
  if (id === 'coins') {
    return (
      <span className="seg-coin">
        <Coin size={16} flip={active} /> Rhythm Coins
      </span>
    )
  }
  if (id === 'insights') {
    return (
      <span className="seg-ico">
        <span className={`twinkle${active ? ' shining' : ''}`}>✦</span> Insights
      </span>
    )
  }
  return <>{VIEWS.find((v) => v.id === id)?.label}</>
}

export default function Toolbar({ minimal = false }: { minimal?: boolean }) {
  const ui = useUi()

  if (minimal) {
    // Fullscreen views (Insights/Coins): premium heading + only the view switcher
    const isCoins = ui.view === 'coins'
    return (
      <div className="toolbar minimal">
        <div className="tb-left">
          {isCoins ? (
            <button
              className="premium-heading coins clickable"
              title="Click to turn Rhythm Coins off/on"
              onClick={ui.openCoinSystemConfirm}
            >
              <span className="ph-icon">
                <Coin size={20} roll />
              </span>
              Rhythm Coins
            </button>
          ) : (
            <span className="premium-heading" title="Premium feature">
              <span className="ph-icon">
                <span className="twinkle shining">✦</span>
              </span>
              Insights
            </span>
          )}
        </div>
        <div className="tb-right">
          <div className="segmented">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`seg-btn${ui.view === v.id ? ' active' : ''}`}
                onClick={() => ui.setView(v.id)}
              >
                <SegIcon id={v.id} active={ui.view === v.id} />
              </button>
            ))}
          </div>
          <button className="icon-btn settings-btn" title="Settings" onClick={ui.openSettings}>
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="2.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <g stroke="currentColor" strokeWidth="1.15" strokeLinecap="round">
                <path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.35 1.35M11.15 11.15l1.35 1.35M12.5 3.5l-1.35 1.35M4.85 11.15l-1.35 1.35" />
              </g>
            </svg>
          </button>
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
              <SegIcon id={v.id} active={ui.view === v.id} />
            </button>
          ))}
        </div>
        <button className="icon-btn settings-btn" title="Settings" onClick={ui.openSettings}>
          <svg viewBox="0 0 16 16" width="15" height="15">
            <circle cx="8" cy="8" r="2.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
            <g stroke="currentColor" strokeWidth="1.15" strokeLinecap="round">
              <path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.35 1.35M11.15 11.15l1.35 1.35M12.5 3.5l-1.35 1.35M4.85 11.15l-1.35 1.35" />
            </g>
          </svg>
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
  if (view === 'coins') return 'Rhythm Coins'
  return 'Agenda'
}
