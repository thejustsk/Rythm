import { useEffect } from 'react'
import { useCoins } from '@/state/coins'
import { useMilestones } from '@/state/milestones'
import { fmtCoins } from '@/lib/gamification'
import MilestonesPanel from '@/components/MilestonesPanel'

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Coins screen: balance, today's earnings, 7-day chart, per-label, ledger. */
export default function CoinsView() {
  const coins = useCoins()
  const loadMs = useMilestones((s) => s.load)

  useEffect(() => {
    void coins.refreshStats()
    void coins.refresh()
    void loadMs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stats = coins.stats
  const maxDay = Math.max(1, ...(stats?.series.map((d) => Math.abs(d.amount)) ?? [0]))
  const days = stats?.series.length ?? 7
  const CHART_W = days * 36 + 8 // dynamic so bars stretch with the box width

  return (
    <div className="coins-view">
      <div className="coins-head">
        <div className="coins-balance">
          <span className="coins-balance-icon">🪙</span>
          <div>
            <div className="coins-balance-value">{fmtCoins(coins.balance)}</div>
            <div className="coins-balance-label">Total Rhythm Coins</div>
          </div>
        </div>
        <div className="coins-today">
          <div className="coins-today-value">{fmtCoins(stats?.today ?? 0)}</div>
          <div className="coins-balance-label">Earned today</div>
        </div>
      </div>

      <div className="coins-grid">
        <div className="ins-panel">
          <div className="ins-panel-title">Last 7 days</div>
          <svg className="chart-svg chart-stretch" viewBox={`0 0 ${CHART_W} 130`} width="100%" height="150">
            {stats?.series.map((d, i) => {
              const hh = (Math.abs(d.amount) / maxDay) * 96
              const hot = d.date === (stats?.series[stats.series.length - 1]?.date ?? '')
              return (
                <g key={d.date}>
                  <rect
                    x={i * 36 + 8}
                    y={104 - hh}
                    width={20}
                    height={hh}
                    rx={3}
                    fill={d.amount >= 0 ? (hot ? 'var(--amber)' : 'var(--green)') : 'var(--red)'}
                    opacity={hot ? 1 : 0.75}
                  >
                    <title>{d.date}: {fmtCoins(d.amount)}</title>
                  </rect>
                  <text x={i * 36 + 18} y={118} fontSize={8.5} textAnchor="middle" fill="var(--text-3)">
                    {DAY_LABEL[new Date(d.date + 'T00:00:00').getDay()]}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>

        <div className="ins-panel">
          <div className="ins-panel-title">Earned by label</div>
          {!stats || stats.perLabel.length === 0 ? (
            <div className="ins-empty">No coins earned yet — complete an activity!</div>
          ) : (
            stats.perLabel.map((l) => (
              <div key={l.labelId ?? 'none'} className="ins-progress">
                <span className="ins-progress-name">{l.labelName}</span>
                <div className="ins-progress-track">
                  <div
                    className="ins-progress-done"
                    style={{ width: `${(l.amount / Math.max(1, stats.perLabel[0].amount)) * 100}%`, background: 'var(--amber)' }}
                  />
                </div>
                <span className="ins-progress-val">{fmtCoins(l.amount)} 🪙</span>
              </div>
            ))
          )}
        </div>

        <MilestonesPanel />

        <div className="ins-panel wide">
          <div className="ins-panel-title">Ledger</div>
          {coins.txs.length === 0 ? (
            <div className="ins-empty">No transactions yet</div>
          ) : (
            <div className="ledger">
              {coins.txs.slice(0, 25).map((t) => (
                <div key={t.id} className={`ledger-row ${t.type}`}>
                  <span className="ledger-date">{t.ts.slice(0, 10)}</span>
                  <span className="ledger-reason">{t.reason}</span>
                  <span className="ledger-amount">
                    {t.type === 'spend' || t.type === 'refund' ? '−' : '+'}
                    {fmtCoins(t.amount)} 🪙
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
