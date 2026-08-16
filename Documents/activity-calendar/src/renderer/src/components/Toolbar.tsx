import { useEffect } from 'react'
import { useUi } from '@/state/store'
import Coin from './Coin'
import { T } from '@/lib/strings'
import { weekStartOf } from '@/lib/dates'

const VIEWS = [
  { id: 'day', label: T.views.day },
  { id: 'week', label: T.views.week },
  { id: 'month', label: T.views.month },
  { id: 'agenda', label: T.views.agenda },
  { id: 'insights', label: T.views.insights },
  { id: 'coins', label: T.coinsName },
  // v1.11.14: trash — dustbin icon only (title carries the meaning)
  { id: 'trash', label: '🗑️' }
] as const

/** Tab icon for a view: coins get the coin (money-flip loop when the Coins tab
 *  is ACTIVE, static otherwise); insights gets the twinkle ✦ (shines when the
 *  Insights tab is ACTIVE, static otherwise). */
function SegIcon({ id, active }: { id: string; active: boolean }) {
  if (id === 'coins') {
    return (
      <span className="seg-coin">
        <Coin size={16} flip={active} /> {T.coinsName}
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

  // v1.11.2: measure the Rhythm Coins pill AND the active tab so the rolling
  // coin travels right THROUGH the right edge completely — distance = from
  // the coin's resting spot to beyond the edge + margin (fully exited). The
  // wheel keyframe computes angle = distance / radius from --roll-px.
  useEffect(() => {
    const measureOne = (pill: HTMLElement) => {
      const pr = pill.getBoundingClientRect()
      const coin = pill.querySelector('.rhythm-coin') as HTMLElement | null
      if (!coin || pr.width === 0) return
      const cr = coin.getBoundingClientRect()
      const dist = pr.right - cr.left + cr.width + 20 // well past the edge
      pill.style.setProperty('--roll-px', String(Math.max(60, Math.round(dist))))
    }
    const measureAll = () => {
      const pill = document.querySelector('.premium-heading.coins') as HTMLElement | null
      if (pill) measureOne(pill)
      const tab = document.querySelector('.seg-btn.active .seg-coin') as HTMLElement | null
      if (tab) measureOne(tab)
    }
    // v1.11.3: measure NOW, then again on the next frames — a layout that
    // isn't ready yet (width 0) would silently keep the fallback distance
    measureAll()
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(measureAll))
    const onResize = () => measureAll()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf1)
      window.removeEventListener('resize', onResize)
    }
  }, [ui.view])

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
                className={`seg-btn${ui.view === v.id ? ' active' : ''}${ui.view === v.id && isTodayPeriod(v.id, ui.cursor) ? ' today' : ''}`}
                title={ui.view === v.id ? 'Click again to go to today' : undefined}
                onClick={() => {
                  if (ui.view === v.id) ui.goToday()
                  else ui.setView(v.id)
                }}
              >
                <SegIcon id={v.id} active={ui.view === v.id} />
              </button>
            ))}
          </div>
          <button className="icon-btn settings-btn" title="Settings" onClick={() => ui.openSettings('general')} aria-label="Settings">
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
        <button className="icon-btn" title="Previous" aria-label="Previous" onClick={() => ui.navigate(ui.view === 'month' ? -30 : ui.view === 'week' ? -7 : -1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="icon-btn" title="Next" aria-label="Next" onClick={() => ui.navigate(ui.view === 'month' ? 30 : ui.view === 'week' ? 7 : 1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="tb-title">{titleFor(ui.view, ui.cursor)}</div>
      </div>

      <div className="tb-right">
        <div className="segmented">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`seg-btn${ui.view === v.id ? ' active' : ''}${ui.view === v.id && isTodayPeriod(v.id, ui.cursor) ? ' today' : ''}`}
              title={ui.view === v.id ? 'Click again to go to today' : undefined}
              onClick={() => {
                if (ui.view === v.id) ui.goToday()
                else ui.setView(v.id)
              }}
            >
              <SegIcon id={v.id} active={ui.view === v.id} />
            </button>
          ))}
        </div>
        <button className="icon-btn settings-btn" title="Settings" onClick={() => ui.openSettings('general')} aria-label="Settings">
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

/** v1.11.15: is the current view's period the one containing today? */
function isTodayPeriod(view: string, cursor: Date): boolean {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()) // date-only
  if (view === 'day') return cursor.toDateString() === today.toDateString()
  if (view === 'week') {
    const ws = useUi.getState().weekStart === 'sunday' ? 0 : 1
    const start = weekStartOf(cursor, ws)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    return today >= start && today <= end // date-only comparisons
  }
  if (view === 'month') return cursor.getFullYear() === today.getFullYear() && cursor.getMonth() === today.getMonth()
  return false
}

function titleFor(view: string, cursor: Date): string {
  const month = cursor.toLocaleString('en-US', { month: 'long' })
  if (view === 'month') return `${month} ${cursor.getFullYear()}`
  if (view === 'day') return cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  if (view === 'week') {
    const start = weekStartOf(cursor, useUi.getState().weekStart === 'sunday' ? 0 : 1)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `${fmt(start)} – ${fmt(end)}`
  }
  if (view === 'insights') return 'Insights'
  if (view === 'coins') return 'Rhythm Coins'
  if (view === 'trash') return 'Trash'
  return 'Agenda'
}
