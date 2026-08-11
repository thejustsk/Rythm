import { useEffect } from 'react'
import { useData, useUi } from '@/state/store'
import TitleBar from '@/components/TitleBar'
import Sidebar from '@/components/Sidebar'
import Toolbar from '@/components/Toolbar'
import StatusFilter from '@/components/StatusFilter'
import QuickAdd from '@/components/QuickAdd'
import EventDialog from '@/components/EventDialog'
import ToastHost from '@/components/ToastHost'
import ScorePrompt from '@/components/ScorePrompt'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import MonthView from '@/views/MonthView'
import WeekView from '@/views/WeekView'
import DayView from '@/views/DayView'
import AgendaView from '@/views/AgendaView'
import InsightsView from '@/views/InsightsView'
import CoinsView from '@/views/CoinsView'

export default function App() {
  const load = useData((s) => s.load)
  const loaded = useData((s) => s.loaded)
  const loadCoins = useCoins((s) => s.load)
  const ui = useUi()

  useEffect(() => {
    void load()
    void loadCoins()
    // daily check-in bonus (once per day)
    window.api.coins.checkIn().then((r) => {
      if (r.award) {
        useToasts.getState().push({
          message: `🔥 Day ${r.streak} check-in — +${r.amount} 🪙`,
          kind: 'info',
          duration: 4000
        })
        void loadCoins()
      }
    })
    // weekly all-done credit: check on every launch too, so it is never missed
    window.api.coins.perfectWeek().then((r) => {
      if (r.award) {
        useToasts.getState().push({
          message: `🏆 Perfect week — +${r.amount} 🪙`,
          kind: 'info',
          duration: 4500
        })
        void loadCoins()
      } else if (r.blockingDay) {
        const bd = new Date(r.blockingDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
        useToasts.getState().push({
          message: `Perfect week: ${bd} had plans but nothing done — complete that day's activities to unlock +100 🪙`,
          kind: 'info',
          duration: 5000
        })
      }
    })
  }, [load, loadCoins])

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

  const isInsights = ui.view === 'insights' || ui.view === 'coins'

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
                {ui.view === 'coins' && <CoinsView />}
              </div>
            )}
          </div>
        </div>
      </div>
      {ui.quickAdd?.open && <QuickAdd />}
      {ui.editorKey && <EventDialog />}
      <ScorePrompt />
      <ToastHost />
    </div>
  )
}
