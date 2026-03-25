import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig, CircuitBreakerSnapshot } from '../types'
import { atomicWriteSync } from './utils'
import { classifyError, ErrorCategory } from './ErrorClassifier'

/**
 * Compute cooldown duration with exponential backoff.
 * Returns base * 2^(epoch-1) capped at max, or base when epoch <= 0.
 */
export function computedCooldown(
  config: Pick<RalphConfig, 'cbCooldownMinutes' | 'cbMaxCooldownMinutes'>,
  reopenEpoch: number
): number {
  const base = config.cbCooldownMinutes
  const max = config.cbMaxCooldownMinutes
  if (reopenEpoch <= 0) return base
  return Math.min(base * Math.pow(2, reopenEpoch - 1), max)
}

export class CircuitBreaker {
  private state: 'CLOSED' | 'HALF_OPEN' | 'OPEN' = 'CLOSED'
  private consecutiveNoProgress = 0
  private errorWindow: Array<{ ts: number; error: string }> = []
  private consecutivePermissionDenials = 0
  private lastProgressLoop = 0
  private totalOpens = 0
  private reopenEpoch = 0
  private reason = 'Initialized'
  private currentLoop = 0
  private openedAt?: string
  private rateLimitUntil?: Date

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
      // Backward compat: restore window from error_window if persisted,
      // otherwise seed from consecutive_same_error count
      if (Array.isArray(data.error_window)) {
        this.errorWindow = data.error_window
      } else if (data.consecutive_same_error) {
        // Legacy: approximate the window from the old count
        this.errorWindow = Array.from({ length: data.consecutive_same_error }, (_, i) => ({
          ts: Date.now() - (data.consecutive_same_error - i) * 1000,
          error: 'legacy'
        }))
      }
      this.consecutivePermissionDenials = data.consecutive_permission_denials ?? 0
      this.lastProgressLoop = data.last_progress_loop ?? 0
      this.totalOpens = data.total_opens ?? 0
      this.reason = data.reason ?? ''
      this.currentLoop = data.current_loop ?? 0
      this.reopenEpoch = data.reopen_epoch ?? 0
      this.openedAt = data.opened_at
      if (data.rate_limit_until) {
        const rlDate = new Date(data.rate_limit_until)
        if (Date.now() < rlDate.getTime()) {
          this.rateLimitUntil = rlDate
        }
      }
      if (this.state === 'OPEN' && this.openedAt) {
        const elapsed = (Date.now() - new Date(this.openedAt).getTime()) / 60_000
        if (elapsed >= computedCooldown(this.config, this.reopenEpoch)) {
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
      consecutive_same_error: this.errorWindow.length,
      error_window_count: this.errorWindow.length,
      error_window: this.errorWindow,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      reopen_epoch: this.reopenEpoch,
      ...(this.openedAt ? { opened_at: this.openedAt } : {}),
      ...(this.rateLimitUntil ? { rate_limit_until: this.rateLimitUntil.toISOString() } : {})
    }
    atomicWriteSync(
      path.join(this.slashbotDir, '.circuit_breaker_state'),
      JSON.stringify(snapshot, null, 2)
    )
  }

  reset(): void {
    this.state = 'CLOSED'
    this.consecutiveNoProgress = 0
    this.errorWindow = []
    this.consecutivePermissionDenials = 0
    this.reopenEpoch = 0
    this.reason = 'Manual reset'
    this.openedAt = undefined
    this.rateLimitUntil = undefined
    this.save()
  }

  tick(loop: number): void {
    this.currentLoop = loop
  }

  isOpen(): boolean {
    return this.state === 'OPEN' || (!!this.rateLimitUntil && Date.now() < this.rateLimitUntil.getTime())
  }

  recordRateLimit(retryAfterMs?: number): void {
    const delay = retryAfterMs ?? 60_000
    this.rateLimitUntil = new Date(Date.now() + delay)
    this._open('API rate limit')
  }

  rateLimitLifted(): boolean {
    if (!this.rateLimitUntil) return true
    if (Date.now() >= this.rateLimitUntil.getTime()) {
      this.rateLimitUntil = undefined
      return true
    }
    return false
  }

  recordProgress(loop: number): void {
    this.lastProgressLoop = loop
    this.consecutiveNoProgress = 0
    this.errorWindow = []
    this.consecutivePermissionDenials = 0
    this.rateLimitUntil = undefined
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      this.reopenEpoch = 0
      this.reason = 'Progress detected, circuit recovered'
    }
  }

  recordNoProgress(askingQuestions: boolean): void {
    if (askingQuestions) return
    this.consecutiveNoProgress++
    this._checkThresholds()
  }

  recordError(errorLine: string, category?: ErrorCategory): void {
    const resolved = category ?? classifyError(errorLine)
    if (resolved === 'permanent') {
      this._open(`Permanent error: ${errorLine}`)
      return
    }
    this.errorWindow.push({ ts: Date.now(), error: errorLine })
    // Prune to window size
    const maxSize = this.config.cbErrorWindowSize
    if (this.errorWindow.length > maxSize) {
      this.errorWindow = this.errorWindow.slice(-maxSize)
    }
    this._checkThresholds()
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
      consecutive_same_error: this.errorWindow.length,
      error_window_count: this.errorWindow.length,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      reopen_epoch: this.reopenEpoch,
      ...(this.openedAt ? { opened_at: this.openedAt } : {}),
      ...(this.rateLimitUntil ? { rate_limit_until: this.rateLimitUntil.toISOString() } : {})
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
    if (this.errorWindow.length >= this.config.cbErrorWindowThreshold) {
      this._open(`${this.errorWindow.length} errors in sliding window`)
    }
  }

  private _open(reason: string): void {
    this.state = 'OPEN'
    this.reason = reason
    this.totalOpens++
    this.reopenEpoch++
    this.openedAt = new Date().toISOString()
  }
}
