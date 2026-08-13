/**
 * Clock formatting (item B.4 — 12/24h setting). 24h keeps the original
 * "HH:mm" behaviour; 12h renders "9:05 AM" style.
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

export function fmtClock(d: Date, clock24: boolean): string {
  if (clock24) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${pad2(d.getMinutes())} ${ampm}`
}

/** Week/day grid hour label: "09:00" (24h) or "9 AM" (12h). */
export function fmtHourLabel(h: number, clock24: boolean): string {
  if (clock24) return `${pad2(h)}:00`
  let hh = h % 12
  if (hh === 0) hh = 12
  return `${hh} ${h >= 12 ? 'PM' : 'AM'}`
}

/** Settings row value for a time input: always 24h "HH:mm". */
export function toInputValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
