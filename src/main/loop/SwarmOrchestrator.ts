import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig, PlanQueueItem, Bead, BeadStats, AgentInfo, ActivityEvent, KnowledgeEntry, MailMessage } from '../types'
import { loadConfig } from './RcParser'
import { AgentCoordinator } from './AgentCoordinator'
import { PlanLoop } from './PlanLoop'
import { WorkerLoop } from './WorkerLoop'
import { runHealthCheck, formatHealthErrors } from './HealthCheck'
import { BuildMonitor } from './BuildMonitor'
import { ProjectPaths, ensureStoreDirs } from './ProjectStore'

export class SwarmOrchestrator extends EventEmitter {
  private workers = new Map<string, WorkerLoop>()
  private workerLoopPromises = new Map<string, Promise<void>>()
  private planner: PlanLoop | null = null
  private planning = false
  private activityPollTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityTs: string | null = null
  private _stoppedEmitted = false
  private planQueue: PlanQueueItem[] = []
  private currentPlanRequest: string | null = null
  coordinator: AgentCoordinator
  private agentOutputBuffers = new Map<string, string>()
  private _outputWriteCounts = new Map<string, number>()
  private _heartbeatMap = new Map<string, number>()
  sessionStartedAt: string | null = null
  private shuttingDown = false
  stoppingGracefully = false
  private buildMonitor: BuildMonitor | null = null

  readonly paths: ProjectPaths
  get projectPath(): string { return this.paths.projectRoot }

  constructor(paths: ProjectPaths) {
    super()
    ensureStoreDirs(paths)
    this.paths = paths
    this.coordinator = new AgentCoordinator(paths)
    // Clear stale agents from a previous session that wasn't cleanly stopped
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
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
    this.currentPlanRequest = next.request
    this.coordinator.planningActive = true
    const config = loadConfig(this.projectPath, this.paths.slashbotrc)
    this._log('INFO', `━━ Swarm: running plan [${next.id}] ━━`)

    this.planner = new PlanLoop(this.paths, config, this.coordinator)
    this.planner.on('log', (level: string, msg: string) => this._log(level, msg, 'planner'))
    this.planner.on('output', (chunk: string) => {
      this._bufferOutput('planner', chunk)
      this.emit('output', 'planner', chunk)
    })
    this.planner.on('phase', (phase: string) => this.emit('planPhase', phase, next.request))
    this.planner.on('done', (beadCount: number) => {
      this.planning = false
      this.currentPlanRequest = null
      this.coordinator.planningActive = false
      this._log('SUCCESS', `Plan [${next.id}] complete — ${beadCount} beads created`)
      this._broadcastGraph()
      this._drainQueue()
    })
    this.planner.on('error', (msg: string) => {
      this.planning = false
      this.currentPlanRequest = null
      this.coordinator.planningActive = false
      this._log('ERROR', `Plan [${next.id}] failed: ${msg}`)
      this._drainQueue()
    })

    await this.planner.run(next.request)
    this.planner = null
  }

  async startWorkers(n = 2): Promise<void> {
    if (this.shuttingDown) {
      this._log('WARN', 'Cannot start workers during shutdown')
      return
    }
    this.stoppingGracefully = false
    this._stoppedEmitted = false
    const config = loadConfig(this.projectPath, this.paths.slashbotrc)

    // Pre-flight health check
    const health = runHealthCheck(this.projectPath, config.claudeCodeCmd)
    if (!health.ok) {
      const report = formatHealthErrors(health.errors)
      this._log('ERROR', `Health check failed:\n${report}`)
      throw new Error(`Health check failed:\n${report}`)
    }
    if (!this.sessionStartedAt) this.sessionStartedAt = new Date().toISOString()

    // Stop excess workers if reducing count
    const currentIds = [...this.workers.keys()].sort()
    for (const id of currentIds) {
      const idx = parseInt(id.replace('worker-', ''), 10)
      if (idx >= n) {
        this._log('INFO', `Stopping excess worker ${id}`)
        this.workers.get(id)?.stop()
        this.workers.delete(id)
      }
    }

    // Reopen any beads left claimed/in_progress from a previous session
    await this.coordinator.reopenStaleBeadsAsync()

    // Start missing workers up to n
    for (let i = 0; i < n; i++) {
      const agentId = `worker-${i}`
      if (this.workers.has(agentId)) continue
      const worker = new WorkerLoop(agentId, i, this.projectPath, config, this.coordinator, this.paths)
      worker.on('log', (level: string, msg: string) => this._log(level, msg, agentId))
      worker.on('output', (chunk: string) => {
        this._bufferOutput(agentId, chunk)
        this.emit('output', agentId, chunk)
      })
      worker.on('phase', (phase: string, bid?: string, btitle?: string) => {
        this._broadcastAgents()
        this._log('INFO', `[${agentId}] phase=${phase}${bid ? ` bead=${bid}` : ''}`, agentId)
      })
      worker.on('heartbeat', () => {
        this._heartbeatMap.set(agentId, Date.now())
      })
      worker.on('exit', (reason: string) => {
        this.workers.delete(agentId)
        this._heartbeatMap.delete(agentId)
        this._broadcastAgents()
        if (this.workers.size === 0 && !this._stoppedEmitted) {
          this._stoppedEmitted = true
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

    // Start background claim-timeout sweep (runs every 60s, outside claimSemaphore)
    this.coordinator.startClaimTimeoutSweep(config.claudeTimeoutMinutes)

    // Start build monitor if configured and not already running
    if (config.buildMonitorCmd && !this.buildMonitor) {
      this._startBuildMonitor(config)
    }

    this._log('INFO', `Workers adjusted to ${n} (${this.workers.size} running)`)
  }

  stopWorkers(): void {
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
    this._heartbeatMap.clear()
    this._stopBuildMonitor()
    this._stopActivityPoll()
    this.coordinator.stopClaimTimeoutSweep()
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
    this._log('INFO', 'All workers stopped')
    if (!this._stoppedEmitted) {
      this._stoppedEmitted = true
      this.emit('stopped')
    }
  }

  /** Signal all workers to stop after their current bead finishes. */
  gracefulStopWorkers(): void {
    this.stoppingGracefully = true
    for (const worker of this.workers.values()) worker.gracefulStop()
    this._log('INFO', 'Graceful stop requested — workers will finish current beads then exit')
  }

  /** Pause a single worker agent. */
  pauseWorker(agentId: string): boolean {
    const worker = this.workers.get(agentId)
    if (!worker) return false
    worker.pause()
    this._broadcastAgents()
    return true
  }

  /** Resume a single paused worker agent. */
  resumeWorker(agentId: string): boolean {
    const worker = this.workers.get(agentId)
    if (!worker) return false
    worker.resume()
    this._broadcastAgents()
    return true
  }

  /** Pause all workers. */
  pauseAllWorkers(): void {
    for (const worker of this.workers.values()) worker.pause()
    this._broadcastAgents()
    this._log('INFO', 'All workers paused')
  }

  /** Resume all paused workers. */
  resumeAllWorkers(): void {
    for (const worker of this.workers.values()) worker.resume()
    this._broadcastAgents()
    this._log('INFO', 'All workers resumed')
  }

  stopAll(): void {
    this.planner?.stop()
    this.planner = null
    this.planning = false
    this.currentPlanRequest = null
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
    this.currentPlanRequest = null
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
      let timer: ReturnType<typeof setTimeout>
      await Promise.race([
        Promise.allSettled(loopPromises),
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            this._log('WARN', `Shutdown timeout (${timeoutMs}ms) — forcing cleanup`)
            resolve()
          }, timeoutMs)
        })
      ])
      clearTimeout(timer!)
    }

    this.workers.clear()
    this.workerLoopPromises.clear()
    this._stopBuildMonitor()
    this._stopActivityPoll()
    this.coordinator.stopClaimTimeoutSweep()
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
    this._log('INFO', 'Shutdown complete')
    this.shuttingDown = false
    this.emit('shutdown-complete')
  }

  isShuttingDown(): boolean { return this.shuttingDown }
  workerCount(): number { return this.workers.size }
  isPlanning(): boolean { return this.planning }
  getPlanRequest(): string | null { return this.currentPlanRequest }
  getAgents(): AgentInfo[] { return this.coordinator.getAgents() }
  getActivity(limit = 50): ActivityEvent[] { return this.coordinator.readActivity(limit) }
  getActivityForBead(beadId: string, limit = 100): ActivityEvent[] { return this.coordinator.readActivityForBead(beadId, limit) }
  getActivityForAgent(agentId: string, limit = 100): ActivityEvent[] { return this.coordinator.readActivityForAgent(agentId, limit) }
  getKnowledge(limit = 50): KnowledgeEntry[] { return this.coordinator.readKnowledge(limit) }
  getMail(limit = 50): MailMessage[] { return this.coordinator.readMail(limit) }
  getMailForAgent(agentId: string, limit = 100): MailMessage[] { return this.coordinator.readMailForAgent(agentId, limit) }

  /** Return the last heartbeat timestamp (epoch ms) for an agent, or undefined if unknown. */
  getHeartbeat(agentId: string): number | undefined { return this._heartbeatMap.get(agentId) }

  /** Return agent IDs whose last heartbeat is older than `thresholdMs` (default: 10 minutes). */
  getStaleAgents(thresholdMs = 10 * 60_000): string[] {
    const now = Date.now()
    const stale: string[] = []
    for (const [id, ts] of this._heartbeatMap) {
      if (now - ts > thresholdMs) stale.push(id)
    }
    return stale
  }

  toggleBuildMonitor(enabled: boolean): void {
    if (enabled) {
      if (this.buildMonitor) return // already running
      const config = loadConfig(this.projectPath, this.paths.slashbotrc)
      if (!config.buildMonitorCmd) {
        this._log('WARN', 'Cannot enable build monitor — no buildMonitorCmd configured')
        return
      }
      this._startBuildMonitor(config)
    } else {
      this._stopBuildMonitor()
    }
  }

  getBuildMonitorStatus(): { enabled: boolean; running: boolean } {
    return {
      enabled: this.buildMonitor !== null,
      running: this.buildMonitor?.isRunning() ?? false,
    }
  }

  getBeads(status?: string): Bead[] {
    if (status && status !== 'all') return this.coordinator.bd.listByStatus(status)
    return this.coordinator.bd.listAll()
  }

  async getBeadsAsync(status?: string): Promise<Bead[]> {
    if (status && status !== 'all') return this.coordinator.bd.listByStatusAsync(status)
    return this.coordinator.bd.listAllAsync()
  }

  async getStats(): Promise<BeadStats> { return this.coordinator.getStats() }

  async getStatsAsync(): Promise<BeadStats> { return this.coordinator.getStats() }

  getAgentOutput(agentId: string): string {
    // Try memory buffer first, fall back to disk log
    const mem = this.agentOutputBuffers.get(agentId)
    if (mem) return mem
    const logFile = path.join(this.paths.logsDir, `${agentId}.log`)
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

  private _startBuildMonitor(config: RalphConfig): void {
    this.buildMonitor = new BuildMonitor(config, this.coordinator, this.coordinator.bd, this.projectPath)
    this.buildMonitor.on('log', (level: string, msg: string) => this._log(level.toUpperCase(), msg))
    this.buildMonitor.on('status', (status: string, fingerprint?: string) => {
      this.emit('build-status', status, fingerprint)
    })
    this.buildMonitor.on('bead-created', (beadInfo: unknown) => {
      this.emit('build-status', 'bead-created', beadInfo)
    })
    this.buildMonitor.start()
    this._log('INFO', 'Build monitor started')
  }

  private _stopBuildMonitor(): void {
    if (!this.buildMonitor) return
    this.buildMonitor.stop()
    this.buildMonitor.removeAllListeners()
    this.buildMonitor = null
    this._log('INFO', 'Build monitor stopped')
  }

  private _broadcastGraph(): void {
    this.coordinator.getStatsAsync()
      .then(stats => this.emit('graph', stats, null))
      .catch(() => {})
  }

  private _broadcastAgents(): void {
    this.emit('agents', this.coordinator.getAgents())
  }

  private _deadAgentPollCount = 0

  private _startActivityPoll(): void {
    if (this.activityPollTimer) return
    this.activityPollTimer = setInterval(() => {
      const events = this.coordinator.readActivity(200)
      if (events.length > 0) {
        const newEvents = this.lastActivityTs
          ? events.filter(e => e.ts > this.lastActivityTs!)
          : events
        if (newEvents.length > 0) {
          for (const event of newEvents) {
            this.emit('activity', event)
          }
          this.lastActivityTs = newEvents[newEvents.length - 1].ts
          this._broadcastGraph()
        }
      }

      // Dead-agent detection: check every ~20 polls (~30s at 1500ms interval)
      this._deadAgentPollCount++
      if (this._deadAgentPollCount >= 20) {
        this._deadAgentPollCount = 0
        this._detectDeadAgents()
      }
    }, 1500)
  }

  /** Check for agents whose heartbeat is older than 2× claudeTimeoutMinutes and reopen their beads. */
  private async _detectDeadAgents(): Promise<void> {
    const config = loadConfig(this.projectPath, this.paths.slashbotrc)
    const thresholdMs = 2 * config.claudeTimeoutMinutes * 60_000
    const now = Date.now()

    for (const [agentId, lastTs] of this._heartbeatMap) {
      if (!this.workers.has(agentId)) continue
      if (now - lastTs > thresholdMs) {
        this._log('WARN', `Dead agent detected: ${agentId} (no heartbeat for ${Math.round((now - lastTs) / 60_000)}m)`)

        // Find the agent's current bead and reopen it
        const agentInfo = this.coordinator.getAgents().find(a => a.id === agentId)
        if (agentInfo?.currentBeadId) {
          await this.coordinator.reopenBead(agentId, agentInfo.currentBeadId)
          this.coordinator.postActivity({
            agentId: 'system',
            type: 'dead_agent',
            beadId: agentInfo.currentBeadId,
            beadTitle: agentInfo.currentBeadTitle ?? undefined,
            summary: `Reopened bead [${agentInfo.currentBeadId}] — agent ${agentId} unresponsive`
          })
          this._log('INFO', `Reopened bead [${agentInfo.currentBeadId}] from dead agent ${agentId}`)
        }

        // Stop the dead worker — do NOT delete from workers map here;
        // the exit handler will handle cleanup and 'stopped' emission
        const worker = this.workers.get(agentId)
        if (worker) {
          worker.stop()
        }
      }
    }
  }

  private _stopActivityPoll(): void {
    if (this.activityPollTimer) { clearInterval(this.activityPollTimer); this.activityPollTimer = null }
  }

  private _broadcastQueue(): void {
    this.emit('planQueue', [...this.planQueue])
  }

  private static readonly OUTPUT_ROTATION_SIZE = 1_048_576 // 1 MB
  private static readonly OUTPUT_ROTATION_CHECK_INTERVAL = 50

  private _bufferOutput(agentId: string, chunk: string): void {
    const prev = this.agentOutputBuffers.get(agentId) ?? ''
    // Keep last 50KB per agent in memory
    this.agentOutputBuffers.set(agentId, (prev + chunk).slice(-50_000))
    // Also persist to per-agent log file on disk
    const logFile = path.join(this.paths.logsDir, `${agentId}.log`)
    fs.appendFileSync(logFile, chunk)
    // Rotate per-agent log when it exceeds 1 MB (checked every 50 writes)
    const count = (this._outputWriteCounts.get(agentId) ?? 0) + 1
    this._outputWriteCounts.set(agentId, count)
    if (count >= SwarmOrchestrator.OUTPUT_ROTATION_CHECK_INTERVAL) {
      this._outputWriteCounts.set(agentId, 0)
      try {
        const stat = fs.statSync(logFile)
        if (stat.size > SwarmOrchestrator.OUTPUT_ROTATION_SIZE) {
          fs.renameSync(logFile, logFile + '.1')
        }
      } catch { /* best-effort rotation */ }
    }
  }

  private _log(level: string, msg: string, agentId?: string): void {
    fs.appendFileSync(path.join(this.paths.logsDir, 'slashbot.log'),
      `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    this.emit('log', level, msg, agentId)
  }
}
