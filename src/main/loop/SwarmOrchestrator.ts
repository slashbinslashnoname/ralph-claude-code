/**
 * SwarmOrchestrator.ts — top-level manager for the multi-agent swarm.
 *
 * Two entry points (matching spec):
 *
 *   injectTasks(text)  — triggered by user adding new tasks
 *     → runs PlanLoop (Steps 1+2) then wakes workers
 *
 *   startWorkers(n)    — triggered by user clicking "Start"
 *     → spawns N WorkerLoops running Steps 3→5 in parallel
 *
 * Each WorkerLoop gets its own agentId ("agent-0", "agent-1", …) and
 * emits PTY output tagged with that agentId so the UI can route it to
 * the correct terminal tab.
 */

import { EventEmitter } from 'events'
import { appendFileSync, mkdirSync } from 'fs'
import { join }                       from 'path'

import { AgentCoordinator, AgentState, MailMessage } from './AgentCoordinator'
import { WorkerLoop }                                 from './WorkerLoop'
import { PlanLoop }                                   from './PlanLoop'
import { loadConfig }                                 from './RcParser'
import { BeadGraph, graphStats, loadGraph }           from './Bead'

// ── Swarm events ───────────────────────────────────────────────────────────

export interface SwarmEvents {
  /** Log line from orchestrator, planner, or any worker. */
  log:       (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string, agentId?: string) => void
  /** PTY output from a specific worker (agentId + raw chunk). */
  output:    (agentId: string, chunk: string) => void
  /** Current bead graph stats (broadcast after any graph change). */
  graph:     (stats: ReturnType<typeof graphStats>, graph: BeadGraph | null) => void
  /** Agent registry snapshot (all active agents). */
  agents:    (agents: AgentState[]) => void
  /** New agent mail message. */
  mail:      (msg: MailMessage) => void
  /** Planner phase changed. */
  planPhase: (phase: string) => void
  /** All workers have stopped. */
  stopped:   () => void
}

interface TypedEmitter extends EventEmitter {
  on<K extends keyof SwarmEvents>(event: K, listener: SwarmEvents[K]): this
  emit<K extends keyof SwarmEvents>(event: K, ...args: Parameters<SwarmEvents[K]>): boolean
}

// ── SwarmOrchestrator ──────────────────────────────────────────────────────

export class SwarmOrchestrator extends (EventEmitter as new () => TypedEmitter) {
  private workers      = new Map<string, WorkerLoop>()
  private planner:       PlanLoop  | null = null
  private planning       = false
  private mailPollTimer: ReturnType<typeof setInterval> | null = null
  private lastMailIndex  = 0

  private readonly coordinator: AgentCoordinator
  private readonly ralphDir:    string
  private readonly logDir:      string

  constructor(private readonly projectPath: string) {
    super()
    this.ralphDir    = join(projectPath, '.ralph')
    this.logDir      = join(this.ralphDir, 'logs')
    mkdirSync(this.logDir, { recursive: true })
    this.coordinator = new AgentCoordinator(this.ralphDir)
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Inject new tasks → run Plan (Step 1) + Encode (Step 2).
   * If workers are running they continue; they'll pick up the new beads
   * automatically once the graph is updated.
   */
  async injectTasks(request: string): Promise<void> {
    if (this.planning) {
      this._log('WARN', 'Already planning — ignoring inject request')
      return
    }
    this.planning = true
    const config  = loadConfig(this.projectPath)

    this._log('INFO', `━━ Swarm: inject-tasks → Plan + Encode ━━`)

    this.planner = new PlanLoop(this.projectPath, config, this.coordinator)

    this.planner.on('log',    (level, msg) => this._log(level, msg, 'planner'))
    this.planner.on('output', chunk => this.emit('output', 'planner', chunk))
    this.planner.on('phase',  phase => this.emit('planPhase', String(phase)))

    this.planner.on('done', beadCount => {
      this.planning = false
      this._log('SUCCESS', `Plan complete — ${beadCount} beads in graph`)
      this._broadcastGraph()
    })
    this.planner.on('error', msg => {
      this.planning = false
      this._log('ERROR', `Plan/Encode failed: ${msg}`)
    })

    await this.planner.run(request)
    this.planner = null
  }

  /**
   * Start N parallel worker loops (Steps 3→5).
   * Workers coordinate via AgentCoordinator to avoid file conflicts.
   */
  startWorkers(n = 2): void {
    const config = loadConfig(this.projectPath)

    for (let i = 0; i < n; i++) {
      const agentId = `agent-${i}`
      if (this.workers.has(agentId)) continue  // already running

      const worker = new WorkerLoop(agentId, i, this.projectPath, config, this.coordinator)

      worker.on('log',    (level, msg)        => this._log(level, msg, agentId))
      worker.on('output', chunk               => this.emit('output', agentId, chunk))
      worker.on('phase',  (phase, bid, btitle) => {
        this._broadcastAgents()
        this._log('INFO', `[${agentId}] phase=${phase}${bid ? ` bead=${bid}` : ''}${btitle ? ` "${btitle}"` : ''}`, agentId)
      })
      worker.on('exit', reason => {
        this.workers.delete(agentId)
        this._log('INFO', `[${agentId}] exited: ${reason}`)
        this._broadcastAgents()
        if (this.workers.size === 0) {
          this._stopMailPoll()
          this.emit('stopped')
        }
      })

      this.workers.set(agentId, worker)
      // Start async — don't await
      worker.start().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `[${agentId}] start failed: ${msg}`)
        this.workers.delete(agentId)
        this._broadcastAgents()
      })
    }

    this._startMailPoll()
    this._broadcastAgents()
    this._broadcastGraph()
    this._log('INFO', `Started ${n} workers`)
  }

  /** Stop all workers and the planner. */
  stopAll(): void {
    this.planner?.stop()
    this.planner = null
    this.planning = false

    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()

    this._stopMailPoll()
    this.coordinator.getAgents().forEach(a => this.coordinator.deregisterAgent(a.id))
    this._log('INFO', 'All workers stopped')
    this.emit('stopped')
  }

  /** Current number of running workers. */
  workerCount(): number { return this.workers.size }

  /** Is planning in progress? */
  isPlanning(): boolean { return this.planning }

  /** Snapshot of agents for UI. */
  getAgents(): AgentState[] { return this.coordinator.getAgents() }

  /** Recent agent mail. */
  getMail(limit = 50): MailMessage[] { return this.coordinator.readMail(limit) }

  /** Bead graph snapshot. */
  getGraph(): BeadGraph | null { return loadGraph(this.ralphDir) }

  /** Graph stats snapshot. */
  getStats(): ReturnType<typeof graphStats> | null {
    const g = this.getGraph()
    return g ? graphStats(g) : null
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _broadcastGraph(): void {
    const graph = this.getGraph()
    this.emit('graph', graph ? graphStats(graph) : { total: 0, pending: 0, ready: 0, claimed: 0, done: 0, failed: 0, pct: 0 }, graph)
  }

  private _broadcastAgents(): void {
    this.emit('agents', this.coordinator.getAgents())
  }

  /** Poll agent mail for new messages and broadcast them. */
  private _startMailPoll(): void {
    if (this.mailPollTimer) return
    this.mailPollTimer = setInterval(() => {
      const msgs = this.coordinator.readMail(200)
      if (msgs.length > this.lastMailIndex) {
        for (let i = this.lastMailIndex; i < msgs.length; i++) {
          this.emit('mail', msgs[i])
        }
        this.lastMailIndex = msgs.length
        // Broadcast graph stats when beads change
        this._broadcastGraph()
      }
    }, 1500)
  }

  private _stopMailPoll(): void {
    if (this.mailPollTimer) { clearInterval(this.mailPollTimer); this.mailPollTimer = null }
  }

  private _log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string, agentId?: string): void {
    appendFileSync(join(this.logDir, 'ralph.log'), `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    this.emit('log', level, msg, agentId)
  }
}
