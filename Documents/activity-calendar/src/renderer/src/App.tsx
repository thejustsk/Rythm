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
import SettingsDialog from '@/components/SettingsDialog'
import CoinScoreFx from '@/components/CoinScoreFx'
import CoinSystemDialog from '@/components/CoinSystemDialog'
import { loadTheme } from '@/state/theme'
import { APP_VERSION, BUILD_TAG } from '@shared/version'
import { loadPrefs } from '@/lib/prefs'
import { installShortcuts } from '@/lib/shortcuts'
import { weekStartOf } from '@/lib/dates'
import { useCoins } from '@/state/coins'
import { useTrash } from '@/state/trash'
import { useToasts } from '@/state/toasts'
import { useMilestones } from '@/state/milestones'
import MonthView from '@/views/MonthView'
import { addDays } from '@/engine/recurrence'
import WeekView from '@/views/WeekView'
import DayView from '@/views/DayView'
import AgendaView from '@/views/AgendaView'
import InsightsView from '@/views/InsightsView'
import CoinsView from '@/views/CoinsView'
import TrashView from '@/views/TrashView'

export default function App() {
  const load = useData((s) => s.load)
  const loaded = useData((s) => s.loaded)
  const loadCoins = useCoins((s) => s.load)
  const loadMilestones = useMilestones((s) => s.load)
  const ui = useUi()
  const loadTrash = useTrash((s) => s.load)

  useEffect(() => {
    void loadTheme()
    void loadPrefs()
    void load()
    void loadCoins()
    void loadMilestones()
    void loadTrash()
    // daily check-in bonus (once per day) — skipped while the coin system is OFF
    if (!useCoins.getState().systemOn) return
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
    window.api.coins.perfectMonth().then((r) => {
      if (r.award) {
        useToasts.getState().push({
          message: `🗓️ Perfect month — +${r.amount} 🪙`,
          kind: 'info',
          duration: 5000
        })
        void loadCoins()
      }
    })
    window.api.coins.perfectWeek().then((r) => {
      if (r.award) {
        useToasts.getState().push({
          message: `🏆 Perfect week — +${r.amount} 🪙`,
          kind: 'info',
          duration: 4500
        })
    window.api.coins.streakMilestone().then((r) => {
      if (r.award) {
        useToasts.getState().push({
          message: `🎯 ${r.level}-day streak milestone — +${r.amount} 🪙`,
          kind: 'info',
          duration: 4500
        })
        void loadCoins()
      }
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

  // global keyboard shortcuts + cheat sheet (?)
  useEffect(() => installShortcuts(), [])

  // v1.11.12: never-silent failures — any unhandled IPC/action error shows
  // as a toast (previously it was an invisible console rejection)
  useEffect(() => {
    const onRej = (e: PromiseRejectionEvent) => {
      // v1.11.18 (audit #8): store actions already toast their own specific
      // message and mark the error — don't double-toast the generic one
      if ((e.reason as { toasted?: boolean } | undefined)?.toasted) return
      const msg = e.reason?.message ?? String(e.reason ?? 'Unknown error')
      useToasts.getState().push({ message: `Something went wrong: ${msg}`, kind: 'danger', duration: 5000 })
    }
    const onErr = (e: ErrorEvent) => {
      if (e.message) useToasts.getState().push({ message: `Something went wrong: ${e.message}`, kind: 'danger', duration: 5000 })
    }
    window.addEventListener('unhandledrejection', onRej)
    window.addEventListener('error', onErr)
    return () => {
      window.removeEventListener('unhandledrejection', onRej)
      window.removeEventListener('error', onErr)
    }
  }, [])

  // v1.11.2: in-app reminders — the main process broadcasts every OS
  // notification here too, so reminders are ALWAYS visible in the app even
  // if Windows blocks the toast.
  useEffect(() => {
    return window.api.notify.onInApp((d) => {
      useToasts.getState().push({
        message: `🔔 ${d.title} — ${d.body}`,
        kind: 'info',
        duration: 7000
      })
    })
  }, [])

  // v1.11.2: one short startup toast proving which build is running —
  // impossible to miss, even if the user never opens the Coins intro.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (document.hidden) return
      useToasts.getState().push({
        message: `Rhythm v${APP_VERSION} · ${BUILD_TAG} — ready`,
        kind: 'info',
        duration: 3500
      })
    }, 900)
    return () => window.clearTimeout(t)
  }, [loaded])

  const weekDays = (() => {
    const cursor = ui.cursor
    const start = weekStartOf(cursor, ui.weekStart === 'sunday' ? 0 : 1)
    const days: Date[] = []
    for (let i = 0; i < 7; i++) days.push(addDays(start, i))
    return days
  })()

  const isInsights = ui.view === 'insights' || ui.view === 'coins' || ui.view === 'trash'

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
                {ui.view === 'trash' && <TrashView />}
              </div>
            )}
          </div>
        </div>
      </div>
      {ui.quickAdd?.open && <QuickAdd />}
      {ui.editorKey && <EventDialog />}
      {ui.settingsOpen && <SettingsDialog />}
      {ui.coinSystemConfirm && <CoinSystemDialog />}
      <ScorePrompt />
      <CoinScoreFx />
      <ToastHost />
    </div>
  )
}
