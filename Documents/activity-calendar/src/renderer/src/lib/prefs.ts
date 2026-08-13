/**
 * User preferences from Settings (item B.4): first day of week, week start
 * hour, 12/24h clock, default event duration. Loaded into the ui store once
 * at startup; Settings writes through the settings IPC and updates the store.
 */
import { useUi } from '@/state/store'

export interface Prefs {
  /** 'monday' | 'sunday' */
  weekStart: 'monday' | 'sunday'
  /** Hour (0-23) the day/week grid starts scrolled at. */
  dayStartHour: number
  /** true = 24h, false = 12h (AM/PM) */
  clock24: boolean
  /** Minutes for a new event's default duration. */
  defaultDuration: number
}

export const DEFAULT_PREFS: Prefs = {
  weekStart: 'monday',
  dayStartHour: 0,
  clock24: true,
  defaultDuration: 60
}

export async function loadPrefs(): Promise<Prefs> {
  const get = async (key: string, fallback: string): Promise<string> => {
    const v = await window.api.settings.get(key)
    return v ?? fallback
  }
  const [weekStart, dayStartHour, clock24, defaultDuration] = await Promise.all([
    get('weekStart', 'monday'),
    get('dayStartHour', '0'),
    get('clock24', '1'),
    get('defaultDuration', '60')
  ])
  const prefs: Prefs = {
    weekStart: weekStart === 'sunday' ? 'sunday' : 'monday',
    dayStartHour: Math.min(23, Math.max(0, parseInt(dayStartHour, 10) || 0)),
    clock24: clock24 !== '0',
    defaultDuration: Math.min(480, Math.max(5, parseInt(defaultDuration, 10) || 60))
  }
  useUi.getState().setPrefs(prefs)
  return prefs
}

/** Persist one pref (settings row + live store). */
export async function setPref(key: keyof Prefs, value: string | number | boolean): Promise<void> {
  // booleans are stored as '1'/'0' — the loader checks !== '0', so a literal
  // 'false' string would be read back as TRUE (v1.11 bug found by smoke)
  const v = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  await window.api.settings.set(key, v)
  await loadPrefs()
}
