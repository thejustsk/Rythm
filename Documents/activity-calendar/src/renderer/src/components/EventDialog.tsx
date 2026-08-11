import { useMemo, useState } from 'react'
import { useData, useUi } from '@/state/store'
import { useToasts } from '@/state/toasts'
import type { EventStatus } from '@shared/types'
import { ruleToHuman, rruleUntil } from '@/engine/recurrence'
import { parseLocal } from '@/engine/occurrences'
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
    if (canEditOccurrence && applyTo === 'this') {
      // one-off override: carry over every field (all-day, colour too)
      await applyOverride(
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
              await removeEvent(newSeries.id)
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
    } else {
      // NON-RECURRING (incl. overrides & multi-day): the form's dates AND times
      // apply verbatim — date edits (trim/extend) must be honoured.
      await updateEvent(event.id, { ...fields, rrule })
    }
    toasts.push({ message: `Saved "${title.trim()}"`, kind: 'info', duration: 2500 })
    const newStatus = fields.status
    if (ui.statusFilter !== 'all' && ui.statusFilter !== newStatus) {
      toasts.push({
        message: `Status changed to ${newStatus} — the "${ui.statusFilter}" filter is hiding this block (use All to see it).`,
        kind: 'danger',
        duration: 4500
      })
    }
    ui.closeEditor()
  }

  /** Skip just this occurrence (series keeps going). */
  const delThis = async () => {
    const prevExdates = [...event.exdates]
    await updateEvent(event.id, { exdates: [...prevExdates, occ.originDate] })
    toasts.push({
      message: `Deleted "${event.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void updateEvent(event.id, { exdates: prevExdates })
        toasts.push({ message: `Restored "${event.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  /** Delete a one-off override. */
  const delOverride = async () => {
    const copy = event
    await removeEvent(event.id)
    toasts.push({
      message: `Deleted "${copy.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void restoreEvent(copy)
        toasts.push({ message: `Restored "${copy.title}"`, kind: 'info' })
      }
    })
    ui.closeEditor()
  }

  /** Delete the whole series (master + every override). */
  const delSeries = async () => {
    const master = event
    const children = events.filter((e) => e.parentId === master.id)
    await removeEvent(master.id)
    toasts.push({
      message: `Deleted series "${master.title}"`,
      kind: 'danger',
      actionLabel: 'Undo',
      onAction: () => {
        void (async () => {
          await restoreEvent(master)
          for (const c of children) await restoreEvent(c)
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
    for (const c of children) await removeEvent(c.id)
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
