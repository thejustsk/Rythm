import { useState } from 'react'
import { useData, useUi } from '@/state/store'
import { useToasts } from '@/state/toasts'
import type { EventStatus } from '@shared/types'
import { parseLocal } from '@/engine/occurrences'
import { EventFormFields } from './EventForm'
import RepeatEditor from './RepeatEditor'

/** Quick add dialog — press Enter to create. */
export default function QuickAdd() {
  const ui = useUi()
  const createEvent = useData((s) => s.createEvent)
  const toasts = useToasts.getState()
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(`${ui.quickAdd!.date}T${ui.quickAdd!.time}`)
  const [end, setEnd] = useState(() => {
    // honour the default-duration pref (Settings → General)
    const preset = ui.quickAdd!.end
    if (preset) return preset
    const [h, m] = ui.quickAdd!.time.split(':').map(Number)
    const eh = (h + 1) % 24
    return `${ui.quickAdd!.date}T${String(eh).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  })
  const [labelId, setLabelId] = useState<string | null>(null)
  const [status, setStatus] = useState<EventStatus>('todo')
  const [description, setDescription] = useState('')
  const [rrule, setRrule] = useState<string | null>(null)

  const rangeValid = parseLocal(end).getTime() > parseLocal(start).getTime()

  const submit = async () => {
    if (!title.trim() || !rangeValid) return
    await createEvent({
      title: title.trim(),
      description: description.trim(),
      startLocal: start,
      endLocal: end,
      labelId,
      status,
      rrule
    })
    toasts.push({ message: `Added "${title.trim()}"`, kind: 'info', duration: 2500 })
    ui.closeQuickAdd()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeQuickAdd()}>
      <div className="dialog quickadd">
        <div className="dialog-title">New activity</div>
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
        {!rangeValid && <div className="ef-error">End must be after start</div>}
        <RepeatEditor value={rrule} onChange={setRrule} startDate={start.slice(0, 10)} />
        <div className="dialog-actions">
          <button className="btn" onClick={ui.closeQuickAdd}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!title.trim() || !rangeValid}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
