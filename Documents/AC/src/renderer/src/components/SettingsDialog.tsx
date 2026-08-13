import { useEffect, useState } from 'react'
import { useUi } from '@/state/store'
import { useToasts } from '@/state/toasts'
import { getThemePref, setThemePref, type ThemePref } from '@/state/theme'
import { APP_VERSION, BUILD_TAG } from '@shared/version'
import Coin from './Coin'

const THEMES: Array<{ id: ThemePref; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' }
]

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Settings (M8): appearance (light/dark/system), automatic backups + manual
 *  backup, data-folder shortcuts, about. */
export default function SettingsDialog() {
  const ui = useUi()
  const toasts = useToasts.getState()
  const [theme, setTheme] = useState<ThemePref>('system')
  const [autoBackup, setAutoBackup] = useState(true)
  const [backupCount, setBackupCount] = useState(0)
  const [lastBackup, setLastBackup] = useState<string | null>(null)
  const [info, setInfo] = useState<{ version: string; dataDir: string; backupsDir: string } | null>(null)
  const [busy, setBusy] = useState(false)

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
    })()
  }, [])

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

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}>
      <div className="dialog settings-dialog">
        <div className="dialog-title">Settings</div>

        <div className="set-section">
          <div className="set-title">Appearance</div>
          <div className="set-row">
            <span className="set-label">Theme</span>
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
          <div className="set-hint">Dark mode protects your eyes in the evening. "System" follows Windows.</div>
        </div>

        <div className="set-section">
          <div className="set-title">Backups</div>
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
              {busy ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
          <div className="set-row">
            <span className="set-label">Your data lives in</span>
            <div className="set-actions">
              <button className="btn sm" onClick={() => void window.api.app.openBackupsFolder()}>
                Backups folder
              </button>
              <button className="btn sm" onClick={() => void window.api.app.openDataFolder()}>
                Data folder
              </button>
            </div>
          </div>
          <div className="set-hint">Backups are copies of your calendar + coins database, kept in the Backups folder (newest 14).</div>
        </div>

        <div className="set-section about">
          <div className="set-row">
            <span className="set-label">
              <Coin size={16} /> Rhythm
            </span>
            <span className="set-hint">
              v{APP_VERSION} · {BUILD_TAG}
            </span>
          </div>
        </div>

        <div className="dialog-actions">
          <button className="btn primary" onClick={ui.closeSettings}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
