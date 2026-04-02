/**
 * CassClient — thin wrapper around the `cm` CLI (CASS memory system).
 *
 * Provides short/medium/long-term memory for planning and execution phases.
 * Gracefully degrades: if `cm` is not installed, all methods return empty/no-op.
 */
import * as cp from 'child_process'

export interface CassContext {
  relevantBullets: CassRule[]
  antiPatterns: CassRule[]
  historySnippets: string[]
  suggestedCassQueries: string[]
}

export interface CassRule {
  id: string
  text: string
  confidence: number
  maturity: string
  effectiveness?: number
}

export class CassClient {
  private available: boolean | null = null

  /** Check if `cm` CLI is installed and functional. */
  check(): boolean {
    if (this.available !== null) return this.available
    try {
      cp.execSync('cm doctor --json', { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  /** Reset availability cache (e.g. after install). */
  resetCache(): void {
    this.available = null
  }

  /**
   * Retrieve relevant memory context for a task description.
   * Returns structured rules, anti-patterns, and history snippets.
   */
  async context(task: string, limit = 30): Promise<CassContext | null> {
    if (!this.check()) return null
    try {
      const out = await this._exec(['context', task, '--json', '--limit', String(limit)])
      const parsed = JSON.parse(out)
      return {
        relevantBullets: parsed.relevantBullets ?? parsed.relevant_bullets ?? [],
        antiPatterns: parsed.antiPatterns ?? parsed.anti_patterns ?? [],
        historySnippets: parsed.historySnippets ?? parsed.history_snippets ?? [],
        suggestedCassQueries: parsed.suggestedCassQueries ?? parsed.suggested_cass_queries ?? [],
      }
    } catch {
      return null
    }
  }

  /**
   * Record the outcome of a session/task (success or failure).
   * Feeds the CASS learning pipeline.
   */
  async outcome(
    result: 'success' | 'failure',
    ruleIds?: string[],
    summary?: string
  ): Promise<void> {
    if (!this.check()) return
    try {
      const args = ['outcome', result]
      if (ruleIds?.length) args.push(ruleIds.join(','))
      if (summary) args.push('--summary', summary)
      await this._exec(args)
    } catch { /* best-effort */ }
  }

  /**
   * Mark a rule as helpful or harmful with an optional reason.
   */
  async mark(
    ruleId: string,
    assessment: 'helpful' | 'harmful',
    reason?: string
  ): Promise<void> {
    if (!this.check()) return
    try {
      const args = ['mark', ruleId, `--${assessment}`]
      if (reason) args.push('--reason', reason)
      await this._exec(args)
    } catch { /* best-effort */ }
  }

  /**
   * Format CASS context as a markdown section for injection into prompts.
   * Returns empty string if no context available.
   */
  formatForPrompt(ctx: CassContext | null): string {
    if (!ctx) return ''
    const sections: string[] = []

    if (ctx.relevantBullets.length > 0) {
      sections.push('### Relevant knowledge (from CASS memory)')
      for (const rule of ctx.relevantBullets.slice(0, 15)) {
        const conf = rule.confidence ? ` [confidence: ${rule.confidence}%]` : ''
        sections.push(`- ${rule.text}${conf}`)
      }
    }

    if (ctx.antiPatterns.length > 0) {
      sections.push('\n### Anti-patterns to avoid')
      for (const ap of ctx.antiPatterns.slice(0, 5)) {
        sections.push(`- ⚠ ${ap.text}`)
      }
    }

    if (ctx.historySnippets.length > 0) {
      sections.push('\n### Historical context')
      for (const snippet of ctx.historySnippets.slice(0, 3)) {
        sections.push(`- ${snippet}`)
      }
    }

    return sections.length > 0 ? sections.join('\n') : ''
  }

  private _exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile('cm', args, { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })
  }
}
