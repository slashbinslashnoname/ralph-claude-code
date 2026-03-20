import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig, CircuitBreakerSnapshot } from '../types'

export class CircuitBreaker {
  private state: 'CLOSED' | 'HALF_OPEN' | 'OPEN' = 'CLOSED'
  private consecutiveNoProgress = 0
  private consecutiveSameError = 0
  private consecutivePermissionDenials = 0
  private lastProgressLoop = 0
  private totalOpens = 0
  private reason = 'Initialized'
  private currentLoop = 0
  private openedAt?: string
  private lastErrors: string[] = []

  constructor(
    private slashbotDir: string,
    private config: RalphConfig
  ) {}

  load(): void {
    const file = path.join(this.slashbotDir, '.circuit_breaker_state')
    if (!fs.existsSync(file)) return
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.state = data.state ?? 'CLOSED'
      this.consecutiveNoProgress = data.consecutive_no_progress ?? 0
      this.consecutiveSameError = data.consecutive_same_error ?? 0
      this.consecutivePermissionDenials = data.consecutive_permission_denials ?? 0
      this.lastProgressLoop = data.last_progress_loop ?? 0
      this.totalOpens = data.total_opens ?? 0
      this.reason = data.reason ?? ''
      this.currentLoop = data.current_loop ?? 0
      this.openedAt = data.opened_at
      if (this.state === 'OPEN' && this.openedAt) {
        const elapsed = (Date.now() - new Date(this.openedAt).getTime()) / 60_000
        if (elapsed >= this.config.cbCooldownMinutes) {
          this.state = 'HALF_OPEN'
          this.reason = `Cooldown elapsed (${Math.round(elapsed)}m), entering HALF_OPEN`
        }
      }
    } catch { /* ignore corrupt state */ }
  }

  save(): void {
    const snapshot: Record<string, unknown> = {
      state: this.state,
      last_change: new Date().toISOString(),
      consecutive_no_progress: this.consecutiveNoProgress,
      consecutive_same_error: this.consecutiveSameError,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      ...(this.openedAt ? { opened_at: this.openedAt } : {})
    }
    fs.writeFileSync(
      path.join(this.slashbotDir, '.circuit_breaker_state'),
      JSON.stringify(snapshot, null, 2)
    )
  }

  reset(): void {
    this.state = 'CLOSED'
    this.consecutiveNoProgress = 0
    this.consecutiveSameError = 0
    this.consecutivePermissionDenials = 0
    this.reason = 'Manual reset'
    this.openedAt = undefined
    this.save()
  }

  tick(loop: number): void {
    this.currentLoop = loop
  }

  isOpen(): boolean {
    return this.state === 'OPEN'
  }

  recordProgress(loop: number): void {
    this.lastProgressLoop = loop
    this.consecutiveNoProgress = 0
    this.consecutiveSameError = 0
    this.consecutivePermissionDenials = 0
    this.lastErrors = []
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      this.reason = 'Progress detected, circuit recovered'
    }
  }

  recordNoProgress(askingQuestions: boolean): void {
    if (askingQuestions) return
    this.consecutiveNoProgress++
    this._checkThresholds()
  }

  recordError(errorLine: string): void {
    if (!this.lastErrors.includes(errorLine)) {
      this.lastErrors.push(errorLine)
      if (this.lastErrors.length > 10) this.lastErrors.shift()
    }
    if (this.lastErrors.length >= 2) {
      this.consecutiveSameError++
      this._checkThresholds()
    }
  }

  recordPermissionDenial(): void {
    this.consecutivePermissionDenials++
    if (this.consecutivePermissionDenials >= this.config.cbPermissionDenialThreshold) {
      this._open(`${this.consecutivePermissionDenials} consecutive permission denials`)
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      last_change: new Date().toISOString(),
      consecutive_no_progress: this.consecutiveNoProgress,
      consecutive_same_error: this.consecutiveSameError,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      ...(this.openedAt ? { opened_at: this.openedAt } : {})
    }
  }

  private _checkThresholds(): void {
    if (this.consecutiveNoProgress >= this.config.cbNoProgressThreshold) {
      if (this.state === 'CLOSED') {
        this.state = 'HALF_OPEN'
        this.reason = `${this.consecutiveNoProgress} loops with no progress`
      } else if (this.state === 'HALF_OPEN') {
        this._open(`Still no progress after HALF_OPEN (${this.consecutiveNoProgress} loops)`)
      }
    }
    if (this.consecutiveSameError >= this.config.cbSameErrorThreshold) {
      this._open(`${this.consecutiveSameError} loops with same error`)
    }
  }

  private _open(reason: string): void {
    this.state = 'OPEN'
    this.reason = reason
    this.totalOpens++
    this.openedAt = new Date().toISOString()
  }
}
