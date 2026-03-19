/**
 * RalphLoop — the autonomous development loop, implemented natively in TypeScript.
 *
 * Replaces ralph_loop.sh entirely. No shell scripts are invoked for loop logic;
 * only the Claude CLI itself is spawned as a subprocess.
 *
 * Emits typed events consumed by the IPC layer in ralph.ts.
 */

import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync
} from 'fs'
import { join } from 'path'

import { CircuitBreaker }                    from './CircuitBreaker'
import { RateLimit }                         from './RateLimit'
import { analyze, extractResultFromJsonStream, detectApiLimit } from './ResponseAnalyzer'
import { validateIntegrity }                 from './FileGuard'
import { loadConfig }                        from './RcParser'
import {
  ExitReason, LoopEvents, RalphConfig, RalphStatus
} from './types'

// Typed EventEmitter shim
interface TypedEmitter extends EventEmitter {
  on<K extends keyof LoopEvents>(event: K, listener: LoopEvents[K]): this
  emit<K extends keyof LoopEvents>(event: K, ...args: Parameters<LoopEvents[K]>): boolean
}

export class RalphLoop extends (EventEmitter as new () => TypedEmitter) {
  private running = false
  private stopped = false
  private loopCount = 0
  private testOnlyCount = 0
  private doneSignals = 0
  private lastSessionId?: string

  private readonly ralphDir: string
  private readonly logDir: string
  private config!: RalphConfig
  private circuit!: CircuitBreaker
  private rate!: RateLimit

  constructor(private readonly projectPath: string) {
    super()
    this.ralphDir = join(projectPath, '.ralph')
    this.logDir   = join(this.ralphDir, 'logs')
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false

    this._setup()
    this._log('INFO', 'Ralph loop starting (TypeScript engine)')
    this._clearStaleState()

    await this._loop()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this._log('INFO', 'Loop stop requested')
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  private _setup(): void {
    mkdirSync(this.logDir, { recursive: true })
    this.config  = loadConfig(this.projectPath)
    this.circuit = new CircuitBreaker(this.ralphDir, this.config)
    this.rate    = new RateLimit(this.ralphDir, this.config.maxCallsPerHour)
    this.circuit.load()
  }

  private _clearStaleState(): void {
    // Reset exit signals from previous runs (Issue #194 equivalent)
    const exitSignals = join(this.ralphDir, '.exit_signals')
    if (existsSync(exitSignals)) writeFileSync(exitSignals, '0')
    const analysis = join(this.ralphDir, '.response_analysis')
    if (existsSync(analysis)) writeFileSync(analysis, '{}')
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  private async _loop(): Promise<void> {
    while (this.running && !this.stopped) {
      this.loopCount++
      this.circuit.tick(this.loopCount)
      this._log('INFO', `── Loop ${this.loopCount} ──────────────────────`)

      // 1. Integrity check
      const integrity = validateIntegrity(this.projectPath)
      if (!integrity.ok) {
        this._log('ERROR', `File integrity failure:\n${integrity.report}`)
        this._exit('file_integrity', integrity.missing.join(', '))
        return
      }

      // 2. Circuit breaker
      if (this.circuit.isOpen()) {
        this._log('WARN', `Circuit breaker OPEN: ${this.circuit.snapshot().reason}`)
        this._writeStatus('halted', 'circuit_open_waiting')
        await this._sleep(60_000)
        this.circuit.load()  // re-check cooldown
        if (this.circuit.isOpen()) { this._exit('circuit_open'); return }
        this._log('INFO', 'Circuit transitioned to HALF_OPEN, resuming')
      }

      // 3. Rate limit
      if (!this.rate.canCall()) {
        const { resetIn } = this.rate.status()
        this._log('WARN', `Rate limit reached (${this.config.maxCallsPerHour}/hr). Reset in ${resetIn}`)
        this._writeStatus('rate_limited', 'waiting_for_reset')
        await this.rate.waitForReset()
        this._log('INFO', 'Rate limit reset, continuing')
      }

      // 4. Run Claude
      this._writeStatus('running', 'claude_execution')
      this.rate.record()

      let rawOutput = ''
      try {
        rawOutput = await this._runClaude()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `Claude execution error: ${msg}`)
        this.circuit.recordNoProgress(false)
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        continue
      }

      // 5. API limit detection
      if (detectApiLimit(rawOutput)) {
        this._log('WARN', 'API limit detected, exiting for cooldown')
        this._exit('api_limit')
        return
      }

      // 6. Analyze response
      const { sessionId } = extractResultFromJsonStream(rawOutput)
      if (sessionId) this.lastSessionId = sessionId

      const result = analyze(rawOutput)
      this._log('INFO', `Analysis: exitSignal=${result.exitSignal} files=${result.filesModified} questions=${result.askingQuestions}`)

      // Persist analysis
      writeFileSync(join(this.ralphDir, '.response_analysis'), JSON.stringify({
        loop_number: this.loopCount,
        timestamp: new Date().toISOString(),
        analysis: {
          has_completion_signal: result.hasCompletionSignal,
          is_test_only: result.isTestOnly,
          is_stuck: result.isStuck,
          has_progress: result.hasProgress,
          files_modified: result.filesModified,
          exit_signal: result.exitSignal,
          work_summary: result.workSummary,
          has_permission_denials: result.hasPermissionDenials,
          denied_commands: result.deniedCommands,
          asking_questions: result.askingQuestions,
          question_count: result.questionCount
        }
      }, null, 2))

      // 7. Circuit breaker update
      if (result.hasPermissionDenials) {
        this._log('WARN', `Permission denied for: ${result.deniedCommands.join(', ')}`)
        this.circuit.recordPermissionDenial()
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        if (this.circuit.isOpen()) { this._exit('permission_denied', result.deniedCommands.join(', ')); return }
      } else if (result.hasProgress || result.filesModified > 0) {
        this.circuit.recordProgress(this.loopCount)
      } else {
        this.circuit.recordNoProgress(result.askingQuestions)
      }
      this.circuit.save()
      this.emit('circuit', this.circuit.snapshot())

      // 8. Exit conditions
      if (result.hasCompletionSignal && result.exitSignal) {
        this._log('SUCCESS', 'Project complete — EXIT_SIGNAL confirmed')
        this._exit('project_complete')
        return
      }

      if (result.isTestOnly) this.testOnlyCount++
      else this.testOnlyCount = 0
      if (this.testOnlyCount >= 3) {
        this._log('INFO', 'Too many test-only loops — project appears complete')
        this._exit('project_complete')
        return
      }

      // Check fix_plan.md completion
      if (this._isPlanComplete()) {
        this._log('SUCCESS', 'All items in fix_plan.md are checked off')
        this._exit('plan_complete')
        return
      }

      // 9. Short sleep between iterations
      this._writeStatus('running', 'sleeping')
      await this._sleep(this.config.sleepDuration * 1_000)
    }

    if (!this.stopped) this._exit('stopped')
  }

  // ── Claude invocation ─────────────────────────────────────────────────────

  private _runClaude(): Promise<string> {
    return new Promise((resolve, reject) => {
      const prompt = this._buildPrompt()
      const args   = this._buildArgs()

      const proc = spawn(this.config.claudeCodeCmd, args, {
        cwd: this.projectPath,
        env: { ...process.env, TERM: 'xterm-256color' },
        timeout: this.config.claudeTimeoutMinutes * 60_000
      })

      // Send prompt via stdin
      proc.stdin.write(prompt)
      proc.stdin.end()

      let output = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        this.emit('output', text)
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', code => {
        if (code === 124) {
          // timeout — treat as non-fatal if there was output
          if (output.trim().length > 0) resolve(output)
          else reject(new Error('Claude timed out with no output'))
          return
        }
        if (code !== 0 && output.trim().length === 0) {
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 300)}`))
          return
        }
        resolve(output)
      })

      proc.on('error', reject)

      // Log raw output file
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = join(this.logDir, `claude_output_${ts}.log`)
      proc.stdout.on('data', (chunk: Buffer) => appendFileSync(outFile, chunk))
    })
  }

  private _buildArgs(): string[] {
    const args = [
      '--output-format', this.config.claudeOutputFormat,
      '--allowedTools', this.config.allowedTools,
      '--print'
    ]
    if (this.config.continueSession && this.lastSessionId) {
      args.push('--resume', this.lastSessionId)
    }
    return args
  }

  private _buildPrompt(): string {
    const promptFile = join(this.ralphDir, 'PROMPT.md')
    const fixPlan    = join(this.ralphDir, 'fix_plan.md')

    const promptContent  = existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : ''
    const remainingTasks = existsSync(fixPlan)
      ? readFileSync(fixPlan, 'utf8')
          .split('\n')
          .filter(l => l.startsWith('- [ ]'))
          .join('\n')
      : ''

    const circuitInfo = this.circuit.isOpen()
      ? `\n\nNOTE: Circuit breaker is ${this.circuit.snapshot().state}: ${this.circuit.snapshot().reason}`
      : ''

    const context = [
      `## Loop Context`,
      `Loop iteration: ${this.loopCount}`,
      `Session: ${this.lastSessionId ?? 'new'}`,
      remainingTasks ? `\n### Remaining tasks\n${remainingTasks}` : '',
      circuitInfo
    ].filter(Boolean).join('\n')

    return `${context}\n\n---\n\n${promptContent}`
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _isPlanComplete(): boolean {
    const f = join(this.ralphDir, 'fix_plan.md')
    if (!existsSync(f)) return false
    const lines = readFileSync(f, 'utf8').split('\n')
    const tasks   = lines.filter(l => l.startsWith('- ['))
    const pending = lines.filter(l => l.startsWith('- [ ]'))
    return tasks.length > 0 && pending.length === 0
  }

  private _writeStatus(
    status: RalphStatus['status'],
    lastAction: string,
    exitReason = ''
  ): void {
    const { used, max, resetIn } = this.rate.status()
    const s: RalphStatus = {
      timestamp: new Date().toISOString(),
      loop_count: this.loopCount,
      calls_made_this_hour: used,
      max_calls_per_hour: max,
      last_action: lastAction,
      status,
      exit_reason: exitReason,
      next_reset: resetIn
    }
    writeFileSync(join(this.ralphDir, 'status.json'), JSON.stringify(s, null, 2))
    this.emit('status', s)
  }

  private _exit(reason: ExitReason, detail?: string): void {
    this.running = false
    this._log('INFO', `Exiting: ${reason}${detail ? ` (${detail})` : ''}`)
    this._writeStatus('completed', 'graceful_exit', reason)
    this.emit('exit', reason, detail)
  }

  private _log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string): void {
    const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `[${ts}] [${level}] ${msg}`
    appendFileSync(join(this.logDir, 'ralph.log'), line + '\n')
    this.emit('log', level, msg)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
