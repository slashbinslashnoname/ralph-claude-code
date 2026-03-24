import { app, BrowserWindow, globalShortcut } from 'electron'
import * as path from 'path'
import { registerIpc, gracefulShutdown } from './ipc'
import { getIconPath } from './getIconPath'

let mainWindow: BrowserWindow | null = null

app.setName('Slashbot')

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    title: 'Slashbot',
    icon: getIconPath(),
    width: 1400,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

const storePath = path.join(app.getPath('userData'), 'projects.json')
const ipcHandle = registerIpc(() => mainWindow, storePath)

app.whenReady().then(() => {
  createWindow()

  // Kick off auto-update checks (~30 s delay, then every 4 h).
  // start() is a no-op in dev builds (app.isPackaged === false).
  ipcHandle.getAutoUpdater().start()

  if (process.env.ELECTRON_RENDERER_URL) {
    globalShortcut.register('F12', () => {
      mainWindow?.webContents.toggleDevTools()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let gracefulShutdownDone = false
app.on('before-quit', (event) => {
  // Prevent immediate quit — wait for graceful shutdown
  if (!gracefulShutdownDone) {
    event.preventDefault()
    gracefulShutdown(storePath).finally(() => {
      gracefulShutdownDone = true
      app.quit()
    })
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  app.quit()
})
