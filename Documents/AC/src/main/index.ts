import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron'
import path from 'node:path'
import { openDatabase, getDataDir } from './db/connection'
import { migrate } from './db/schema'
import { seedIfEmpty } from './db/seed'
import { registerEventHandlers } from './ipc/events'
import { registerLabelHandlers } from './ipc/labels'
import { registerSettingsHandlers } from './ipc/settings'
import { registerGamifyHandlers } from './ipc/gamify'
import { registerWindowHandlers } from './ipc/window'

const isDev = !app.isPackaged

/** Resolve the stored theme (light/dark/system) to a concrete window
 *  background so the window never flashes white in dark mode. */
function windowBackgroundColor(db: ReturnType<typeof openDatabase>): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get() as { value: string } | undefined
    const pref = row?.value ?? 'system'
    const dark = pref === 'dark' || (pref === 'system' && nativeTheme.shouldUseDarkColors)
    return dark ? '#1C1C1E' : '#F5F5F7'
  } catch {
    return '#F5F5F7'
  }
}

function createWindow(db?: ReturnType<typeof openDatabase>): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: db ? windowBackgroundColor(db) : '#F5F5F7',
    title: 'Rhythm',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const query: Record<string, string> = {}
  if (process.env.AC_VIEW) query.view = process.env.AC_VIEW

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL + '?' + new URLSearchParams(query))
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
  }

  // Self-test hook: capture a screenshot (and optionally a DOM dump) then quit.
  if (process.env.AC_SCREENSHOT || process.env.AC_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      // FX harness: fire the score-fx so a screenshot can capture it mid-flight
      if (process.env.AC_PICKER) {
        setTimeout(() => {
          win.webContents
            .executeJavaScript("(() => { const t = document.querySelector('.mm-title'); if (t) t.click(); return !!t })()")
            .catch(() => {})
        }, 700)
      }
      if (process.env.AC_FX) {
        setTimeout(() => {
          win.webContents.executeJavaScript('window.__rhythmCoins2.fireScoreFx()').catch(() => {})
        }, 600)
      }
      if (process.env.AC_SCROLLTOP) {
        const target = Number(process.env.AC_SCROLLTOP)
        // fixed attempts (no infinite retry racing the capture)
        for (const t of [600, 2000, 3400]) {
          setTimeout(() => {
            win.webContents
              .executeJavaScript(
                "(() => { const s = document.querySelector('.agenda-view'); if (s) s.scrollTop = " + target + "; return !!s })()"
              )
              .catch(() => {})
          }, t)
        }
      }
      setTimeout(async () => {
        try {
          const fs = await import('node:fs')
          if (process.env.AC_SMOKE) {
            win.webContents.on('console-message', (_e, _l, message) => console.log('[renderer]', message))
            const { runSmoke } = await import('./smoke')
            await runSmoke(win, process.env.AC_SMOKE)
            app.quit()
            return
          }
          if (process.env.AC_DOM_DUMP) {
            const info = await win.webContents.executeJavaScript(`(() => {
              const q = (s) => document.querySelectorAll(s).length
              const text = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent.trim()).slice(0, 30)
              return {
                view: document.querySelector('.view-host') ? location.search : '',
                blocks: q('.eb'),
                monthCells: q('.day-cell'),
                dayCols: q('.day-col'),
                pills: q('.pill'),
                labels: q('.label-row'),
                agendaGroups: q('.agenda-group'),
                agendaTitles: Array.from(document.querySelectorAll('.agenda-title')).map((e) => e.textContent.trim()),
                firstBlockTexts: text('.eb-title'),
                nowLine: q('.now-line'),
                errors: window.__errors || [],
                intro: (() => {
                  const w = document.querySelector('.intro-word')
                  const m = document.querySelector('.intro-word-main')
                  if (!w) return null
                  const wr = w.getBoundingClientRect()
                  return {
                    rect: { x: Math.round(wr.x), y: Math.round(wr.y), w: Math.round(wr.width), h: Math.round(wr.height) },
                    opacity: getComputedStyle(w).opacity,
                    visibility: getComputedStyle(w).visibility,
                    color: m ? getComputedStyle(m).color : null,
                    clip: m ? getComputedStyle(m).webkitBackgroundClip || getComputedStyle(m).backgroundClip : null,
                    anim: m ? getComputedStyle(m).animationName : null,
                    text: m ? m.textContent : null
                  }
                })(),
                agendaTop: (() => {
                  const card = document.querySelector('.agenda-view')
                  if (!card) return null
                  const cr = card.getBoundingClientRect()
                  const titles = Array.from(document.querySelectorAll('.agenda-title')).map((t) => {
                    const r = t.getBoundingClientRect()
                    return { text: t.textContent, top: Math.round(r.top), h: Math.round(r.height), x: Math.round(r.left), w: Math.round(r.width), pos: getComputedStyle(t).position }
                  })
                  const probe = (() => { const el = document.elementFromPoint(cr.left + 60, cr.top + 12); return el ? el.className : 'none' })()
                  const t0 = document.querySelector('.agenda-title')
                  const cs = t0 ? getComputedStyle(t0) : null
                  return {
                    cardTop: Math.round(cr.top), titles, probe,
                    ml: cs ? cs.marginLeft : '', mr: cs ? cs.marginRight : '',
                    scrollTop: card ? Math.round(card.scrollTop) : -1,
                    grp: (() => {
                      const g = document.querySelector('.agenda-group')
                      if (!g) return null
                      const r = g.getBoundingClientRect()
                      const gc = getComputedStyle(g)
                      g.style.marginLeft = '-18px'
                      const r2 = g.getBoundingClientRect()
                      g.style.marginLeft = ''
                      const par = g.parentElement
                      return { x: Math.round(r.left), w: Math.round(r.width), ml: gc.marginLeft, after18: Math.round(r2.left), parent: par ? par.className : 'none' }
                    })()
                  }
                  return { cardTop: Math.round(cr.top), titles, probe }
                })(),
                streakCal: (() => {
                  return {
                    rows: Array.from(document.querySelectorAll('.streak-row')).map((r) => ({
                      cls: r.className,
                      done: Array.from(r.querySelectorAll('.streak-day.done')).length,
                      none: Array.from(r.querySelectorAll('.streak-day.none')).length
                    })),
                    perfectM: document.querySelectorAll('.streak-day.perfect-m').length
                  }
                })(),
                stickytest: (() => {
                  const v = document.querySelector('.agenda-view')
                  if (!v) return null
                  const out = []
                  for (const pos of [100, 250, 400, 550, 700]) {
                    v.scrollTop = pos
                    const t = document.querySelector('.agenda-title')
                    const r = t ? Math.round(t.getBoundingClientRect().top) : -1
                    out.push({ pos, titleTop: r, scrollTop: Math.round(v.scrollTop) })
                  }
                  v.scrollTop = 700
                  return out
                })(),
                ancestors: (() => {
                  const t = document.querySelector('.agenda-title')
                  if (!t) return []
                  const out = []
                  let el = t.parentElement
                  while (el && out.length < 8) {
                    const cs = getComputedStyle(el)
                    const r = el.getBoundingClientRect()
                    out.push({ cls: el.className, top: Math.round(r.top), overflowY: cs.overflowY, position: cs.position, maxH: cs.maxHeight })
                    el = el.parentElement
                  }
                  return out
                })(),
                overlapprobe: (() => {
                  const sb = document.querySelector('.sidebar')
                  const tc = document.querySelector('.today-card')
                  const tree = document.querySelector('.label-tree')
                  const rows = Array.from(document.querySelectorAll('.label-row'))
                  const sr = sb ? sb.getBoundingClientRect() : null
                  const tr = tc ? tc.getBoundingClientRect() : null
                  const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null
                  return {
                    sidebar: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom) } : null,
                    today: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom) } : null,
                    lastLabel: last ? { bottom: Math.round(last.bottom) } : null,
                    treeScroll: tree ? { ch: tree.clientHeight, sh: tree.scrollHeight } : null,
                    labelRows: rows.length
                  }
                })(),
                streakNum: (() => {
                  const c = document.querySelector('.streak-kpi')
                  const ms = window.__rhythmMilestones ? 0 : 0
                  return { kpi: c ? c.textContent : '' }
                })(),
                coin3d: (() => {
                  const coin = document.querySelector('.premium-heading .ph-icon .rhythm-coin')
                  if (!coin) return null
                  const r = coin.getBoundingClientRect()
                  const spin = coin.querySelector('.c3-spin')
                  const face = coin.querySelector('.c3-face.front')
                  const fr = face ? face.getBoundingClientRect() : null
                  return {
                    wrap: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                    spinAnim: spin ? getComputedStyle(spin).animationName : '',
                    spinTs: spin ? getComputedStyle(spin).transformStyle : '',
                    spinTransform: spin ? getComputedStyle(spin).transform : '',
                    face: fr ? { w: Math.round(fr.width), h: Math.round(fr.height) } : null,
                    segs: coin.querySelectorAll('.c3-seg').length,
                    wrapPerspective: getComputedStyle(coin).perspective
                  }
                })()
              }
            })()`)
            fs.writeFileSync(process.env.AC_DOM_DUMP!, JSON.stringify(info, null, 2))
            console.log('[domdump] saved to', process.env.AC_DOM_DUMP)
          }
          if (process.env.AC_SCREENSHOT !== 'none') {
            const image = await win.webContents.capturePage()
            fs.writeFileSync(process.env.AC_SCREENSHOT!, image.toPNG())
            console.log('[screenshot] saved to', process.env.AC_SCREENSHOT)
          }
        } catch (e) {
          console.error('[screenshot] failed', e)
        }
        app.quit()
      }, parseInt(process.env.AC_SHOT_DELAY || '2600', 10))
    })
  }

  return win
}

app.whenReady().then(async () => {
  console.log('[main] data dir:', getDataDir())
  const db = openDatabase()
  migrate(db)
  seedIfEmpty(db)

  registerEventHandlers(db)
  registerLabelHandlers(db)
  registerSettingsHandlers(db)
  registerGamifyHandlers(db)
  registerWindowHandlers()

  createWindow(db)

  // M8: automatic daily backup (once per 24h, when enabled)
  const { runAutoBackup } = await import('./backup')
  void runAutoBackup(db)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(db)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
