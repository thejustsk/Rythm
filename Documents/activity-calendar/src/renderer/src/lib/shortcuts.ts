/**
 * Global keyboard shortcuts (item B.5 — the cheat sheet documents these).
 *
 *   d / w / m / a / i  → switch views
 *   c                 → quick-add a new activity on the cursor day
 *   t                 → jump to today
 *   ← / →             → previous / next day
 *   Shift + ← / →     → previous / next week
 *   ?                 → toggle the shortcut cheat sheet
 *   Esc               → close the cheat sheet
 *
 * Safe: ignores keystrokes while typing in inputs, and navigation keys while
 * a dialog is open.
 */
import { useUi } from '@/state/store'
import { useData } from '@/state/store'

/** The shortcut list — shared by the Settings → Shortcuts tab (v1.11.4). */
export const SHORTCUT_ROWS: Array<{ keys: string[]; label: string }> = [
  { keys: ['D', 'W', 'M', 'A'], label: 'Switch view (Day / Week / Month / Agenda)' },
  { keys: ['I'], label: 'Open Insights' },
  { keys: ['C'], label: 'Quick-add a new activity' },
  { keys: ['T'], label: 'Jump to today' },
  { keys: ['←', '→'], label: 'Previous / next day' },
  { keys: ['Shift', '←', '→'], label: 'Previous / next week' },
  { keys: ['?'], label: 'Open Settings → Shortcuts' },
  { keys: ['Esc'], label: 'Close dialogs' }
]

type View = 'day' | 'week' | 'month' | 'agenda' | 'insights' | 'coins'

const VIEW_KEYS: Record<string, View> = {
  d: 'day',
  w: 'week',
  m: 'month',
  a: 'agenda',
  i: 'insights'
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  )
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const ui = useUi.getState()
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

    if (key === 'Escape') {
      // Esc already closes dialogs via their own handlers; nothing extra here
      return
    }
    if (key === '?') {
      ui.openSettings('shortcuts')
      e.preventDefault()
      return
    }
    if (isTyping(e)) return

    const dialogOpen = !!ui.editorKey || !!ui.quickAdd || ui.settingsOpen || ui.coinSystemConfirm || !!document.querySelector('.score-prompt')
    if (dialogOpen) return

    if (key === 'c') {
      e.preventDefault()
      const d = ui.cursor
      ui.openQuickAdd(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        '09:00'
      )
      return
    }
    if (key === 't') {
      e.preventDefault()
      ui.goToday()
      return
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault()
      const step = e.shiftKey ? 7 : 1
      ui.navigate(key === 'ArrowRight' ? step : -step)
      return
    }
    const v = VIEW_KEYS[key]
    if (v) {
      e.preventDefault()
      ui.setView(v)
      void useData.getState().load()
      return
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
