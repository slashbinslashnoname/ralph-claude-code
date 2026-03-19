/**
 * ralph.ts — all IPC handlers.
 *
 * Multi-project: watchers and loops are keyed by projectPath, not winId.
 * The RalphLoop TS engine replaces ralph_loop.sh entirely.
 */

import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { join }                                         from 'path'
import { exec }                                         from 'child_process'
import { existsSync, readFileSync, writeFileSync,
         appendFileSync, readdirSync, mkdirSync }       from 'fs'
import { promisify }                                    from 'util'
import chokidar, { FSWatcher }                          from 'chokidar'

import { RalphLoop }    from './loop/RalphLoop'
import { loadConfig }   from './loop/RcParser'
import { CircuitBreaker } from './loop/CircuitBreaker'
import {
  checkEnabled, detectProjectContext, enableRalph,
  EnableOptions
} from './loop/RalphEnabler'
import { SwarmOrchestrator } from './loop/SwarmOrchestrator'
import { AgentState }        from './loop/AgentCoordinator'

const execAsync = promisify(exec)

// ── Stores (keyed by projectPath) ──────────────────────────────────────────

const watchers = new Map<string, FSWatcher>()
const loops    = new Map<string, RalphLoop>()
const swarms   = new Map<string, SwarmOrchestrator>()

// ── Recent projects (userData JSON) ────────────────────────────────────────

const STORE = join(app.getPath('userData'), 'projects.json')
const readStore  = (): string[] => { try { return JSON.parse(readFileSync(STORE, 'utf8')) as string[] } catch { return [] } }
const addToStore = (p: string): void => writeFileSync(STORE, JSON.stringify([p, ...readStore().filter(x => x !== p)].slice(0, 20)))

// ── Broadcast to all windows ───────────────────────────────────────────────

function broadcast(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, ...args))
}

// ── Helpers ────────────────────────────────────────────────────────────────

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
const ralphDir = (p: string): string => join(p, '.ralph')

// ── IPC registration ────────────────────────────────────────────────────────

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {

  // ── Project ──────────────────────────────────────────────────────────────

  ipcMain.handle('project:select', async () => {
    const win = getMainWindow()
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Open Ralph project' })
    if (r.canceled) return null
    addToStore(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('project:recent', () => readStore())
  ipcMain.handle('project:add', (_e, p: string) => { addToStore(p); return true })

  // ── Status snapshot ───────────────────────────────────────────────────────

  ipcMain.handle('status:read', (_e, projectPath: string) => {
    const rd = ralphDir(projectPath)
    return {
      status:   readJson(join(rd, 'status.json')),
      progress: readJson(join(rd, 'progress.json')),
      circuit:  readJson(join(rd, '.circuit_breaker_state')),
      analysis: readJson(join(rd, '.response_analysis'))
    }
  })

  // ── File watchers ─────────────────────────────────────────────────────────

  function subscribeProject(projectPath: string): void {
    if (watchers.has(projectPath)) return  // already watching

    const rd = ralphDir(projectPath)
    if (!existsSync(rd)) return

    const watcher = chokidar.watch(rd, {
      ignoreInitial: true, depth: 1,
      ignored: ['**/.claude_session_id', '**/.ralph_session_history']
    })

    const push = (channel: string, file: string): void => {
      const data = readJson(join(rd, file))
      if (data) broadcast(channel, projectPath, data)
    }

    watcher.on('change', path => {
      const name = path.split('/').pop() ?? ''
      if (name === 'status.json')           push('status:update',   'status.json')
      if (name === 'progress.json')          push('progress:update', 'progress.json')
      if (name === '.circuit_breaker_state') push('circuit:update',  '.circuit_breaker_state')
      if (name === '.response_analysis')     push('analysis:update', '.response_analysis')
      if (name === 'fix_plan.md')            broadcast('fixplan:update', projectPath, readText(join(rd, 'fix_plan.md')))
    })

    // Log tailing
    const logFile = join(rd, 'logs', 'ralph.log')
    let logSize = existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0
    const logWatcher = chokidar.watch(logFile, { ignoreInitial: true })
    logWatcher.on('change', () => {
      const text = readText(logFile) ?? ''
      const newContent = text.slice(logSize)
      logSize = text.length
      if (newContent) broadcast('logs:lines', projectPath, newContent.split('\n').filter(Boolean))
    })
    ;(watcher as FSWatcher & { add(p: string): void }).add(logFile)

    watchers.set(projectPath, watcher)
  }

  ipcMain.handle('status:subscribe', (_e, projectPath: string) => subscribeProject(projectPath))

  ipcMain.handle('status:unsubscribe', (_e, projectPath: string) => {
    watchers.get(projectPath)?.close()
    watchers.delete(projectPath)
  })

  // ── Logs ──────────────────────────────────────────────────────────────────

  ipcMain.handle('logs:read', (_e, projectPath: string, lines: number = 200) => {
    const logFile = join(ralphDir(projectPath), 'logs', 'ralph.log')
    if (!existsSync(logFile)) return []
    return (readText(logFile) ?? '').split('\n').filter(Boolean).slice(-lines)
  })

  ipcMain.handle('logs:list', (_e, projectPath: string) => {
    const logsDir = join(ralphDir(projectPath), 'logs')
    if (!existsSync(logsDir)) return []
    return readdirSync(logsDir)
      .filter(f => f.endsWith('.log') && f !== 'ralph.log')
      .sort().reverse().slice(0, 30)
  })

  // ── File editor ───────────────────────────────────────────────────────────

  const EDITABLE = ['.ralphrc', '.ralph/PROMPT.md', '.ralph/fix_plan.md', '.ralph/AGENT.md']

  ipcMain.handle('file:read', (_e, projectPath: string, relPath: string) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    const c = readText(join(projectPath, relPath))
    return c !== null ? { ok: true, content: c } : { ok: false, error: 'File not found' }
  })

  ipcMain.handle('file:write', (_e, projectPath: string, relPath: string, content: string) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    try { writeFileSync(join(projectPath, relPath), content); return { ok: true } }
    catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // ── Ralph loop (TS engine) ────────────────────────────────────────────────

  ipcMain.handle('ralph:start', (_e, projectPath: string) => {
    if (loops.has(projectPath)) return { ok: false, error: 'Already running' }

    const loop = new RalphLoop(projectPath)

    loop.on('status',  s  => broadcast('status:update',   projectPath, s))
    loop.on('circuit', c  => broadcast('circuit:update',  projectPath, c))
    loop.on('log',     (level, msg) => broadcast('logs:lines', projectPath, [`[${new Date().toISOString()}] [${level}] ${msg}`]))
    loop.on('output',  chunk => broadcast('pty:data', projectPath, chunk))
    loop.on('exit',    (reason, detail) => {
      loops.delete(projectPath)
      broadcast('ralph:exit', projectPath, reason, detail)
    })

    loops.set(projectPath, loop)
    addToStore(projectPath)

    // Ensure file watchers are active — re-subscribe now that .ralph/ will exist
    // (the renderer may have called subscribeStatus before .ralph/ was created)
    if (!watchers.has(projectPath)) {
      // Small delay so _setup() finishes creating .ralph/logs/ before we watch
      setTimeout(() => subscribeProject(projectPath), 300)
    }

    // Start async — don't await so IPC returns immediately
    loop.start().catch((err: unknown) => {
      loops.delete(projectPath)
      broadcast('ralph:exit', projectPath, 'error', err instanceof Error ? err.message : String(err))
    })

    return { ok: true }
  })

  ipcMain.handle('ralph:stop', (_e, projectPath: string) => {
    loops.get(projectPath)?.stop()
    loops.delete(projectPath)
  })

  ipcMain.handle('ralph:running', (_e, projectPath: string) => loops.has(projectPath))

  // ── PTY write (pass-through to running loop's stdin — future use) ─────────
  // Currently the loop manages the Claude subprocess internally.
  // This channel is kept for future interactive terminal use.
  ipcMain.handle('pty:write', (_e, _projectPath: string, _data: string) => { /* no-op for now */ })
  ipcMain.handle('pty:resize', () => { /* no-op — internal loop, no PTY to resize */ })

  // ── Circuit breaker ───────────────────────────────────────────────────────

  ipcMain.handle('circuit:reset', (_e, projectPath: string) => {
    // Reset the running loop's circuit if active
    const loop = loops.get(projectPath)
    if (loop) {
      // Expose circuit reset via event — loop will pick it up next iteration
      // For now write directly (loop re-reads on next iteration)
    }
    try {
      const config  = loadConfig(projectPath)
      const circuit = new CircuitBreaker(ralphDir(projectPath), config)
      circuit.reset()
      broadcast('circuit:update', projectPath, circuit.snapshot())
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('session:reset', (_e, projectPath: string) => {
    const f = join(ralphDir(projectPath), '.claude_session_id')
    try { if (existsSync(f)) writeFileSync(f, ''); return { ok: true } }
    catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // ── Fix plan task injection ───────────────────────────────────────────────

  ipcMain.handle('fixplan:add-task', (_e, projectPath: string, task: string) => {
    const file = join(ralphDir(projectPath), 'fix_plan.md')
    if (!existsSync(file)) return { ok: false, error: 'fix_plan.md not found' }
    const trimmed = task.trim()
    if (!trimmed) return { ok: false, error: 'Task text is empty' }
    try {
      appendFileSync(file, `\n- [ ] ${trimmed}\n`)
      broadcast('fixplan:update', projectPath, readText(file))
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Ralph enable (replaces ralph_enable.sh) ──────────────────────────────

  ipcMain.handle('ralph:is-enabled', (_e, projectPath: string) => {
    return {
      ...checkEnabled(projectPath),
      context: detectProjectContext(projectPath)
    }
  })

  ipcMain.handle('ralph:enable', (_e, projectPath: string, opts: EnableOptions) => {
    return enableRalph(projectPath, opts)
  })

  // ── Beads ─────────────────────────────────────────────────────────────────

  ipcMain.handle('beads:check', async (_e, projectPath: string) => {
    if (!existsSync(join(projectPath, '.beads')))
      return { available: false, reason: 'No .beads directory found' }
    try { await execAsync('which bd'); return { available: true } }
    catch { return { available: false, reason: '`bd` command not found on PATH' } }
  })

  ipcMain.handle('beads:fetch', async (_e, projectPath: string, filter = 'open') => {
    const args = filter === 'all' ? ['list', '--json', '--all'] : ['list', '--json', '--status', filter]
    try {
      const { stdout } = await execAsync(`bd ${args.join(' ')}`, { cwd: projectPath })
      const raw = JSON.parse(stdout) as Record<string, unknown>[]
      if (!Array.isArray(raw)) throw new Error('Unexpected format')
      return {
        ok: true,
        tasks: raw.filter(t => t.id && t.title).map(t => ({
          id: String(t.id), title: String(t.title), status: String(t.status ?? 'open'),
          priority: t.priority !== undefined ? String(t.priority) : undefined,
          tags: Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : []
        }))
      }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] }
    }
  })

  // ── Shell ─────────────────────────────────────────────────────────────────

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // ── Swarm orchestrator ────────────────────────────────────────────────────

  function getOrCreateSwarm(projectPath: string): SwarmOrchestrator {
    if (swarms.has(projectPath)) return swarms.get(projectPath)!
    const swarm = new SwarmOrchestrator(projectPath)

    swarm.on('log', (level, msg, agentId) => {
      broadcast('logs:lines', projectPath, [`[${new Date().toISOString()}] [${level}] ${msg}`])
      broadcast('swarm:log', projectPath, level, msg, agentId ?? null)
    })
    swarm.on('output', (agentId, chunk) => {
      broadcast('pty:data',   projectPath, chunk)   // legacy single-terminal channel
      broadcast('swarm:output', projectPath, agentId, chunk)
    })
    swarm.on('graph', (stats, graph) => {
      broadcast('swarm:graph', projectPath, stats, graph)
    })
    swarm.on('agents', (agents: AgentState[]) => {
      broadcast('swarm:agents', projectPath, agents)
    })
    swarm.on('mail', msg => {
      broadcast('swarm:mail', projectPath, msg)
    })
    swarm.on('planPhase', phase => {
      broadcast('swarm:planPhase', projectPath, phase)
    })
    swarm.on('stopped', () => {
      swarms.delete(projectPath)
      broadcast('swarm:stopped', projectPath)
    })

    swarms.set(projectPath, swarm)
    return swarm
  }

  // Inject new tasks → Step 1 (Plan) + Step 2 (Encode)
  ipcMain.handle('swarm:inject', async (_e, projectPath: string, request: string) => {
    try {
      const swarm = getOrCreateSwarm(projectPath)
      // Don't await — runs async and broadcasts events
      swarm.injectTasks(request).catch((err: unknown) => {
        broadcast('swarm:log', projectPath, 'ERROR', err instanceof Error ? err.message : String(err), 'planner')
      })
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Start N workers → Steps 3–5 loop
  ipcMain.handle('swarm:start', (_e, projectPath: string, workerCount: number = 2) => {
    try {
      const swarm = getOrCreateSwarm(projectPath)
      swarm.startWorkers(workerCount)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Stop all workers
  ipcMain.handle('swarm:stop', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath)
    if (swarm) { swarm.stopAll(); swarms.delete(projectPath) }
    return { ok: true }
  })

  // Status snapshot
  ipcMain.handle('swarm:status', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath)
    if (!swarm) return { running: false, planning: false, workerCount: 0, agents: [], stats: null }
    return {
      running:     swarm.workerCount() > 0,
      planning:    swarm.isPlanning(),
      workerCount: swarm.workerCount(),
      agents:      swarm.getAgents(),
      stats:       swarm.getStats()
    }
  })

  // Graph + mail snapshots
  ipcMain.handle('swarm:graph', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath) ?? getOrCreateSwarm(projectPath)
    return swarm.getGraph()
  })

  ipcMain.handle('swarm:mail', (_e, projectPath: string, limit: number = 50) => {
    const swarm = swarms.get(projectPath) ?? getOrCreateSwarm(projectPath)
    return swarm.getMail(limit)
  })

  // ── Cleanup ───────────────────────────────────────────────────────────────

  ipcMain.handle('window:cleanup', (_e, projectPath?: string) => {
    if (projectPath) {
      watchers.get(projectPath)?.close(); watchers.delete(projectPath)
      loops.get(projectPath)?.stop();    loops.delete(projectPath)
      swarms.get(projectPath)?.stopAll(); swarms.delete(projectPath)
    } else {
      // Clean everything (window close)
      watchers.forEach(w => w.close()); watchers.clear()
      loops.forEach(l => l.stop());    loops.clear()
      swarms.forEach(s => s.stopAll()); swarms.clear()
    }
  })
}
