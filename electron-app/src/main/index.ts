import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, resolve } from 'path'
import { execFile, exec } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

// ──────────────────────────────────────────────────────────────
// Window
// ──────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ──────────────────────────────────────────────────────────────
// IPC: Project folder selection
// ──────────────────────────────────────────────────────────────

ipcMain.handle('project:select', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Ralph project folder'
  })
  return result.canceled ? null : result.filePaths[0]
})

// ──────────────────────────────────────────────────────────────
// IPC: Beads
// ──────────────────────────────────────────────────────────────

/** Check whether a project folder has Beads set up and `bd` on PATH */
ipcMain.handle('beads:check', async (_e, projectPath: string) => {
  const hasDir = existsSync(join(projectPath, '.beads'))
  if (!hasDir) return { available: false, reason: 'No .beads directory found' }

  try {
    await execAsync('which bd')
    return { available: true }
  } catch {
    return { available: false, reason: '`bd` command not found on PATH' }
  }
})

/** Fetch tasks from `bd list --json [--status <filter>]` */
ipcMain.handle('beads:fetch', async (_e, projectPath: string, filter: string = 'open') => {
  const args = ['list', '--json']
  if (filter !== 'all') args.push('--status', filter)
  else args.push('--all')

  try {
    const { stdout } = await execFileAsync('bd', args, { cwd: projectPath })
    const raw: unknown = JSON.parse(stdout)
    if (!Array.isArray(raw)) throw new Error('Unexpected response format from bd')

    const tasks = (raw as Record<string, unknown>[])
      .filter(t => t.id && t.title)
      .map(t => ({
        id: String(t.id),
        title: String(t.title),
        status: String(t.status ?? 'open'),
        priority: t.priority !== undefined ? String(t.priority) : undefined,
        tags: Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : []
      }))

    return { ok: true, tasks }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg, tasks: [] }
  }
})

/** Open a URL in the system browser */
ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
