/**
 * Quick status cycling from the block's status dot (user feature):
 *   todo → doing → done → todo   (cancelled is NOT clickable)
 * Status always applies to THIS occurrence only (override rows are used for
 * recurring events, exactly like drag-move / single-occurrence edits).
 */
import type { CalendarEvent, EventInput, EventStatus } from '@shared/types'
import type { Occurrence } from '@/engine/occurrences'
import { useData, useUi } from '@/state/store'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'

/** Pure cycle: todo → doing → done → todo. Cancelled stays cancelled. */
export function nextStatus(s: EventStatus): EventStatus {
  if (s === 'todo') return 'doing'
  if (s === 'doing') return 'done'
  if (s === 'done') return 'todo'
  return 'cancelled'
}

/** Pure: which row should a status change hit for THIS occurrence? */
export function targetRow(
  occ: Occurrence
): { kind: 'override' } | { kind: 'master'; master: CalendarEvent } | { kind: 'single' } {
  const ev = occ.event
  if (ev.parentId || occ.isOverride) return { kind: 'override' }
  if (ev.rrule) return { kind: 'master', master: ev }
  return { kind: 'single' }
}

/**
 * Persist a cycle step for the single occurrence. Handles coins:
 *  - leaving done → refund (silent, consistent with the editor's revert)
 *  - entering done → opens the "How did it go?" score prompt (normal flow)
 */
export async function cycleOccurrenceStatus(occ: Occurrence): Promise<EventStatus | null> {
  const ev = occ.event
  if (ev.status === 'cancelled') return null
  const next = nextStatus(ev.status)

  const data = useData.getState()
  const coins = useCoins.getState()
  const row = targetRow(occ)
  let saved: CalendarEvent | null = null

  // 1) persist the new status on the right row
  if (row.kind === 'override') {
    saved = await data.updateEvent(ev.id, { status: next })
  } else if (row.kind === 'master') {
    // recurring series → one-off override row (this occurrence only).
    // v1.11.5 CRITICAL: the override must carry the OCCURRENCE's real
    // date+time — using the master's startLocal made later occurrences
    // render on the master's start day (and the clicked day vanished).
    const base = row.master
    const loc = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
    }
    saved = await data.applyOverride(
      {
        title: base.title,
        description: base.description,
        startLocal: loc(occ.start),
        endLocal: loc(occ.end),
        allDay: base.allDay,
        labelId: base.labelId,
        colorOverride: base.colorOverride,
        status: next,
        rrule: null,
        exdates: [],
        parentId: base.id,
        originDate: occ.originDate
      } as EventInput,
      base.id,
      [...(base.exdates ?? []), occ.originDate]
    )
  } else {
    saved = await data.updateEvent(ev.id, { status: next })
  }

  // 2) coins: leaving done refunds (and drops any open prompt for it);
  //    entering done opens the score prompt
  if (ev.status === 'done' && next !== 'done') {
    await coins.revertScore(ev.id, occ.originDate)
    const p = coins.pending
    if (p && p.event.id === ev.id && p.originDate === occ.originDate) coins.setPending(null)
    await coins.refresh()
  } else if (next === 'done' && ev.status !== 'done' && saved) {
    if (coins.systemOn) {
      coins.setPending({ event: saved, originDate: occ.originDate })
    }
  }

  // 3) v1.11.3: the event must NEVER vanish — if the active status filter
  //    would hide the new status, switch the filter to All automatically
  //    (with a toast explaining) so the block stays visible.
  const ui = useUi.getState()
  if (ui.statusFilter !== 'all' && ui.statusFilter !== next) {
    const label = ui.statusFilter === 'todo' ? 'To Do' : ui.statusFilter === 'doing' ? 'In Progress' : ui.statusFilter === 'done' ? 'Done' : 'Cancelled'
    useToasts.getState().push({
      message: `Status changed to ${next} — the "${label}" filter was hiding it, so the filter switched to All.`,
      kind: 'info',
      duration: 4500
    })
    ui.setStatusFilter('all')
  }
  return next
}
