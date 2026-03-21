import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { promisify } from 'util'
import { exec, execSync } from 'child_process'
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
import {
  validateBeadsList,
  validateBeadsCreate,
  validateBeadsUpdate,
  validateBeadId,
  validateProjectPath,
} from './loop/beadValidation'
import { validateConfigRead, validateConfigWrite } from './loop/configValidation'
import { validateProjectPathArg, validateSaveTabs } from './loop/projectValidation'
import { validateTelegramProjectPath, validateTelegramConfigure } from './loop/telegramValidation'
import { TelegramBot } from './loop/TelegramBot'
import { TelegramBridge } from './loop/TelegramBridge'
import {
  validateSwarmStart,
  validateSwarmStop,
  validateSwarmInject,
  validateSwarmQueueRemove,
  validateSwarmQueue,
  validateSwarmStatus,
  validateSwarmBeads,
  validateSwarmBeadStats,
  validateSwarmAgentLogs,
  validateSwarmActivity,
  validateSwarmAgentOutput,
  validateSwarmAgentLogContent,
  validateSwarmPauseResume,
} from './loop/swarmValidation'
import { EnableOptions } from './types'

const execAsync = promisify(exec)

const watchers = new Map<string, ReturnType<typeof chokidar.watch>>()
const loops = new Map<string, RalphLoop>()
const swarms = new Map<string, SwarmOrchestrator>()
const telegramBots = new Map<string, TelegramBot>()
const telegramBridges = new Map<string, TelegramBridge>()

/**
 * Gracefully shut down all active swarms, stop loops/watchers,
 * and clean up orphaned git worktrees.
 */
export async function gracefulShutdown(storePath: string, timeoutMs = 30_000): Promise<void> {
  // 1. Shut down all active swarms (waits for in-flight merges)
  const shutdownPromises = [...swarms.entries()].map(([projectPath, swarm]) =>
    swarm.shutdown(timeoutMs).catch((err: unknown) => {
      console.error(`[gracefulShutdown] swarm shutdown failed for ${projectPath}:`, err)
    })
  )
  await Promise.allSettled(shutdownPromises)
  swarms.clear()

  // 2. Disconnect Telegram bridges and bots
  telegramBridges.forEach(bridge => bridge.stop())
  telegramBridges.clear()
  const botDisconnects = [...telegramBots.values()].map(bot =>
    bot.disconnect().catch((err: unknown) => {
      console.error('[gracefulShutdown] telegram bot disconnect failed:', err)
    })
  )
  await Promise.allSettled(botDisconnects)
  telegramBots.clear()

  // 3. Stop legacy loops
  loops.forEach(l => l.stop())
  loops.clear()

  // 4. Close file watchers
  watchers.forEach(w => w.close())
  watchers.clear()

  // 5. Clean up orphaned worktrees across known projects
  const projectPaths = readProjectStore(storePath)
  for (const projectPath of projectPaths) {
    cleanOrphanedWorktrees(projectPath)
  }
}

function readProjectStore(storePath: string): string[] {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')) } catch { return [] }
}

function cleanOrphanedWorktrees(projectPath: string): void {
  const worktreesDir = path.join(projectPath, '.worktrees')
  if (!fs.existsSync(worktreesDir)) return

  let entries: string[]
  try {
    entries = fs.readdirSync(worktreesDir)
  } catch { return }

  for (const entry of entries) {
    const fullPath = path.join(worktreesDir, entry)
    try {
      const stat = fs.statSync(fullPath)
      if (!stat.isDirectory()) continue
    } catch { continue }

    // Try to remove the worktree via git
    try {
      execSync(`git worktree remove --force "${fullPath}"`, {
        cwd: projectPath, timeout: 10_000, stdio: 'pipe'
      })
    } catch {
      // If git worktree remove fails, try manual cleanup
      try { fs.rmSync(fullPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    // Clean up the corresponding agent branch
    // Pattern: agent-0-sb-abc -> agent/agent-0/sb-abc
    const branchMatch = entry.match(/^(agent-\d+)-(.+)$/)
    if (branchMatch) {
      const agentBranch = `agent/${branchMatch[1]}/${branchMatch[2]}`
      try {
        execSync(`git branch -D "${agentBranch}"`, { cwd: projectPath, timeout: 5000, stdio: 'pipe' })
      } catch { /* branch may not exist */ }
    }
  }

  // Remove the .worktrees dir if empty
  try {
    const remaining = fs.readdirSync(worktreesDir)
    if (remaining.length === 0) fs.rmdirSync(worktreesDir)
  } catch { /* ignore */ }
}

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
const slashbotDir = (p: string): string => path.join(p, '.slashbot')

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

  ipcMain.handle('project:add', (_e, p: unknown) => {
    try {
      const validated = validateProjectPathArg(p)
      addToStore(validated)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('project:active-tabs', () => readTabs())

  ipcMain.handle('project:save-tabs', (_e, tabs: unknown) => {
    try {
      const validated = validateSaveTabs(tabs)
      saveTabs(validated)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Status ──────────────────────────────────────────────────────────────

  ipcMain.handle('status:read', (_e, projectPath: string) => {
    const rd = slashbotDir(projectPath)
    return {
      status: readJson(path.join(rd, 'status.json')),
      progress: readJson(path.join(rd, 'progress.json')),
      circuit: readJson(path.join(rd, '.circuit_breaker_state')),
      analysis: readJson(path.join(rd, '.response_analysis'))
    }
  })

  function subscribeProject(projectPath: string): void {
    if (watchers.has(projectPath)) return
    const rd = slashbotDir(projectPath)
    if (!fs.existsSync(rd)) return

    const watcher = chokidar.watch(rd, {
      ignoreInitial: true,
      depth: 1,
      ignored: ['**/.claude_session_id', '**/.slashbot_session_history']
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

    const logFile = path.join(rd, 'logs', 'slashbot.log')
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
    const logFile = path.join(slashbotDir(projectPath), 'logs', 'slashbot.log')
    if (!fs.existsSync(logFile)) return []
    return (readText(logFile) ?? '').split('\n').filter(Boolean).slice(-lines)
  })

  ipcMain.handle('logs:list', (_e, projectPath: string) => {
    const logsDir = path.join(slashbotDir(projectPath), 'logs')
    if (!fs.existsSync(logsDir)) return []
    return fs.readdirSync(logsDir).filter(f => f.endsWith('.log') && f !== 'slashbot.log').sort().reverse().slice(0, 30)
  })

  // ── File editor ─────────────────────────────────────────────────────────

  ipcMain.handle('file:read', (_e, projectPath: string, relPath: string) => {
    try {
      const v = validateConfigRead(projectPath, relPath)
      const c = readText(v.resolvedPath)
      return c !== null ? { ok: true, content: c } : { ok: false, error: 'File not found' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:write', (_e, projectPath: string, relPath: string, content: string) => {
    try {
      const v = validateConfigWrite(projectPath, relPath, content)
      fs.writeFileSync(v.resolvedPath, v.content)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Slashbot loop ──────────────────────────────────────────────────────────

  ipcMain.handle('slashbot:start', (_e, projectPath: string) => {
    if (loops.has(projectPath)) return { ok: false, error: 'Already running' }
    const loop = new RalphLoop(projectPath)
    loop.on('status', (s) => broadcast('status:update', projectPath, s))
    loop.on('circuit', (c) => broadcast('circuit:update', projectPath, c))
    loop.on('log', (level: string, msg: string) =>
      broadcast('logs:lines', projectPath, [`[${new Date().toISOString()}] [${level}] ${msg}`]))
    loop.on('output', (chunk: string) => broadcast('pty:data', projectPath, chunk))
    loop.on('exit', (reason: string, detail?: string) => {
      loops.delete(projectPath)
      broadcast('slashbot:exit', projectPath, reason, detail)
    })
    loops.set(projectPath, loop)
    addToStore(projectPath)
    if (!watchers.has(projectPath)) setTimeout(() => subscribeProject(projectPath), 300)
    loop.start().catch(err => {
      loops.delete(projectPath)
      broadcast('slashbot:exit', projectPath, 'error', err instanceof Error ? err.message : String(err))
    })
    return { ok: true }
  })

  ipcMain.handle('slashbot:stop', (_e, projectPath: string) => {
    loops.get(projectPath)?.stop()
    loops.delete(projectPath)
  })

  ipcMain.handle('slashbot:running', (_e, projectPath: string) => loops.has(projectPath))

  // ── PTY (placeholder) ──────────────────────────────────────────────────

  ipcMain.handle('pty:write', () => {})
  ipcMain.handle('pty:resize', () => {})

  // ── Circuit breaker & session ──────────────────────────────────────────

  ipcMain.handle('circuit:reset', (_e, projectPath: string) => {
    try {
      const config = loadConfig(projectPath)
      const circuit = new CircuitBreaker(slashbotDir(projectPath), config)
      circuit.reset()
      broadcast('circuit:update', projectPath, circuit.snapshot())
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('session:reset', (_e, projectPath: string) => {
    const f = path.join(slashbotDir(projectPath), '.claude_session_id')
    try {
      if (fs.existsSync(f)) fs.writeFileSync(f, '')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Slashbot enable ───────────────────────────────────────────────────────

  ipcMain.handle('slashbot:is-enabled', (_e, projectPath: string) => ({
    ...checkEnabled(projectPath),
    context: detectProjectContext(projectPath)
  }))

  ipcMain.handle('slashbot:enable', (_e, projectPath: string, opts: EnableOptions) =>
    enableRalph(projectPath, opts))

  // ── Beads via bd CLI ───────────────────────────────────────────────────

  ipcMain.handle('beads:check', async (_e, projectPath: string) => {
    const bd = new BdClient(projectPath)
    return bd.check()
  })

  ipcMain.handle('beads:list', async (_e, projectPath: string, filter = 'open') => {
    try {
      const v = validateBeadsList(projectPath, filter)
      const bd = new BdClient(v.projectPath)
      const tasks = v.filter === 'all' ? bd.listAll() : bd.listByStatus(v.filter)
      return { ok: true, tasks }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] }
    }
  })

  ipcMain.handle('beads:show', async (_e, projectPath: string, id: string) => {
    try {
      const p = validateProjectPath(projectPath)
      const beadId = validateBeadId(id)
      const bd = new BdClient(p)
      const task = bd.show(beadId)
      return task ? { ok: true, task } : { ok: false, error: 'Not found' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:create', async (_e, projectPath: string, opts: {
    title: string; type?: string; priority?: number; description?: string; labels?: string[]
  }) => {
    try {
      const v = validateBeadsCreate(projectPath, opts)
      const bd = new BdClient(v.projectPath)
      const task = bd.create(v.opts as any)
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
      const v = validateBeadsUpdate(projectPath, id, opts)
      const bd = new BdClient(v.projectPath)
      bd.update(v.id, {
        priority: v.opts.priority,
        claim: v.opts.claim,
        unclaim: v.opts.unclaim,
        title: v.opts.title,
        description: v.opts.description,
        labels: { add: v.opts.labelsAdd, remove: v.opts.labelsRemove }
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:close', async (_e, projectPath: string, id: string, reason = 'Done') => {
    try {
      const p = validateProjectPath(projectPath)
      const beadId = validateBeadId(id)
      const bd = new BdClient(p)
      bd.close(beadId, reason)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('beads:reopen', async (_e, projectPath: string, id: string, reason = '') => {
    try {
      const p = validateProjectPath(projectPath)
      const beadId = validateBeadId(id)
      const bd = new BdClient(p)
      bd.reopen(beadId, reason)
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

  ipcMain.handle('swarm:inject', (_e, projectPath: unknown, request: unknown) => {
    try {
      const v = validateSwarmInject(projectPath, request)
      const swarm = getOrCreateSwarm(v.projectPath)
      const { id } = swarm.injectPlan(v.request)
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:queue-remove', (_e, projectPath: unknown, id: unknown) => {
    try {
      const v = validateSwarmQueueRemove(projectPath, id)
      const swarm = swarms.get(v.projectPath)
      if (!swarm) return { ok: false, error: 'No swarm' }
      return { ok: swarm.removeQueuedPlan(v.id) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:queue', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmQueue(projectPath)
      const swarm = swarms.get(v.projectPath)
      return swarm ? swarm.getPlanQueue() : []
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:start', async (_e, projectPath: unknown, workerCount: unknown) => {
    try {
      const v = validateSwarmStart(projectPath, workerCount)
      const swarm = getOrCreateSwarm(v.projectPath)
      swarm.startWorkers(v.workerCount)

      // Auto-connect Telegram bridge if configured and not already connected
      if (!telegramBots.has(v.projectPath)) {
        try {
          const config = loadConfig(v.projectPath)
          if (config.telegram?.enabled && config.telegram.botToken && config.telegram.chatId) {
            await connectTelegramForProject(
              v.projectPath,
              config.telegram.botToken,
              config.telegram.chatId,
              config.telegram.notifyOn ?? 'errors'
            )
          }
        } catch (err) {
          console.error('[swarm:start] telegram auto-connect failed:', err)
        }
      } else if (!telegramBridges.has(v.projectPath)) {
        // Bot exists but no bridge yet — attach it to the new swarm
        const bot = telegramBots.get(v.projectPath)!
        const config = loadConfig(v.projectPath)
        const bridge = new TelegramBridge({
          orchestrator: swarm as any,
          bot,
          notifyOn: (config.telegram?.notifyOn ?? 'errors') as any,
        })
        bridge.start()
        telegramBridges.set(v.projectPath, bridge)
      }

      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:stop', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmStop(projectPath)
      const swarm = swarms.get(v.projectPath)
      if (swarm) swarm.stopWorkers()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:graceful-stop', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmStop(projectPath)
      const swarm = swarms.get(v.projectPath)
      if (swarm) swarm.gracefulStopWorkers()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:pause-agent', (_e, projectPath: unknown, agentId: unknown) => {
    try {
      const v = validateSwarmPauseResume(projectPath, agentId)
      const swarm = swarms.get(v.projectPath)
      if (!swarm) return { ok: false, error: 'No swarm' }
      return { ok: swarm.pauseWorker(v.agentId) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:resume-agent', (_e, projectPath: unknown, agentId: unknown) => {
    try {
      const v = validateSwarmPauseResume(projectPath, agentId)
      const swarm = swarms.get(v.projectPath)
      if (!swarm) return { ok: false, error: 'No swarm' }
      return { ok: swarm.resumeWorker(v.agentId) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:pause-all', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmStop(projectPath)
      const swarm = swarms.get(v.projectPath)
      if (swarm) swarm.pauseAllWorkers()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:resume-all', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmStop(projectPath)
      const swarm = swarms.get(v.projectPath)
      if (swarm) swarm.resumeAllWorkers()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:status', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmStatus(projectPath)
      const swarm = swarms.get(v.projectPath)
      if (!swarm) return { running: false, planning: false, workerCount: 0, agents: [], stats: null, sessionStartedAt: null, stoppingGracefully: false }
      return {
        running: swarm.workerCount() > 0,
        planning: swarm.isPlanning(),
        workerCount: swarm.workerCount(),
        agents: swarm.getAgents(),
        stats: swarm.getStats(),
        sessionStartedAt: swarm.sessionStartedAt,
        stoppingGracefully: swarm.stoppingGracefully
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:beads', (_e, projectPath: unknown, status: unknown) => {
    try {
      const v = validateSwarmBeads(projectPath, status)
      const swarm = swarms.get(v.projectPath) ?? getOrCreateSwarm(v.projectPath)
      if (v.status !== 'all') return swarm.getBeads(v.status)
      return swarm.getBeads()
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:bead-stats', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmBeadStats(projectPath)
      const swarm = swarms.get(v.projectPath) ?? getOrCreateSwarm(v.projectPath)
      return swarm.getStats()
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('swarm:activity', (_e, projectPath: unknown, limit: unknown) => {
    try {
      const v = validateSwarmActivity(projectPath, limit)
      const swarm = swarms.get(v.projectPath) ?? getOrCreateSwarm(v.projectPath)
      return swarm.getActivity(v.limit)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Agent log history (for closed beads) ───────────────────────────────

  ipcMain.handle('swarm:agent-logs', (_e, projectPath: unknown) => {
    try {
      const v = validateSwarmAgentLogs(projectPath)
      const logsDir = path.join(slashbotDir(v.projectPath), 'logs')
      if (!fs.existsSync(logsDir)) return []
      return fs.readdirSync(logsDir)
        .filter(f => f.match(/^agent-\d+_\w+_.*\.log$/))
        .sort().reverse()
        .map(f => {
          const m = f.match(/^(agent-\d+)_(think|execute|review)_(.+)\.log$/)
          return {
            file: f,
            agentId: m?.[1] ?? 'unknown',
            phase: m?.[2] ?? 'unknown',
            timestamp: (m?.[3] ?? '').replace(/-/g, (_, i) => i < 10 ? '-' : i < 13 ? 'T' : ':'),
            size: fs.statSync(path.join(logsDir, f)).size,
          }
        })
    } catch {
      return []
    }
  })

  ipcMain.handle('swarm:agent-log-content', (_e, projectPath: unknown, filename: unknown) => {
    try {
      const v = validateSwarmAgentLogContent(projectPath, filename)
      const filePath = path.join(slashbotDir(v.projectPath), 'logs', v.filename)
      return readText(filePath) ?? ''
    } catch {
      return ''
    }
  })

  ipcMain.handle('swarm:agent-output', (_e, projectPath: unknown, agentId: unknown) => {
    try {
      const v = validateSwarmAgentOutput(projectPath, agentId)
      const swarm = swarms.get(v.projectPath)
      if (swarm) return swarm.getAgentOutput(v.agentId)
      // Fallback: read from disk even without active swarm
      const logFile = path.join(slashbotDir(v.projectPath), 'logs', `${v.agentId}.log`)
      return readText(logFile) ?? ''
    } catch {
      return ''
    }
  })

  // ── Telegram ─────────────────────────────────────────────────────────

  function persistTelegramToRc(
    projectPath: string,
    botToken: string,
    chatId: string,
    enabled: boolean,
    notifyLevel: string
  ): void {
    const rcPath = path.join(projectPath, '.slashbotrc')
    let content = ''
    try { content = fs.readFileSync(rcPath, 'utf8') } catch { /* file may not exist */ }

    const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ENABLED', 'TELEGRAM_NOTIFY_LEVEL']
    const lines = content.split('\n').filter(line => {
      const trimmed = line.trim()
      return !keys.some(k => trimmed.startsWith(k + '='))
    })

    // Remove trailing empty lines, then add telegram config
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(
      `TELEGRAM_BOT_TOKEN=${botToken}`,
      `TELEGRAM_CHAT_ID=${chatId}`,
      `TELEGRAM_ENABLED=${enabled}`,
      `TELEGRAM_NOTIFY_LEVEL=${notifyLevel}`,
    )

    fs.writeFileSync(rcPath, lines.join('\n') + '\n')
  }

  async function connectTelegramForProject(
    projectPath: string,
    botToken: string,
    chatId: string,
    notifyLevel: string
  ): Promise<TelegramBot> {
    // Disconnect existing bot if any
    const existingBridge = telegramBridges.get(projectPath)
    if (existingBridge) {
      existingBridge.stop()
      telegramBridges.delete(projectPath)
    }
    const existingBot = telegramBots.get(projectPath)
    if (existingBot) {
      await existingBot.disconnect()
      telegramBots.delete(projectPath)
    }

    const bot = new TelegramBot()
    await bot.connect({ botToken, chatId, enabled: true, notifyOn: notifyLevel as any })
    telegramBots.set(projectPath, bot)

    // If there's an active swarm, attach a bridge
    const swarm = swarms.get(projectPath)
    if (swarm) {
      const bridge = new TelegramBridge({
        orchestrator: swarm as any,
        bot,
        notifyOn: notifyLevel as any,
      })
      bridge.start()
      telegramBridges.set(projectPath, bridge)
    }

    return bot
  }

  ipcMain.handle('telegram:status', (_e, projectPath: unknown) => {
    try {
      const pp = validateTelegramProjectPath(projectPath)
      const bot = telegramBots.get(pp)
      if (!bot) {
        return {
          connected: false,
          botUsername: null,
          lastError: null,
          messagesSent: 0,
          messagesReceived: 0,
        }
      }
      return bot.getStatus()
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('telegram:configure', async (_e, projectPath: unknown, opts: unknown) => {
    try {
      const v = validateTelegramConfigure(projectPath, opts)

      // Persist to .slashbotrc
      persistTelegramToRc(v.projectPath, v.botToken, v.chatId, true, v.notifyLevel)

      // Connect the bot
      await connectTelegramForProject(v.projectPath, v.botToken, v.chatId, v.notifyLevel)

      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('telegram:test', async (_e, projectPath: unknown) => {
    try {
      const pp = validateTelegramProjectPath(projectPath)
      const bot = telegramBots.get(pp)
      if (!bot || !bot.isConnected()) {
        return { ok: false, error: 'Telegram bot is not connected' }
      }
      const sent = await bot.sendMessage('🤖 Slashbot test message — Telegram integration is working!')
      return sent ? { ok: true } : { ok: false, error: 'Failed to send test message' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('telegram:disconnect', async (_e, projectPath: unknown) => {
    try {
      const pp = validateTelegramProjectPath(projectPath)

      // Stop bridge if active
      const bridge = telegramBridges.get(pp)
      if (bridge) {
        bridge.stop()
        telegramBridges.delete(pp)
      }

      // Disconnect bot
      const bot = telegramBots.get(pp)
      if (bot) {
        await bot.disconnect()
        telegramBots.delete(pp)
      }

      // Update .slashbotrc to mark as disabled
      persistTelegramToRc(pp, '', '', false, 'errors')

      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Cleanup ────────────────────────────────────────────────────────────

  ipcMain.handle('window:cleanup', async (_e, projectPath?: string) => {
    if (projectPath) {
      watchers.get(projectPath)?.close(); watchers.delete(projectPath)
      loops.get(projectPath)?.stop(); loops.delete(projectPath)
      swarms.get(projectPath)?.stopAll(); swarms.delete(projectPath)
      telegramBridges.get(projectPath)?.stop(); telegramBridges.delete(projectPath)
      const bot = telegramBots.get(projectPath)
      if (bot) { await bot.disconnect(); telegramBots.delete(projectPath) }
    } else {
      watchers.forEach(w => w.close()); watchers.clear()
      loops.forEach(l => l.stop()); loops.clear()
      swarms.forEach(s => s.stopAll()); swarms.clear()
      telegramBridges.forEach(b => b.stop()); telegramBridges.clear()
      await Promise.allSettled([...telegramBots.values()].map(b => b.disconnect()))
      telegramBots.clear()
    }
  })
}
