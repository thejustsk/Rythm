import { useUi } from '@/state/store'
import { T } from '@/lib/strings'

const ROWS: Array<{ keys: string[]; label: string }> = [
  { keys: ['D', 'W', 'M', 'A'], label: 'Switch view (Day / Week / Month / Agenda)' },
  { keys: ['I'], label: 'Open Insights' },
  { keys: ['C'], label: 'Quick-add a new activity' },
  { keys: ['T'], label: 'Jump to today' },
  { keys: ['←', '→'], label: 'Previous / next day' },
  { keys: ['Shift', '←', '→'], label: 'Previous / next week' },
  { keys: ['?'], label: 'Open / close this sheet' },
  { keys: ['Esc'], label: 'Close dialogs & this sheet' }
]

/** Keyboard-shortcut cheat sheet (item B.5). */
export default function ShortcutSheet() {
  const ui = useUi()
  return (
    <div
      className="overlay shortcut-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && ui.closeShortcuts()}
    >
      <div className="dialog shortcut-sheet">
        <div className="dialog-title">{T.shortcutSheet.title}</div>
        <div className="shortcut-hint">{T.shortcutSheet.hint}</div>
        <div className="shortcut-rows">
          {ROWS.map((r, i) => (
            <div key={i} className="shortcut-row">
              <span className="shortcut-keys">
                {r.keys.map((k, j) => (
                  <kbd key={j} className="shortcut-key">
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="shortcut-label">{r.label}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn primary" onClick={ui.closeShortcuts}>
            {T.settings.done}
          </button>
        </div>
      </div>
    </div>
  )
}
