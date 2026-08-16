/**
 * Insights engine — pure, unit-tested. Turns events into pragmatic stats:
 * planned vs done, per-label rollup (children → parent, with the parent's own
 * part reported separately), per-day (split by calendar day so overnight
 * events count their share on each day), hour & weekday distribution, streaks
 * (skipping days with no planned events), heatmap, unique (overlap-corrected)
 * time, and a plain-language digest.
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
  /** true when this row represents the parent's own (non-sublabel) part */
  own?: boolean
}

export interface DayStat {
  date: string
  plannedMin: number
  doneMin: number
}

export interface Insights {
  plannedMin: number
  doneMin: number
  /** overlap-corrected unique busy time (union of intervals) */
  uniqueMin: number
  count: number
  doneCount: number
  todoCount: number
  doingCount: number
  cancelledCount: number
  todoMin: number
  doingMin: number
  cancelledMin: number
  completion: number // 0-100
  perLabel: LabelStat[]
  perDay: DayStat[]
  hourDist: number[] // 24 entries
  weekdayDist: number[] // 7 entries (Sun..Sat)
  heatmap: Array<{ date: string; min: number }>
  streak: number
  streakStart: string | null
  firstDone: string | null
  bestDay: string | null
  bestDayMin: number
  busiestHour: number
  digest: string[]
  /** sub-label stats keyed by top-level parent id (parents that have children,
   *  plus the parent's own part as a separate row when it has one) */
  childStats: Record<string, LabelStat[]>
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

/** Split an occurrence's duration across calendar days: [{date, min, startMin}]. */
function splitByDay(start: Date, end: Date): Array<{ date: string; min: number; startMin: number }> {
  const out: Array<{ date: string; min: number; startMin: number }> = []
  const startMs = start.getTime()
  const endMs = end.getTime()
  let cur = startMs
  let dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
  while (cur < endMs) {
    const dayEnd = dayStart + 86400000
    const segEnd = Math.min(endMs, dayEnd)
    const min = (segEnd - cur) / 60000
    if (min > 0) {
      const d = new Date(cur)
      out.push({ date: isoD(d), min, startMin: d.getHours() * 60 + d.getMinutes() })
    }
    cur = dayEnd
    dayStart = dayEnd
  }
  return out
}

export function computeInsights(
  events: CalendarEvent[],
  labels: Label[],
  hidden: Set<string>,
  rangeStart: Date,
  rangeEnd: Date,
  /** filter to one top-level label (its children included) — M7 item 7 */
  topLabelId: string | null = null,
  /** the selected period — the heatmap window follows it */
  period: string = 'week'
): Insights {
  const occs = computeOccurrences(events, rangeStart, rangeEnd)

  const perDay = new Map<string, DayStat>()
  const hourDist = new Array(24).fill(0) as number[]
  const weekdayDist = new Array(7).fill(0) as number[]
  const labelMin = new Map<string, { planned: number; done: number; count: number }>()
  const childAcc = new Map<string, Map<string, { planned: number; done: number; count: number }>>()
  const ownAcc = new Map<string, { planned: number; done: number; count: number }>()
  let unlabelled = { planned: 0, done: 0, count: 0 }
  let plannedMin = 0
  let doneMin = 0
  let count = 0
  let doneCount = 0
  let todoCount = 0
  let doingCount = 0
  let cancelledCount = 0
  let todoMin = 0
  let doingMin = 0
  let cancelledMin = 0

  for (const o of occs) {
    const durMin = (o.end.getTime() - o.start.getTime()) / 60000
    // roll labels up to their top-level parent; also collect child-level stats
    let top: Label | null = null
    let child: Label | null = null
    if (o.event.labelId) {
      const l = labels.find((x) => x.id === o.event.labelId)
      if (l) {
        top = l.parentId ? labels.find((x) => x.id === l.parentId) ?? l : l
        child = l.parentId ? l : null
      }
    }
    if (topLabelId && (top?.id ?? null) !== topLabelId) continue

    if (o.event.status === 'cancelled') {
      cancelledCount++
      cancelledMin += durMin
      // cancelled events are counted for the status faces but excluded from
      // planned time and label rollups
      continue
    }

    // status buckets
    if (o.event.status === 'done') {
      doneMin += durMin
      doneCount++
    } else if (o.event.status === 'doing') {
      doingMin += durMin
      doingCount++
    } else {
      todoMin += durMin
      todoCount++
    }
    plannedMin += durMin
    count++

    // per-day split: an overnight event contributes its share to each day
    const parts = splitByDay(o.start, o.end)
    for (const p of parts) {
      const ds = perDay.get(p.date) ?? { date: p.date, plannedMin: 0, doneMin: 0 }
      ds.plannedMin += p.min
      if (o.event.status === 'done') ds.doneMin += p.min
      perDay.set(p.date, ds)
      weekdayDist[new Date(p.date + 'T00:00:00').getDay()] += p.min
      // hour distribution: attribute each minute to its actual hour
      let curMin = p.startMin
      let remaining = p.min
      while (remaining > 0) {
        const hour = Math.floor(curMin / 60) % 24
        const nextHourStart = (Math.floor(curMin / 60) + 1) * 60
        const inHour = Math.min(remaining, nextHourStart - curMin)
        hourDist[hour] += inHour
        remaining -= inHour
        curMin = nextHourStart
      }
    }

    // label rollups (full duration attributed to the label)
    if (child && top) {
      let m = childAcc.get(top.id)
      if (!m) {
        m = new Map()
        childAcc.set(top.id, m)
      }
      const cs = m.get(child.id) ?? { planned: 0, done: 0, count: 0 }
      cs.planned += durMin
      if (o.event.status === 'done') cs.done += durMin
      cs.count++
      m.set(child.id, cs)
    } else if (top && !child) {
      // labelled directly with a top-level label → the parent's OWN part
      const own = ownAcc.get(top.id) ?? { planned: 0, done: 0, count: 0 }
      own.planned += durMin
      if (o.event.status === 'done') own.done += durMin
      own.count++
      ownAcc.set(top.id, own)
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

  // unique time: merge overlapping intervals so overlaps aren't double-counted
  let uniqueMin = 0
  {
    const ints = occs
      .filter((o) => o.event.status !== 'cancelled')
      .map((o) => [o.start.getTime(), o.end.getTime()])
      .sort((a, b) => a[0] - b[0])
    let curStart: number | null = null
    let curEnd = 0
    for (const [st, en] of ints) {
      if (curStart === null) {
        curStart = st
        curEnd = en
      } else if (st <= curEnd) {
        curEnd = Math.max(curEnd, en)
      } else {
        uniqueMin += (curEnd - curStart) / 60000
        curStart = st
        curEnd = en
      }
    }
    if (curStart !== null) uniqueMin += (curEnd - curStart) / 60000
  }

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

  // sub-label stats per parent (only parents that actually have children);
  // each parent's OWN (non-sublabel) part becomes a separate row
  const childStats: Record<string, LabelStat[]> = {}
  for (const [parentId, m] of childAcc) {
    const parent = labels.find((x) => x.id === parentId)
    const arr: LabelStat[] = []
    for (const [childId, st] of m) {
      const childL = labels.find((x) => x.id === childId)
      if (!childL) continue
      arr.push({
        id: childId,
        name: childL.name,
        color: childL.color ?? parent?.color ?? '#8E8E93',
        plannedMin: st.planned,
        doneMin: st.done,
        count: st.count,
        completion: st.planned > 0 ? Math.round((st.done / st.planned) * 100) : 0
      })
    }
    const own = ownAcc.get(parentId)
    if (own && own.planned > 0) {
      arr.push({
        id: `${parentId}::own`,
        name: 'Own (no sub-label)',
        color: parent?.color ?? '#8E8E93',
        plannedMin: own.planned,
        doneMin: own.done,
        count: own.count,
        completion: own.planned > 0 ? Math.round((own.done / own.planned) * 100) : 0,
        own: true
      })
    }
    if (arr.length > 0) {
      arr.sort((a, b) => b.plannedMin - a.plannedMin)
      childStats[parentId] = arr
    }
  }

  const daysArr = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date))

  // ---- global pass (last 2000 days): streak (skips empty days), first done ----
  // v1.11.12: the streak is computed over ALL events (label filters must NOT
  // change the streak number) and matches the main streak rule: today is a
  // GRACE day (planned-but-not-done today does not break it), a PAST day with
  // planned-but-not-done does break it, empty days continue.
  const today = startOfDay(new Date())
  const gOccs = computeOccurrences(events, addDays(today, -2000), addDays(today, 1))
  const gDay = new Map<string, { planned: number; done: number }>()
  for (const o of gOccs) {
    const dur = (o.end.getTime() - o.start.getTime()) / 60000
    const day = isoD(o.start)
    const g = gDay.get(day) ?? { planned: 0, done: 0 }
    g.planned += dur
    if (o.event.status === 'done') g.done += dur
    gDay.set(day, g)
  }
  let streak = 0
  let streakStart: string | null = null
  for (let i = 0; i < 2000; i++) {
    const day = addDays(today, -i)
    const g = gDay.get(isoD(day))
    const p = (g?.planned ?? 0) > 0
    const d = (g?.done ?? 0) > 0
    if (d) {
      streak++
      streakStart = isoD(day)
      continue
    }
    if (p && i > 0) break // a PAST day planned but nothing done → broken
    // today with pending plans is a GRACE day (does not break); empty days continue
  }
  let firstDone: string | null = null
  for (const [date, g] of gDay) {
    if (g.done > 0 && (!firstDone || date < firstDone)) firstDone = date
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

  // activity heatmap: follows the SELECTED PERIOD (week → at least 16 weeks
  // back or the first completion; month/year/all/custom → exactly that window).
  // Respects the label filters (gDay above is already filtered).
  const monOf = (d: Date) => {
    const dow = d.getDay()
    return addDays(d, dow === 0 ? -6 : 1 - dow)
  }
  let heatStart: Date
  let heatEnd: Date = rangeEnd.getTime() > today.getTime() ? today : rangeEnd
  if (period !== 'week') {
    heatStart = monOf(rangeStart)
  } else {
    heatStart = addDays(monOf(today), -15 * 7) // ~16 weeks back, Monday-aligned
    // always AT LEAST 112 cells (16 full weeks) — extend by whole weeks
    while (Math.round((today.getTime() - heatStart.getTime()) / 86400000) + 1 < 112) {
      heatStart = addDays(heatStart, -7)
    }
    if (firstDone) {
      const fdMon = monOf(new Date(firstDone + 'T00:00:00'))
      if (fdMon.getTime() < heatStart.getTime()) heatStart = fdMon
    }
  }
  const heatmap: Array<{ date: string; min: number }> = []
  for (let d = heatStart; d.getTime() <= heatEnd.getTime(); d = addDays(d, 1)) {
    const iso = isoD(d)
    heatmap.push({ date: iso, min: gDay.get(iso)?.planned ?? 0 })
  }

  // ---- plain-language digest ("different vernaculars") ----
  const digest: string[] = []
  if (topLabelId) {
    const focusLabel = labels.find((l) => l.id === topLabelId)
    digest.push(`Showing insights for "${focusLabel?.name ?? 'this label'}" only.`)
  }
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
      const topL = perLabel[0]
      const kids = childStats[topL.id ?? ''] ?? []
      let partNote = ''
      if (kids.length > 0) {
        const biggest = kids.reduce((a, b) => (b.plannedMin > a.plannedMin ? b : a))
        partNote = ` — mostly ${biggest.name} (${fmtH(biggest.plannedMin)})`
      }
      digest.push(
        `Biggest time investment: ${topL.name} (${fmtH(topL.plannedMin)}, ${topL.completion}% done)${partNote}.`
      )
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
      const sd = streakStart ? new Date(streakStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
      digest.push(`Completion streak: ${streak} day${streak > 1 ? 's' : ''}${sd ? ` (started ${sd})` : ''} — keep it going!`)
    } else if (doneCount === 0 && count > 0) {
      digest.push('Mark a block Done today to start your first streak.')
    }
    const overlapPct = plannedMin > 0 ? Math.round((1 - uniqueMin / plannedMin) * 100) : 0
    if (overlapPct >= 10) {
      digest.push(
        `Some activities overlap — unique busy time is ${fmtH(uniqueMin)} (${overlapPct}% less than the raw sum).`
      )
    }
    const low = perLabel.filter((p) => p.plannedMin >= 60 && p.completion < 50)
    if (low[0]) {
      digest.push(`${low[0].name} completion is low (${low[0].completion}%) — try smaller, more realistic blocks.`)
    }
    const high = perLabel.find((p) => p.plannedMin >= 60 && p.completion >= 90)
    if (high) {
      digest.push(`${high.name} is crushing it (${high.completion}% done) — this rhythm works.`)
    }
    if (firstDone) {
      const fd = new Date(firstDone + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      digest.push(`First completion ever: ${fd}.`)
    }
  }

  return {
    plannedMin,
    doneMin,
    uniqueMin,
    count,
    doneCount,
    todoCount,
    doingCount,
    cancelledCount,
    todoMin,
    doingMin,
    cancelledMin,
    completion,
    perLabel,
    perDay: daysArr,
    hourDist,
    weekdayDist,
    heatmap,
    streak,
    streakStart,
    firstDone,
    bestDay,
    bestDayMin,
    busiestHour,
    digest,
    childStats
  }
}
