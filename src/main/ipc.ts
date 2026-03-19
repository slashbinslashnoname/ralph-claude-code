import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { promisify } from 'util'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

// Dynamic require to prevent rollup from bundling native fsevents module
const _require = createRequire(import.meta.url ?? __filename)
const chokidar: typeof import('chokidar') = _require('chokidar')
import { RalphLoop } from './loop/RalphLoop'
import { SwarmOrchestrator } from './loop/SwarmOrchestrator'
import { loadConfig } from './loop/RcParser'
import { CircuitBreaker } from './loop/CircuitBreaker'
import { checkEnabled, detectProjectContext, enableRalph } from './loop/RalphEnabler'
import { BdClient } from './loop/BdClient'
import { EnableOptions } from './types'

const execAsync = promisify(exec)

const watchers = new Map<string, chokidar.FSWatcher>()
const loops = new Map<string, RalphLoop>()
const swarms = new Map<string, SwarmOrchestrator>()

const STORE_PATH_PLACEHOLDER = '' // set in registerIpc

function broadcast(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, ...args))
}

const readJson = (filePath: string): unknown => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}
const readText = (filePath: string): string | null => {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
}
const ralphDir = (p: string): string => path.join(p, '.ralph')

export function registerIpc(
  getMainWindow: () => BrowserWindow | null,
  storePath: string
): void {
  const readStore = (): string[] => {
    try { return JSON.parse(fs.readFileSync(storePath, 'utf8')) } catch { return [] }
  }
  const addToStore = (p: string): void => {
    fs.writeFileSync(storePath, JSON.stringify(
      [p, ...readStore().filter(x => x !== p)].slice(0, 20)
    ))
  }

  const tabsPath = path.join(path.dirname(storePath), 'active-tabs.json')
  const readTabs = (): { paths: string[]; active: number } => {
    try { return JSON.parse(fs.readFileSync(tabsPath, 'utf8')) } catch { return { paths: [], active: 0 } }
  }
  const saveTabs = (tabs: { paths: string[]; active: number }): void => {
    fs.writeFileSync(tabsPath, JSON.stringify(tabs))
  }

  // ── Project management ──────────────────────────────────────────────────

  ipcMain.handle('project:select', async () => {
    const win = getMainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Open project'
    })
    if (r.canceled) return null
    addToStore(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('project:recent', () => readStore())

  ipcMain.handle('project:add', (_e, p: string) => {
    addToStore(p)
    return true
  })

  ipcMain.handle('project:active-tabs', () => readTabs())

  ipcMain.handle('project:save-tabs', (_e, tabs: { paths: string[]; active: number }) => {
    saveTabs(tabs)
    return true
  })

  // ── Status ──────────────────────────────────────────────────────────────

  ipcMain.handle('status:read', (_e, projectPath: string) => {
    const rd = ralphDir(projectPath)
    return {
      status: readJson(path.join(rd, 'status.json')),
      progress: readJson(path.join(rd, 'progress.json')),
      circuit: readJson(path.join(rd, '.circuit_breaker_state')),
      analysis: readJson(path.join(rd, '.response_analysis'))
    }
  })

  function subscribeProject(projectPath: string): void {
    if (watchers.has(projectPath)) return
    const rd = ralphDir(projectPath)
    if (!fs.existsSync(rd)) return

    const watcher = chokidar.watch(rd, {
      ignoreInitial: true,
      depth: 1,
      ignored: ['**/.claude_session_id', '**/.ralph_session_history']
    })

    const push = (channel: string, file: string): void => {
      const data = readJson(path.join(rd, file))
      if (data) broadcast(channel, projectPath, data)
    }

    watcher.on('change', (filePath: string) => {
      const name = filePath.split('/').pop() ?? ''
      if (name === 'status.json') push('status:update', 'status.json')
      if (name === 'progress.json') push('progress:update', 'progress.json')
      if (name === '.circuit_breaker_state') push('circuit:update', '.circuit_breaker_state')
      if (name === '.response_analysis') push('analysis:update', '.response_analysis')
    })

    const logFile = path.join(rd, 'logs', 'ralph.log')
    let logSize = fs.existsSync(logFile) ? (readText(logFile) ?? '').length : 0
    const logWatcher = chokidar.watch(logFile, { ignoreInitial: true })
    logWatcher.on('change', () => {
      const text = readText(logFile) ?? ''
      const newContent = text.slice(logSize)
      logSize = text.length
      if (newContent) broadcast('logs:lines', projectPath, newContent.split('\n').filter(Boolean))
    })

    watchers.set(projectPath, watcher)
  }

  ipcMain.handle('status:subscribe', (_e, projectPath: string) => subscribeProject(projectPath))
  ipcMain.handle('status:unsubscribe', (_e, projectPath: string) => {
    watchers.get(projectPath)?.close()
    watchers.delete(projectPath)
  })

  // ── Logs ────────────────────────────────────────────────────────────────

  ipcMain.handle('logs:read', (_e, projectPath: string, lines = 200) => {
    const logFile = path.join(ralphDir(projectPath), 'logs', 'ralph.log')
    if (!fs.existsSync(logFile)) return []
    return (readText(logFile) ?? '').split('\n').filter(Boolean).slice(-lines)
  })

  ipcMain.handle('logs:list', (_e, projectPath: string) => {
    const logsDir = path.join(ralphDir(projectPath), 'logs')
    if (!fs.existsSync(logsDir)) return []
    return fs.readdirSync(logsDir).filter(f => f.endsWith('.log') && f !== 'ralph.log').sort().reverse().slice(0, 30)
  })

  // ── File editor ─────────────────────────────────────────────────────────

  const EDITABLE = ['.ralphrc', '.ralph/PROMPT.md', '.ralph/AGENT.md']

  ipcMain.handle('file:read', (_e, projectPath: string, relPath: string) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    const c = readText(path.join(projectPath, relPath))
    return c !== null ? { ok: true, content: c } : { ok: false, error: 'File not found' }
  })

  ipcMain.handle('file:write', (_e, projectPath: string, relPath: string, content: string) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: 'Not an editable file' }
    try {
      fs.writeFileSync(path.join(projectPath, relPath), content)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Ralph loop ──────────────────────────────────────────────────────────

  ipcMain.handle('ralph:start', (_e, projectPath: string) => {
    if (loops.has(projectPath)) return { ok: false, error: 'Already running' }
    const loop = new RalphLoop(projectPath)
    loop.on('status', (s) => broadcast('status:update', projectPath, s))
    loop.on('circuit', (c) => broadcast('circuit:update', projectPath, c))
    loop.on('log', (level: string, msg: string) =>
      broadcast('logs:lines', projectPath, [`[${new Date().toISOString()}] [${level}] ${msg}`]))
    loop.on('output', (chunk: string) => broadcast('pty:data', projectPath, chunk))
    loop.on('exit', (reason: string, detail?: string) => {
      loops.delete(projectPath)
      broadcast('ralph:exit', projectPath, reason, detail)
    })
    loops.set(projectPath, loop)
    addToStore(projectPath)
    if (!watchers.has(projectPath)) setTimeout(() => subscribeProject(projectPath), 300)
    loop.start().catch(err => {
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

  // ── PTY (placeholder) ──────────────────────────────────────────────────

  ipcMain.handle('pty:write', () => {})
  ipcMain.handle('pty:resize', () => {})

  // ── Circuit breaker & session ──────────────────────────────────────────

  ipcMain.handle('circuit:reset', (_e, projectPath: string) => {
    try {
      const config = loadConfig(projectPath)
      const circuit = new CircuitBreaker(ralphDir(projectPath), config)
      circuit.reset()
      broadcast('circuit:update', projectPath, circuit.snapshot())
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('session:reset', (_e, projectPath: string) => {
    const f = path.join(ralphDir(projectPath), '.claude_session_id')
    try {
      if (fs.existsSync(f)) fs.writeFileSync(f, '')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Ralph enable ───────────────────────────────────────────────────────

  ipcMain.handle('ralph:is-enabled', (_e, projectPath: string) => ({
    ...checkEnabled(projectPath),
    context: detectProjectContext(projectPath)
  }))

  ipcMain.handle('ralph:enable', (_e, projectPath: string, opts: EnableOptions) =>
    enableRalph(projectPath, opts))

  // ── Beads via bd CLI ───────────────────────────────────────────────────

  ipcMain.handle('beads:check', async (_e, projectPath: string) => {
    const bd = new BdClient(projectPath)
    return bd.check()
  })

  ipcMain.handle('beads:list', async (_e, projectPath: string, filter = 'open') => {
    try {
      const bd = new BdClient(projectPath)
      const tasks = filter === 'all' ? bd.listAll() : bd.listByStatus(filter)
      return { ok: true, tasks }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] }
    }
  })

  ipcMain.handle('beads:show', async (_e, projectPath: string, id: string) => {
    try {
      const bd = new BdClient(projectPath)
      const task = bd.show(id)
      return task ? { ok: true, task } : { ok: false, error: 'Not found' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:create', async (_e, projectPath: string, opts: {
    title: string; type?: string; priority?: number; description?: string; labels?: string[]
  }) => {
    try {
      const bd = new BdClient(projectPath)
      const task = bd.create(opts as any)
      return { ok: true, task }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:update', async (_e, projectPath: string, id: string, opts: {
    priority?: number; claim?: boolean; unclaim?: boolean;
    title?: string; description?: string;
    labelsAdd?: string[]; labelsRemove?: string[]
  }) => {
    try {
      const bd = new BdClient(projectPath)
      bd.update(id, {
        priority: opts.priority,
        claim: opts.claim,
        unclaim: opts.unclaim,
        title: opts.title,
        description: opts.description,
        labels: { add: opts.labelsAdd, remove: opts.labelsRemove }
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:close', async (_e, projectPath: string, id: string, reason = 'Done') => {
    try {
      const bd = new BdClient(projectPath)
      bd.close(id, reason)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:reopen', async (_e, projectPath: string, id: string, reason = '') => {
    try {
      const bd = new BdClient(projectPath)
      bd.reopen(id, reason)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:ready', async (_e, projectPath: string) => {
    try {
      const bd = new BdClient(projectPath)
      return { ok: true, tasks: bd.ready() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] }
    }
  })

  ipcMain.handle('beads:stats', async (_e, projectPath: string) => {
    try {
      const bd = new BdClient(projectPath)
      return { ok: true, stats: bd.stats() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Shell ──────────────────────────────────────────────────────────────

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // ── Swarm orchestrator ─────────────────────────────────────────────────

  function getOrCreateSwarm(projectPath: string): SwarmOrchestrator {
    if (swarms.has(projectPath)) return swarms.get(projectPath)!
    const swarm = new SwarmOrchestrator(projectPath)
    swarm.on('log', (level: string, msg: string, agentId?: string) =>
      broadcast('swarm:log', projectPath, level, msg, agentId ?? null))
    swarm.on('output', (agentId: string, chunk: string) => {
      broadcast('pty:data', projectPath, chunk)
      broadcast('swarm:output', projectPath, agentId, chunk)
    })
    swarm.on('graph', (stats: unknown) => broadcast('swarm:graph', projectPath, stats, null))
    swarm.on('agents', (agents: unknown) => broadcast('swarm:agents', projectPath, agents))
    swarm.on('activity', (event: unknown) => broadcast('swarm:activity', projectPath, event))
    swarm.on('planPhase', (phase: string) => broadcast('swarm:planPhase', projectPath, phase))
    swarm.on('planQueue', (queue: unknown) => broadcast('swarm:planQueue', projectPath, queue))
    swarm.on('stopped', () => {
      swarms.delete(projectPath)
      broadcast('swarm:stopped', projectPath)
    })
    swarms.set(projectPath, swarm)
    return swarm
  }

  ipcMain.handle('swarm:inject', (_e, projectPath: string, request: string) => {
    try {
      const swarm = getOrCreateSwarm(projectPath)
      const { id } = swarm.injectPlan(request)
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:queue-remove', (_e, projectPath: string, id: string) => {
    const swarm = swarms.get(projectPath)
    if (!swarm) return { ok: false, error: 'No swarm' }
    return { ok: swarm.removeQueuedPlan(id) }
  })

  ipcMain.handle('swarm:queue', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath)
    return swarm ? swarm.getPlanQueue() : []
  })

  ipcMain.handle('swarm:start', (_e, projectPath: string, workerCount = 2) => {
    try {
      const swarm = getOrCreateSwarm(projectPath)
      swarm.startWorkers(workerCount)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:stop', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath)
    if (swarm) { swarm.stopAll(); swarms.delete(projectPath) }
    return { ok: true }
  })

  ipcMain.handle('swarm:status', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath)
    if (!swarm) return { running: false, planning: false, workerCount: 0, agents: [], stats: null }
    return {
      running: swarm.workerCount() > 0,
      planning: swarm.isPlanning(),
      workerCount: swarm.workerCount(),
      agents: swarm.getAgents(),
      stats: swarm.getStats()
    }
  })

  ipcMain.handle('swarm:beads', (_e, projectPath: string, status?: string) => {
    const swarm = swarms.get(projectPath) ?? getOrCreateSwarm(projectPath)
    if (status && status !== 'all') return swarm.getBeads(status)
    return swarm.getBeads()
  })

  ipcMain.handle('swarm:bead-stats', (_e, projectPath: string) => {
    const swarm = swarms.get(projectPath) ?? getOrCreateSwarm(projectPath)
    return swarm.getStats()
  })

  ipcMain.handle('swarm:activity', (_e, projectPath: string, limit = 50) => {
    const swarm = swarms.get(projectPath) ?? getOrCreateSwarm(projectPath)
    return swarm.getActivity(limit)
  })

  ipcMain.handle('swarm:agent-output', (_e, projectPath: string, agentId: string) => {
    const swarm = swarms.get(projectPath)
    if (swarm) return swarm.getAgentOutput(agentId)
    // Fallback: read from disk even without active swarm
    const logFile = path.join(ralphDir(projectPath), 'logs', `${agentId}.log`)
    return readText(logFile) ?? ''
  })

  // ── Cleanup ────────────────────────────────────────────────────────────

  ipcMain.handle('window:cleanup', (_e, projectPath?: string) => {
    if (projectPath) {
      watchers.get(projectPath)?.close(); watchers.delete(projectPath)
      loops.get(projectPath)?.stop(); loops.delete(projectPath)
      swarms.get(projectPath)?.stopAll(); swarms.delete(projectPath)
    } else {
      watchers.forEach(w => w.close()); watchers.clear()
      loops.forEach(l => l.stop()); loops.clear()
      swarms.forEach(s => s.stopAll()); swarms.clear()
    }
  })
}
