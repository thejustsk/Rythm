import { useEffect, useState } from 'react'
import { useUi } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { getThemePref, setThemePref, type ThemePref } from '@/state/theme'
import { APP_VERSION, BUILD_TAG } from '@shared/version'
import { T } from '@/lib/strings'
import { setPref } from '@/lib/prefs'
import { SHORTCUT_ROWS } from '@/lib/shortcuts'
import Coin from './Coin'

const THEMES: Array<{ id: ThemePref; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' }
]

const LEAD_OPTIONS = [5, 10, 15, 30, 60]

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

type Tab = 'general' | 'notifications' | 'about' | 'shortcuts'

/** Settings (M8 + v1.11): three tabs — General (appearance + calendar prefs),
 *  Notifications (B.2 — morning summary + slot reminders), About (backups). */
export default function SettingsDialog() {
  const ui = useUi()
  const toasts = useToasts.getState()
  const settingsTab = useUi((s) => s.settingsTab)
  const [tab, setTab] = useState<Tab>(settingsTab)
  const [theme, setTheme] = useState<ThemePref>('system')
  const [autoBackup, setAutoBackup] = useState(true)
  const [backupCount, setBackupCount] = useState(0)
  const [lastBackup, setLastBackup] = useState<string | null>(null)
  const [info, setInfo] = useState<{ version: string; dataDir: string; backupsDir: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // calendar prefs (live from the ui store)
  const weekStart = useUi((s) => s.weekStart)
  const clock24 = useUi((s) => s.clock24)
  const dayStartHour = useUi((s) => s.dayStartHour)
  const defaultDuration = useUi((s) => s.defaultDuration)
  // notification config
  const [notifOn, setNotifOn] = useState(true)
  const [slots, setSlots] = useState<string[]>(['09:00', '13:00', '18:00'])
  const [leadMin, setLeadMin] = useState(30)
  const [newSlot, setNewSlot] = useState('09:00')
  const [launchOn, setLaunchOn] = useState(false)

  useEffect(() => {
    void (async () => {
      setTheme(await getThemePref())
      const auto = await window.api.settings.get('autoBackup')
      setAutoBackup(auto !== '0')
      const last = await window.api.settings.get('lastBackup')
      setLastBackup(last)
      const list = await window.api.backups.list()
      setBackupCount(list.length)
      setInfo(await window.api.app.info())
      const cfg = await window.api.notify.getConfig()
      setNotifOn(cfg.enabled)
      setSlots(cfg.slots.length ? cfg.slots : ['09:00', '13:00', '18:00'])
      setLeadMin(cfg.leadMin)
      try { setLaunchOn(await window.api.app.getLaunchAtStartup()) } catch { setLaunchOn(false) }
    })()
  }, [])

  const saveNotify = async (patch: { enabled?: boolean; slots?: string[]; leadMin?: number }) => {
    const next = {
      enabled: patch.enabled ?? notifOn,
      slots: patch.slots ?? slots,
      leadMin: patch.leadMin ?? leadMin
    }
    if (patch.enabled !== undefined) setNotifOn(patch.enabled)
    if (patch.slots !== undefined) setSlots(patch.slots)
    if (patch.leadMin !== undefined) setLeadMin(patch.leadMin)
    await window.api.notify.setConfig(next)
  }

  const doBackup = async () => {
    setBusy(true)
    try {
      const res = await window.api.backups.now()
      if (res.ok) {
        setBackupCount(res.count)
        setLastBackup(res.lastBackup)
        toasts.push({ message: `Backup created — ${res.count} stored 🗄️`, kind: 'info', duration: 3500 })
      } else {
        toasts.push({ message: 'Backup failed — see the console', kind: 'danger', duration: 4000 })
      }
    } finally {
      setBusy(false)
    }
  }

  const pickTheme = async (t: ThemePref) => {
    setTheme(t)
    await setThemePref(t)
  }

  const toggleAuto = async () => {
    const next = !autoBackup
    setAutoBackup(next)
    await window.api.settings.set('autoBackup', next ? '1' : '0')
    toasts.push({ message: next ? 'Automatic daily backup ON' : 'Automatic daily backup OFF', kind: 'info', duration: 2500 })
  }

  const lastFmt = lastBackup
    ? new Date(lastBackup).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'never'

  const addSlot = async () => {
    if (!/^\d{2}:\d{2}$/.test(newSlot)) return
    if (slots.includes(newSlot)) return
    const next = [...slots, newSlot].sort()
    setNewSlot('09:00')
    await saveNotify({ slots: next })
  }
  const removeSlot = async (s: string) => {
    await saveNotify({ slots: slots.filter((x) => x !== s) })
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}>
      <div className="dialog settings-dialog">
        <div className="dialog-title">{T.settings.title}</div>

        <div className="set-tabs">
          <button className={`set-tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>
            {T.settings.general}
          </button>
          <button className={`set-tab${tab === 'notifications' ? ' active' : ''}`} onClick={() => setTab('notifications')}>
            {T.settings.notifications}
          </button>
          <button className={`set-tab${tab === 'shortcuts' ? ' active' : ''}`} onClick={() => setTab('shortcuts')}>
            Shortcuts
          </button>
          <button className={`set-tab${tab === 'about' ? ' active' : ''}`} onClick={() => setTab('about')}>
            {T.settings.about}
          </button>
        </div>

        {tab === 'general' && (
          <>
            <div className="set-section">
              <div className="set-title">{T.settings.appearance}</div>
              <div className="set-row">
                <span className="set-label">{T.settings.theme}</span>
                <div className="segmented accent theme-seg">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={`seg-btn${theme === t.id ? ' active' : ''}`}
                      onClick={() => void pickTheme(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-hint">{T.settings.themeHint}</div>
            </div>

            <div className="set-section">
              <div className="set-title">Calendar</div>
              <div className="set-row">
                <span className="set-label">First day of week</span>
                <div className="segmented accent">
                  <button
                    className={`seg-btn${weekStart === 'monday' ? ' active' : ''}`}
                    onClick={() => void setPref('weekStart', 'monday')}
                  >
                    Monday
                  </button>
                  <button
                    className={`seg-btn${weekStart === 'sunday' ? ' active' : ''}`}
                    onClick={() => void setPref('weekStart', 'sunday')}
                  >
                    Sunday
                  </button>
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">Clock</span>
                <div className="segmented accent">
                  <button className={`seg-btn${clock24 ? ' active' : ''}`} onClick={() => void setPref('clock24', true)}>
                    24-hour
                  </button>
                  <button className={`seg-btn${!clock24 ? ' active' : ''}`} onClick={() => void setPref('clock24', false)}>
                    12-hour (AM/PM)
                  </button>
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">Day starts at</span>
                <select
                  className="set-select"
                  value={dayStartHour}
                  aria-label="Day starts at hour"
                  onChange={(e) => void setPref('dayStartHour', parseInt(e.target.value, 10))}
                >
                  {Array.from({ length: 24 }, (_, h) => {
                    const label = clock24
                      ? `${String(h).padStart(2, '0')}:00`
                      : `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`
                    return (
                      <option key={h} value={h}>
                        {label}
                      </option>
                    )
                  })}
                </select>
                <span className="set-label muted">— the grid opens scrolled here</span>
              </div>
              <div className="set-row">
                <span className="set-label">Default activity length</span>
                <input
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  value={defaultDuration}
                  className="set-num"
                  aria-label="Default activity length in minutes"
                  onChange={(e) => void setPref('defaultDuration', Math.min(480, Math.max(5, parseInt(e.target.value, 10) || 60)))}
                />
                <span className="set-label muted">minutes</span>
              </div>
            </div>
          </>
        )}

        {tab === 'notifications' && (
          <div className="set-section">
            <div className="set-title">Windows notifications</div>
            <div className="set-row">
              <span className="set-label">Enable notifications</span>
              <button
                role="switch"
                aria-checked={notifOn}
                className={`switch${notifOn ? ' on' : ''}`}
                onClick={() => void saveNotify({ enabled: !notifOn })}
                title={notifOn ? 'On' : 'Off'}
              />
            </div>
            <div className="set-hint">
              <b>When you'll get notifications:</b>
              <br />• <b>Morning summary</b> — the first time Rhythm opens each day:
              "Good morning ☀️ — You have N activities planned today."
              <br />• <b>At each reminder time</b> — for activities starting within the
              next 2 hours: "Upcoming — Title at 10:00 (in 25 min)" (or "…and N more").
              <br />• <b>Right after opening</b> — if an activity starts within your lead
              time below, you get an Upcoming notification immediately.
              <br />• Every notification also appears inside Rhythm as a 🔔 toast, even
              if Windows blocks the system popup.
            </div>
            <div className="set-row">
              <span className="set-label">Start Rhythm with Windows</span>
              <button
                role="switch"
                aria-checked={launchOn}
                className={`switch${launchOn ? ' on' : ''}`}
                onClick={async () => {
                  const next = !launchOn
                  setLaunchOn(next)
                  const ok = await window.api.app.setLaunchAtStartup(next)
                  if (!ok) setLaunchOn(false)
                  toasts.push({ message: ok ? (next ? 'Rhythm will start with Windows' : 'Rhythm will not auto-start') : 'Not available on this system', kind: 'info', duration: 3000 })
                }}
                title={launchOn ? 'On' : 'Off'}
              />
            </div>
            <div className="set-row">
              <span className="set-label">Remind me before activities</span>
              <select
                className="set-select"
                value={leadMin}
                aria-label="Remind before activities"
                onChange={(e) => void saveNotify({ leadMin: parseInt(e.target.value, 10) })}
              >
                {LEAD_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </div>
            <div className="set-title" style={{ marginTop: 10 }}>
              Reminder times
            </div>
            <div className="notif-slots">
              {slots.length === 0 && <div className="set-hint">No reminder times set — add one below.</div>}
              {slots.map((s) => (
                <span key={s} className="notif-slot">
                  🕐 {s}
                  <button className="notif-slot-x" title="Remove" onClick={() => void removeSlot(s)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="set-row">
              <input
                type="time"
                className="set-num"
                value={newSlot}
                aria-label="New reminder time"
                onChange={(e) => setNewSlot(e.target.value)}
              />
              <button className="btn sm" onClick={() => void addSlot()}>
                Add time
              </button>
              <button
                className="btn sm"
                disabled={!notifOn}
                onClick={async () => {
                  const r = await window.api.notify.test()
                  if (r.ok) {
                    toasts.push({ message: 'Test notification sent ✓', kind: 'info', duration: 3000 })
                  } else {
                    toasts.push({
                      message: `Test failed (${r.reason}) — check Windows notification settings & focus assist`,
                      kind: 'danger',
                      duration: 6000
                    })
                  }
                }}
              >
                Test notification
              </button>
            </div>
          </div>
        )}

        {tab === 'shortcuts' && (
          <div className="set-section">
            <div className="set-title">Keyboard shortcuts</div>
            <div className="set-hint">Press ? anywhere to open this tab. Esc closes dialogs.</div>
            <div className="shortcut-rows">
              {SHORTCUT_ROWS.map((r, i) => (
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
          </div>
        )}

        {tab === 'about' && (
          <>
            <div className="set-section">
              <div className="set-title">{T.settings.backups}</div>
              <div className="set-row">
                <span className="set-label">Automatic daily backup</span>
                <button
                  role="switch"
                  aria-checked={autoBackup}
                  className={`switch${autoBackup ? ' on' : ''}`}
                  onClick={toggleAuto}
                  title={autoBackup ? 'On' : 'Off'}
                />
              </div>
              <div className="set-row">
                <span className="set-label">
                  {backupCount} stored · last {lastFmt}
                </span>
                <button className="btn sm" disabled={busy} onClick={() => void doBackup()}>
                  {busy ? T.settings.backingUp : T.settings.backUpNow}
                </button>
              </div>
              <div className="set-row">
                <span className="set-label">Your data lives in</span>
                <div className="set-actions">
                  <button className="btn sm" onClick={() => void window.api.app.openBackupsFolder()}>
                    {T.settings.backupsFolder}
                  </button>
                  <button className="btn sm" onClick={() => void window.api.app.openDataFolder()}>
                    {T.settings.dataFolder}
                  </button>
                </div>
              </div>
              <div className="set-hint">Backups are copies of your calendar + coins database, kept in the Backups folder (newest 14).</div>
            </div>

            <div className="set-section about">
              <div className="set-row">
                <span className="set-label">
                  <Coin size={16} /> {T.appName}
                </span>
                <span className="set-hint">
                  v{APP_VERSION} · {BUILD_TAG}
                </span>
              </div>
            </div>
          </>
        )}

        <div className="dialog-actions">
          <button className="btn primary" onClick={ui.closeSettings}>
            {T.settings.done}
          </button>
        </div>
      </div>
    </div>
  )
}
