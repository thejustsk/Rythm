import { iso } from '@/state/store'
import { addDays, startOfDay } from '@/engine/recurrence'

interface Props {
  cursor: Date
  onChange: (d: Date) => void
}

/** Small month grid for quick navigation. */
export default function MiniMonth({ cursor, onChange }: Props) {
  const today = startOfDay(new Date())
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = addDays(first, 1 - (first.getDay() === 0 ? 7 : first.getDay())) // Monday-start

  const cells: Date[] = []
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i))

  return (
    <div className="minimonth">
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
