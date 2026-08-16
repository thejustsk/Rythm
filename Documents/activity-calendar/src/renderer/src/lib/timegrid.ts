/** Time-grid math: positions, snapping, overlap column layout. */

export const DAY_MINUTES = 24 * 60

/** Base pixel height per minute in the week/day grid. */
export const BASE_PX_PER_MIN = 0.55

/** v1.11.14: live grid zoom (Ctrl+P). Mutated via setGridZoom; every importer
 *  sees the new value (ES module live binding). */
export let PX_PER_MIN = BASE_PX_PER_MIN
export function setGridZoom(z: number): void {
  PX_PER_MIN = Math.round(BASE_PX_PER_MIN * z * 1000) / 1000
}

export function toMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** Round to the nearest 15 minutes, never negative. */
export function snap15(mins: number): number {
  return Math.max(0, Math.round(mins / 15) * 15)
}

export function minutesToHM(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export interface Box {
  top: number
  height: number
}

/** Whole calendar days between two local dates (a ≤ b normally). */
export function daysBetween(a: Date, b: Date): number {
  const A = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const B = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((B - A) / 86400000)
}

/** End minute count including overflow into later days (overnight/multi-day events). */
export function toAbsEndMin(start: Date, end: Date): number {
  return toMinutes(end) + 1440 * daysBetween(start, end)
}

/** Minutes of [start,end] that actually fall inside `day` (local) — multi-day events
 *  contribute only their today-part (used by the sidebar "Today" card). */
export function minutesOnDay(start: Date, end: Date, day: Date): number {
  const ds = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const de = ds + 86400000
  const s = Math.max(start.getTime(), ds)
  const e = Math.min(end.getTime(), de)
  return Math.max(0, (e - s) / 60000)
}

/** Minutes of `t` relative to `day` midnight — can be NEGATIVE (t before day) or > 1440 (after). */
export function relMinFrom(day: Date, t: Date): number {
  const mid = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  return Math.round((t.getTime() - mid) / 60000)
}

/** Snap to 15 min allowing negatives (used when a grabbed chunk starts before its day). */
export function snap15Rel(mins: number): number {
  return Math.round(mins / 15) * 15
}

/** Clamped start/end minutes of an occurrence within ONE day column. */
export function dayRelMins(day: Date, start: Date, end: Date): { startMin: number; endMin: number } {
  const s = Math.max(relMinFrom(day, start), 0)
  const e = Math.min(relMinFrom(day, end), DAY_MINUTES)
  return { startMin: s, endMin: Math.max(e, s + 1) }
}

/** Absolute minutes (relative to `day` midnight) → 'YYYY-MM-DDTHH:MM', day-shifted as needed. */
export function localFromDayMinutes(day: Date, mins: number): string {
  const d = new Date(day)
  d.setDate(d.getDate() + Math.floor(mins / 1440))
  const m = ((mins % 1440) + 1440) % 1440
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${minutesToHM(m)}`
}

/** Pixel box of an occurrence within ONE specific day column (handles overnight/multi-day spans). */
export function blockBoxForDay(occStart: Date, occEnd: Date, day: Date, pxPerMin: number): Box {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const dayEnd = dayStart + 86400000
  const s = Math.max(occStart.getTime(), dayStart)
  const e = Math.min(occEnd.getTime(), dayEnd)
  if (e <= s) return { top: 0, height: 10 }
  const round2 = (n: number) => Math.round(n * 100) / 100
  return { top: round2(((s - dayStart) / 60000) * pxPerMin), height: Math.max(round2(((e - s) / 60000) * pxPerMin), 10) }
}

/** Pixel box of a block within a day column (clamped to the visible day). */
export function blockBox(
  startMin: number,
  endMin: number,
  pxPerMin: number,
  dayStartMin = 0,
  dayEndMin = DAY_MINUTES
): Box {
  const s = Math.max(startMin, dayStartMin)
  const e = Math.min(endMin, dayEndMin)
  const round2 = (n: number) => Math.round(n * 100) / 100
  const height = Math.max(round2((e - s) * pxPerMin), 10)
  return { top: round2((s - dayStartMin) * pxPerMin), height }
}

export interface LayoutItem<T> {
  item: T
  startMin: number
  endMin: number
}

/** Assign overlapping items to side-by-side columns (classic calendar algorithm). */
export function layoutColumns<T>(items: Array<LayoutItem<T>>): Map<T, { col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const colEnds: number[] = []
  const result = new Map<T, { col: number; cols: number }>()
  for (const it of sorted) {
    let col = colEnds.findIndex((end) => end <= it.startMin)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(0)
      // a new column opened: every overlapping block shares the wider layout
      for (const entry of result.values()) entry.cols = colEnds.length
    }
    colEnds[col] = it.endMin
    result.set(it.item, { col, cols: colEnds.length })
  }
  return result
}

/**
 * Split side-by-side only within connected clusters of overlapping items.
 * Non-overlapping items keep full width — the split never applies to the
 * whole day (issue: card-size split applied to all events of the day).
 */
export function layoutClusters<T>(items: Array<LayoutItem<T>>): Map<T, { col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const result = new Map<T, { col: number; cols: number }>()
  let cluster: Array<LayoutItem<T>> = []
  let clusterEnd = -Infinity
  const flush = () => {
    if (cluster.length === 0) return
    const m = layoutColumns(cluster)
    for (const [it, v] of m) result.set(it, v)
    cluster = []
  }
  for (const it of sorted) {
    // a new cluster starts when this item begins after everything in the current one ended
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.endMin)
  }
  flush()
  return result
}
