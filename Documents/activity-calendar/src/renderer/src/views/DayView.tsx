import { useUi } from '@/state/store'
import WeekView from './WeekView'

/** Day view = the shared hour grid with a single column. */
export default function DayView() {
  const cursor = useUi((s) => s.cursor)
  const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
  return <WeekView days={[day]} />
}
