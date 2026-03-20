import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig, PlanQueueItem, Bead, BeadStats, AgentInfo, ActivityEvent } from '../types'
import { loadConfig } from './RcParser'
import { AgentCoordinator } from './AgentCoordinator'
import { PlanLoop } from './PlanLoop'
import { WorkerLoop } from './WorkerLoop'

export class SwarmOrchestrator extends EventEmitter {
  private workers = new Map<string, WorkerLoop>()
  private workerLoopPromises = new Map<string, Promise<void>>()
  private planner: PlanLoop | null = null
  private planning = false
  private activityPollTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityIndex = 0
  private planQueue: PlanQueueItem[] = []
  coordinator: AgentCoordinator
  private ralphDir: string
  private logDir: string
  private agentOutputBuffers = new Map<string, string>()
  sessionStartedAt: string | null = null
  private shuttingDown = false

  constructor(private projectPath: string) {
    super()
    this.ralphDir = path.join(projectPath, '.ralph')
    this.logDir = path.join(this.ralphDir, 'logs')
    fs.mkdirSync(this.logDir, { recursive: true })
    this.coordinator = new AgentCoordinator(this.ralphDir, projectPath)
  }

  // ── Public API ─────────────────────────────────────────────────────────

  injectPlan(request: string): { id: string } {
    const id = `plan-${Date.now()}`
    this.planQueue.push({ id, request })
    this._broadcastQueue()
    this._log('INFO', `Plan queued [${id}]: "${request.slice(0, 60)}"`)
    this._drainQueue()
    return { id }
  }

  removeQueuedPlan(id: string): boolean {
    const idx = this.planQueue.findIndex(p => p.id === id)
    if (idx < 0) return false
    this.planQueue.splice(idx, 1)
    this._broadcastQueue()
    return true
  }

  getPlanQueue(): PlanQueueItem[] {
    return [...this.planQueue]
  }

  private async _drainQueue(): Promise<void> {
    if (this.planning || this.planQueue.length === 0) return
    const next = this.planQueue.shift()!
    this._broadcastQueue()
    this.planning = true
    const config = loadConfig(this.projectPath)
    this._log('INFO', `━━ Swarm: running plan [${next.id}] ━━`)

    this.planner = new PlanLoop(this.projectPath, config, this.coordinator)
    this.planner.on('log', (level: string, msg: string) => this._log(level, msg, 'planner'))
    this.planner.on('output', (chunk: string) => {
      this._bufferOutput('planner', chunk)
      this.emit('output', 'planner', chunk)
    })
    this.planner.on('phase', (phase: string) => this.emit('planPhase', phase))
    this.planner.on('done', (beadCount: number) => {
      this.planning = false
      this._log('SUCCESS', `Plan [${next.id}] complete — ${beadCount} beads created`)
      this._broadcastGraph()
      this._drainQueue()
    })
    this.planner.on('error', (msg: string) => {
      this.planning = false
      this._log('ERROR', `Plan [${next.id}] failed: ${msg}`)
      this._drainQueue()
    })

    await this.planner.run(next.request)
    this.planner = null
  }

  startWorkers(n = 2): void {
    if (this.shuttingDown) {
      this._log('WARN', 'Cannot start workers during shutdown')
      return
    }
    const config = loadConfig(this.projectPath)
    if (!this.sessionStartedAt) this.sessionStartedAt = new Date().toISOString()

    // Stop excess workers if reducing count
    const currentIds = [...this.workers.keys()].sort()
    for (const id of currentIds) {
      const idx = parseInt(id.replace('agent-', ''), 10)
      if (idx >= n) {
        this._log('INFO', `Stopping excess worker ${id}`)
        this.workers.get(id)?.stop()
        this.workers.delete(id)
      }
    }

    // Start missing workers up to n
    for (let i = 0; i < n; i++) {
      const agentId = `agent-${i}`
      if (this.workers.has(agentId)) continue
      const worker = new WorkerLoop(agentId, i, this.projectPath, config, this.coordinator)
      worker.on('log', (level: string, msg: string) => this._log(level, msg, agentId))
      worker.on('output', (chunk: string) => {
        this._bufferOutput(agentId, chunk)
        this.emit('output', agentId, chunk)
      })
      worker.on('phase', (phase: string, bid?: string, btitle?: string) => {
        this._broadcastAgents()
        this._log('INFO', `[${agentId}] phase=${phase}${bid ? ` bead=${bid}` : ''}`, agentId)
      })
      worker.on('exit', (reason: string) => {
        this.workers.delete(agentId)
        this._broadcastAgents()
        if (this.workers.size === 0) {
          this._stopActivityPoll()
          this.emit('stopped')
        }
      })
      this.workers.set(agentId, worker)
      const loopPromise = worker.start().catch(err => {
        this._log('ERROR', `[${agentId}] start failed: ${err instanceof Error ? err.message : err}`)
        this.workers.delete(agentId)
        this._broadcastAgents()
      }).finally(() => {
        this.workerLoopPromises.delete(agentId)
      })
      this.workerLoopPromises.set(agentId, loopPromise)
    }
    this._startActivityPoll()
    this._broadcastAgents()
    this._broadcastGraph()
    this._log('INFO', `Workers adjusted to ${n} (${this.workers.size} running)`)
  }

  stopWorkers(): void {
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
    this._stopActivityPoll()
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
    this._log('INFO', 'All workers stopped')
    this.emit('stopped')
  }

  stopAll(): void {
    this.planner?.stop()
    this.planner = null
    this.planning = false
    this.planQueue = []
    this._broadcastQueue()
    this.stopWorkers()
  }

  /**
   * Gracefully shut down: stop accepting new work, wait for in-flight merges
   * to finish, then clean up and emit 'shutdown-complete'.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this._log('INFO', 'Shutdown initiated — stopping planner and workers…')

    // Stop planner and clear queue
    this.planner?.stop()
    this.planner = null
    this.planning = false
    this.planQueue = []
    this._broadcastQueue()

    // Signal all workers to stop (they will finish in-flight merges via their finally blocks)
    for (const worker of this.workers.values()) {
      worker.stop()
    }

    // Wait for worker loops to fully complete (including finally-block merges),
    // with a timeout to avoid hanging indefinitely
    const loopPromises = [...this.workerLoopPromises.values()]
    if (loopPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(loopPromises),
        new Promise<void>(resolve => setTimeout(() => {
          this._log('WARN', `Shutdown timeout (${timeoutMs}ms) — forcing cleanup`)
          resolve()
        }, timeoutMs))
      ])
    }

    this.workers.clear()
    this.workerLoopPromises.clear()
    this._stopActivityPoll()
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
    this._log('INFO', 'Shutdown complete')
    this.shuttingDown = false
    this.emit('shutdown-complete')
  }

  isShuttingDown(): boolean { return this.shuttingDown }
  workerCount(): number { return this.workers.size }
  isPlanning(): boolean { return this.planning }
  getAgents(): AgentInfo[] { return this.coordinator.getAgents() }
  getActivity(limit = 50): ActivityEvent[] { return this.coordinator.readActivity(limit) }

  getBeads(status?: string): Bead[] {
    if (status && status !== 'all') return this.coordinator.bd.listByStatus(status)
    return this.coordinator.bd.listAll()
  }

  getStats(): BeadStats { return this.coordinator.getStats() }

  getAgentOutput(agentId: string): string {
    // Try memory buffer first, fall back to disk log
    const mem = this.agentOutputBuffers.get(agentId)
    if (mem) return mem
    const logFile = path.join(this.logDir, `${agentId}.log`)
    try {
      const content = fs.readFileSync(logFile, 'utf8')
      // Populate buffer from disk so subsequent reads are fast
      if (content) this.agentOutputBuffers.set(agentId, content.slice(-50_000))
      return content
    } catch {
      return ''
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _broadcastGraph(): void {
    this.emit('graph', this.coordinator.getStats(), null)
  }

  private _broadcastAgents(): void {
    this.emit('agents', this.coordinator.getAgents())
  }

  private _startActivityPoll(): void {
    if (this.activityPollTimer) return
    this.activityPollTimer = setInterval(() => {
      const events = this.coordinator.readActivity(200)
      if (events.length > this.lastActivityIndex) {
        for (let i = this.lastActivityIndex; i < events.length; i++) {
          this.emit('activity', events[i])
        }
        this.lastActivityIndex = events.length
        this._broadcastGraph()
      }
    }, 1500)
  }

  private _stopActivityPoll(): void {
    if (this.activityPollTimer) { clearInterval(this.activityPollTimer); this.activityPollTimer = null }
  }

  private _broadcastQueue(): void {
    this.emit('planQueue', [...this.planQueue])
  }

  private _bufferOutput(agentId: string, chunk: string): void {
    const prev = this.agentOutputBuffers.get(agentId) ?? ''
    // Keep last 50KB per agent in memory
    this.agentOutputBuffers.set(agentId, (prev + chunk).slice(-50_000))
    // Also persist to per-agent log file on disk
    const logFile = path.join(this.logDir, `${agentId}.log`)
    fs.appendFileSync(logFile, chunk)
  }

  private _log(level: string, msg: string, agentId?: string): void {
    fs.appendFileSync(path.join(this.logDir, 'ralph.log'),
      `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    this.emit('log', level, msg, agentId)
  }
}
