import { app, BrowserWindow, ipcMain, shell, nativeTheme, Tray, Menu, nativeImage } from 'electron'
import { APP_VERSION } from '../shared/version'
import path from 'node:path'
import fs from 'node:fs'
import { openDatabase, getDataDir } from './db/connection'
import { migrate } from './db/schema'
import { seedIfEmpty } from './db/seed'
import { registerEventHandlers } from './ipc/events'
import { registerLabelHandlers } from './ipc/labels'
import { registerSettingsHandlers } from './ipc/settings'
import { registerGamifyHandlers } from './ipc/gamify'
import { registerWindowHandlers } from './ipc/window'
import { registerNotificationHandlers, startNotifier, runRemindOnce } from './notify'
import { registerTrashHandlers } from './ipc/trash'
import { runAutoBackup } from './backup'
import { runSmoke } from './smoke'

const isDev = !app.isPackaged

/** v1.11.17: main-process safety net. If anything ever throws in main, the
 *  FULL error is written to main-errors.log next to the database (so we can
 *  always diagnose it) and an in-app toast tells the user — instead of the
 *  scary native "A JavaScript error occurred" dialog. The app keeps running.
 *  This replaced the old dynamic `import('./backup')` pattern that could hit
 *  module-resolution failures in the portable temp folder on reopen. */
const mainErrorLog = path.join(getDataDir(), 'main-errors.log')
function logMainError(tag: string, err: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${tag}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    fs.appendFileSync(mainErrorLog, line)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('notify:inapp', {
          title: 'Rhythm note',
          body: 'Something went wrong in the background. Everything keeps working — details were saved to main-errors.log.'
        })
      }
    }
  } catch {
    /* the safety net must never throw */
  }
}
process.on('uncaughtException', (e) => logMainError('uncaughtException', e))
process.on('unhandledRejection', (e) => logMainError('unhandledRejection', e))

/** v1.11.4: the app keeps running in the SYSTEM TRAY when the window is
 *  closed, so notifications keep firing (slot reminders etc.) even with the
 *  window "off". Quit via the tray menu. */
let quitting = false
let tray: Tray | null = null
let mainWin: BrowserWindow | null = null

function setupTray(): void {
  if (tray) return
  try {
  const img = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }))
  tray.setToolTip('Rhythm — running (notifications on)')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Rhythm', click: () => { if (mainWin) { mainWin.show(); mainWin.focus() } } },
      { type: 'separator' },
      { label: 'Quit Rhythm', click: () => { quitting = true; app.quit() } }
    ])
  )
  tray.on('click', () => { if (mainWin) { mainWin.show(); mainWin.focus() } })
  } catch (e) {
    console.log('[tray] not available:', e)
  }
}

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


/** v1.11.6: Windows toasts need a Start Menu shortcut carrying the app's
 *  AppUserModelID. Installed (NSIS) builds get one automatically, but the
 *  PORTABLE exe does not — so OS notifications silently fail there. This
 *  creates the shortcut (with the AUMID property) on first run.
 *  Pure best-effort: any failure is logged and ignored (in-app toasts still
 *  work regardless). */
/** v1.11.7: register Windows Task-Scheduler tasks so reminders can fire even
 *  when the app is fully closed. At each slot, the OS starts the app hidden
 *  ("--remind"); the app checks for due events, shows the OS toast, and
 *  exits if nothing is due. Best-effort: any failure is logged and the
 *  in-app toasts still work regardless. */
function syncReminderTasks(db: ReturnType<typeof openDatabase>): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  try {
    const cfg = readNotifyConfig(db)
    if (!cfg.enabled || cfg.slots.length === 0) return
    const exe = process.execPath
    const { execFile } = require('node:child_process') as typeof import('node:child_process')
    for (const slot of cfg.slots) {
      const [h, m] = slot.split(':').map(Number)
      if (isNaN(h) || isNaN(m)) continue
      const name = `Rhythm-reminder-${h}-${m}`
      // register a daily task that runs the app hidden at HH:MM
      const ps = `
$action = New-ScheduledTaskAction -Execute '${exe.replace(/'/g, "''")}' -Argument '--remind'
$trigger = New-ScheduledTaskTrigger -Daily -At ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName '${name}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
`
      const psPath = path.join(app.getPath('temp'), `rhythm-task-${h}-${m}.ps1`)
      require('node:fs').writeFileSync(psPath, ps, 'utf8')
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], { timeout: 15000 }, (err) => {
        if (err) console.log(`[remind] task ${name} failed:`, err.message)
        else console.log(`[remind] task ${name} registered`)
      })
    }
  } catch (e) {
    console.log('[remind] sync failed:', e)
  }
}

import { readConfig as readNotifyConfig } from './notify'

function ensureNotificationShortcut(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const { execFile } = require('node:child_process') as typeof import('node:child_process')
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Rhythm.lnk')
  const exe = process.execPath.replace(/'/g, "''")
  const appId = 'com.rhythm.calendar'
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnk}')
$sc.TargetPath = '${exe}'
$sc.WorkingDirectory = [System.IO.Path]::GetDirectoryName('${exe}')
$sc.Save()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Aumid {
  [StructLayout(LayoutKind.Sequential)]
  struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr val; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out IntPtr key);
    int GetValue(ref IntPtr key, out IntPtr pv);
    int SetValue(ref IntPtr key, ref IntPtr pv);
    int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, uint flags, ref Guid riid, out IntPtr ppv);
  public static void Set(string lnk, string appId) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IntPtr ppv;
    if (SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 0, ref iid, out ppv) != 0) return;
    var store = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv);
    PROPERTYKEY key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    IntPtr kp = Marshal.AllocHGlobal(Marshal.SizeOf(key));
    Marshal.StructureToPtr(key, kp, false);
    PROPVARIANT pv = new PROPVARIANT { vt = 31, val = Marshal.StringToCoTaskMemUni(appId) };
    store.SetValue(ref kp, ref pv);
    store.Commit();
  }
}
"@
[Aumid]::Set('${lnk}', '${appId}')
`
  const psPath = path.join(app.getPath('temp'), 'rhythm-notify-shortcut.ps1')
  try {
    require('node:fs').writeFileSync(psPath, ps, 'utf8')
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], { timeout: 15000 }, (err) => {
      if (err) console.log('[notify] shortcut setup failed (toasts may need the installer):', err.message)
      else console.log('[notify] Start Menu shortcut with AUMID ensured:', lnk)
    })
  } catch (e) {
    console.log('[notify] shortcut setup error:', e)
  }
}


function createWindow(db?: ReturnType<typeof openDatabase>): BrowserWindow {
  const win = new BrowserWindow({
    width: process.env.AC_WIN_W ? Number(process.env.AC_WIN_W) : 1380,
    height: process.env.AC_WIN_H ? Number(process.env.AC_WIN_H) : 880,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: db ? windowBackgroundColor(db) : '#F5F5F7',
    // v1.11.6: the OS/taskbar window title is "Rhythm vX.Y.Z" — no ".exe",
    // no "activity-calendar" — so the taskbar never shows an extension
    title: `Rhythm v${APP_VERSION}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // v1.11.18 (audit): renderer fully sandboxed — the preload only uses
      // contextBridge + ipcRenderer, both fully supported in the sandbox
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  mainWin = win


  // v1.11.4: closing the window hides it to the tray instead of quitting —
  // notifications stay ON. Quit via the tray menu (or app.quit()).
  win.on('close', async (e) => {
    // harness mode (smoke/screenshot) must be able to quit normally
    if (process.env.AC_SMOKE || process.env.AC_SCREENSHOT) return
    // v1.11.10: in DEV (npm run dev) closing the window QUITS the app so the
    // terminal returns to the prompt. The tray keep-alive is only for the
    // packaged app (reminders need it); in dev it just hangs the terminal.
    if (!app.isPackaged) return
    if (!quitting) {
      e.preventDefault()
      // v1.11.16: SAVE + BACK UP before hiding — nothing is ever lost when
      // the window closes (WAL checkpoint flushes the write-ahead log, then
      // a forced backup snapshots the database).
      if (db) {
        try {
          db.pragma('wal_checkpoint(PASSIVE)')
        } catch { /* non-fatal */ }
        try {
          void runAutoBackup(db, true)
        } catch { /* non-fatal */ }
      }
      win.hide()
      // tell the user once, via the in-app channel (renders if visible)
      try {
        win.webContents.send('notify:inapp', {
          title: 'Rhythm stays on — saved & backed up',
          body: 'Everything is saved. Rhythm keeps running in the tray so reminders keep working. Use Quit in the tray to stop it.'
        })
      } catch { /* window hidden is fine */ }
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // v1.11.18 (audit): only ever open http(s) links externally — anything
    // else (file:, javascript:, custom schemes) is denied outright
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(url)
    } catch {
      /* malformed — deny */
    }
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
      if (process.env.AC_EDGE) {
        // debug: dispatch a hard wheel at the top of the day/week grid and log
        // the title before/after (edge-nav verification)
        setTimeout(() => {
          win.webContents
            .executeJavaScript(`(async () => {
              const body = document.querySelector('.week-body')
              const title = () => document.querySelector('.tb-title')?.textContent ?? ''
              const before = title()
              let fired = false
              if (body) {
                body.addEventListener('wheel', () => { fired = true }, { once: true })
                body.scrollTop = 0
                body.dispatchEvent(new WheelEvent('wheel', { deltaY: -220, bubbles: true, cancelable: true }))
              }
              await new Promise((r) => setTimeout(r, 1000))
              return { before, after: title(), fired, hasBody: !!body, st: body ? body.scrollTop : -1, ch: body ? body.clientHeight : -1, sh: body ? body.scrollHeight : -1 }
            })()`)
            .then((v) => console.log('[edge-probe]', JSON.stringify(v)))
            .catch((e) => console.log('[edge-probe] error', String(e).slice(0, 200)))
        }, 2500)
      }
      setTimeout(async () => {
        try {
          if (process.env.AC_SMOKE) {
            win.webContents.on('console-message', (_e, _l, message) => console.log('[renderer]', message))
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
                weekGeo: (() => {
                  const body = document.querySelector('.week-body')
                  if (!body) return null
                  const br = body.getBoundingClientRect()
                  const head = body.querySelector('.week-head')
                  const hr = head ? head.getBoundingClientRect() : null
                  const grid = body.querySelector('.week-grid')
                  const gr = grid ? grid.getBoundingClientRect() : null
                  const cols = Array.from(body.querySelectorAll('.day-col')).map((c) => {
                    const r = c.getBoundingClientRect()
                    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
                  })
                  const ebs = Array.from(body.querySelectorAll('.eb')).map((e) => {
                    const r = e.getBoundingClientRect()
                    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
                  })
                  const gutter = body.querySelector('.week-gutter')
                  const gur = gutter ? gutter.getBoundingClientRect() : null
                  return {
                    body: { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width), scrollW: body.scrollWidth, clientW: body.clientWidth, scrollH: body.scrollHeight, clientH: body.clientHeight, overflowX: getComputedStyle(body).overflowX },
                    head: hr ? { left: Math.round(hr.left), right: Math.round(hr.right), w: Math.round(hr.width), top: Math.round(hr.top), pos: getComputedStyle(head).position } : null,
                    grid: gr ? { left: Math.round(gr.left), right: Math.round(gr.right), w: Math.round(gr.width) } : null,
                    gutter: gur ? { left: Math.round(gur.left), right: Math.round(gur.right) } : null,
                    cols,
                    ebs
                  }
                })(),
                streakCal: (() => {
                  const cov = document.querySelector('.streak-day.cover')
                  const ccs = cov ? getComputedStyle(cov) : null
                  const anc = []
                  let el = cov ? cov.parentElement : null
                  while (el && anc.length < 8) {
                    const cs = getComputedStyle(el)
                    const r = el.getBoundingClientRect()
                    anc.push({ cls: String(el.className).slice(0, 40), transform: cs.transform, opacity: cs.opacity, filter: cs.filter, willChange: cs.willChange, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
                    el = el.parentElement
                  }
                  const cr = cov ? cov.getBoundingClientRect() : null
                  return {
                    rows: Array.from(document.querySelectorAll('.streak-row')).map((r) => ({
                      cls: r.className,
                      done: Array.from(r.querySelectorAll('.streak-day.done')).length,
                      none: Array.from(r.querySelectorAll('.streak-day.none')).length
                    })),
                    perfectM: document.querySelectorAll('.streak-day.perfect-m').length,
                    coverStyle: ccs ? { outline: ccs.outline, offset: ccs.outlineOffset, shadow: ccs.boxShadow, cls: cov.className, transform: ccs.transform, opacity: ccs.opacity, filter: ccs.filter, width: ccs.width, height: ccs.height, rect: cr ? { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } : null } : null,
                    ancestors: anc,
                    dots: Array.from(document.querySelectorAll('.streak-row .streak-day')).map((d) => {
                      const r = d.getBoundingClientRect()
                      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: d.className, txt: d.textContent }
                    })
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
            win.webContents.invalidate() // force a full repaint before capture
            await new Promise((r) => setTimeout(r, 250))
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

// v1.11.14: only ONE app instance — clicking the exe again focuses the open
// window instead of opening a second one
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
    }
  })
}

app.whenReady().then(async () => {
  // Windows: notifications need a stable AppUserModelID
  app.setName('Rhythm')
  if (process.platform === 'win32') app.setAppUserModelId('com.rhythm.calendar')
  ensureNotificationShortcut() // portable builds have no Start Menu shortcut → toasts silently fail

  // v1.11.7: started by the Task Scheduler with --remind → show a toast for
  // any event starting within the lead time, then exit (no window)
  if (process.argv.includes('--remind')) {
    try {
      const db = openDatabase()
      migrate(db)
      runRemindOnce(db)
    } catch (e) {
      logMainError('remind', e)
    }
    setTimeout(() => app.quit(), 4000)
    return
  }
  console.log('[main] data dir:', getDataDir())
  const db = openDatabase()
  migrate(db)
  seedIfEmpty(db)
  syncReminderTasks(db)

  registerEventHandlers(db)
  registerLabelHandlers(db)
  registerSettingsHandlers(db)
  registerGamifyHandlers(db)
  registerWindowHandlers()
  registerNotificationHandlers(db)
  registerTrashHandlers(db)

  // v1.11.4: Windows — launch at login toggle
  ipcMain.handle('app:getLaunchAtStartup', () => {
    if (process.platform !== 'win32') return false
    try { return app.getLoginItemSettings().openAtLogin } catch { return false }
  })
  ipcMain.handle('app:setLaunchAtStartup', (_e, on: boolean) => {
    if (process.platform === 'win32') {
      try { app.setLoginItemSettings({ openAtLogin: on }) } catch { return false }
    }
    return process.platform === 'win32'
  })

  createWindow(db)
  setupTray()

  // M8: automatic backup — once at launch, then re-checked EVERY HOUR while
  // the app is in use; a forced backup also runs as the app closes (v1.11.14).
  // v1.11.17: statically imported + protected — a backup hiccup must never
  // take the app down (this was an unprotected dynamic import before).
  try {
    void runAutoBackup(db)
  } catch (e) {
    logMainError('startup backup', e)
  }
  setInterval(() => {
    try {
      void runAutoBackup(db)
    } catch (e) {
      logMainError('hourly backup', e)
    }
  }, 3600 * 1000)
  let backupOnCloseDone = false
  app.on('before-quit', (e) => {
    if (process.env.AC_SMOKE || process.env.AC_SCREENSHOT) return // harness quits instantly
    if (backupOnCloseDone) return
    e.preventDefault()
    backupOnCloseDone = true
    void runAutoBackup(db, true).finally(() => app.quit())
  })
  // B.2: OS notifications — morning summary (first time on each day) + slot reminders
  startNotifier(db)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(db)
  })
})

app.on('window-all-closed', () => {
  // v1.11.10: quit when the window is really gone — always in dev (so the
  // terminal returns), and in the packaged app only after an explicit Quit
  // (the tray keeps the packaged app alive for reminders otherwise)
  if (process.platform !== 'darwin' && (quitting || !app.isPackaged)) app.quit()
})
