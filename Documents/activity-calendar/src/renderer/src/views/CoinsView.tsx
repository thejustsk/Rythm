import { useEffect, useMemo, useRef, useState } from 'react'
import { useCoins } from '@/state/coins'
import { useMilestones } from '@/state/milestones'
import { useToasts } from '@/state/toasts'
import { fmtCoins, streakMilestoneReward, streakWindow } from '@/lib/gamification'
import { computeOccurrences, parseLocal } from '@/engine/occurrences'
import { addDays, startOfDay, isoDate } from '@/engine/recurrence'
import { perfectWeekCheck, perfectMonthCheck } from '../../../main/gamifyCore'
import { useData, useUi } from '@/state/store'
import type { RewardMilestone } from '@shared/types'
import Coin from '@/components/Coin'
import CoinIntro from '@/components/CoinIntro'

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The cinematic intro plays only on the FIRST Coins open per app session. */

/** Mini-month style streak calendar: day numbers inside status-dot colors. */
function StreakMonth({
  month,
  onMonth,
  dayMap,
  perfectWeeks,
  perfectMonth,
  coverUpTo
}: {
  month: Date
  onMonth: (m: Date) => void
  dayMap: Map<string, 'done' | 'missed' | 'none'>
  /** Monday-Iso dates of PERFECT weeks (rows get a golden border). */
  perfectWeeks: Set<string>
  /** 'YYYY-MM' when the displayed month is a PERFECT month (golden dots,
   *  blue text on done days; no-event days keep their normal styling). */
  perfectMonth: string | null
  /** while the streak is ALIVE today, the current week's golden cover runs
   *  only up to TODAY's dot — never into days that haven't happened yet. */
  coverUpTo: string | null
}) {
  // v1.11.4: the STREAK calendar is ALWAYS Monday–Sunday (the Sunday/Monday
  // setting applies to the main week/month views only)
  const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const today = startOfDay(new Date())
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const gridStart = addDays(first, 1 - (first.getDay() === 0 ? 7 : first.getDay())) // Monday
  // dynamic rows: only the weeks actually needed to cover the month
  const startOffset = first.getDay() === 0 ? 6 : first.getDay() - 1
  const daysInThisMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const rowsNeeded = Math.ceil((startOffset + daysInThisMonth) / 7)
  const rows: Date[][] = []
  for (let r = 0; r < rowsNeeded; r++) {
    const row: Date[] = []
    for (let c = 0; c < 7; c++) row.push(addDays(gridStart, r * 7 + c))
    rows.push(row)
  }
  const monthKeyStr = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
  const isPerfectMonth = perfectMonth === monthKeyStr
  return (
    <div className="streak-month">
      <div className="streak-month-head">
        <button className="mm-nav" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <span className="streak-month-title">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button className="mm-nav" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="streak-month-week">
        {DAYS.map((d) => <span key={d}>{d[0]}</span>)}
      </div>
      <div className="streak-month-grid">
        {rows.map((row, r) => {
          const weekMon = isoDate(row[0])
          const weekEnd = isoDate(row[6])
          const wkPerfect = perfectWeeks.has(weekMon)
          const rowCover = !!coverUpTo && weekMon <= coverUpTo && coverUpTo <= weekEnd
          return (
            <div
              key={r}
              className={`streak-row${wkPerfect ? ' perfect-wk' : ''}${rowCover ? ' perfect-up' : ''}`}
              title={wkPerfect ? 'Perfect week 🏆' : rowCover ? 'Perfect so far — keep it up!' : undefined}
            >
              {row.map((d, i) => {
                const iso = isoDate(d)
                const status = dayMap.get(iso) ?? 'none'
                const isToday = iso === isoDate(today)
                const other = d.getMonth() !== month.getMonth()
                const future = d.getTime() > today.getTime()
                // perfect month: done dates get a GOLDEN dot with blue text;
                // no-event days keep their normal styling
                const perfectM = isPerfectMonth && status === 'done' ? ' perfect-m' : ''
                // v1.10.6: golden cover Mon..today on the current week while
                // the streak is alive — the row never wears it beyond today
                const covered = rowCover && !!coverUpTo && iso <= coverUpTo
                return (
                  <span
                    key={i}
                    className={`streak-day ${status}${perfectM}${isToday ? ' today' : ''}${other ? ' other' : ''}${future ? ' future' : ''}${covered ? ' cover' : ''}`}
                    title={`${iso}${status === 'done' ? ' — done ✓' : status === 'missed' ? ' — missed ✗' : ' — no events'}${wkPerfect ? ' (perfect week)' : covered ? ' (perfect so far)' : ''}`}
                  >
                    {d.getDate()}
                  </span>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The 4-stone streak goal window with progress toward the next stone. */
function StreakGoalWindow({ streak }: { streak: number }) {
  const w = streakWindow(streak)
  const hit = w.hitIndex >= 0 ? w.stones[w.hitIndex] : null
  const next = w.stones[w.nextIndex] ?? w.stones[w.stones.length - 1]
  const progress = hit === null ? Math.min(1, streak / next) : Math.min(1, (streak - hit) / (next - hit))
  return (
    <div className="streak-goal">
      <div className="streak-goal-sub">Current: <b>{streak}d</b> · next reward at {next}d = {streakMilestoneReward(next)} 🪙</div>
      <div className="streak-goal-stones">
        {w.stones.map((c, i) => {
          const isHit = i === w.hitIndex
          const isPrev = i === w.hitIndex - 1 // the second-last reached mile
          const isNext = i === w.nextIndex
          return (
            <div key={c} className={`streak-stone${isHit ? ' hit' : ''}${isPrev ? ' hit-prev' : ''}${isNext ? ' next' : ''}`}>
              <div className="streak-stone-num">{c}d</div>
              {isNext && (
                <div className="streak-stone-bar">
                  <div className="streak-stone-fill" style={{ width: `${progress * 100}%` }} />
                </div>
              )}
              {isHit && <div className="streak-stone-tick">✓</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Celebration overlay: confetti + coin burst when a milestone is claimed. */
export function Celebration({ m, onClose }: { m: RewardMilestone; onClose: () => void }) {
  const pieces = Array.from({ length: 42 }, (_, i) => ({
    left: (i * 137) % 100,
    delay: (i % 12) * 0.12,
    color: ['#FFD60A', '#0A84FF', '#34C759', '#FF375F', '#BF5AF2', '#FF9F0A'][i % 6],
    rotate: (i * 61) % 360
  }))
  return (
    <div className="overlay celeb" onClick={onClose}>
      <div className="confetti">
        {pieces.map((p, i) => (
          <span key={i} className="confetti-piece" style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, transform: `rotate(${p.rotate}deg)` }} />
        ))}
      </div>
      <div className="celeb-card">
        <div className="celeb-icon">🎉</div>
        <div className="celeb-title">Milestone claimed!</div>
        <div className="celeb-name">
          {m.icon} {m.name}
        </div>
        <div className="celeb-sub">Treat yourself — you earned it. 🪙</div>
        <button className="btn primary" onClick={onClose}>
          Enjoy!
        </button>
      </div>
    </div>
  )
}

/** Prompt to set the reward for the next milestone (fires on first crossing). */
/** Generic reward-item dialog (name/icon/notes only — cost/level are fixed). */
/** Reward-note dialog — level name & icon are FIXED; only the reward note is editable. */
function RewardDialog({
  title,
  initialNote,
  onSave,
  onClose
}: {
  title: string
  initialNote: string
  onSave: (note: string) => void
  onClose: () => void
}) {
  const [note, setNote] = useState(initialNote === 'Set your reward' ? '' : initialNote)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        <div className="repeat-note muted">The level and coin cost are fixed — only the reward note is yours to set.</div>
        <div className="mile-form">
          <input
            autoFocus
            placeholder="Reward (e.g. Movie night)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mile-notes"
          />
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!note.trim()} onClick={() => onSave(note.trim())}>
            Save reward
          </button>
        </div>
      </div>
    </div>
  )
}

/** Reward-time popup — asks for the reward of EVERY pending reached stone in
 *  ONE dialog (1 or more): the first milestone included, and no conflict when
 *  several milestones are achieved at once. */
function RewardBatchPrompt({
  stones,
  onSave,
  onSkip
}: {
  stones: RewardMilestone[]
  onSave: (notes: Record<string, string>) => void
  onSkip: () => void
}) {
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}
    for (const s of stones) o[s.id] = s.notes && s.notes !== 'Set your reward' ? s.notes : ''
    return o
  })
  const anyNote = stones.some((s) => (notes[s.id] ?? '').trim())
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onSkip()}>
      <div className="dialog reward-batch">
        <div className="dialog-title">🎯 Reward time!</div>
        <div className="repeat-note muted">
          {stones.length === 1
            ? `Set the reward you'll claim for ${stones[0].name}.`
            : 'Set a reward for each level — the last one is the next level coming up.'}
        </div>
        <div className="rb-list">
          {stones.map((s) => (
            <div key={s.id} className="rb-item">
              <div className="rb-name">
                {s.name} · <span className="mile-level">{s.cost} 🪙</span>
              </div>
              <input
                autoFocus={stones.length === 1}
                className="rb-input mile-notes"
                placeholder="Reward (e.g. Movie night)"
                value={notes[s.id] ?? ''}
                onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onSkip}>
            Skip
          </button>
          <button className="btn primary" disabled={!anyNote} onClick={() => onSave(notes)}>
            Save rewards
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CoinsView() {
  const ui = useUi()
  const coins = useCoins()
  const ms = useMilestones()
  const systemOn = useCoins((s) => s.systemOn)
  const loadMs = useMilestones((s) => s.load)
  const { events } = useData()
  const toasts = useToasts.getState()

  const [faces, setFaces] = useState<number[]>([0, 0, 0, 0])
  const [intro, setIntro] = useState(true)
  const [introSkipped, setIntroSkipped] = useState(false)
  const [streakMonth, setStreakMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [celebrate, setCelebrate] = useState<RewardMilestone | null>(null)
  const [rewardBatch, setRewardBatch] = useState<RewardMilestone[] | null>(null)
  const [editStone, setEditStone] = useState<RewardMilestone | null>(null)
  const [pathKey, setPathKey] = useState(0)
  const [chartCol, setChartCol] = useState<string | undefined>(undefined)
  const [streakInfo, setStreakInfo] = useState(false)
  /** v1.11.17: earned-by-label parent groups — DEFAULT COLLAPSED, only ONE
   *  group open at a time (single key, like the Insights label panels) */
  const [earnOpenKey, setEarnOpenKey] = useState<string | null>(null)
  const kpiBandRef = useRef<HTMLDivElement>(null)

  // ---- intro: cinematic coin-drop plays IMMEDIATELY on every Coins visit.
  // Clicking it skips it instantly (KPI cards appear right away — they never
  // wait for the intro's natural end). ----
  useEffect(() => {
    void coins.refreshStats()
    void coins.refresh()
    void loadMs()
    void useData.getState().load() // pick up any direct-DB changes (streak calendar etc.)
    setIntro(true)
    setIntroSkipped(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // STREAK BONUSES (catch-up): run once the intro has dismissed (or been
  // skipped), so reward toasts are actually VISIBLE — fired during the 5.3s
  // intro they would expire unseen. All three IPCs are idempotent: a reward
  // already paid never pays twice.
  useEffect(() => {
    if (intro) return
    void window.api.coins.perfectMonth().then((r) => {
      if (r.award) {
        toasts.push({ message: `🗓️ Perfect month — +${r.amount} 🪙`, kind: 'info', duration: 5000 })
        void coins.refresh()
      }
    })
    void window.api.coins.perfectWeek().then((r) => {
      if (r.award) {
        toasts.push({ message: `🏆 Perfect week — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
        void coins.refresh()
      }
    })
    void window.api.coins.streakMilestone().then((r) => {
      if (r.award) {
        toasts.push({ message: `🎯 ${r.level}-day streak milestone — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
        void coins.refresh()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro])

  // ---- "Last 7 days" box width == KPI card width, EXACTLY (any machine) ----
  // Left panel now pins 3 KPI cards; the chart column matches one card exactly.
  useEffect(() => {
    const band = kpiBandRef.current
    if (!band) return
    const measure = () => {
      const w = band.getBoundingClientRect().width
      if (w <= 0) return
      const card = (w - 2 * 10) / 3 // 3 cards, 10px gaps — mirrors the CSS
      setChartCol(`${Math.round(card * 100) / 100}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(band)
    return () => ro.disconnect()
  }, [])

  // ---- dice: left → right cascade every 5s ----
  const statsKey = `${coins.balance}|${coins.stats?.today ?? 0}|${coins.stats?.series.length ?? 0}|${coins.txs.length}`
  useEffect(() => {
    if (intro) return
    const roll = () => {
      for (let k = 0; k < 4; k++) {
        window.setTimeout(() => {
          setFaces((f) => ({ ...f, [k]: ((f[k] ?? 0) + 1) % 2 }))
        }, k * 150)
      }
    }
    const first = window.setTimeout(roll, 1500)
    const id = window.setInterval(roll, 5000)
    // v1.11.7: pause the dice when the tab is hidden (saves CPU)
    const onVis = () => {
      if (document.hidden) {
        window.clearInterval(id)
      } else {
        // restart on return
        window.clearInterval(id)
        const id2 = window.setInterval(roll, 5000)
        ;(window as unknown as { __rhythmDice?: number }).__rhythmDice = id2
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [statsKey, intro])

  // ---- derived stats ----
  const totals = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const localOf = (iso: string) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    const today = localOf(new Date().toISOString())
    let earned = 0
    let redeemed = 0
    let todayEarn = 0
    let todaySpend = 0
    for (const t of coins.txs) {
      const isToday = localOf(t.ts) === today
      if (t.type === 'earn' || t.type === 'bonus') {
        earned += t.amount
        if (isToday) todayEarn += t.amount
      } else if (t.type === 'refund') {
        // refunds reduce both total and today's earning
        earned -= t.amount
        if (isToday) todayEarn -= t.amount
      } else if (t.type === 'spend') {
        redeemed += t.amount
        if (isToday) todaySpend += t.amount
      }
    }
    return { earned, redeemed, todayEarn, todaySpend }
  }, [coins.txs])

  // Balance recomputed from the visible ledger — the milestone path can never
  // disagree with the KPI cards, even if a refresh race left the chip stale.
  const derivedBalance = useMemo(
    () => coins.txs.reduce((s, t) => s + (t.type === 'spend' || t.type === 'refund' ? -t.amount : t.amount), 0),
    [coins.txs]
  )

  const bestStreak = useCoins((s) => s.bestStreak) as unknown as number

  /** v1.11.16: earned-by-label grouped under PARENT labels (parent's own part
   *  + children) so the panel gets expand/collapse toggles like the Insights
   *  label panels. 'No label' and 'Rewards 🏆' stay top-level rows. */
  const earnGroups = useMemo(() => {
    const pl = coins.stats?.perLabel ?? []
    type Row = (typeof pl)[number]
    interface G {
      key: string
      name: string
      amount: number
      own: Row | null
      children: Row[]
    }
    const groups = new Map<string, G>()
    const order: string[] = []
    const get = (key: string, name: string): G => {
      let g = groups.get(key)
      if (!g) {
        g = { key, name, amount: 0, own: null, children: [] }
        groups.set(key, g)
        order.push(key)
      }
      return g
    }
    for (const r of pl) {
      if (r.labelId === '__rewards__' || r.labelId === null) {
        // top-level rows: Rewards 🏆 and 'No label'
        get(r.labelId ?? '__none__', r.labelName).own = r
        get(r.labelId ?? '__none__', r.labelName).amount += r.amount
      } else if (r.parentId) {
        const g = get(r.parentId, r.parentName ?? r.labelName)
        g.children.push(r)
        g.amount += r.amount
      } else {
        // a top-level label with its own earnings
        const g = get(r.labelId, r.labelName)
        g.own = r
        g.amount += r.amount
      }
    }
    const out = order.map((k) => groups.get(k)!)
    for (const g of out) g.children.sort((a, b) => b.amount - a.amount)
    out.sort((a, b) => b.amount - a.amount)
    return out
  }, [coins.stats])

  // ---- streak calendar: full history, week start follows Settings ----
  const cal = useMemo(() => {
    const today = startOfDay(new Date())
    // FULL-HISTORY window: from the MONDAY of the earliest event (clamped to
    // the last 1999 days) to today+1 — the streak calendar is ALWAYS Mon–Sun
    let rawStart = addDays(today, -1999)
    for (const e of events) {
      const t = parseLocal(e.startLocal)
      if (t.getTime() < rawStart.getTime()) rawStart = startOfDay(t)
    }
    const rawDow = rawStart.getDay()
    const gridStart = addDays(rawStart, rawDow === 0 ? -6 : 1 - rawDow) // Monday
    const raw = new Map<string, { planned: number; done: number }>()
    const occs = computeOccurrences(events, gridStart, addDays(today, 1))
    for (const o of occs) {
      const d = isoDate(o.start)
      const cur = raw.get(d) ?? { planned: 0, done: 0 }
      cur.planned++
      if (o.event.status === 'done') cur.done++
      raw.set(d, cur)
    }
    const dayMap = new Map<string, 'done' | 'missed' | 'none'>()
    for (const [iso, info] of raw) dayMap.set(iso, info.done > 0 ? 'done' : info.planned > 0 ? 'missed' : 'none')
    const cells: Array<{ date: string; planned: number; done: number; future: boolean }> = []
    for (let d = gridStart; d.getTime() <= today.getTime(); d = addDays(d, 1)) {
      const iso = isoDate(d)
      const info = raw.get(iso)
      cells.push({ date: iso, planned: info?.planned ?? 0, done: info?.done ?? 0, future: false })
    }
    // current streak (done days count, no-event days skip, missed breaks;
    // TODAY with pending plans is a grace day and never breaks the streak)
    let streak = 0
    for (let i = 0; i < 2000; i++) {
      const d = isoDate(addDays(today, -i))
      const info = raw.get(d)
      if (info && info.done > 0) {
        streak++
        continue
      }
      if (info && info.planned > 0 && i > 0) break
    }
    // PERFECT WEEKS (cup 5): every Mon–Sun row in the window. A week earns the
    // FULL golden border only once it has ENDED (Sunday <= today) — the
    // in-progress week must never wear it early, even when its future days
    // happen to be empty. While the streak is ALIVE today, the current week
    // instead gets the partial cover Mon..today (v1.10.6).
    const perfectWeeks = new Set<string>()
    let coverUpTo: string | null = null
    const todayIso = isoDate(today)
    for (let rowStart = gridStart; rowStart.getTime() <= today.getTime(); rowStart = addDays(rowStart, 7)) {
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const iso = isoDate(addDays(rowStart, i))
        const info = raw.get(iso)
        return { planned: info?.planned ?? 0, done: info?.done ?? 0 }
      })
      const rowStartIso = isoDate(rowStart)
      const wkEnd = isoDate(addDays(rowStart, 6))
      const completed = wkEnd <= todayIso
      if (perfectWeekCheck(days) && completed) {
        perfectWeeks.add(rowStartIso)
      } else if (streak > 0 && !completed && todayIso >= rowStartIso && todayIso <= wkEnd) {
        // CURRENT week (in progress) with the streak alive: the golden cover
        // runs week-start..today only — every day up to today must be
        // resolved (rest day or >=1 done) with >=1 planned day in the range.
        let okUpToToday = true
        let plannedUpTo = false
        for (let i = 0; i < 7; i++) {
          const iso = isoDate(addDays(rowStart, i))
          if (iso > todayIso) break
          const info = raw.get(iso)
          if (info && info.planned > 0) {
            plannedUpTo = true
            if (info.done === 0) {
              okUpToToday = false
              break
            }
          }
        }
        if (okUpToToday && plannedUpTo) coverUpTo = todayIso
      }
    }
    // PERFECT MONTHS (v1.10.5): every day of the month is a rest day or has
    // >=1 done, AND no block of 7+ consecutive no-event days exists
    const perfectMonths = new Set<string>()
    const m0 = new Date(gridStart.getFullYear(), gridStart.getMonth(), 1)
    for (let m = m0; m.getTime() <= today.getTime(); m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const start = isoDate(m)
      const end = isoDate(new Date(m.getFullYear(), m.getMonth() + 1, 0))
      const dayOf = (iso: string) => {
        const info = raw.get(iso)
        return { planned: info?.planned ?? 0, done: info?.done ?? 0 }
      }
      if (perfectMonthCheck(start, end, dayOf)) perfectMonths.add(start.slice(0, 7))
    }
    return { cells, streak, dayMap, perfectWeeks, perfectMonths, coverUpTo }
  }, [events])

  // ---- best streak: current > stored → persist (fixes "best shows 0d") ----
  useEffect(() => {
    void useCoins.getState().updateBestStreak(cal.streak)
  }, [cal.streak])

  // STREAK-GOAL REWARDS (v1.10.5): whenever the visible streak changes, run
  // the bonus checks so perfect-week/month + streak-milestone coins land in
  // the ledger + toaster immediately — even without a save/relaunch.
  useEffect(() => {
    if (intro || !cal.streak) return
    void window.api.coins.perfectWeek().then((r) => {
      if (r.award) {
        toasts.push({ message: `🏆 Perfect week — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
        void coins.refresh()
      }
    })
    void window.api.coins.perfectMonth().then((r) => {
      if (r.award) {
        toasts.push({ message: `🗓️ Perfect month — +${r.amount} 🪙`, kind: 'info', duration: 5000 })
        void coins.refresh()
      }
    })
    void window.api.coins.streakMilestone().then((r) => {
      if (r.award) {
        toasts.push({ message: `🎯 ${r.level}-day streak milestone — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
        void coins.refresh()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal.streak])

  // ---- reward-time popup: set rewards BEFORE a level is reached.
  // Rule: ask for every level in the VISIBLE path (reached levels that still
  // have no reward text + the ONE upcoming level) — so Level 1's reward is
  // asked on the very first open (before hitting it), Level 2's when Level 1
  // is hit, and if 2-3 levels get hit at once, the hit ones without rewards
  // and the upcoming one are all asked together in ONE popup.
  // A level is "answered" only when the user saved or skipped under this flow
  // (rewardAsked.<cost>); old-build keys never suppress the ask. ----
  useEffect(() => {
    if (!ms.loaded || intro) return
    if (rewardBatch) return
    if (!systemOn) return // cup 3: no reward prompts while the system is OFF
    void (async () => {
      const reachedCount = ms.list.reduce((acc, m) => (m.reached ? acc + 1 : acc), 0)
      const visibleCount = Math.max(1, reachedCount + 1) // reached + the next upcoming one
      const pending: RewardMilestone[] = []
      for (let i = 0; i < visibleCount; i++) {
        const m = ms.list[i]
        if (!m) continue
        const asked = await window.api.settings.get('rewardAsked.' + m.cost)
        if (asked) continue
        const rewardMissing = !m.notes || m.notes === 'Set your reward'
        if (rewardMissing) pending.push(m)
      }
      if (pending.length) setRewardBatch(pending)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms.list, ms.loaded, intro, derivedBalance])

  const saveRewards = async (notes: Record<string, string>) => {
    if (!rewardBatch) return
    for (const s of rewardBatch) {
      const n = (notes[s.id] ?? '').trim()
      if (n) await ms.update(s.id, { notes: n })
      await window.api.settings.set('stoneCrossed.' + s.cost, '1')
      await window.api.settings.set('rewardAsked.' + s.cost, '1')
    }
    toasts.push({
      message: rewardBatch.length === 1 ? 'Reward saved — enjoy it when you redeem! 🎁' : `${rewardBatch.length} rewards saved — enjoy them! 🎁`,
      kind: 'info',
      duration: 3500
    })
    setRewardBatch(null)
    // force a clean second layout pass 2-3ms after editing (fixes first-time
    // overlap; same as returning to the tab a second time, but instant)
    window.setTimeout(() => setPathKey((k) => k + 1), 3)
  }

  const skipRewards = async () => {
    if (!rewardBatch) return
    for (const s of rewardBatch) {
      await window.api.settings.set('stoneCrossed.' + s.cost, '1')
      await window.api.settings.set('rewardAsked.' + s.cost, '1')
    }
    setRewardBatch(null)
    window.setTimeout(() => setPathKey((k) => k + 1), 3)
  }

  const claim = async (m: RewardMilestone) => {
    const res = await ms.claim(m.id)
    await coins.refresh()
    if (res.ok) {
      setCelebrate(m)
      toasts.push({
        message: `Claimed "${m.name}" — ${fmtCoins(m.cost)} 🪙 spent. Enjoy!`,
        kind: 'info',
        duration: 6000,
        actionLabel: 'Undo',
        onAction: async () => {
          const u = await window.api.milestones.unclaim(m.id)
          if (u.ok) {
            await coins.refresh()
            void loadMs()
            toasts.push({ message: `"${m.name}" refunded — ${fmtCoins(m.cost)} 🪙 back`, kind: 'info', duration: 3500 })
          }
        }
      })
    } else {
      toasts.push({ message: `Not enough coins yet (need ${fmtCoins(m.cost)})`, kind: 'danger', duration: 3500 })
    }
  }

  const redeemCount = (name: string) => coins.txs.filter((t) => t.type === 'spend' && t.reason.includes('Milestone: ' + name)).length

  // ---- KPI dice faces ----
  const kpiFaces: Array<Array<{ label: string; value: string; icon: string; cls: string }>> = [
    [
      { label: 'Total Rhythm Coins', value: fmtCoins(coins.balance), icon: 'front', cls: 'blue' },
      { label: "Today's net", value: fmtCoins(coins.stats?.today ?? 0), icon: 'today', cls: 'blue' }
    ],
    [
      { label: 'Total earned', value: fmtCoins(totals.earned), icon: 'up', cls: 'green' },
      { label: "Today's earning", value: fmtCoins(totals.todayEarn), icon: 'today', cls: 'green' }
    ],
    [
      { label: 'Total redeemed', value: fmtCoins(totals.redeemed), icon: 'down', cls: 'red' },
      { label: "Today's redemption", value: fmtCoins(totals.todaySpend), icon: 'today', cls: 'red' }
    ],
    [
      { label: 'Current streak', value: `${cal.streak}d`, icon: 'fire', cls: 'gold' },
      { label: 'Best streak ever', value: `${bestStreak}d`, icon: 'trophy', cls: 'gold' }
    ]
  ]

  return (
    <div className={`coins-view${introSkipped ? ' intro-skipped' : ''}`}>
      {!systemOn && (
        <div className="coins-off-banner">
          🪙 <b>Rhythm Coins is off.</b> Click the <b>Rhythm Coins</b> pill in the header to turn it back on — your balance and progress are safe.
        </div>
      )}
      {intro && (
        <CoinIntro
          onDone={(skipped) => {
            setIntro(false)
            if (skipped) setIntroSkipped(true)
          }}
        />
      )}

      <div className="coins-layout">
        {/* ============ LEFT column: 3 KPI cards PINNED on top, panels scroll below ============ */}
        <div className="coins-col">
          <div className="coins-kpis left" ref={kpiBandRef}>
            {kpiFaces.slice(0, 3).map((arr, ci) => {
              const face = arr[faces[ci] ?? 0]
              return (
                <div key={ci} className={`coins-kpi ${face.cls}`} data-face={faces[ci] ?? 0}>
                  <div key={`${statsKey}-${faces[ci]}`} className="kpi-face">
                    <span className="kpi-coin">{face.icon === 'front' ? <Coin size={40} flip /> : face.icon === 'today' ? <Coin size={26} flip /> : <span className={`kpi-emoji${face.icon === 'today' ? ' sm' : ''}`}>{face.icon === 'up' ? '📈' : '📤'}</span>}</span>
                    <div>
                      <div className="coins-kpi-value">{face.value}</div>
                      <div className="coins-kpi-label">{face.label}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="coins-left">
          <div className="coins-charts" style={chartCol ? { gridTemplateColumns: `${chartCol} 1fr` } : undefined}>
            <div className="ins-panel">
              <div className="ins-panel-title">Last 7 days</div>
              <svg className="chart-svg chart-stretch" viewBox="0 0 260 130" width="100%" height="150">
                {coins.stats?.series.map((d, i) => {
                  const maxDay = Math.max(1, ...(coins.stats?.series.map((x) => Math.abs(x.amount)) ?? [0]))
                  const hh = (Math.abs(d.amount) / maxDay) * 96
                  const hot = d.date === (coins.stats?.series[coins.stats.series.length - 1]?.date ?? '')
                  return (
                    <g key={d.date}>
                      <rect x={i * 36 + 8} y={104 - hh} width={20} height={hh} rx={3}
                        fill={d.amount >= 0 ? (hot ? 'var(--amber)' : 'var(--green)') : 'var(--red)'} opacity={hot ? 1 : 0.75}>
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
              {earnGroups.length === 0 ? (
                <div className="ins-empty">No coins earned yet</div>
              ) : (
                <div className="earn-groups">
                  {earnGroups.map((g) => {
                    const hasKids = g.children.length > 0
                    const open = earnOpenKey === g.key
                    const maxAmt = Math.max(1, earnGroups[0]?.amount ?? 1)
                    return (
                      <div key={g.key} className="earn-group">
                        <button
                          className={`ins-progress${hasKids ? ' expandable' : ''}${open ? ' open' : ''}`}
                          onClick={() => hasKids && setEarnOpenKey(open ? null : g.key)}
                          title={hasKids ? (open ? 'Collapse' : 'Expand') : undefined}
                        >
                          <span className="ins-progress-name">{g.name}</span>
                          <div className="ins-progress-track">
                            <div className="ins-progress-done" style={{ width: `${(g.amount / maxAmt) * 100}%`, background: 'var(--amber)' }} />
                          </div>
                          <span className="ins-progress-val">{fmtCoins(g.amount)} 🪙</span>
                          {hasKids && <span className="ins-caret">{open ? '▾' : '▸'}</span>}
                        </button>
                        {hasKids && open && (
                          <div className="earn-kids">
                            {g.children.map((c) => (
                              <div key={c.labelId} className="ins-progress sub">
                                <span className="ins-progress-name">{c.labelName}</span>
                                <div className="ins-progress-track">
                                  <div className="ins-progress-done" style={{ width: `${(c.amount / maxAmt) * 100}%`, background: 'var(--amber)' }} />
                                </div>
                                <span className="ins-progress-val">{fmtCoins(c.amount)} 🪙</span>
                              </div>
                            ))}
                            {g.own && g.children.length > 0 && (
                              <div className="ins-progress sub">
                                <span className="ins-progress-name">↳ Own (no sub-label)</span>
                                <div className="ins-progress-track">
                                  <div className="ins-progress-done" style={{ width: `${(g.own.amount / maxAmt) * 100}%`, background: 'var(--amber)' }} />
                                </div>
                                <span className="ins-progress-val">{fmtCoins(g.own.amount)} 🪙</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">
              Ledger
              {coins.txs.length > 0 && <span className="ledger-count">{coins.txs.length} entries</span>}
            </div>
            {coins.txs.length === 0 ? (
              <div className="ins-empty">No transactions yet</div>
            ) : (
              <div className="ledger">
                {coins.txs.map((t) => (
                  <div key={t.id} className={`ledger-row ${t.type}`}>
                    <span className="ledger-date">{t.ts.slice(0, 10)}</span>
                    <span className="ledger-reason">{t.reason}</span>
                    <span className="ledger-amount">{t.type === 'spend' || t.type === 'refund' ? '−' : '+'}{fmtCoins(t.amount)} 🪙</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>
          </div>

        {/* ============ RIGHT column: streak KPI PINNED on top, panels scroll below ============ */}
        <div className="coins-col">
          <div className="coins-kpis right">
            {(() => {
              const arr = kpiFaces[3]
              const face = arr[faces[3] ?? 0]
              return (
                <div className={`coins-kpi ${face.cls} streak-kpi`} data-face={faces[3] ?? 0}>
                  <div key={`${statsKey}-${faces[3]}`} className="kpi-face">
                    <span className="kpi-coin"><span className="kpi-emoji">{face.icon === 'fire' ? '🔥' : '🏆'}</span></span>
                    <div>
                      <div className="coins-kpi-value">{face.value}</div>
                      <div className="coins-kpi-label">{face.label}</div>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>

          <div className="coins-right">
          <div className="ins-panel">
            <div className="ins-panel-title streak-title-row">
              <span>Streak calendar</span>
              <button
                type="button"
                className="streak-info-btn"
                title="What the colours mean"
                aria-label="What the colours mean"
                onClick={() => setStreakInfo((o) => !o)}
              >
                ℹ️
              </button>
              {streakInfo && (
                <div className="streak-info-pop">
                  <span><i className="sl done" /> done</span>
                  <span><i className="sl none" /> no events (streak continues)</span>
                  <span><i className="sl missed" /> missed (streak ends)</span>
                  <span><i className="sl perfect-wk" /> perfect week</span>
                  <span><i className="sl perfect-up" /> perfect so far</span>
                  <span><i className="sl perfect-m" /> perfect month</span>
                </div>
              )}
            </div>
            <StreakMonth
              month={streakMonth}
              onMonth={(m) => setStreakMonth(m)}
              dayMap={cal.dayMap}
              perfectWeeks={cal.perfectWeeks}
              perfectMonth={cal.perfectMonths.has(String(streakMonth.getFullYear()) + '-' + String(streakMonth.getMonth() + 1).padStart(2, '0')) ? String(streakMonth.getFullYear()) + '-' + String(streakMonth.getMonth() + 1).padStart(2, '0') : null}
              coverUpTo={cal.coverUpTo}
            />
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">Streak goal</div>
            <StreakGoalWindow streak={cal.streak} />
          </div>

          <div className="ins-panel">
            <div className="ins-panel-title">Milestone path</div>
            <div className="mile-path" key={pathKey}>
              {(() => {
                // STICKY REACH: a stone is REACHED once its cost was ever met
                // (persisted by the main process as `reached`), so a box NEVER
                // disappears when the net drops. Start = Level 1 only; each
                // reached stone stacks the next; if multiple stones are hit,
                // all of them stay present. Claiming is NOT required.
                const reachedCount = ms.list.reduce((acc, m) => (m.reached ? acc + 1 : acc), 0)
                const visible = ms.list.slice(0, Math.max(1, reachedCount + 1))
                // Stack: descending — highest level on TOP, Level 1 at the BOTTOM.
                const order = [...visible].reverse()
                return order.map((m, i) => {
                  // "crossed" = the net currently covers this stone (gold highlight + Claim afford)
                  const crossed = derivedBalance >= m.cost
                  const redeemed = redeemCount(m.name)
                  const first = m.achievedAt
                  const isNext = i === 0 && !m.reached
                  return (
                    <div key={m.id} className={`mile-stone${crossed ? ' crossed' : ''}${first ? ' first' : ''}${isNext ? ' next' : ''}`}>
                      {i > 0 && <div className="mile-link" />}
                      <div className="mile-stone-head">
                        <span className="mile-stone-icon">🎯</span>
                        <div className="mile-stone-info">
                          <div className="mile-stone-name">
                            {m.name}
                            <span className="mile-level">{m.cost} 🪙</span>
                          </div>
                          {m.notes ? (
                            <div className="mile-stone-notes">🎁 {m.notes}</div>
                          ) : (
                            <div className="mile-stone-notes hint">Set your reward</div>
                          )}
                          <div className="mile-stone-cost">
                            {first && <span className="redeem-gold">redeemed {redeemed}×</span>}
                          </div>
                        </div>
                        <div className="mile-stone-actions">
                          {crossed && !first && (
                            <button className="btn primary sm" onClick={() => void claim(m)}>Claim 🎉</button>
                          )}
                          {first && (
                            <button className="btn sm" onClick={() => void claim(m)}>Redeem</button>
                          )}
                          <button className="btn sm mile-edit" title="Edit reward" onClick={() => setEditStone(m)}>
                            ✎
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              })()}            <div className="mile-sub">Reach a stone to unlock its reward — redeemable again and again. 🎁</div>
          </div>
        </div>
      </div>

      {celebrate && <Celebration m={celebrate} onClose={() => setCelebrate(null)} />}
      {rewardBatch && <RewardBatchPrompt stones={rewardBatch} onSave={(n) => void saveRewards(n)} onSkip={() => void skipRewards()} />}
      {editStone && (
        <RewardDialog
          title={`Edit reward — ${editStone.name}`}
          initialNote={editStone.notes}
          onSave={async (note) => {
            await ms.update(editStone.id, { notes: note })
            window.setTimeout(() => setPathKey((k) => k + 1), 3)
            toasts.push({ message: 'Reward updated', kind: 'info', duration: 2500 })
            setEditStone(null)
          }}
          onClose={() => setEditStone(null)}
        />
      )}
      </div>
      </div>
    </div>
  )
}
