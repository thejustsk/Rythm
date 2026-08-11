import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { openDatabase, getDataDir } from './db/connection'
import { migrate } from './db/schema'
import { seedIfEmpty } from './db/seed'
import { registerEventHandlers } from './ipc/events'
import { registerLabelHandlers } from './ipc/labels'
import { registerSettingsHandlers } from './ipc/settings'
import { registerWindowHandlers } from './ipc/window'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#F5F5F7',
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
                errors: window.__errors || []
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
      }, 2600)
    })
  }

  return win
}

app.whenReady().then(() => {
  console.log('[main] data dir:', getDataDir())
  const db = openDatabase()
  migrate(db)
  seedIfEmpty(db)

  registerEventHandlers(db)
  registerLabelHandlers(db)
  registerSettingsHandlers(db)
  registerWindowHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
