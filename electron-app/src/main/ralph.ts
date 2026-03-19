/**
 * ralph.ts — Ralph process manager, file watchers, and all IPC handlers.
 *
 * Registers every ipcMain.handle() channel so index.ts stays clean.
 */

import {
  ipcMain,
  BrowserWindow,
  dialog,
  app,
  shell
} from 'electron'
import { join } from 'path'
import { execFile, exec } from 'child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync
} from 'fs'
import { promisify } from 'util'
import chokidar, { FSWatcher } from 'chokidar'
import * as pty from 'node-pty'

const execAsync   = promisify(exec)
const execFileAsync = promisify(execFile)

// ── Recent projects store (plain JSON in userData) ─────────────────────────

const STORE_PATH = join(app.getPath('userData'), 'projects.json')

function readStore(): string[] {
  try { return JSON.parse(readFileSync(STORE_PATH, 'utf8')) } catch { return [] }
}
function addToStore(p: string): void {
  const list = [p, ...readStore().filter(x => x !== p)].slice(0, 20)
  writeFileSync(STORE_PATH, JSON.stringify(list))
}

// ── Per-window watcher registry ─────────────────────────────────────────────

const watchers = new Map<number, FSWatcher>()

function stopWatchers(winId: number): void {
  watchers.get(winId)?.close()
  watchers.delete(winId)
}

// ── PTY registry ────────────────────────────────────────────────────────────

type PtyEntry = { pty: pty.IPty; projectPath: string }
const ptys = new Map<number, PtyEntry>()

function stopPty(winId: number): void {
  ptys.get(winId)?.pty.kill()
  ptys.delete(winId)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function getRalphDir(projectPath: string): string {
  return join(projectPath, '.ralph')
}

/** Find the ralph_loop.sh script (bundled resources or global install) */
function findRalphScript(): string {
  // 1. Bundled in extraResources (production)
  const bundled = join(process.resourcesPath, 'ralph', 'ralph_loop.sh')
  if (existsSync(bundled)) return bundled
  // 2. Global install
  const global_ = join(process.env.HOME ?? '', '.ralph', 'ralph_loop.sh')
  if (existsSync(global_)) return global_
  // 3. Dev: sibling directory
  const dev = join(__dirname, '../../../../ralph_loop.sh')
  if (existsSync(dev)) return dev
  throw new Error('ralph_loop.sh not found. Run install.sh to install Ralph globally.')
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {

  // ── Project ──────────────────────────────────────────────────────────────

  ipcMain.handle('project:select', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Select Ralph project folder'
    })
    if (result.canceled) return null
    const p = result.filePaths[0]
    addToStore(p)
    return p
  })

  ipcMain.handle('project:recent', () => readStore())

  ipcMain.handle('project:add', (_e, p: string) => { addToStore(p); return true })

  // ── Status ───────────────────────────────────────────────────────────────

  ipcMain.handle('status:read', (_e, projectPath: string) => {
    const ralph = getRalphDir(projectPath)
    return {
      status:   readJson(join(ralph, 'status.json')),
      progress: readJson(join(ralph, 'progress.json')),
      circuit:  readJson(join(ralph, '.circuit_breaker_state')),
      analysis: readJson(join(ralph, '.response_analysis'))
    }
  })

  /** Subscribe to file-change events for a project. Replaces any prior watcher. */
  ipcMain.handle('status:subscribe', (_e, projectPath: string) => {
    const win = getMainWindow()
    if (!win) return

    stopWatchers(win.id)

    const ralph = getRalphDir(projectPath)
    if (!existsSync(ralph)) return

    const watcher = chokidar.watch(ralph, {
      ignoreInitial: true,
      depth: 1,
      ignored: ['**/*.log', '**/live.log', '**/.claude_session_id', '**/.ralph_session_history']
    })

    const push = (channel: string, file: string): void => {
      const data = readJson(join(ralph, file))
      if (data) win.webContents.send(channel, data)
    }

    watcher.on('change', path => {
      const name = path.split('/').pop() ?? ''
      if (name === 'status.json')             push('status:update', 'status.json')
      if (name === 'progress.json')            push('progress:update', 'progress.json')
      if (name === '.circuit_breaker_state')   push('circuit:update', '.circuit_breaker_state')
      if (name === '.response_analysis')       push('analysis:update', '.response_analysis')
      if (name === 'fix_plan.md')              win.webContents.send('fixplan:update', readText(join(ralph, 'fix_plan.md')))
    })

    watchers.set(win.id, watcher)

    // Also tail ralph.log for streaming log lines
    const logFile = join(ralph, 'logs', 'ralph.log')
    if (existsSync(logFile)) {
      let lastSize = 0
      const logWatcher = chokidar.watch(logFile, { ignoreInitial: true })
      logWatcher.on('change', () => {
        const text = readText(logFile) ?? ''
        const newContent = text.slice(lastSize)
        lastSize = text.length
        if (newContent) win.webContents.send('logs:lines', newContent.split('\n').filter(Boolean))
      })
      // Merge into same watcher so cleanup is automatic
      ;(watcher as FSWatcher & { add: (p: string) => void }).add(logFile)
    }
  })

  ipcMain.handle('status:unsubscribe', () => {
    const win = getMainWindow()
    if (win) stopWatchers(win.id)
  })

  // ── Logs ─────────────────────────────────────────────────────────────────

  ipcMain.handle('logs:read', (_e, projectPath: string, lines: number = 200) => {
    const logFile = join(getRalphDir(projectPath), 'logs', 'ralph.log')
    if (!existsSync(logFile)) return []
    const content = readText(logFile) ?? ''
    return content.split('\n').filter(Boolean).slice(-lines)
  })

  ipcMain.handle('logs:list', (_e, projectPath: string) => {
    const logsDir = join(getRalphDir(projectPath), 'logs')
    if (!existsSync(logsDir)) return []
    return readdirSync(logsDir)
      .filter(f => f.endsWith('.log') && f !== 'ralph.log')
      .sort()
      .reverse()
      .slice(0, 30)
  })

  // ── Files (config editor) ─────────────────────────────────────────────────

  const editableFiles = ['.ralphrc', '.ralph/PROMPT.md', '.ralph/fix_plan.md', '.ralph/AGENT.md']

  ipcMain.handle('file:read', (_e, projectPath: string, relPath: string) => {
    if (!editableFiles.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    const full = join(projectPath, relPath)
    const content = readText(full)
    return content !== null ? { ok: true, content } : { ok: false, error: 'File not found' }
  })

  ipcMain.handle('file:write', (_e, projectPath: string, relPath: string, content: string) => {
    if (!editableFiles.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    try {
      writeFileSync(join(projectPath, relPath), content, 'utf8')
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Ralph process ─────────────────────────────────────────────────────────

  ipcMain.handle('ralph:start', (_e, projectPath: string, args: string[] = []) => {
    const win = getMainWindow()
    if (!win) return { ok: false, error: 'No window' }

    if (ptys.has(win.id)) return { ok: false, error: 'Already running' }

    let script: string
    try { script = findRalphScript() }
    catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }

    const proc = pty.spawn('bash', [script, ...args], {
      name: 'xterm-256color',
      cwd: projectPath,
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    proc.onData(data => win.webContents.send('pty:data', data))
    proc.onExit(({ exitCode }) => {
      ptys.delete(win.id)
      win.webContents.send('ralph:exit', exitCode)
    })

    ptys.set(win.id, { pty: proc, projectPath })
    addToStore(projectPath)
    return { ok: true }
  })

  ipcMain.handle('ralph:stop', () => {
    const win = getMainWindow()
    if (!win) return
    const entry = ptys.get(win.id)
    if (entry) { entry.pty.kill('SIGTERM'); ptys.delete(win.id) }
  })

  ipcMain.handle('ralph:running', () => {
    const win = getMainWindow()
    return win ? ptys.has(win.id) : false
  })

  ipcMain.handle('pty:write', (_e, data: string) => {
    const win = getMainWindow()
    if (!win) return
    ptys.get(win.id)?.pty.write(data)
  })

  ipcMain.handle('pty:resize', (_e, cols: number, rows: number) => {
    const win = getMainWindow()
    if (!win) return
    ptys.get(win.id)?.pty.resize(cols, rows)
  })

  // ── Circuit breaker ───────────────────────────────────────────────────────

  ipcMain.handle('circuit:reset', async (_e, projectPath: string) => {
    try {
      await execAsync('ralph --reset-circuit', { cwd: projectPath })
      return { ok: true }
    } catch {
      // Fallback: write CLOSED state directly
      const file = join(getRalphDir(projectPath), '.circuit_breaker_state')
      const state = {
        state: 'CLOSED', last_change: new Date().toISOString(),
        consecutive_no_progress: 0, consecutive_same_error: 0,
        consecutive_permission_denials: 0, last_progress_loop: 0,
        total_opens: 0, reason: 'Manual reset via Ralph Desktop', current_loop: 0
      }
      try { writeFileSync(file, JSON.stringify(state, null, 2)); return { ok: true } }
      catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    }
  })

  ipcMain.handle('session:reset', async (_e, projectPath: string) => {
    try {
      await execAsync('ralph --reset-session', { cwd: projectPath })
      return { ok: true }
    } catch {
      const f = join(getRalphDir(projectPath), '.claude_session_id')
      try { if (existsSync(f)) writeFileSync(f, ''); return { ok: true } }
      catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    }
  })

  // ── Beads ─────────────────────────────────────────────────────────────────

  ipcMain.handle('beads:check', async (_e, projectPath: string) => {
    if (!existsSync(join(projectPath, '.beads')))
      return { available: false, reason: 'No .beads directory found' }
    try { await execAsync('which bd'); return { available: true } }
    catch { return { available: false, reason: '`bd` command not found on PATH' } }
  })

  ipcMain.handle('beads:fetch', async (_e, projectPath: string, filter: string = 'open') => {
    const args = ['list', '--json']
    if (filter === 'all') args.push('--all')
    else args.push('--status', filter)

    try {
      const { stdout } = await execFileAsync('bd', args, { cwd: projectPath })
      const raw = JSON.parse(stdout) as Record<string, unknown>[]
      if (!Array.isArray(raw)) throw new Error('Unexpected format')
      const tasks = raw
        .filter(t => t.id && t.title)
        .map(t => ({
          id: String(t.id), title: String(t.title), status: String(t.status ?? 'open'),
          priority: t.priority !== undefined ? String(t.priority) : undefined,
          tags: Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : []
        }))
      return { ok: true, tasks }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] }
    }
  })

  // ── Shell ─────────────────────────────────────────────────────────────────

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // ── Cleanup on window close ───────────────────────────────────────────────

  ipcMain.handle('window:cleanup', () => {
    const win = getMainWindow()
    if (!win) return
    stopWatchers(win.id)
    stopPty(win.id)
  })
}
