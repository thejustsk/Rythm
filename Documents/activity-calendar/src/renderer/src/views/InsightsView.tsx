import { useMemo, useState } from 'react'
import { useData, useUi, hiddenLabelIds } from '@/state/store'
import { computeInsights, fmtH, isoD } from '@/lib/insights'
import { startOfDay, addDays } from '@/engine/recurrence'
import { parseLocal } from '@/engine/occurrences'
import { isoDate } from '@/engine/recurrence'

type Period = 'week' | 'month' | 'year' | 'all'

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' }
]

function rangeFor(period: Period, events: { startLocal: string }[]): { start: Date; end: Date } {
  const today = startOfDay(new Date())
  if (period === 'week') {
    const dow = today.getDay()
    const mon = addDays(today, dow === 0 ? -6 : 1 - dow)
    return { start: mon, end: addDays(mon, 7) }
  }
  if (period === 'month') {
    return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: new Date(today.getFullYear(), today.getMonth() + 1, 1) }
  }
  if (period === 'year') {
    return { start: new Date(today.getFullYear(), 0, 1), end: new Date(today.getFullYear() + 1, 0, 1) }
  }
  let earliest = addDays(today, -365)
  for (const e of events) {
    const t = parseLocal(e.startLocal).getTime()
    if (t < earliest.getTime()) earliest = new Date(t)
  }
  return { start: startOfDay(earliest), end: addDays(today, 1) }
}

export default function InsightsView() {
  const { events, labels } = useData()
  const ui = useUi()
  const [period, setPeriod] = useState<Period>('week')

  const hidden = useMemo(() => hiddenLabelIds(labels, ui.hiddenLabels), [labels, ui.hiddenLabels])

  const ins = useMemo(() => {
    const { start, end } = rangeFor(period, events)
    return computeInsights(events, labels, hidden, start, end)
  }, [events, labels, hidden, period])

  const donut = useMemo(() => {
    const top = ins.perLabel.slice(0, 6)
    const restMin = ins.perLabel.slice(6).reduce((s, p) => s + p.plannedMin, 0)
    if (restMin > 0) top.push({ id: 'rest', name: 'Other', color: '#aeaeb2', plannedMin: restMin, doneMin: 0, count: 0, completion: 0 })
    return top
  }, [ins.perLabel])

  const barBuckets = useMemo(() => {
    // week → daily bars; month → daily; year → monthly; all → weekly buckets
    const p = ins.perDay
    if (period === 'week') return p.map((d) => ({ label: new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }), plannedMin: d.plannedMin, doneMin: d.doneMin }))
    if (period === 'month') return p.map((d) => ({ label: new Date(d.date + 'T00:00:00').getDate().toString(), plannedMin: d.plannedMin, doneMin: d.doneMin }))
    if (period === 'year') {
      const buckets = new Map<string, { plannedMin: number; doneMin: number }>()
      for (const d of p) {
        const k = new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' })
        const b = buckets.get(k) ?? { plannedMin: 0, doneMin: 0 }
        b.plannedMin += d.plannedMin
        b.doneMin += d.doneMin
        buckets.set(k, b)
      }
      return [...buckets.entries()].map(([label, v]) => ({ label, plannedMin: v.plannedMin, doneMin: v.doneMin }))
    }
    const buckets: Array<{ label: string; plannedMin: number; doneMin: number }> = []
    let cur: { label: string; plannedMin: number; doneMin: number } | null = null
    for (const d of p) {
      const dt = new Date(d.date + 'T00:00:00')
      const key = isoDate(addDays(dt, -(dt.getDay() === 0 ? 6 : dt.getDay() - 1)))
      if (!cur || cur.label !== key) {
        cur = { label: key, plannedMin: 0, doneMin: 0 }
        buckets.push(cur)
      }
      cur.plannedMin += d.plannedMin
      cur.doneMin += d.doneMin
    }
    return buckets.map((b) => ({ label: new Date(b.label + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), plannedMin: b.plannedMin, doneMin: b.doneMin }))
  }, [ins.perDay, period])

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const maxBar = Math.max(1, ...barBuckets.map((b) => b.plannedMin))
  const maxHour = Math.max(1, ...ins.hourDist)
  const maxWd = Math.max(1, ...ins.weekdayDist)

  return (
    <div className="insights-view">
      <div className="ins-top">
        <div className="segmented accent ins-period">
          {PERIODS.map((p) => (
            <button key={p.id} className={`seg-btn${period === p.id ? ' active' : ''}`} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="ins-subtitle">
          {new Date(ins.bestDay ?? Date.now()).getFullYear()} · planned {fmtH(ins.plannedMin)} · completed {fmtH(ins.doneMin)}
        </div>
      </div>

      {/* cards — the numbers vernacular */}
      <div className="ins-cards">
        <div className="ins-card">
          <span className="ins-card-icon" style={{ background: 'rgba(10,132,255,.14)', color: 'var(--accent)' }}>⏱</span>
          <div><div className="ins-card-value">{fmtH(ins.plannedMin)}</div><div className="ins-card-label">Planned time</div></div>
        </div>
        <div className="ins-card">
          <span className="ins-card-icon" style={{ background: 'rgba(52,199,89,.15)', color: 'var(--green)' }}>✓</span>
          <div><div className="ins-card-value">{ins.doneCount}<span className="ins-card-sub"> / {ins.count}</span></div><div className="ins-card-label">Completed activities</div></div>
        </div>
        <div className="ins-card">
          <span className="ins-card-icon" style={{ background: 'rgba(255,159,10,.16)', color: 'var(--amber)' }}>%</span>
          <div><div className="ins-card-value">{ins.completion}%</div><div className="ins-card-label">Plan completion</div></div>
        </div>
        <div className="ins-card">
          <span className="ins-card-icon" style={{ background: 'rgba(255,69,58,.14)', color: '#ff453a' }}>🔥</span>
          <div><div className="ins-card-value">{ins.streak}<span className="ins-card-sub"> day{ins.streak === 1 ? '' : 's'}</span></div><div className="ins-card-label">Completion streak</div></div>
        </div>
      </div>

      {/* digest — the words vernacular */}
      <div className="ins-panel digest">
        <div className="ins-panel-title">In plain words</div>
        <ul>
          {ins.digest.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>

      <div className="ins-grid">
        <div className="ins-panel">
          <div className="ins-panel-title">Time per label</div>
          {donut.length === 0 ? <div className="ins-empty">No data yet</div> : (
            <div className="ins-donut-row">
              <Donut data={donut} />
              <div className="ins-legend">
                {donut.map((d) => (
                  <div key={d.id ?? 'u'} className="ins-legend-row">
                    <span className="ins-legend-dot" style={{ background: d.color }} />
                    <span className="ins-legend-name">{d.name}</span>
                    <span className="ins-legend-val">{fmtH(d.plannedMin)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="ins-panel">
          <div className="ins-panel-title">Planned vs done</div>
          <svg className="chart-svg" viewBox={`0 0 ${Math.max(220, barBuckets.length * 24)} 140`} width="100%" height="150">
            {barBuckets.map((b, i) => {
              const x = i * 24 + 4
              const ph = (b.plannedMin / maxBar) * 100
              const dh = (b.doneMin / maxBar) * 100
              return (
                <g key={i}>
                  <rect x={x} y={130 - ph} width={9} height={ph} rx={2} fill="var(--accent)" opacity={0.85}>
                    <title>{b.label}: {fmtH(b.plannedMin)} planned</title>
                  </rect>
                  <rect x={x + 11} y={130 - dh} width={9} height={dh} rx={2} fill="var(--green)" opacity={0.9}>
                    <title>{b.label}: {fmtH(b.doneMin)} done</title>
                  </rect>
                  {i % 2 === 0 && <text x={x} y={142} fontSize={8} fill="var(--text-3)">{b.label}</text>}
                </g>
              )
            })}
          </svg>
        </div>

        <div className="ins-panel">
          <div className="ins-panel-title">Busiest hours</div>
          <svg className="chart-svg" viewBox="0 0 240 110" width="100%" height="120">
            {ins.hourDist.map((m, h) => {
              const hh = (m / maxHour) * 80
              const hot = h === ins.busiestHour
              return (
                <rect
                  key={h}
                  x={h * 10}
                  y={100 - hh}
                  width={8}
                  height={hh}
                  rx={1.5}
                  fill={hot ? 'var(--amber)' : 'var(--accent)'}
                  opacity={hot ? 1 : 0.55}
                >
                  <title>{String(h).padStart(2, '0')}:00 — {fmtH(m)}</title>
                </rect>
              )
            })}
          </svg>
          <div className="ins-axis">
            {[0, 6, 12, 18, 23].map((h) => (
              <span key={h}>{String(h).padStart(2, '0')}</span>
            ))}
          </div>
        </div>

        <div className="ins-panel">
          <div className="ins-panel-title">Day of week</div>
          <svg className="chart-svg" viewBox="0 0 240 110" width="100%" height="120">
            {ins.weekdayDist.map((m, d) => {
              const hh = (m / maxWd) * 80
              const hot = m === Math.max(...ins.weekdayDist) && m > 0
              return (
                <rect
                  key={d}
                  x={d * 33 + 5}
                  y={100 - hh}
                  width={22}
                  height={hh}
                  rx={3}
                  fill={hot ? 'var(--amber)' : 'var(--accent)'}
                  opacity={hot ? 1 : 0.6}
                >
                  <title>{WD[d]}: {fmtH(m)}</title>
                </rect>
              )
            })}
          </svg>
          <div className="ins-axis">
            {WD.map((w) => (
              <span key={w}>{w[0]}</span>
            ))}
          </div>
        </div>

        <div className="ins-panel wide">
          <div className="ins-panel-title">Last 16 weeks of activity</div>
          <div className="heatmap">
            {ins.heatmap.map((c, i) => {
              const intensity = c.min === 0 ? 0 : 0.25 + Math.min(0.75, c.min / 240)
              return (
                <span
                  key={i}
                  className="heat-cell"
                  style={c.min === 0 ? undefined : { background: `rgba(10,132,255,${intensity})` }}
                  title={`${c.date}: ${fmtH(c.min)} planned`}
                />
              )
            })}
          </div>
          <div className="ins-axis heat-legend">
            <span>Less</span>
            <span className="heat-cell" style={{ background: 'rgba(10,132,255,.3)' }} />
            <span className="heat-cell" style={{ background: 'rgba(10,132,255,.6)' }} />
            <span className="heat-cell" style={{ background: 'rgba(10,132,255,.95)' }} />
            <span>More</span>
          </div>
        </div>

        <div className="ins-panel wide">
          <div className="ins-panel-title">Label completion</div>
          {ins.perLabel.length === 0 ? (
            <div className="ins-empty">No data yet</div>
          ) : (
            ins.perLabel.slice(0, 6).map((p) => (
              <div key={p.id ?? 'u'} className="ins-progress">
                <span className="ins-progress-name" style={{ color: p.color }}>{p.name}</span>
                <div className="ins-progress-track">
                  <div className="ins-progress-done" style={{ width: `${p.completion}%`, background: p.color }} />
                </div>
                <span className="ins-progress-val">{p.completion}% · {fmtH(p.doneMin)}/{fmtH(p.plannedMin)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Simple SVG donut. */
function Donut({ data }: { data: Array<{ id: string | null; name: string; color: string; plannedMin: number }> }) {
  const total = Math.max(1, data.reduce((s, d) => s + d.plannedMin, 0))
  const R = 40
  const C = 2 * Math.PI * R
  let acc = 0
  return (
    <svg className="chart-svg donut" viewBox="0 0 110 110" width="120" height="120">
      <circle cx={55} cy={55} r={R} fill="none" stroke="var(--surface-3)" strokeWidth={16} />
      {data.map((d) => {
        const frac = d.plannedMin / total
        const dash = frac * C
        const el = (
          <circle
            key={d.id ?? 'u'}
            cx={55}
            cy={55}
            r={R}
            fill="none"
            stroke={d.color}
            strokeWidth={16}
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={-acc * C}
            transform="rotate(-90 55 55)"
          >
            <title>{d.name}: {fmtH(d.plannedMin)}</title>
          </circle>
        )
        acc += frac
        return el
      })}
      <text x={55} y={52} textAnchor="middle" fontSize={14} fontWeight={700} fill="var(--text)">{fmtH(total)}</text>
      <text x={55} y={66} textAnchor="middle" fontSize={8} fill="var(--text-3)">planned</text>
    </svg>
  )
}
