import { useMemo, useState } from 'react'
import { useData, useUi } from '@/state/store'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import type { EventStatus, ScoreRow } from '@shared/types'
import { ruleToHuman, rruleUntil } from '@/engine/recurrence'
import { parseLocal } from '@/engine/occurrences'
import { computeEarn } from '@/lib/gamification'
import { EventFormFields } from './EventForm'
import RepeatEditor from './RepeatEditor'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The day before an ISO date — used by "delete upcoming". */
export function dayBefore(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Full editor for one occurrence / event. */
export default function EventDialog() {
  const ui = useUi()
  const { events, updateEvent, removeEvent, applyOverride, restoreEvent, createEvent } = useData()
  const coins = useCoins()
  const toasts = useToasts.getState()

  const occ = useMemo(() => {
    const [eventId, originDate] = ui.editorKey!.split('|')
    return { eventId, originDate }
  }, [ui.editorKey])

  const event = events.find((e) => e.id === occ.eventId) ?? null

  // The form must show the SELECTED occurrence's date, not the series' start
  // date: a regular occurrence lives on occ.originDate; only its time comes
  // from the master event.
  const timeOf = (s: string) => (s ? s.slice(11) : '00:00')
  const pad2 = (n: number) => String(n).padStart(2, '0')
  // Non-recurring events (and overrides) show their REAL stored times verbatim —
  // reconstructing from the clicked day would shift multi-day events (bug fix).
  const isSeriesOccurrence = !!(event && event.rrule && !event.parentId)
  const formStartLocal = event
    ? isSeriesOccurrence
      ? `${occ.originDate}T${timeOf(event.startLocal)}`
      : event.startLocal
    : ''
  const formEndLocal = event
    ? isSeriesOccurrence
      ? (() => {
          // keep the series' real duration (handles overnight/multi-day ends)
          const durMs = parseLocal(event.endLocal).getTime() - parseLocal(event.startLocal).getTime()
          const d = new Date(parseLocal(formStartLocal).getTime() + durMs)
          return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${timeOf(event.endLocal)}`
        })()
      : event.endLocal
    : ''

  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(formStartLocal)
  const [end, setEnd] = useState(formEndLocal)
  const [labelId, setLabelId] = useState<string | null>(event?.labelId ?? null)
  const [status, setStatus] = useState<EventStatus>(event?.status ?? 'todo')
  const [description, setDescription] = useState(event?.description ?? '')
  const [rrule, setRrule] = useState<string | null>(event?.rrule ?? null)
  const [applyTo, setApplyTo] = useState<'this' | 'series'>('this')
  const [applyFrom, setApplyFrom] = useState<'start' | 'date'>('start')

  // reset state whenever a different event OR occurrence is opened
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  if (event && loadedKey !== `${event.id}|${occ.originDate}`) {
    setLoadedKey(`${event.id}|${occ.originDate}`)
    setTitle(event.title)
    setStart(formStartLocal)
    setEnd(formEndLocal)
    setLabelId(event.labelId)
    setStatus(event.status)
    setDescription(event.description)
    setRrule(event.rrule)
    setApplyTo('this')
    setApplyFrom('start')
  }

  if (!event) return null
  const recurring = !!event.rrule
  const isOverride = !!event.parentId
  const canEditOccurrence = recurring && !isOverride
  const seriesMode = canEditOccurrence && applyTo === 'series'

  const rangeValid = parseLocal(end).getTime() > parseLocal(start).getTime()

  const save = async () => {
    if (!title.trim() || !rangeValid) return
    const fields = {
      title: title.trim(),
      description,
      startLocal: start,
      endLocal: end,
      labelId,
      status
    }
    const wasDone = event.status === 'done'
    const willBeDone = fields.status === 'done'
    let savedId = event.id
    let effOrigin: string

    if (canEditOccurrence && applyTo === 'this') {
      // one-off override: carry over every field (all-day, colour too);
      // re-saving the same day updates the SAME override row (stable id)
      const created = await applyOverride(
        {
          ...fields,
          allDay: event.allDay,
          colorOverride: event.colorOverride,
          rrule: null,
          exdates: [],
          parentId: event.id,
          originDate: occ.originDate
        },
        event.id,
        [...(event.exdates ?? []), occ.originDate]
      )
      savedId = created.id
      effOrigin = occ.originDate
    } else if (recurring && !isOverride) {
      // RECURRING SERIES: keep the series' own start/end DATES — only the
      // times from the form apply (otherwise earlier occurrences vanish).
      const seriesStart = `${event.startLocal.slice(0, 10)}T${start.slice(11)}`
      const seriesEnd = `${event.endLocal.slice(0, 10)}T${end.slice(11)}`
      const split = applyFrom === 'date' && occ.originDate > event.startLocal.slice(0, 10)
      if (split) {
        // APPLY FROM THIS DATE: end the old series the day before, start a new
        // series at the selected day with the new settings (earlier days keep
        // the old schedule — nothing before the selected day changes).
        const oldRrule = event.rrule!
        const newSeries = await createEvent({
          ...fields,
          allDay: event.allDay,
          colorOverride: event.colorOverride,
          rrule,
          exdates: [],
          parentId: null,
          originDate: null
        })
        await updateEvent(event.id, {
          title: event.title,
          description: event.description,
          labelId: event.labelId,
          status: event.status,
          startLocal: seriesStart,
          endLocal: seriesEnd,
          rrule: rruleUntil(oldRrule, dayBefore(occ.originDate))
        })
        toasts.push({
          message: `Series split — "${title.trim()}" now starts ${occ.originDate}`,
          kind: 'info',
          actionLabel: 'Undo',
          onAction: () => {
            void (async () => {
              await removeEvent(newSeries.id, { toTrash: false }) // internal split cleanup
              await updateEvent(event.id, { rrule: oldRrule })
            })()
          },
          duration: 6000
        })
      } else {
        // WHOLE SERIES FROM ITS START: keep the series' own start/end DATES —
        // only the times from the form apply (bug A1 fix).
        await updateEvent(event.id, { ...fields, startLocal: seriesStart, endLocal: seriesEnd, rrule })
      }
      savedId = event.id
      effOrigin = occ.originDate
    } else {
      // NON-RECURRING (incl. overrides & multi-day): the form's dates AND times
      // apply verbatim — date edits (trim/extend) must be honoured.
      await updateEvent(event.id, { ...fields, rrule })
      savedId = event.id
      effOrigin = start.slice(0, 10)
    }

    // ---- coin correctness ----
    const oldOrigin = recurring && !isOverride ? occ.originDate : event.startLocal.slice(0, 10)
    const dateMoved = oldOrigin !== effOrigin
    // 1) left Done → refund but KEEP the score row (marked refunded) so that
    //    re-marking Done restores silently instead of re-prompting
    if (wasDone && !willBeDone) {
      await coins.revertScore(savedId, effOrigin)
    }
    // 2) still Done but the occurrence's date moved → the old score is stale:
    //    refund it so the new date can be scored once (no double earn)
    else if (wasDone && willBeDone) {
      if (dateMoved) {
        const cleared = await coins.clearScores(savedId)
        void cleared
      }
    }

    toasts.push({ message: `Saved "${title.trim()}"`, kind: 'info', duration: 2500 })
    // M10.2 bonuses: "all planned done" for the affected day + perfect week
    // Only for a FRESH completion (status changed to done in this edit) —
    // re-saving an event that was already done (e.g. done while the coin
    // system was OFF) must never add coins.
    if (willBeDone && !wasDone) {
      window.api.coins.allDoneCheck(effOrigin).then((r) => {
        if (r.award) toasts.push({ message: `🎉 All planned done — +${r.amount} 🪙`, kind: 'info', duration: 4000 })
      })
      window.api.coins.perfectWeek().then((r) => {
        if (r.award) {
          toasts.push({ message: `🏆 Perfect week — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
          void useCoins.getState().refresh() // sidebar chip updates instantly
        }
      })
      window.api.coins.streakMilestone().then((r) => {
        if (r.award) {
          toasts.push({ message: `🎯 ${r.level}-day streak milestone — +${r.amount} 🪙`, kind: 'info', duration: 4500 })
          void useCoins.getState().refresh()
        }
      })
    }
    // gamification: completed → either restore a previously-refunded score
    // silently, or ask "How did it go?" (only for single occurrences)
    if (willBeDone && (applyTo === 'this' || !recurring)) {
      const existing = await window.api.coins.getScore(savedId, effOrigin)
      if (existing) {
        if (!wasDone && existing.refundedAt) {
          // re-marked Done after a status revert → restore the coins quietly
          const minutes = (parseLocal(end).getTime() - parseLocal(start).getTime()) / 60000
          const amount = computeEarn(minutes, existing.scoreType)
          await coins.restoreScore(savedId, effOrigin, existing.scoreType, amount, event.labelId)
          toasts.push({ message: `Coins restored for "${title.trim()}"`, kind: 'info', duration: 2500 })
        }
        // wasDone → plain re-save → nothing to do
      } else if (coins.systemOn && (!wasDone || dateMoved)) {
        // ask "How did it go?" only for a genuine NEW completion:
        //  - status changed to done in this edit (!wasDone), OR
        //  - the occurrence's DATE moved while done (dateMoved → the old score
        //    was cleared above, so this is a fresh completion on the new date)
        // An event that was ALREADY done and UNCHANGED (e.g. marked done while
        // the coin system was OFF) must NEVER prompt or earn on re-save.
        coins.setPending({ event: { ...event, id: savedId, startLocal: start, endLocal: end }, originDate: effOrigin })
      }
      // system OFF → marking done does NOTHING (no prompt, no coins, ever)
    }
    const newStatus = fields.status
    if (ui.statusSel.size > 0 && !ui.statusSel.has(newStatus)) {
      toasts.push({
        message: `Status changed to ${newStatus} — the selected filter is hiding this block (use All to see it).`,
        kind: 'danger',
        duration: 4500
      })
    }
    ui.closeEditor()
  }

  /** Skip just this occurrence (series keeps going). */
  const delThis = async () => {
    const prevExdates = [...event.exdates]
    const { scores, earns } = await coins.clearScores(event.id, occ.originDate)
    await updateEvent(event.id, { exdates: [...prevExdates, occ.originDate] })
    toasts.push({
      message: `Deleted "${event.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void (async () => {
          await updateEvent(event.id, { exdates: prevExdates })
          if (scores.length > 0) await coins.restoreScores(scores, earns)
        })()
        toasts.push({ message: `Restored "${event.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  /** Delete a one-off override. */
  const delOverride = async () => {
    const copy = event
    const { scores, earns } = await coins.clearScores(event.id)
    await removeEvent(event.id)
    toasts.push({
      message: `Deleted "${copy.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void (async () => {
          await restoreEvent(copy)
          if (scores.length > 0) await coins.restoreScores(scores, earns)
        })()
        toasts.push({ message: `Restored "${copy.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  /** Delete the whole series (master + every override). v1.11.15: when the
   *  editor was opened on an OVERRIDE, resolve the real master first — the
   *  whole series must go, not just the override row. */
  const delSeries = async () => {
    const master = event.parentId ? events.find((e) => e.id === event.parentId) ?? event : event
    const children = events.filter((e) => e.parentId === master.id)
    const allScores: ScoreRow[] = []
    const allEarns: Array<{ eventId: string; originDate: string; amount: number; labelId: string | null }> = []
    const cleared = await coins.clearScores(master.id)
    allScores.push(...cleared.scores)
    allEarns.push(...cleared.earns)
    for (const c of children) {
      const res = await coins.clearScores(c.id)
      allScores.push(...res.scores)
      allEarns.push(...res.earns)
    }
    await removeEvent(master.id)
    toasts.push({
      message: `Deleted series "${master.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void (async () => {
          await restoreEvent(master)
          for (const c of children) await restoreEvent(c)
          if (allScores.length > 0) await coins.restoreScores(allScores, allEarns)
        })()
        toasts.push({ message: `Restored series "${master.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  /** Delete this occurrence and everything after it; keep the past. */
  const delUpcoming = async () => {
    const master = event
    const prevRrule = master.rrule!
    const until = dayBefore(occ.originDate)
    const children = events.filter(
      (e) => e.parentId === master.id && e.originDate && e.originDate >= occ.originDate
    )
    await updateEvent(master.id, { rrule: rruleUntil(prevRrule, until) })
    // v1.11.12: refund + clear scores for every removed future occurrence
    // (matches the "delete this occurrence" / "delete series" paths)
    for (const c of children) {
      await coins.clearScores(c.id)
      await removeEvent(c.id)
    }
    toasts.push({
      message: `Deleted "${master.title}" and upcoming`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void (async () => {
          await updateEvent(master.id, { rrule: prevRrule })
          for (const c of children) await restoreEvent(c)
        })()
        toasts.push({ message: `Restored "${master.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeEditor()}>
      <div className="dialog editor">
        {canEditOccurrence && (
          <div className="apply-to top">
            <span className="re-label">Apply changes to</span>
            <div className="segmented accent">
              <button
                className={`seg-btn${applyTo === 'this' ? ' active' : ''}`}
                onClick={() => setApplyTo('this')}
              >
                This occurrence
              </button>
              <button
                className={`seg-btn${applyTo === 'series' ? ' active' : ''}`}
                onClick={() => setApplyTo('series')}
              >
                Whole series
              </button>
            </div>
          </div>
        )}

        <div className="dialog-title">
          Edit activity
          {isOverride && <span className="badge">one-time change</span>}
          {recurring && !isOverride && <span className="badge repeat">repeats</span>}
        </div>

        {!rangeValid && <div className="ef-error">End must be after start</div>}

        {isOverride ? (
          <>
            <EventFormFields
              title={title}
              setTitle={setTitle}
              start={start}
              setStart={setStart}
              end={end}
              setEnd={setEnd}
              labelId={labelId}
              setLabelId={setLabelId}
              status={status}
              setStatus={setStatus}
              description={description}
              setDescription={setDescription}
            />
            <div className="repeat-note muted">This is a one-time change to a repeating activity.</div>
          </>
        ) : canEditOccurrence && applyTo === 'this' ? (
          <>
            <EventFormFields
              title={title}
              setTitle={setTitle}
              start={start}
              setStart={setStart}
              end={end}
              setEnd={setEnd}
              labelId={labelId}
              setLabelId={setLabelId}
              status={status}
              setStatus={setStatus}
              description={description}
              setDescription={setDescription}
            />
            <div className="repeat-note muted">
              Repeat settings apply to the whole series. Editing just this occurrence creates a one-time change.
            </div>
          </>
        ) : (
          <div className="dialog-grid">
            <div className="ef-col">
              <EventFormFields
                title={title}
                setTitle={setTitle}
                start={start}
                setStart={setStart}
                end={end}
                setEnd={setEnd}
                labelId={labelId}
                setLabelId={setLabelId}
                status={status}
                setStatus={setStatus}
                description={description}
                setDescription={setDescription}
              />
            </div>
            <div className="repeat-col">
              {canEditOccurrence && (
                <div className="apply-to top">
                  <span className="re-label">Apply repeat from</span>
                  <div className="segmented accent">
                    <button
                      className={`seg-btn${applyFrom === 'start' ? ' active' : ''}`}
                      onClick={() => setApplyFrom('start')}
                    >
                      Series start
                    </button>
                    <button
                      className={`seg-btn${applyFrom === 'date' ? ' active' : ''}`}
                      disabled={occ.originDate <= event.startLocal.slice(0, 10)}
                      title={occ.originDate <= event.startLocal.slice(0, 10) ? 'Selected day is the series start' : `Start a new series from ${occ.originDate}`}
                      onClick={() => setApplyFrom('date')}
                    >
                      This date {occ.originDate}
                    </button>
                  </div>
                </div>
              )}
              <RepeatEditor key={event.id} value={rrule} onChange={setRrule} startDate={event.startLocal.slice(0, 10)} />
            </div>
          </div>
        )}

        <div className="dialog-actions between">
          <div className="del-actions">
            {canEditOccurrence ? (
              applyTo === 'this' ? (
                <button className="btn danger" onClick={() => void delThis()}>
                  Delete this occurrence
                </button>
              ) : (
                <>
                  <button className="btn danger" onClick={() => void delUpcoming()}>
                    Delete upcoming
                  </button>
                  <button className="btn danger" onClick={() => void delSeries()}>
                    Delete series
                  </button>
                </>
              )
            ) : (
              <button className="btn danger" onClick={() => void delOverride()}>
                Delete
              </button>
            )}
          </div>
          <div>
            <button className="btn" onClick={ui.closeEditor}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={!title.trim() || !rangeValid}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
