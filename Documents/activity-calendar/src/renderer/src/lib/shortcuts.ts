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
      if (ui.shortcutsOpen) {
        ui.closeShortcuts()
        e.preventDefault()
      }
      return
    }
    if (key === '?') {
      ui.toggleShortcuts()
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
