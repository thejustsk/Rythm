import { useEffect } from 'react'
import { useData, useUi } from '@/state/store'
import TitleBar from '@/components/TitleBar'
import Sidebar from '@/components/Sidebar'
import Toolbar from '@/components/Toolbar'
import StatusFilter from '@/components/StatusFilter'
import QuickAdd from '@/components/QuickAdd'
import EventDialog from '@/components/EventDialog'
import ToastHost from '@/components/ToastHost'
import MonthView from '@/views/MonthView'
import WeekView from '@/views/WeekView'
import DayView from '@/views/DayView'
import AgendaView from '@/views/AgendaView'
import InsightsView from '@/views/InsightsView'

export default function App() {
  const load = useData((s) => s.load)
  const loaded = useData((s) => s.loaded)
  const ui = useUi()

  useEffect(() => {
    void load()
  }, [load])

  const weekDays = (() => {
    const cursor = ui.cursor
    const dow = cursor.getDay()
    const monday = new Date(cursor)
    monday.setDate(cursor.getDate() - (dow === 0 ? 6 : dow - 1))
    const days: Date[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      days.push(d)
    }
    return days
  })()

  const isInsights = ui.view === 'insights'

  return (
    <div className="app">
      <TitleBar />
      <div className={`app-body${isInsights ? ' insights' : ''}`}>
        <Sidebar />
        <div className="main">
          <Toolbar minimal={isInsights} />
          <div className="view-wrap">
            <div className={`status-wrap${isInsights ? ' gone' : ''}`}>
              <StatusFilter />
            </div>
            {!loaded ? (
              <div className="empty-state">Loading…</div>
            ) : (
              <div className="view-host">
                {ui.view === 'month' && <MonthView />}
                {ui.view === 'week' && <WeekView days={weekDays} />}
                {ui.view === 'day' && <DayView />}
                {ui.view === 'agenda' && <AgendaView />}
                {ui.view === 'insights' && <InsightsView />}
              </div>
            )}
          </div>
        </div>
      </div>
      {ui.quickAdd?.open && <QuickAdd />}
      {ui.editorKey && <EventDialog />}
      <ToastHost />
    </div>
  )
}
