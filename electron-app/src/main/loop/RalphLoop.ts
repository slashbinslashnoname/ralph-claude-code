/**
 * RalphLoop — the autonomous development loop, implemented natively in TypeScript.
 * No shell scripts invoked — only the Claude CLI is spawned as a subprocess.
 */

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync
} from 'fs'
import { join } from 'path'

import { CircuitBreaker }   from './CircuitBreaker'
import { RateLimit }        from './RateLimit'
import {
  analyze, extractResultFromJsonStream, detectApiLimit
} from './ResponseAnalyzer'
import { validateIntegrity } from './FileGuard'
import { loadConfig }        from './RcParser'
import { ExitReason, LoopEvents, RalphConfig, RalphStatus } from './types'

interface TypedEmitter extends EventEmitter {
  on<K extends keyof LoopEvents>(event: K, listener: LoopEvents[K]): this
  emit<K extends keyof LoopEvents>(event: K, ...args: Parameters<LoopEvents[K]>): boolean
}

export class RalphLoop extends (EventEmitter as new () => TypedEmitter) {
  private running = false
  private stopped = false
  private exited  = false   // prevents double-emit of 'exit'
  private loopCount = 0
  private testOnlyCount = 0
  private lastSessionId?: string
  private claudeProc: ChildProcess | null = null  // current Claude subprocess

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

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false

    this._setup()
    this._log('INFO', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    this._log('INFO', '  Ralph Desktop — TypeScript loop engine')
    this._log('INFO', `  Project: ${this.projectPath}`)
    this._log('INFO', `  Claude cmd: ${this.config.claudeCodeCmd}`)
    this._log('INFO', `  Max calls/hr: ${this.config.maxCallsPerHour}`)
    this._log('INFO', `  Timeout: ${this.config.claudeTimeoutMinutes}m`)
    this._log('INFO', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    this._clearStaleState()

    await this._loop()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this._log('INFO', 'Stop requested — terminating Claude subprocess…')
    if (this.claudeProc) {
      try { this.claudeProc.kill('SIGTERM') } catch { /* already dead */ }
      setTimeout(() => {
        try { this.claudeProc?.kill('SIGKILL') } catch { /* ignore */ }
      }, 3000)
    }
    // Emit exit here so the UI updates immediately
    this._exit('stopped')
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private _setup(): void {
    mkdirSync(this.logDir, { recursive: true })
    this.config  = loadConfig(this.projectPath)
    this.circuit = new CircuitBreaker(this.ralphDir, this.config)
    this.rate    = new RateLimit(this.ralphDir, this.config.maxCallsPerHour)
    this.circuit.load()
  }

  private _clearStaleState(): void {
    const exitSignals = join(this.ralphDir, '.exit_signals')
    if (existsSync(exitSignals)) writeFileSync(exitSignals, '0')
    const analysis = join(this.ralphDir, '.response_analysis')
    if (existsSync(analysis)) writeFileSync(analysis, '{}')
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  private async _loop(): Promise<void> {
    while (this.running && !this.stopped) {
      this.loopCount++
      this.circuit.tick(this.loopCount)

      this._log('INFO', '')
      this._log('INFO', `┌─ Loop ${this.loopCount} ${'─'.repeat(Math.max(0, 32 - String(this.loopCount).length))}`)

      // ── 1. Integrity check ──────────────────────────────────────────────
      this._log('INFO', '│ [1/5] Checking file integrity…')
      const integrity = validateIntegrity(this.projectPath)
      if (!integrity.ok) {
        this._log('ERROR', `│ ✗ Missing: ${integrity.missing.join(', ')}`)
        this._log('ERROR', '│   Run Setup Wizard to restore files.')
        this._exit('file_integrity', integrity.missing.join(', '))
        return
      }
      this._log('INFO', '│ ✓ Integrity OK')

      // ── 2. Circuit breaker ──────────────────────────────────────────────
      const cb = this.circuit.snapshot()
      this._log('INFO', `│ [2/5] Circuit: ${cb.state} (no-progress: ${cb.consecutive_no_progress}/${this.config.cbNoProgressThreshold}, errors: ${cb.consecutive_same_error}/${this.config.cbSameErrorThreshold})`)
      if (this.circuit.isOpen()) {
        this._log('WARN', `│ ✗ Circuit OPEN: ${cb.reason}`)
        this._log('WARN', `│   Waiting ${this.config.cbCooldownMinutes}m for cooldown…`)
        this._writeStatus('halted', 'circuit_open_waiting')
        await this._sleep(60_000)
        this.circuit.load()
        if (this.circuit.isOpen()) { this._exit('circuit_open'); return }
        this._log('INFO', '│ ↻ Circuit → HALF_OPEN, resuming')
      }

      // ── 3. Rate limit ───────────────────────────────────────────────────
      const { used, max, resetIn } = this.rate.status()
      this._log('INFO', `│ [3/5] Rate limit: ${used}/${max} calls this hour (resets in ${resetIn})`)
      if (!this.rate.canCall()) {
        this._log('WARN', `│ ✗ Rate limit reached — waiting until reset (${resetIn})`)
        this._writeStatus('rate_limited', 'waiting_for_reset')
        await this.rate.waitForReset()
        this._log('INFO', '│ ↻ Rate limit reset, continuing')
      }

      // ── 4. Run Claude ───────────────────────────────────────────────────
      this.rate.record()
      const { used: usedNow, max: maxNow } = this.rate.status()
      this._log('INFO', `│ [4/5] Spawning Claude (call ${usedNow}/${maxNow})`)
      this._log('INFO', `│   cmd: ${this.config.claudeCodeCmd} --output-format ${this.config.claudeOutputFormat} --print`)
      if (this.lastSessionId) this._log('INFO', `│   session: ${this.lastSessionId}`)
      this._writeStatus('running', 'claude_execution')

      const claudeStart = Date.now()
      let rawOutput = ''
      try {
        rawOutput = await this._runClaude()
        const elapsed = ((Date.now() - claudeStart) / 1000).toFixed(1)
        this._log('INFO', `│ ✓ Claude finished in ${elapsed}s (${rawOutput.length} bytes output)`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `│ ✗ Claude error: ${msg}`)
        this.circuit.recordNoProgress(false)
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        this._log('WARN', '│   Continuing to next iteration…')
        continue
      }

      // ── 5. Analyse ──────────────────────────────────────────────────────
      this._log('INFO', '│ [5/5] Analysing response…')

      if (detectApiLimit(rawOutput)) {
        this._log('WARN', '│ ✗ API/rate limit message detected — exiting for cooldown')
        this._exit('api_limit')
        return
      }

      const { sessionId } = extractResultFromJsonStream(rawOutput)
      if (sessionId && sessionId !== this.lastSessionId) {
        this.lastSessionId = sessionId
        this._log('INFO', `│   New session ID: ${sessionId}`)
      }

      const result = analyze(rawOutput)
      this._log('INFO', `│   exitSignal=${result.exitSignal}  files=${result.filesModified}  questions=${result.askingQuestions}  progress=${result.hasProgress}`)
      if (result.workSummary) this._log('INFO', `│   summary: ${result.workSummary.slice(0, 120)}`)

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

      // Circuit breaker update
      if (result.hasPermissionDenials) {
        this._log('WARN', `│   Permission denied: ${result.deniedCommands.join(', ')}`)
        this.circuit.recordPermissionDenial()
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        if (this.circuit.isOpen()) { this._exit('permission_denied', result.deniedCommands.join(', ')); return }
      } else if (result.hasProgress || result.filesModified > 0) {
        this._log('INFO', `│   Circuit: recording progress (${result.filesModified} files)`)
        this.circuit.recordProgress(this.loopCount)
      } else {
        this._log(result.askingQuestions ? 'WARN' : 'INFO',
          `│   Circuit: no progress${result.askingQuestions ? ' (Claude asked questions — not counting against circuit)' : ''}`)
        this.circuit.recordNoProgress(result.askingQuestions)
      }
      this.circuit.save()
      this.emit('circuit', this.circuit.snapshot())

      this._log('INFO', `│   Circuit now: ${this.circuit.snapshot().state}`)

      // Exit conditions
      if (result.hasCompletionSignal && result.exitSignal) {
        this._log('SUCCESS', '└─ ✓ Project complete — EXIT_SIGNAL confirmed')
        this._exit('project_complete')
        return
      }

      if (result.isTestOnly) this.testOnlyCount++
      else this.testOnlyCount = 0
      if (this.testOnlyCount >= 3) {
        this._log('INFO', '└─ ✓ 3 consecutive test-only loops — project appears complete')
        this._exit('project_complete')
        return
      }

      if (this._isPlanComplete()) {
        this._log('SUCCESS', '└─ ✓ All fix_plan.md items checked off')
        this._exit('plan_complete')
        return
      }

      // Count remaining tasks and log
      const remaining = this._remainingTaskCount()
      this._log('INFO', `└─ ${remaining} task${remaining !== 1 ? 's' : ''} remaining — sleeping ${this.config.sleepDuration}s`)

      this._writeStatus('running', 'sleeping')
      await this._sleep(this.config.sleepDuration * 1_000)
    }

    // Always emit exit (the exited guard prevents double-emit)
    this._exit('stopped')
  }

  // ── Claude invocation ──────────────────────────────────────────────────────

  private _runClaude(): Promise<string> {
    return new Promise((resolve, reject) => {
      const prompt = this._buildPrompt()
      const args   = this._buildArgs()

      this._log('INFO', `│   Prompt: ${prompt.length} chars, args: ${args.join(' ')}`)

      const proc = spawn(this.config.claudeCodeCmd, args, {
        cwd: this.projectPath,
        env: { ...process.env, TERM: 'xterm-256color' },
        timeout: this.config.claudeTimeoutMinutes * 60_000
      })
      this.claudeProc = proc

      proc.stdin.write(prompt)
      proc.stdin.end()

      let output = ''
      let stderr = ''
      let lastEmit = Date.now()

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        this.emit('output', text)
        // Throttle progress logs to avoid flooding (max 1 per 2s)
        if (Date.now() - lastEmit > 2000) {
          lastEmit = Date.now()
          this._log('INFO', `│   … Claude running (${output.length} bytes received)`)
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        stderr += text
        if (text) {
          // Surface stderr immediately so users can see it
          for (const line of text.split('\n').filter(Boolean)) {
            this._log('WARN', `│   stderr: ${line}`)
          }
        }
      })

      proc.on('close', code => {
        this.claudeProc = null
        if (stderr.trim()) {
          this._log('WARN', `│   Claude stderr (${stderr.length} bytes) — shown above`)
        }
        if (this.stopped) { resolve(output); return }  // stopped externally, return whatever we got
        if (code === 124) {
          if (output.trim().length > 0) {
            this._log('WARN', '│   ⏱ Timeout but output exists — treating as productive')
            resolve(output)
          } else {
            reject(new Error(`Claude timed out after ${this.config.claudeTimeoutMinutes}m with no output`))
          }
          return
        }
        if (code !== 0 && output.trim().length === 0) {
          reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 400)}`))
          return
        }
        if (code !== 0) {
          this._log('WARN', `│   Claude exited with code ${code} but had output — continuing`)
        }
        resolve(output)
      })

      proc.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            `Claude CLI not found: '${this.config.claudeCodeCmd}'. ` +
            `Install with: npm install -g @anthropic-ai/claude-code`
          ))
        } else {
          reject(err)
        }
      })

      // Write raw output to timestamped log file
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
      ? readFileSync(fixPlan, 'utf8').split('\n').filter(l => l.startsWith('- [ ]')).join('\n')
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _isPlanComplete(): boolean {
    const f = join(this.ralphDir, 'fix_plan.md')
    if (!existsSync(f)) return false
    const lines   = readFileSync(f, 'utf8').split('\n')
    const tasks   = lines.filter(l => l.startsWith('- ['))
    const pending = lines.filter(l => l.startsWith('- [ ]'))
    return tasks.length > 0 && pending.length === 0
  }

  private _remainingTaskCount(): number {
    const f = join(this.ralphDir, 'fix_plan.md')
    if (!existsSync(f)) return 0
    return readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('- [ ]')).length
  }

  private _writeStatus(status: RalphStatus['status'], lastAction: string, exitReason = ''): void {
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
    if (this.exited) return
    this.exited  = true
    this.running = false
    this._log('INFO', `Exit: ${reason}${detail ? ` — ${detail}` : ''}`)
    try { this._writeStatus('completed', 'graceful_exit', reason) } catch { /* best-effort */ }
    this.emit('exit', reason, detail)
  }

  private _log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string): void {
    const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `[${ts}] [${level}] ${msg}`
    appendFileSync(join(this.logDir, 'ralph.log'), line + '\n')
    this.emit('log', level, msg)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const poll = setInterval(() => { if (this.stopped) { clearInterval(poll); clearTimeout(timer); resolve() } }, 250)
      const timer = setTimeout(() => { clearInterval(poll); resolve() }, ms)
    })
  }
}
