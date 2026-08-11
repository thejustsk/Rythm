import { useEffect, useMemo, useState } from 'react'
import { buildRRule, nextOccurrences, parseRRule, ruleToHuman, WEEKDAY_KEYS } from '@/engine/recurrence'
import type { Freq } from '@/engine/recurrence'

const FREQS: Array<{ id: Freq | 'none'; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'DAILY', label: 'Daily' },
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'MONTHLY', label: 'Monthly' },
  { id: 'YEARLY', label: 'Yearly' }
]

const WD = [
  { k: 'MO', s: 'M' },
  { k: 'TU', s: 'T' },
  { k: 'WE', s: 'W' },
  { k: 'TH', s: 'T' },
  { k: 'FR', s: 'F' },
  { k: 'SA', s: 'S' },
  { k: 'SU', s: 'S' }
]

const UNIT: Record<Freq, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Props {
  value: string | null
  onChange: (rrule: string | null) => void
  /** 'YYYY-MM-DD' — the event's start date, used as the series anchor */
  startDate: string
}

/** Visual recurrence builder with a live preview of upcoming dates. */
export default function RepeatEditor({ value, onChange, startDate }: Props) {
  const start = useMemo(() => new Date(startDate + 'T00:00:00'), [startDate])
  const startDow = WEEKDAY_KEYS[start.getDay()]
  const parsed = useMemo(() => (value ? parseRRule(value) : null), [value])

  const [freq, setFreq] = useState<Freq | 'none'>(parsed?.freq ?? 'none')
  const [intervalN, setIntervalN] = useState(parsed?.interval ?? 1)
  const [byday, setByday] = useState<string[]>(parsed?.byday ?? [startDow])
  const [monthday, setMonthday] = useState(parsed?.bymonthday?.[0] ?? start.getDate())
  const [month, setMonth] = useState(parsed?.bymonth?.[0] ?? start.getMonth() + 1)
  const defaultUntil = () => {
    const d = new Date(start)
    d.setMonth(d.getMonth() + 3)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const [endMode, setEndMode] = useState<'never' | 'until' | 'count'>(
    parsed?.until ? 'until' : parsed?.count ? 'count' : 'never'
  )
  const [until, setUntil] = useState(parsed?.until ?? '')
  const [count, setCount] = useState(parsed?.count ?? 10)

  useEffect(() => {
    if (freq === 'none') {
      onChange(null)
      return
    }
    onChange(
      buildRRule({
        freq: freq as Freq,
        interval: intervalN,
        byday: freq === 'WEEKLY' ? (byday.length ? byday : [startDow]) : undefined,
        bymonthday: freq === 'MONTHLY' || freq === 'YEARLY' ? monthday : undefined,
        bymonth: freq === 'YEARLY' ? month : undefined,
        endMode,
        until,
        count
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, intervalN, byday, monthday, month, endMode, until, count])

  const preview = useMemo(() => {
    if (!value) return []
    return nextOccurrences(value, start, 6)
  }, [value, start])

  // yearly previews must show the year (issue 2)
  const chipText = (d: Date) =>
    freq === 'YEARLY'
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const summary = useMemo(() => (value ? ruleToHuman(value) : null), [value])

  // Warning: the event's own start day isn't in the weekly rule → the first
  // occurrence will be later than the event's start date (block "jumps").
  const weeklySkipsStart = freq === 'WEEKLY' && !byday.includes(startDow)

  const toggleDay = (k: string) => {
    setByday((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
  }

  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = parseInt(v, 10)
    if (isNaN(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  return (
    <div className="repeat-editor">
      <div className="re-title">Repeat</div>

      <div className="segmented accent re-freq">
        {FREQS.map((f) => (
          <button
            key={f.id}
            className={`seg-btn${freq === f.id ? ' active' : ''}`}
            onClick={() => setFreq(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {freq !== 'none' && (
        <>
          {freq === 'WEEKLY' && (
            <div className="re-row">
              <span className="re-label">On</span>
              <div className="wd-pills">
                {WD.map((w) => (
                  <button
                    key={w.k}
                    data-day={w.k}
                    className={`wd-pill${byday.includes(w.k) ? ' on' : ''}`}
                    onClick={() => toggleDay(w.k)}
                  >
                    {w.s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="re-row">
            <span className="re-label">Every</span>
            <input
              type="number"
              min={1}
              max={99}
              className="re-num"
              value={intervalN}
              onChange={(e) => setIntervalN(num(e.target.value, 1, 99, 1))}
            />
            <span className="re-hint">
              {UNIT[freq as Freq]}
              {intervalN > 1 ? 's' : ''}
            </span>
            {freq === 'MONTHLY' && (
              <span className="re-hint">
                on day{' '}
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="re-num re-num-sm"
                  value={monthday}
                  onChange={(e) => setMonthday(num(e.target.value, 1, 31, start.getDate()))}
                />
              </span>
            )}
            {freq === 'YEARLY' && (
              <span className="re-hint">
                in{' '}
                <select className="re-month" value={month} onChange={(e) => setMonth(parseInt(e.target.value, 10))}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' })}
                    </option>
                  ))}
                </select>{' '}
                on day{' '}
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="re-num re-num-sm"
                  value={monthday}
                  onChange={(e) => setMonthday(num(e.target.value, 1, 31, start.getDate()))}
                />
              </span>
            )}
          </div>

          <div className="re-row">
            <span className="re-label">Ends</span>
            <div className="segmented accent re-ends">
              <button className={`seg-btn${endMode === 'never' ? ' active' : ''}`} onClick={() => setEndMode('never')}>
                Never
              </button>
              <button
                className={`seg-btn${endMode === 'until' ? ' active' : ''}`}
                onClick={() => {
                  setEndMode('until')
                  // prefill a meaningful end date the first time
                  setUntil((u) => u || defaultUntil())
                }}
              >
                On date
              </button>
              <button className={`seg-btn${endMode === 'count' ? ' active' : ''}`} onClick={() => setEndMode('count')}>
                After
              </button>
            </div>
            {endMode === 'until' && (
              <input type="date" className="re-until" value={until} onChange={(e) => setUntil(e.target.value)} />
            )}
            {endMode === 'count' && (
              <span className="re-hint">
                <input
                  type="number"
                  min={1}
                  max={999}
                  className="re-num re-num-sm re-count"
                  value={count}
                  onChange={(e) => setCount(num(e.target.value, 1, 999, 10))}
                />{' '}
                times
              </span>
            )}
          </div>

          {weeklySkipsStart && (
            <div className="re-warn">
              This activity starts on {DAY_NAMES[start.getDay()]}, which isn't selected — the first
              occurrence will be{' '}
              <strong>{preview[0]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? '…'}</strong>.
              Tap the {DAY_NAMES[start.getDay()].slice(0, 3)} pill to include it.
            </div>
          )}

          {preview.length > 0 && (
            <div className="re-preview">
              {preview.map((d, i) => (
                <span key={i} className="re-preview-date">
                  {chipText(d)}
                </span>
              ))}
              <span className="re-preview-more">…</span>
            </div>
          )}

          {summary && <div className="re-summary">{summary}</div>}
        </>
      )}
    </div>
  )
}
