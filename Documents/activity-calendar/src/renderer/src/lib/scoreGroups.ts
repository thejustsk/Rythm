/** v1.11.16/17: group the on-time/late/off-schedule per-label rows under their
 *  PARENT labels (parent's own part + children), so the Insights panel can
 *  render them with expand/collapse toggles. Pure + unit-tested. */
export interface ScoreRow {
  labelId: string | null
  name: string
  parentId: string | null
  parentName: string | null
  /** label colour (child's own, falling back to its parent's) — used to
   *  colour the row names like the Label completion panel */
  color?: string | null
  on_time: number
  late: number
  off_schedule: number
  total: number
}

export interface ScoreGroup {
  key: string
  name: string
  color: string | null
  /** the parent's OWN row (events labelled directly with the parent label,
   *  or the "No label" bucket) — null when the group is children-only */
  own: ScoreRow | null
  children: ScoreRow[]
  on_time: number
  late: number
  off_schedule: number
  total: number
}

export function groupScores(rows: ScoreRow[]): ScoreGroup[] {
  const groups = new Map<string, ScoreGroup>()
  const order: string[] = []
  const keyOf = (r: ScoreRow) => r.parentId ?? r.labelId ?? '__none__'

  for (const r of rows) {
    const key = keyOf(r)
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        name: r.parentId ? (r.parentName ?? r.name) : r.name,
        color: null,
        own: null,
        children: [],
        on_time: 0,
        late: 0,
        off_schedule: 0,
        total: 0
      }
      groups.set(key, g)
      order.push(key)
    }
    if (r.parentId) g.children.push(r)
    else g.own = r
    if (r.color && !g.color) g.color = r.color
    g.on_time += r.on_time
    g.late += r.late
    g.off_schedule += r.off_schedule
    g.total += r.total
  }

  const out = order.map((k) => groups.get(k)!)
  for (const g of out) {
    g.children.sort((a, b) => b.total - a.total)
  }
  out.sort((a, b) => b.total - a.total)
  return out
}
