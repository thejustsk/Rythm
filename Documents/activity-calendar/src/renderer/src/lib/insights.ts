/**
 * Insights engine — pure, unit-tested. Turns events into pragmatic stats:
 * planned vs done, per-label rollup (children → parent), per-day, hour &
 * weekday distribution, streaks, heatmap, and a plain-language digest.
 */
import type { CalendarEvent, Label } from '@shared/types'
import { computeOccurrences } from '@/engine/occurrences'
import { addDays, startOfDay, isoDate } from '@/engine/recurrence'

export interface LabelStat {
  id: string | null
  name: string
  color: string
  plannedMin: number
  doneMin: number
  count: number
  completion: number // 0-100
}

export interface DayStat {
  date: string
  plannedMin: number
  doneMin: number
}

export interface Insights {
  plannedMin: number
  doneMin: number
  count: number
  doneCount: number
  completion: number // 0-100
  perLabel: LabelStat[]
  perDay: DayStat[]
  hourDist: number[] // 24 entries
  weekdayDist: number[] // 7 entries (Sun..Sat)
  heatmap: Array<{ date: string; min: number }>
  streak: number
  bestDay: string | null
  bestDayMin: number
  busiestHour: number
  digest: string[]
}

const pad2 = (n: number) => String(n).padStart(2, '0')
export const isoD = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 137 minutes → "2h 17m", 45 → "45m", 120 → "2h" */
export function fmtH(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function computeInsights(
  events: CalendarEvent[],
  labels: Label[],
  hidden: Set<string>,
  rangeStart: Date,
  rangeEnd: Date
): Insights {
  const occs = computeOccurrences(events, rangeStart, rangeEnd)

  const perDay = new Map<string, DayStat>()
  const hourDist = new Array(24).fill(0) as number[]
  const weekdayDist = new Array(7).fill(0) as number[]
  const labelMin = new Map<string, { planned: number; done: number; count: number }>()
  let unlabelled = { planned: 0, done: 0, count: 0 }
  let plannedMin = 0
  let doneMin = 0
  let count = 0
  let doneCount = 0

  for (const o of occs) {
    if (o.event.status === 'cancelled') continue
    const durMin = (o.end.getTime() - o.start.getTime()) / 60000
    const day = isoD(o.start)
    const ds = perDay.get(day) ?? { date: day, plannedMin: 0, doneMin: 0 }
    ds.plannedMin += durMin
    if (o.event.status === 'done') ds.doneMin += durMin
    perDay.set(day, ds)

    plannedMin += durMin
    count++
    hourDist[o.start.getHours()] += durMin
    weekdayDist[o.start.getDay()] += durMin
    if (o.event.status === 'done') {
      doneMin += durMin
      doneCount++
    }

    // roll labels up to their top-level parent
    let top: Label | null = null
    if (o.event.labelId) {
      const l = labels.find((x) => x.id === o.event.labelId)
      if (l) top = l.parentId ? labels.find((x) => x.id === l.parentId) ?? l : l
    }
    if (top && !hidden.has(top.id)) {
      const st = labelMin.get(top.id) ?? { planned: 0, done: 0, count: 0 }
      st.planned += durMin
      if (o.event.status === 'done') st.done += durMin
      st.count++
      labelMin.set(top.id, st)
    } else if (!top && !hidden.has('__unlabelled__')) {
      unlabelled.planned += durMin
      if (o.event.status === 'done') unlabelled.done += durMin
      unlabelled.count++
    }
  }

  const completion = plannedMin > 0 ? Math.round((doneMin / plannedMin) * 100) : 0

  const perLabel: LabelStat[] = []
  for (const l of labels.filter((x) => !x.parentId)) {
    const st = labelMin.get(l.id)
    if (st && st.planned > 0) {
      perLabel.push({
        id: l.id,
        name: l.name,
        color: l.color ?? '#8E8E93',
        plannedMin: st.planned,
        doneMin: st.done,
        count: st.count,
        completion: st.planned > 0 ? Math.round((st.done / st.planned) * 100) : 0
      })
    }
  }
  if (unlabelled.planned > 0) {
    perLabel.push({
      id: null,
      name: 'Unlabelled',
      color: '#8E8E93',
      plannedMin: unlabelled.planned,
      doneMin: unlabelled.done,
      count: unlabelled.count,
      completion: unlabelled.planned > 0 ? Math.round((unlabelled.done / unlabelled.planned) * 100) : 0
    })
  }
  perLabel.sort((a, b) => b.plannedMin - a.plannedMin)

  const daysArr = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date))

  // completion streak: consecutive days (ending today, or yesterday if today
  // has no completions yet) with at least one done activity
  const today = startOfDay(new Date())
  const todayDone = (perDay.get(isoD(today))?.doneMin ?? 0) > 0
  let streak = 0
  for (let i = todayDone ? 0 : 1; i < 400; i++) {
    const ds = perDay.get(isoD(addDays(today, -i)))
    if (ds && ds.doneMin > 0) streak++
    else break
  }

  let bestDay: string | null = null
  let bestDayMin = 0
  for (const ds of daysArr) {
    if (ds.plannedMin > bestDayMin) {
      bestDayMin = ds.plannedMin
      bestDay = ds.date
    }
  }

  let busiestHour = 0
  let busiestHourMin = 0
  for (let h = 0; h < 24; h++) {
    if (hourDist[h] > busiestHourMin) {
      busiestHourMin = hourDist[h]
      busiestHour = h
    }
  }

  // last 16 weeks, ending today — for the GitHub-style heatmap
  const heatmap: Array<{ date: string; min: number }> = []
  for (let i = 111; i >= 0; i--) {
    const day = addDays(today, -i)
    heatmap.push({ date: isoD(day), min: perDay.get(isoD(day))?.plannedMin ?? 0 })
  }

  // ---- plain-language digest ("different vernaculars") ----
  const digest: string[] = []
  if (count === 0) {
    digest.push('No activities in this period yet — add a few blocks and the insights light up.')
  } else {
    digest.push(`You planned ${fmtH(plannedMin)} across ${count} activities.`)
    if (doneCount > 0) {
      digest.push(`${doneCount} completed (${fmtH(doneMin)}) — ${completion}% of your plan.`)
    } else {
      digest.push('Nothing completed yet in this period — mark a block Done to start your streak.')
    }
    if (perLabel[0]) {
      digest.push(`Biggest time investment: ${perLabel[0].name} (${fmtH(perLabel[0].plannedMin)}, ${perLabel[0].completion}% done).`)
    }
    if (bestDay) {
      const bd = new Date(bestDay + 'T00:00:00')
      digest.push(
        `Most packed day: ${bd.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} with ${fmtH(bestDayMin)} planned.`
      )
    }
    if (busiestHourMin > 0) {
      digest.push(
        `You're most active around ${String(busiestHour).padStart(2, '0')}:00–${String((busiestHour + 1) % 24).padStart(2, '0')}:00.`
      )
    }
    if (streak > 0) {
      digest.push(`Completion streak: ${streak} day${streak > 1 ? 's' : ''} — keep it going!`)
    }
    const low = perLabel.filter((p) => p.plannedMin >= 60 && p.completion < 50)
    if (low[0]) {
      digest.push(`${low[0].name} completion is low (${low[0].completion}%) — try smaller, more realistic blocks.`)
    }
    const high = perLabel.find((p) => p.plannedMin >= 60 && p.completion >= 90)
    if (high) {
      digest.push(`${high.name} is crushing it (${high.completion}% done) — this rhythm works.`)
    }
  }

  return {
    plannedMin,
    doneMin,
    count,
    doneCount,
    completion,
    perLabel,
    perDay: daysArr,
    hourDist,
    weekdayDist,
    heatmap,
    streak,
    bestDay,
    bestDayMin,
    busiestHour,
    digest
  }
}
