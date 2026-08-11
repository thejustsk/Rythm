import { useMemo, useState } from 'react'
import { useData, useUi } from '@/state/store'
import type { EventStatus } from '@shared/types'
import { ruleToHuman } from '@/engine/recurrence'
import { EventFormFields } from './EventForm'
import RepeatEditor from './RepeatEditor'

/** Full editor for one occurrence / event. */
export default function EventDialog() {
  const ui = useUi()
  const { events, updateEvent, removeEvent, applyOverride } = useData()

  const occ = useMemo(() => {
    const [eventId, originDate] = ui.editorKey!.split('|')
    return { eventId, originDate }
  }, [ui.editorKey])

  const event = events.find((e) => e.id === occ.eventId) ?? null

  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(event?.startLocal ?? '')
  const [end, setEnd] = useState(event?.endLocal ?? '')
  const [labelId, setLabelId] = useState<string | null>(event?.labelId ?? null)
  const [status, setStatus] = useState<EventStatus>(event?.status ?? 'todo')
  const [description, setDescription] = useState(event?.description ?? '')
  const [rrule, setRrule] = useState<string | null>(event?.rrule ?? null)
  const [applyTo, setApplyTo] = useState<'this' | 'series'>('series')

  // reset state whenever a different event is opened
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  if (event && loadedKey !== event.id) {
    setLoadedKey(event.id)
    setTitle(event.title)
    setStart(event.startLocal)
    setEnd(event.endLocal)
    setLabelId(event.labelId)
    setStatus(event.status)
    setDescription(event.description)
    setRrule(event.rrule)
    setApplyTo('series')
  }

  if (!event) return null
  const recurring = !!event.rrule
  const isOverride = !!event.parentId
  const canEditOccurrence = recurring && !isOverride

  const save = async () => {
    if (!title.trim()) return
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
    } else {
      await updateEvent(event.id, { ...fields, rrule })
    }
    ui.closeEditor()
  }

  const del = async (mode: 'this' | 'series' | null) => {
    if (canEditOccurrence) {
      if (mode === 'this') {
        const exdates = [...event.exdates, occ.originDate]
        await updateEvent(event.id, { exdates })
      } else {
        await removeEvent(event.id)
      }
    } else {
      await removeEvent(event.id)
    }
    ui.closeEditor()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeEditor()}>
      <div className="dialog editor">
        <div className="dialog-title">
          Edit activity
          {isOverride && <span className="badge">one-time change</span>}
          {recurring && !isOverride && <span className="badge repeat">repeats</span>}
        </div>

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

        {canEditOccurrence && (
          <div className="apply-to">
            <span className="re-label">Apply changes to</span>
            <div className="segmented accent">
              <button
                className={`seg-btn${applyTo === 'series' ? ' active' : ''}`}
                onClick={() => setApplyTo('series')}
              >
                Whole series
              </button>
              <button
                className={`seg-btn${applyTo === 'this' ? ' active' : ''}`}
                onClick={() => setApplyTo('this')}
              >
                This occurrence
              </button>
            </div>
          </div>
        )}

        {!isOverride &&
          (canEditOccurrence && applyTo === 'this' ? (
            <div className="repeat-note muted">
              Repeat settings apply to the whole series. Editing just this occurrence creates a one-time change.
            </div>
          ) : (
            <>
              <RepeatEditor key={event.id} value={rrule} onChange={setRrule} startDate={start.slice(0, 10)} />
              {recurring && <div className="repeat-note">🔁 {ruleToHuman(rrule!)}</div>}
            </>
          ))}
        {isOverride && <div className="repeat-note muted">This is a one-time change to a repeating activity.</div>}

        <div className="dialog-actions between">
          <div className="del-actions">
            {canEditOccurrence ? (
              <>
                <button className="btn danger" onClick={() => void del('this')}>
                  Delete this occurrence
                </button>
                <button className="btn danger" onClick={() => void del('series')}>
                  Delete series
                </button>
              </>
            ) : (
              <button className="btn danger" onClick={() => void del(null)}>
                Delete
              </button>
            )}
          </div>
          <div>
            <button className="btn" onClick={ui.closeEditor}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={!title.trim()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
