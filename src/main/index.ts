import { app, BrowserWindow, globalShortcut } from 'electron'
import * as path from 'path'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    title: 'Slashbot',
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
registerIpc(() => mainWindow, storePath)

app.whenReady().then(() => {
  createWindow()

  if (process.env.ELECTRON_RENDERER_URL) {
    globalShortcut.register('F12', () => {
      mainWindow?.webContents.toggleDevTools()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
