import { EventEmitter } from 'events'
import { exec, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import type { AgentCoordinator } from './AgentCoordinator'
import type { BdClient } from './BdClient'
import type { RalphConfig } from '../types'

const EXEC_TIMEOUT_MS = 120_000
const COOLDOWN_COUNT = 3
const OUTPUT_CAP = 2048

interface FailureRecord {
  count: number
  beadFiled: boolean
}

/**
 * Monitors the project build on a periodic interval.
 * On repeated failures (same fingerprint), files a bead via BdClient.
 * Skips checks while any agent is in the 'merging' phase.
 */
export class BuildMonitor extends EventEmitter {
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private checking = false
  private failures: Map<string, FailureRecord> = new Map()
  private cmd: string
  private intervalMs: number
  private coordinator: AgentCoordinator
  private bd: BdClient

  constructor(config: Pick<RalphConfig, 'buildMonitorCmd' | 'buildMonitorInterval'>, coordinator: AgentCoordinator, bd: BdClient) {
    super()
    this.cmd = config.buildMonitorCmd
    this.intervalMs = (config.buildMonitorInterval ?? 120) * 1000
    this.coordinator = coordinator
    this.bd = bd
  }

  start(): void {
    if (this.running) return
    if (!this.cmd) {
      this.emit('log', 'warn', 'BuildMonitor: no buildMonitorCmd configured, not starting')
      return
    }
    this.running = true
    this.emit('log', 'info', `BuildMonitor: started (interval=${this.intervalMs / 1000}s)`)
    // Run first check immediately, then on interval
    this._runCheck()
    this.timer = setInterval(() => this._runCheck(), this.intervalMs)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.emit('log', 'info', 'BuildMonitor: stopped')
  }

  toggle(): boolean {
    if (this.running) {
      this.stop()
    } else {
      this.start()
    }
    return this.running
  }

  isRunning(): boolean {
    return this.running
  }

  /** Run the build command and handle the result. */
  _runCheck(): void {
    if (this.checking) return
    if (!this.running) return

    // Skip if any agent is currently merging (transient failures likely)
    const agents = this.coordinator.getAgents()
    if (agents.some(a => a.phase === 'merging')) {
      this.emit('log', 'debug', 'BuildMonitor: skipping check — agent merging')
      return
    }

    this.checking = true
    exec(this.cmd, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      this.checking = false
      if (!this.running) return

      if (err) {
        const output = (stderr || stdout || err.message || '').toString()
        this._handleFailure(output)
      } else {
        this._handlePass()
      }
    })
  }

  /** Handle a build failure: fingerprint, dedup, and optionally create a bead. */
  _handleFailure(output: string): void {
    const fingerprint = createHash('sha256').update(output).digest('hex').slice(0, 16)
    const record = this.failures.get(fingerprint) ?? { count: 0, beadFiled: false }
    record.count++
    this.failures.set(fingerprint, record)

    this.emit('log', 'warn', `BuildMonitor: build failed (fingerprint=${fingerprint}, count=${record.count})`)
    this.emit('status', 'failed', fingerprint)

    if (record.count >= COOLDOWN_COUNT && !record.beadFiled) {
      record.beadFiled = true
      const cappedOutput = output.length > OUTPUT_CAP ? output.slice(0, OUTPUT_CAP) : output
      const description = `Build monitor detected a recurring build failure.\n\n**Fingerprint:** ${fingerprint}\n**Occurrences:** ${record.count}\n\n\`\`\`\n${cappedOutput}\n\`\`\``

      try {
        this.bd.create({
          title: `[auto-fix] Build failure: ${fingerprint}`,
          type: 'bug',
          priority: 0,
          description,
          labels: ['auto-fix', 'build-monitor'],
        })
        this.emit('log', 'info', `BuildMonitor: created bead for fingerprint ${fingerprint}`)
        // Remove from map after filing — keeps map bounded
        this.failures.delete(fingerprint)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.emit('log', 'error', `BuildMonitor: failed to create bead: ${msg}`)
      }
    }
  }

  /** Handle a passing build: reset all failure counters. */
  _handlePass(): void {
    if (this.failures.size > 0) {
      this.emit('log', 'info', 'BuildMonitor: build passed, resetting failure counters')
      this.failures.clear()
    }
    this.emit('status', 'passed')
  }
}
