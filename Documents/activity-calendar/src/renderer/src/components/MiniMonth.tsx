import { useEffect, useState } from 'react'
import { iso } from '@/state/store'
import { addDays, startOfDay, daysInMonth } from '@/engine/recurrence'

interface Props {
  cursor: Date
  onChange: (d: Date) => void
}

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('en-US', { month: 'short' }))

/** Small month grid with a custom month/year selector (no dropdown). */
export default function MiniMonth({ cursor, onChange }: Props) {
  const today = startOfDay(new Date())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewYear, setViewYear] = useState(cursor.getFullYear())

  // keep the picker's year in sync with the cursor when it changes externally
  useEffect(() => setViewYear(cursor.getFullYear()), [cursor.getFullYear()])

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = addDays(first, 1 - (first.getDay() === 0 ? 7 : first.getDay())) // Monday-start

  const cells: Date[] = []
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i))

  const stepMonth = (delta: number) => {
    onChange(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1))
  }

  const pickMonth = (m0: number) => {
    const dim = daysInMonth(viewYear, m0)
    const day = Math.min(cursor.getDate(), dim)
    onChange(new Date(viewYear, m0, day))
    setPickerOpen(false)
  }

  const goToday = () => {
    onChange(new Date())
    setPickerOpen(false)
  }

  return (
    <div className="minimonth">
      <div className="mm-head">
        <button className="mm-nav" title="Previous month" onClick={() => stepMonth(-1)}>
          ‹
        </button>
        <button
          className="mm-title"
          onClick={() => setPickerOpen((o) => !o)}
          title="Choose month / year"
        >
          {cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
        </button>
        <button className="mm-nav" title="Next month" onClick={() => stepMonth(1)}>
          ›
        </button>
      </div>

      {pickerOpen && (
        <div className="mm-picker">
          <div className="mm-picker-year">
            <button className="mm-nav" title="Previous year" onClick={() => setViewYear((y) => y - 1)}>
              ‹
            </button>
            <span className="mm-picker-year-num">{viewYear}</span>
            <button className="mm-nav" title="Next year" onClick={() => setViewYear((y) => y + 1)}>
              ›
            </button>
          </div>
          <div className="mm-picker-months">
            {MONTHS.map((m, i) => (
              <button
                key={m}
                className={`mm-month${i === cursor.getMonth() && viewYear === cursor.getFullYear() ? ' cur' : ''}`}
                onClick={() => pickMonth(i)}
              >
                {m}
              </button>
            ))}
          </div>
          <button className="mm-today" onClick={goToday}>
            Today
          </button>
        </div>
      )}

      <div className="minimonth-head">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="minimonth-grid">
        {cells.map((d, i) => {
          const isToday = iso(d) === iso(today)
          const isCursor = iso(d) === iso(cursor)
          const otherMonth = d.getMonth() !== cursor.getMonth()
          return (
            <button
              key={i}
              className={`mm-cell${isToday ? ' today' : ''}${isCursor ? ' cursor' : ''}${otherMonth ? ' dim' : ''}`}
              onClick={() => onChange(d)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
