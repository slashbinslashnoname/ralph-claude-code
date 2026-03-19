import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

interface RateLimitState {
  count: number
  hourStart: string
}

export class RateLimit {
  private count = 0
  private hourStart = new Date()

  constructor(
    private readonly ralphDir: string,
    private readonly max: number
  ) {
    this._load()
    this._maybeReset()
  }

  private _load(): void {
    const f = join(this.ralphDir, '.call_count')
    if (!existsSync(f)) return
    try {
      const d = JSON.parse(readFileSync(f, 'utf8')) as RateLimitState
      this.count = d.count ?? 0
      this.hourStart = new Date(d.hourStart ?? Date.now())
    } catch { /* start fresh */ }
  }

  private _save(): void {
    writeFileSync(join(this.ralphDir, '.call_count'), JSON.stringify({
      count: this.count,
      hourStart: this.hourStart.toISOString()
    }))
  }

  private _maybeReset(): void {
    const elapsedMs = Date.now() - this.hourStart.getTime()
    if (elapsedMs >= 3_600_000) {
      this.count = 0
      this.hourStart = new Date()
      this._save()
    }
  }

  /** Returns true if a call can proceed now */
  canCall(): boolean {
    this._maybeReset()
    return this.count < this.max
  }

  record(): void {
    this._maybeReset()
    this.count++
    this._save()
  }

  /** ms until the current hour window resets */
  msUntilReset(): number {
    const elapsed = Date.now() - this.hourStart.getTime()
    return Math.max(0, 3_600_000 - elapsed)
  }

  /** Human-readable HH:MM:SS string */
  resetIn(): string {
    const ms = this.msUntilReset()
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  status(): { used: number; max: number; resetIn: string } {
    this._maybeReset()
    return { used: this.count, max: this.max, resetIn: this.resetIn() }
  }

  /** Wait (async) until the rate limit resets */
  async waitForReset(): Promise<void> {
    const delay = this.msUntilReset()
    await new Promise<void>(resolve => setTimeout(resolve, delay))
    this.count = 0
    this.hourStart = new Date()
    this._save()
  }
}
