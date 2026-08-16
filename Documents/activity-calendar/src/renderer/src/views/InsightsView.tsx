import { useEffect, useMemo, useRef, useState } from 'react'
import { useData, useUi, hiddenLabelIds } from '@/state/store'
import { computeInsights, fmtH, isoD } from '@/lib/insights'
import { startOfDay, addDays, isoDate } from '@/engine/recurrence'
import { parseLocal } from '@/engine/occurrences'
import { groupScores, type ScoreRow } from '@/lib/scoreGroups'
import type { Label } from '@shared/types'

type Period = 'week' | 'month' | 'year' | 'all' | 'custom'

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' }
]

const pad2 = (n: number) => String(n).padStart(2, '0')
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const niceDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function rangeFor(
  period: Period,
  events: { startLocal: string }[],
  customFrom: string,
  customTo: string,
  alt: boolean
): { start: Date; end: Date } {
  const today = startOfDay(new Date())
  if (period === 'week') {
    const dow = today.getDay()
    const mon = addDays(today, dow === 0 ? -6 : 1 - dow)
    if (alt) return { start: addDays(mon, -7), end: mon } // LAST week (Mon–Sun)
    return { start: mon, end: addDays(mon, 7) }
  }
  if (period === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1)
    if (alt) {
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return { start: prev, end: first } // LAST month
    }
    return { start: first, end: new Date(today.getFullYear(), today.getMonth() + 1, 1) }
  }
  if (period === 'year') {
    const y0 = new Date(today.getFullYear(), 0, 1)
    if (alt) return { start: new Date(today.getFullYear() - 1, 0, 1), end: y0 } // LAST year
    return { start: y0, end: new Date(today.getFullYear() + 1, 0, 1) }
  }
  if (period === 'custom' && customFrom && customTo) {
    const from = new Date(customFrom + 'T00:00:00')
    const to = new Date(customTo + 'T00:00:00')
    if (to >= from) return { start: from, end: addDays(to, 1) }
  }
  // ALL TIME: every past event (completely) up to THIS YEAR's last day.
  let earliest: Date | null = null
  for (const e of events) {
    const t = parseLocal(e.startLocal).getTime()
    if (!earliest || t < earliest.getTime()) earliest = new Date(t)
  }
  const start = startOfDay(earliest ?? addDays(today, -30))
  const end = new Date(today.getFullYear() + 1, 0, 1) // Jan 1 next year = Dec 31 23:59 this year
  return { start, end }
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function InsightsView() {
  const { events, labels } = useData()
  const ui = useUi()
  const [period, setPeriod] = useState<Period>('week')
  const [periodAlt, setPeriodAlt] = useState(false)
  const [customFrom, setCustomFrom] = useState(todayIso)
  const [customTo, setCustomTo] = useState(todayIso)
  /** v1.11.16: MULTI-SELECT parent-label chips — empty set = All labels */
  const [focusTops, setFocusTops] = useState<Set<string>>(new Set())
  const [expandedDonut, setExpandedDonut] = useState<string | null>(null)
  const [expandedComp, setExpandedComp] = useState<string | null>(null)
  const [scoreIns, setScoreIns] = useState<{ total: { on_time: number; late: number; off_schedule: number }; labels: Array<{ labelId: string | null; name: string; parentId: string | null; parentName: string | null; color: string | null; on_time: number; late: number; off_schedule: number; total: number }>; count: number } | null>(null)
  /** v1.11.17: on-time/late/off-schedule parent groups — DEFAULT COLLAPSED,
   *  and only ONE parent open at a time (single key, like Label completion) */
  const [scoreOpenKey, setScoreOpenKey] = useState<string | null>(null)

  // v1.11.15/16: on-time/late/off-schedule follows the selected PERIOD and
  // the parent-label chips chosen on top — never the sidebar (user decision)
  const scoreRange = useMemo(() => {
    const { start, end } = rangeFor(period, events, customFrom, customTo, periodAlt)
    return { from: isoD(start), to: isoD(end) }
  }, [period, events, customFrom, customTo, periodAlt])
  useEffect(() => {
    void window.api.coins
      .scoreInsights({ from: scoreRange.from, to: scoreRange.to, parentIds: [...focusTops] })
      .then(setScoreIns)
      .catch(() => {})
  }, [scoreRange.from, scoreRange.to, focusTops])
  const heatWrapRef = useRef<HTMLDivElement>(null)
  const [faces, setFaces] = useState<number[]>([0, 0, 0, 0])
  const [bestStreak, setBestStreak] = useState(0)
  const [heatOpen, setHeatOpen] = useState(false)
  const [heatT1, setHeatT1] = useState(2) // hours: low → medium boundary
  const [heatT2, setHeatT2] = useState(5) // hours: medium → high boundary
  const heatTitleRef = useRef<HTMLDivElement>(null)

  // B.6: close the threshold popover on outside click
  useEffect(() => {
    if (!heatOpen) return
    const onDown = (e: MouseEvent) => {
      const el = heatTitleRef.current
      if (el && !el.contains(e.target as Node)) setHeatOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [heatOpen])

  useEffect(() => {
    void (async () => {
      const [t1, t2] = await Promise.all([window.api.settings.get('heatT1'), window.api.settings.get('heatT2')])
      if (t1) setHeatT1(parseInt(t1, 10) || 2)
      if (t2) setHeatT2(parseInt(t2, 10) || 5)
    })()
  }, [])
  const saveHeat = async () => {
    const a = Math.max(1, heatT1)
    const b = Math.max(a + 1, heatT2)
    setHeatT1(a); setHeatT2(b)
    await window.api.settings.set('heatT1', String(a))
    await window.api.settings.set('heatT2', String(b))
    setHeatOpen(false)
  }

  const hidden = useMemo(() => hiddenLabelIds(labels, ui.hiddenLabels), [labels, ui.hiddenLabels])
  const parents = useMemo(() => labels.filter((l) => !l.parentId), [labels])

  const ins = useMemo(() => {
    const { start, end } = rangeFor(period, events, customFrom, customTo, periodAlt)
    return computeInsights(events, labels, hidden, start, end, focusTops, period)
  }, [events, labels, hidden, period, periodAlt, customFrom, customTo, focusTops])

  /** v1.11.16: does the period contain events that would actually be VISIBLE
   *  here (not label-hidden, and inside the selected parent chips)? The
   *  "Last …" toggle must never open an empty period. */
  const visibleIn = (start: Date, end: Date): boolean =>
    events.some((e) => {
      if (hidden.has(e.labelId ?? '')) return false
      if (focusTops.size > 0) {
        const l = labels.find((x) => x.id === e.labelId)
        const topId = l ? (l.parentId ?? l.id) : ''
        if (!focusTops.has(topId)) return false
      }
      const t = parseLocal(e.startLocal).getTime()
      return t >= start.getTime() && t < end.getTime()
    })

  // when the heatmap data changes, scroll to the LATEST weeks (right end)
  useEffect(() => {
    const w = heatWrapRef.current
    if (w) w.scrollLeft = w.scrollWidth
  }, [ins.heatmap.length])

  // persist best streak (all-time high) + load it once
  useEffect(() => {
    window.api.settings.get('bestStreak').then((v) => {
      const n = parseInt(v ?? '0', 10)
      if (!isNaN(n) && n > 0) setBestStreak(n)
    })
  }, [])
  useEffect(() => {
    if (ins.streak > bestStreak) {
      setBestStreak(ins.streak)
      void window.api.settings.set('bestStreak', String(ins.streak))
    }
  }, [ins.streak, bestStreak])

  const donut = useMemo(() => {
    const top = ins.perLabel.slice(0, 6)
    const restMin = ins.perLabel.slice(6).reduce((s, p) => s + p.plannedMin, 0)
    if (restMin > 0) top.push({ id: 'rest', name: 'Other', color: '#aeaeb2', plannedMin: restMin, doneMin: 0, count: 0, completion: 0 })
    return top
  }, [ins.perLabel])

  const barBuckets = useMemo(() => {
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

  // heatmap week columns (Mon-start weeks, for horizontal scrolling)
  const heatWeeks = useMemo(() => {
    const weeks: Array<Array<{ date: string; min: number }>> = []
    let cur: Array<{ date: string; min: number }> = []
    for (const c of ins.heatmap) {
      cur.push(c)
      if (cur.length === 7) {
        weeks.push(cur)
        cur = []
      }
    }
    if (cur.length) weeks.push(cur)
    return weeks
  }, [ins.heatmap])

  const maxBar = Math.max(1, ...barBuckets.map((b) => b.plannedMin))
  const maxHour = Math.max(1, ...ins.hourDist)
  const maxWd = Math.max(1, ...ins.weekdayDist)

  // ---- dice KPI faces ----
  const totalShare = Math.max(1, ins.plannedMin + ins.cancelledMin)
  const pctOf = (min: number) => (totalShare > 0 ? `${Math.round((min / totalShare) * 100)}%` : '—')
  const kpiFaces: Array<Array<{ label: string; value: string; icon: string; iconBg: string; iconColor: string }>> = [
    [
      { label: 'Planned time', value: fmtH(ins.plannedMin), icon: '⏱', iconBg: 'rgba(10,132,255,.14)', iconColor: 'var(--accent)' },
      { label: 'Achieved', value: fmtH(ins.doneMin), icon: '✓', iconBg: 'rgba(52,199,89,.15)', iconColor: 'var(--green)' }
    ],
    [
      { label: 'Completed', value: `${ins.doneCount} / ${ins.count}`, icon: '✓', iconBg: 'rgba(52,199,89,.15)', iconColor: 'var(--green)' },
      { label: 'To Do', value: String(ins.todoCount), icon: '◌', iconBg: 'rgba(142,142,147,.18)', iconColor: 'var(--text-2)' },
      { label: 'In Progress', value: String(ins.doingCount), icon: '●', iconBg: 'rgba(10,132,255,.14)', iconColor: 'var(--accent)' },
      { label: 'Cancelled', value: String(ins.cancelledCount), icon: '✕', iconBg: 'rgba(255,59,48,.13)', iconColor: 'var(--red)' }
    ],
    [
      { label: 'Completion', value: `${ins.completion}%`, icon: '%', iconBg: 'rgba(255,159,10,.16)', iconColor: 'var(--amber)' },
      { label: 'To Do share', value: pctOf(ins.todoMin), icon: '◌', iconBg: 'rgba(142,142,147,.18)', iconColor: 'var(--text-2)' },
      { label: 'In Progress share', value: pctOf(ins.doingMin), icon: '●', iconBg: 'rgba(10,132,255,.14)', iconColor: 'var(--accent)' },
      { label: 'Cancelled share', value: pctOf(ins.cancelledMin), icon: '✕', iconBg: 'rgba(255,59,48,.13)', iconColor: 'var(--red)' }
    ],
    [
      { label: 'Current streak', value: `${ins.streak}d`, icon: '🔥', iconBg: 'rgba(255,69,58,.14)', iconColor: '#ff453a' },
      { label: 'Streak started', value: ins.streakStart ? niceDate(ins.streakStart) : '—', icon: '📅', iconBg: 'rgba(10,132,255,.14)', iconColor: 'var(--accent)' },
      { label: 'Best streak ever', value: `${bestStreak}d`, icon: '🏆', iconBg: 'rgba(255,159,10,.16)', iconColor: 'var(--amber)' },
      { label: 'First completion', value: ins.firstDone ? niceDate(ins.firstDone) : '—', icon: '🌱', iconBg: 'rgba(52,199,89,.15)', iconColor: 'var(--green)' }
    ]
  ]
  const statsKey = `${ins.plannedMin}|${ins.doneMin}|${ins.doneCount}|${ins.count}|${ins.todoCount}|${ins.doingCount}|${ins.cancelledCount}|${ins.completion}|${ins.streak}|${ins.streakStart}|${ins.firstDone}|${bestStreak}`
  useEffect(() => {
    // when the period/data changes, reset all dice to face 0 (the headline
    // value — e.g. "Planned time") so the new data is visible immediately,
    // THEN resume the 5s cascade right → left
    setFaces([0, 0, 0, 0])
    const roll = () => {
      // dice cascade LEFT → RIGHT (card 1 first, card 4 last)
      for (let k = 0; k < 4; k++) {
        const ci = k
        const len = kpiFaces[ci].length
        window.setTimeout(() => {
          setFaces((f) => ({ ...f, [ci]: ((f[ci] ?? 0) + 1) % len }))
        }, k * 150)
      }
    }
    const first = window.setTimeout(roll, 1500)
    const id = window.setInterval(roll, 5000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey])

  const donutKids = (parentId: string) => ins.childStats[parentId] ?? []
  const compKids = (parentId: string) => ins.childStats[parentId] ?? []
  // when EXACTLY ONE parent label is selected, its sublabels are shown by
  // default (manual expand/collapse still works via explicit state)
  const autoFocus = focusTops.size === 1 ? [...focusTops][0] : null
  const effDonut = expandedDonut ?? (autoFocus && donutKids(autoFocus).length > 0 ? autoFocus : null)
  const effComp = expandedComp ?? (autoFocus && compKids(autoFocus).length > 0 ? autoFocus : null)

  return (
    <div className="insights-view">
      <div className="ins-head">
        <div className="ins-top">
          <div className="segmented accent ins-period">
            {PERIODS.map((p) => {
              const isActive = period === p.id
              const isAlt = isActive && periodAlt && p.id !== 'all' && p.id !== 'custom'
              return (
                <button
                  key={p.id}
                  className={`seg-btn${isActive ? ' active' : ''}${isAlt ? ' alt' : ''}`}
                  title={p.id === 'week' || p.id === 'month' || p.id === 'year' ? 'Click again for the previous period' : undefined}
                  onClick={() => {
                    if (isActive && (p.id === 'week' || p.id === 'month' || p.id === 'year')) {
                      // toggle amber: previous period — ONLY when that period
                      // has visible (unfiltered) data (v1.11.16 robustness)
                      const prev = rangeFor(p.id, events, customFrom, customTo, !periodAlt)
                      if (!periodAlt) {
                        if (visibleIn(prev.start, prev.end)) setPeriodAlt(true)
                      } else {
                        setPeriodAlt(false)
                      }
                    } else if (!isActive) {
                      setPeriod(p.id)
                      setPeriodAlt(false)
                    }
                  }}
                >
                  {isAlt ? p.label.replace('This ', 'Last ') : p.label}
                </button>
              )
            })}
          </div>
          {period === 'custom' && (
            <div className="ins-custom-range">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="ins-custom-arrow">→</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          )}
          <div className="ins-subtitle">
            planned {fmtH(ins.plannedMin)} · completed {fmtH(ins.doneMin)}
          </div>
        </div>

        <div className="ins-chips">
          <button
            className={`ins-chip${focusTops.size === 0 ? ' active' : ''}`}
            title="Show all labels"
            onClick={() => { setFocusTops(new Set()); setExpandedDonut(null); setExpandedComp(null) }}
          >
            All labels
          </button>
          {parents.map((p: Label) => {
            const on = focusTops.has(p.id)
            return (
              <button
                key={p.id}
                className={`ins-chip${on ? ' active' : ''}`}
                title={on ? 'Click again to remove' : 'Toggle (multi-select — pick several together)'}
                onClick={() => {
                  const n = new Set(focusTops)
                  if (n.has(p.id)) n.delete(p.id)
                  else n.add(p.id)
                  // v1.11.17: selecting EVERY parent = nothing filtered →
                  // snap back to the "All labels" chip automatically
                  if (parents.length > 0 && n.size === parents.length) n.clear()
                  setFocusTops(n)
                  setExpandedDonut(null)
                  setExpandedComp(null)
                }}
              >
                <span className="ins-chip-dot" style={{ background: p.color ?? '#8E8E93' }} />
                {p.name}
              </button>
            )
          })}
        </div>

        {/* dice KPI cards — roll right→left every 5s */}
        <div className="ins-cards">
          {kpiFaces.map((facesArr, ci) => {
            const face = facesArr[faces[ci] ?? 0]
            return (
              <div key={ci} className="ins-card kpi" data-card={ci} data-face={faces[ci] ?? 0} title={facesArr.map((f) => `${f.label}: ${f.value}`).join(' · ')}>
                <div key={`${statsKey}-${faces[ci]}`} className="kpi-face">
                  <span className="ins-card-icon" style={{ background: face.iconBg, color: face.iconColor }}>{face.icon}</span>
                  <div>
                    <div className="ins-card-value">{face.value}</div>
                    <div className="ins-card-label">{face.label}</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="ins-scroll">
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
              <>
                <div className="ins-donut-row">
                  <Donut data={donut} />
                  <div className="ins-legend">
                    {donut.map((d) => {
                      const kids = donutKids(d.id ?? '')
                      const expandable = kids.length > 0
                      return (
                        <button
                          key={d.id ?? 'u'}
                          className={`ins-legend-row${expandable ? ' expandable' : ''}${effDonut === d.id ? ' open' : ''}`}
                          onClick={() => expandable && setExpandedDonut(effDonut === d.id ? null : d.id)}
                        >
                          <span className="ins-legend-dot" style={{ background: d.color }} />
                          <span className="ins-legend-name">{d.name}</span>
                          <span className="ins-legend-val">{fmtH(d.plannedMin)}</span>
                          {expandable && <span className="ins-caret">{expandedDonut === d.id ? '▾' : '▸'}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {effDonut && donutKids(effDonut).length > 0 && (
                  <div className="ins-sublabels">
                    <div className="ins-sublabel-bar">
                      {donutKids(effDonut).map((c) => (
                        <span
                          key={c.id}
                          className="ins-sublabel-seg"
                          style={{ width: `${(c.plannedMin / Math.max(1, donutKids(effDonut).reduce((s, x) => s + x.plannedMin, 0))) * 100}%`, background: c.color }}
                          title={`${c.name}: ${fmtH(c.plannedMin)}`}
                        />
                      ))}
                    </div>
                    <div className="ins-sublabel-rows">
                      {donutKids(effDonut).map((c) => (
                        <span key={c.id} className="ins-subrow">
                          <span className="ins-legend-dot" style={{ background: c.color }} />
                          {c.own ? <i>{c.name}</i> : c.name}
                          <b>{fmtH(c.plannedMin)}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">Planned vs done</div>
            <svg className="chart-svg" viewBox={`0 0 ${barW()} 150`} width="100%" height="160">
              {barBuckets.map((b, i) => {
                const x = i * 30 + 2
                const ph = (b.plannedMin / maxBar) * 120
                const dh = (b.doneMin / maxBar) * 120
                return (
                  <g key={i}>
                    <rect x={x} y={126 - ph} width={11} height={ph} rx={2} fill="var(--accent)" opacity={0.85}>
                      <title>{b.label}: {fmtH(b.plannedMin)} planned</title>
                    </rect>
                    <rect x={x + 13} y={126 - dh} width={11} height={dh} rx={2} fill="var(--green)" opacity={0.9}>
                      <title>{b.label}: {fmtH(b.doneMin)} done</title>
                    </rect>
                    {i % Math.max(1, Math.ceil(barBuckets.length / 8)) === 0 && (
                      <text x={x + 12} y={144} fontSize={8.5} textAnchor="middle" fill="var(--text-3)">{b.label}</text>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">Busiest hours</div>
            <svg className="chart-svg" viewBox="0 0 240 120" width="100%" height="128">
              {ins.hourDist.map((m, h) => {
                const hh = (m / maxHour) * 88
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
              {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                <text key={h} x={h * 10 + 4} y={112} fontSize={8} textAnchor="middle" fill="var(--text-3)">
                  {String(h).padStart(2, '0')}
                </text>
              ))}
            </svg>
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">Day of week</div>
            <svg className="chart-svg" viewBox="0 0 240 120" width="100%" height="128">
              {ins.weekdayDist.map((m, d) => {
                const hh = (m / maxWd) * 88
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
              {WD.map((w, d) => (
                <text key={w} x={d * 33 + 16} y={112} fontSize={8.5} textAnchor="middle" fill="var(--text-3)">
                  {w[0]}
                </text>
              ))}
            </svg>
          </div>

          <div className="ins-panel wide">
            <div className="ins-panel-title" ref={heatTitleRef}>
              <button className="heat-head-btn" title="Change the hour thresholds for the 3 colours" onClick={() => setHeatOpen((o) => !o)}>
                Activity heatmap ⚙
              </button>
              {heatOpen && (() => {
                const invalid = !(heatT1 >= 1 && heatT2 > heatT1)
                return (
                  <div className="heat-pop">
                    <div className="heat-pop-row">
                      <span>Low → Medium above</span>
                      <input type="number" min={1} value={heatT1} onChange={(e) => setHeatT1(parseInt(e.target.value, 10) || 1)} /> h
                    </div>
                    <div className="heat-pop-row">
                      <span>Medium → High above</span>
                      <input type="number" min={1} value={heatT2} onChange={(e) => setHeatT2(parseInt(e.target.value, 10) || 1)} /> h
                    </div>
                    {invalid && (
                      <div className="heat-pop-err">Low → Medium must be less than Medium → High (and both ≥ 1).</div>
                    )}
                    <div className="heat-pop-actions">
                      <button className="btn sm" onClick={() => setHeatOpen(false)}>Cancel</button>
                      <button className="btn sm primary" disabled={invalid} onClick={() => void saveHeat()}>Save</button>
                    </div>
                  </div>
                )
              })()}
            </div>
            <div className="heatmap-wrap" ref={heatWrapRef}>
              <div className="heatmap">
                {heatWeeks.map((wk, wi) => (
                  <div key={wi} className="heat-week">
                    {wk.map((c) => {
                      const h = c.min / 60
                      let bg: string | undefined
                      if (c.min > 0) {
                        if (h <= heatT1) bg = 'rgba(10,132,255,.32)'
                        else if (h <= heatT2) bg = 'rgba(10,132,255,.62)'
                        else bg = 'rgba(10,132,255,.95)'
                      }
                      return (
                        <span
                          key={c.date}
                          className="heat-cell"
                          style={bg ? { background: bg } : undefined}
                          title={`${c.date}: ${fmtH(c.min)} planned`}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="ins-axis heat-legend">
              <span>Less</span>
              <span className="heat-cell" style={{ background: 'rgba(10,132,255,.32)' }} />
              <span className="heat-cell" style={{ background: 'rgba(10,132,255,.62)' }} />
              <span className="heat-cell" style={{ background: 'rgba(10,132,255,.95)' }} />
              <span>More · ≤{heatT1}h · ≤{heatT2}h</span>
            </div>
          </div>

          <div className="ins-panel wide">
            <div className="ins-panel-title">On-time · Late · Off-schedule</div>
            {!scoreIns || scoreIns.count === 0 ? (
              <div className="ins-empty">No scores yet — mark activities done and rate them to see patterns.</div>
            ) : (
              <>
                <div className="score-total-row">
                  {(['on_time', 'late', 'off_schedule'] as const).map((k) => {
                    const n = scoreIns.total[k]
                    const pct = scoreIns.count ? Math.round((n / scoreIns.count) * 100) : 0
                    const label = k === 'on_time' ? 'On time' : k === 'late' ? 'Late' : 'Off schedule'
                    const cls = k === 'on_time' ? 'ontime' : k === 'late' ? 'late' : 'off'
                    return (
                      <div key={k} className={`score-pill ${cls}`}>
                        <b>{pct}%</b> <span>{label}</span> <i>({n})</i>
                      </div>
                    )
                  })}
                </div>
                <ScoreGroups rows={scoreIns.labels} openKey={scoreOpenKey} setOpenKey={setScoreOpenKey} />
              </>
            )}
          </div>

          <div className="ins-panel wide">
            <div className="ins-panel-title">Label completion</div>
            {ins.perLabel.length === 0 ? (
              <div className="ins-empty">No data yet</div>
            ) : (
              ins.perLabel.slice(0, 6).map((p) => {
                const kids = compKids(p.id ?? '')
                const expandable = kids.length > 0
                return (
                  <div key={p.id ?? 'u'} className="ins-comp-group">
                    <button
                      className={`ins-progress${expandable ? ' expandable' : ''}${effComp === p.id ? ' open' : ''}`}
                      onClick={() => expandable && setExpandedComp(effComp === p.id ? null : p.id)}
                    >
                      <span className="ins-progress-name" style={{ color: p.color }}>{p.name}</span>
                      <div className="ins-progress-track">
                        <div className="ins-progress-done" style={{ width: `${p.completion}%`, background: p.color }} />
                      </div>
                      <span className="ins-progress-val">{p.completion}% · {fmtH(p.doneMin)}/{fmtH(p.plannedMin)}</span>
                      {expandable && <span className="ins-caret">{expandedComp === p.id ? '▾' : '▸'}</span>}
                    </button>
                    {effComp === p.id &&
                      kids.map((k) => (
                        <div key={k.id} className={`ins-progress sub${k.own ? ' own' : ''}`}>
                          <span className="ins-progress-name" style={{ color: k.color }}>{k.own ? '↳ (no sub-label)' : `↳ ${k.name}`}</span>
                          <div className="ins-progress-track">
                            <div className="ins-progress-done" style={{ width: `${k.completion}%`, background: k.color }} />
                          </div>
                          <span className="ins-progress-val">{k.completion}% · {fmtH(k.doneMin)}/{fmtH(k.plannedMin)}</span>
                        </div>
                      ))}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )

  function barW() {
    return Math.max(220, barBuckets.length * 30)
  }
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

/** v1.11.17: On-time · Late · Off-schedule rows grouped under their PARENT
 *  labels — the row STYLE matches the Label completion panel (colored name +
 *  track + value + caret, children indented), the track stays the 3-colour
 *  on-time/late/off bar, and only ONE group is open at a time (default
 *  COLLAPSED, like Label completion). Every child row carries its own bar. */
function ScoreGroups({
  rows,
  openKey,
  setOpenKey
}: {
  rows: ScoreRow[]
  openKey: string | null
  setOpenKey: (k: string | null) => void
}) {
  const groups = groupScores(rows)
  if (groups.length === 0) return null
  return (
    <div className="score-by-label">
      {groups.map((g) => {
        const hasKids = g.children.length > 0
        const open = openKey === g.key
        const tot = Math.max(1, g.total)
        const segs = (o: number, la: number, of: number) => (
          <div className="score-label-track">
            <div className="score-seg ontime" style={{ width: `${(o / tot) * 100}%` }} title={`On time ${o}`} />
            <div className="score-seg late" style={{ width: `${(la / tot) * 100}%` }} title={`Late ${la}`} />
            <div className="score-seg off" style={{ width: `${(of / tot) * 100}%` }} title={`Off schedule ${of}`} />
          </div>
        )
        return (
          <div key={g.key} className="score-group">
            <button
              className={`ins-progress${hasKids ? ' expandable' : ''}${open ? ' open' : ''}`}
              onClick={() => hasKids && setOpenKey(open ? null : g.key)}
              title={hasKids ? (open ? 'Collapse' : 'Expand') : undefined}
            >
              <span className="ins-progress-name" style={g.color ? { color: g.color } : undefined}>{g.name}</span>
              {segs(g.on_time, g.late, g.off_schedule)}
              <span className="ins-progress-val">{g.total}</span>
              {hasKids && <span className="ins-caret">{open ? '▾' : '▸'}</span>}
            </button>
            {hasKids && open && (
              <div className="score-kids">
                {g.children.map((c) => (
                  <div key={c.labelId ?? c.name} className="ins-progress sub">
                    <span className="ins-progress-name" style={c.color ? { color: c.color } : undefined}>{c.name}</span>
                    <div className="score-label-track">
                      <div className="score-seg ontime" style={{ width: `${(c.on_time / Math.max(1, c.total)) * 100}%` }} title={`On time ${c.on_time}`} />
                      <div className="score-seg late" style={{ width: `${(c.late / Math.max(1, c.total)) * 100}%` }} title={`Late ${c.late}`} />
                      <div className="score-seg off" style={{ width: `${(c.off_schedule / Math.max(1, c.total)) * 100}%` }} title={`Off schedule ${c.off_schedule}`} />
                    </div>
                    <span className="ins-progress-val">{c.total}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
