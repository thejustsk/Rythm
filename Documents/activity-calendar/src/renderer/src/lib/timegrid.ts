/** Time-grid math: positions, snapping, overlap column layout. */

export const DAY_MINUTES = 24 * 60

/** Pixel height per minute in the week/day grid. */
export const PX_PER_MIN = 0.55

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
