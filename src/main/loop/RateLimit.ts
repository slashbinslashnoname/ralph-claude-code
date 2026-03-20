import * as fs from 'fs'
import * as path from 'path'

export class RateLimit {
  private count = 0
  private hourStart = new Date()

  constructor(
    private slashbotDir: string,
    private max: number
  ) {
    this._load()
    this._maybeReset()
  }

  private _load(): void {
    const f = path.join(this.slashbotDir, '.call_count')
    if (!fs.existsSync(f)) return
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      this.count = d.count ?? 0
      this.hourStart = new Date(d.hourStart ?? Date.now())
    } catch { /* ignore */ }
  }

  private _save(): void {
    fs.writeFileSync(
      path.join(this.slashbotDir, '.call_count'),
      JSON.stringify({ count: this.count, hourStart: this.hourStart.toISOString() })
    )
  }

  private _maybeReset(): void {
    const elapsedMs = Date.now() - this.hourStart.getTime()
    if (elapsedMs >= 3_600_000) {
      this.count = 0
      this.hourStart = new Date()
      this._save()
    }
  }

  canCall(): boolean {
    this._maybeReset()
    return this.count < this.max
  }

  record(): void {
    this._maybeReset()
    this.count++
    this._save()
  }

  msUntilReset(): number {
    const elapsed = Date.now() - this.hourStart.getTime()
    return Math.max(0, 3_600_000 - elapsed)
  }

  resetIn(): string {
    const ms = this.msUntilReset()
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1_000)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  status(): { used: number; max: number; resetIn: string } {
    this._maybeReset()
    return { used: this.count, max: this.max, resetIn: this.resetIn() }
  }

  async waitForReset(): Promise<void> {
    const delay = this.msUntilReset()
    await new Promise(resolve => setTimeout(resolve, delay))
    this.count = 0
    this.hourStart = new Date()
    this._save()
  }
}
