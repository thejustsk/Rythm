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
import { useUi, useData } from '@/state/store'
import { useToasts } from '@/state/toasts'

/** The shortcut list — shared by the Settings → Shortcuts tab (v1.11.4). */
export const SHORTCUT_ROWS: Array<{ keys: string[]; label: string }> = [
  { keys: ['D', 'W', 'M', 'A'], label: 'Switch view (Day / Week / Month / Agenda)' },
  { keys: ['I'], label: 'Open Insights' },
  { keys: ['C'], label: 'Quick-add a new activity' },
  { keys: ['T'], label: 'Jump to today' },
  { keys: ['←', '→'], label: 'Previous / next day' },
  { keys: ['Shift', '←', '→'], label: 'Previous / next week' },
  { keys: ['Ctrl', 'Scroll'], label: 'Zoom the Day/Week grid (1× – 4×)' },
  { keys: ['Ctrl', 'P'], label: 'Zoom the Day/Week grid (alternate)' },
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
    if (isTyping(e)) return

    const dialogOpen = !!ui.editorKey || !!ui.quickAdd || ui.settingsOpen || ui.coinSystemConfirm || !!document.querySelector('.score-prompt')
    // v1.11.18 (audit): '?' must respect the SAME guards as every other
    // shortcut — typing a literal '?' into a title/search field must never
    // open Settings mid-sentence. When Settings is already open it just
    // switches to the Shortcuts tab.
    if (key === '?') {
      if (dialogOpen && !ui.settingsOpen) return
      ui.openSettings('shortcuts')
      e.preventDefault()
      return
    }
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
    // v1.11.14: Ctrl+P cycles the day/week grid VERTICAL zoom
    if (e.ctrlKey && key === 'p') {
      e.preventDefault()
      const levels = [1, 1.35, 1.75, 2.2]
      const cur = ui.gridZoom
      const next = levels[(levels.indexOf(cur) + 1) % levels.length] ?? 1.35
      ui.setGridZoom(next)
      useToasts.getState().push({ message: `Grid zoom ${next.toFixed(2).replace(/\.?0+$/, '')}×`, kind: 'info', duration: 1500 })
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
