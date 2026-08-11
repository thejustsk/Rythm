import { useState } from 'react'
import { useData, useUi } from '@/state/store'
import type { EventStatus } from '@shared/types'
import { EventFormFields } from './EventForm'
import RepeatEditor from './RepeatEditor'

/** Quick add dialog — press Enter to create. */
export default function QuickAdd() {
  const ui = useUi()
  const createEvent = useData((s) => s.createEvent)
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(`${ui.quickAdd!.date}T${ui.quickAdd!.time}`)
  const [end, setEnd] = useState(() => {
    const [h, m] = ui.quickAdd!.time.split(':').map(Number)
    const eh = (h + 1) % 24
    return `${ui.quickAdd!.date}T${String(eh).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  })
  const [labelId, setLabelId] = useState<string | null>(null)
  const [status, setStatus] = useState<EventStatus>('todo')
  const [rrule, setRrule] = useState<string | null>(null)

  const submit = async () => {
    if (!title.trim()) return
    await createEvent({
      title: title.trim(),
      description: '',
      startLocal: start,
      endLocal: end,
      labelId,
      status,
      rrule
    })
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
        />
        <RepeatEditor value={rrule} onChange={setRrule} startDate={start.slice(0, 10)} />
        <div className="dialog-actions">
          <button className="btn" onClick={ui.closeQuickAdd}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!title.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
