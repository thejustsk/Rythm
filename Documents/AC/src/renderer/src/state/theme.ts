/** Theme (M8): light / dark / system, persisted in the settings table.
 *  `system` is resolved via matchMedia and re-applied when the OS theme
 *  changes. The resolved value lives on <html data-theme="…"> so the CSS
 *  tokens can switch everything in one place. */
export type ThemePref = 'light' | 'dark' | 'system'

const KEY = 'theme'
let media: MediaQueryList | null = null
let mediaCb: ((e: MediaQueryListEvent) => void) | null = null

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }
  return pref
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref)
  // follow OS changes only when the user chose "system"
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  if (mediaCb) {
    media?.removeEventListener?.('change', mediaCb)
    mediaCb = null
  }
  if (pref === 'system') {
    mediaCb = () => {
      document.documentElement.dataset.theme = resolveTheme('system')
    }
    mql.addEventListener('change', mediaCb)
    media = mql
  }
}

export async function loadTheme(): Promise<void> {
  const stored = await window.api.settings.get(KEY)
  applyTheme((stored as ThemePref) || 'system')
}

export async function setThemePref(pref: ThemePref): Promise<void> {
  await window.api.settings.set(KEY, pref)
  applyTheme(pref)
}

export async function getThemePref(): Promise<ThemePref> {
  const stored = await window.api.settings.get(KEY)
  return (stored as ThemePref) || 'system'
}

// Test hook for the automated smoke suite — harmless in production.
;(window as unknown as { __rhythmTheme: { loadTheme: () => Promise<void> } }).__rhythmTheme = { loadTheme }
