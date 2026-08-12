import { useMilestones } from '@/state/milestones'
import { useCoins } from '@/state/coins'
import { fmtCoins } from '@/lib/gamification'

/** Sidebar widget: nearest milestone with a live progress ring. */
export default function MilestoneWidget() {
  const m = useMilestones((s) => s.next())
  const balance = useCoins((s) => s.balance)
  if (!m) return null

  const pct = Math.min(100, Math.round((balance / m.cost) * 100))
  const R = 20
  const C = 2 * Math.PI * R
  const done = pct >= 100

  return (
    <div className={`mile-widget${done ? ' ready' : ''}`} title={`${m.name} — ${fmtCoins(balance)} / ${fmtCoins(m.cost)} 🪙`}>
      <svg className="mile-ring" viewBox="0 0 48 48" width="44" height="44">
        <circle cx="24" cy="24" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="5" />
        <circle
          cx="24"
          cy="24"
          r={R}
          fill="none"
          stroke={done ? 'var(--amber)' : 'var(--accent)'}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * C} ${C}`}
          transform="rotate(-90 24 24)"
        />
        <text x="24" y="28" textAnchor="middle" fontSize="11" fontWeight="700" fill={done ? 'var(--amber)' : 'var(--text)'}>
          {m.icon}
        </text>
      </svg>
      <div className="mile-info">
        <div className="mile-name">{m.name}</div>
        <div className="mile-progress">
          {fmtCoins(balance)} / {fmtCoins(m.cost)} 🪙 · {pct}%
        </div>
        {done && <div className="mile-cta">Claim in Coins 🎉</div>}
      </div>
    </div>
  )
}
