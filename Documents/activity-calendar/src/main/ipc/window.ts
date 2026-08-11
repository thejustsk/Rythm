import { BrowserWindow, ipcMain } from 'electron'

/** Register window control handlers (custom traffic-light titlebar). */
export function registerWindowHandlers(): void {
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  ipcMain.on('window:is-maximized', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    e.returnValue = win ? win.isMaximized() : false
  })
}

export function notifyMaximized(win: BrowserWindow): void {
  win.webContents.send('window:maximized', win.isMaximized())
}
