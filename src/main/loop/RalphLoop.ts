/**
 * RalphLoop — the autonomous development loop, implemented natively in TypeScript.
 * No shell scripts invoked — only the Claude CLI is spawned as a subprocess.
 *
 * Claude is spawned via node-pty (pseudo-terminal) so it detects a TTY and
 * outputs normally. Raw PTY data is forwarded to the Terminal page via
 * emit('output'). ANSI codes are stripped before JSON parsing.
 */

import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { IPty } from 'node-pty'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync
} from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

import { CircuitBreaker }   from './CircuitBreaker'
import { RateLimit }        from './RateLimit'
import {
  analyze, extractResultFromJsonStream, detectApiLimit
} from './ResponseAnalyzer'
import { validateIntegrity } from './FileGuard'
import { loadConfig }        from './RcParser'
import { loadGraph }         from './Bead'
import { ExitReason, LoopEvents, RalphConfig, RalphStatus } from './types'

interface TypedEmitter extends EventEmitter {
  on<K extends keyof LoopEvents>(event: K, listener: LoopEvents[K]): this
  emit<K extends keyof LoopEvents>(event: K, ...args: Parameters<LoopEvents[K]>): boolean
}

// Strip ANSI escape sequences and normalize line endings from PTY output
function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')  // CSI sequences (colors, cursor)
    .replace(/\x1B\][^\x07]*\x07/g, '')       // OSC sequences (title, etc.)
    .replace(/\x1B[()][AB012]/g, '')           // Character set sequences
    .replace(/\x1B[=>]/g, '')                  // Keypad mode
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Build a PATH-enriched environment for spawning subprocesses.
 * Electron GUI apps inherit a stripped PATH; we add common bin dirs so
 * node-pty (which uses posix_spawnp) can find claude and system tools.
 */
function buildEnv(): Record<string, string> {
  const extraPaths = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',       // macOS Homebrew
    `${process.env.HOME ?? ''}/.local/bin`,           // pip / cargo user installs
    `${process.env.HOME ?? ''}/.npm-global/bin`,      // npm global (manual prefix)
    `${process.env.HOME ?? ''}/.volta/bin`,           // Volta
  ]
  // Pull the full login-shell PATH so Electron's stripped env doesn't miss
  // custom install locations (nvm, volta, /opt/node*, etc.)
  let loginPath = ''
  try { loginPath = execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim() } catch { /* ignore */ }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extraPaths].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged } as Record<string, string>
}

/**
 * Resolve a command name to its absolute path using `which` in the enriched env.
 * Falls back to the original name if resolution fails.
 */
function resolveCmd(cmd: string, env: Record<string, string>): string {
  // If absolute path given but doesn't exist, fall back to which <basename>
  if (cmd.startsWith('/')) {
    if (existsSync(cmd)) return cmd
    cmd = cmd.split('/').pop() ?? cmd   // strip path, retry as bare name
  }
  try {
    const result = execSync(`which ${cmd}`, { env, timeout: 3000 }).toString().trim()
    if (result && result.startsWith('/')) return result
  } catch { /* not found — return as-is and let pty give a clear error */ }
  return cmd
}

export class RalphLoop extends (EventEmitter as new () => TypedEmitter) {
  private running = false
  private stopped = false
  private exited  = false   // prevents double-emit of 'exit'
  private loopCount = 0
  private testOnlyCount = 0
  private lastSessionId?: string
  private ptyProc: IPty | null = null  // current Claude PTY subprocess

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
    this._log('INFO', '  Slashbot — TypeScript loop engine')
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
    if (this.ptyProc) {
      try { this.ptyProc.kill('SIGTERM') } catch { /* already dead */ }
      const proc = this.ptyProc
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* ignore */ } }, 3000)
    }
    // Emit exit immediately so the UI updates now, not after Claude finishes
    this._exit('stopped')
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private _setup(): void {
    mkdirSync(this.logDir, { recursive: true })
    this._rotateLog()
    this.config  = loadConfig(this.projectPath)
    this.circuit = new CircuitBreaker(this.ralphDir, this.config)
    this.rate    = new RateLimit(this.ralphDir, this.config.maxCallsPerHour)
    this.circuit.load()
    // Save circuit state immediately so Dashboard shows CLOSED instead of "No state file"
    this.circuit.save()
    this.emit('circuit', this.circuit.snapshot())
  }

  /** Keep the log file at most MAX_LOG_LINES lines to prevent runaway growth. */
  private _rotateLog(maxLines = 2_000): void {
    const logFile = join(this.logDir, 'ralph.log')
    if (!existsSync(logFile)) return
    try {
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      if (lines.length > maxLines) {
        writeFileSync(logFile, lines.slice(-maxLines).join('\n') + '\n')
      }
    } catch { /* best-effort */ }
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
        // Sleep for the REMAINING cooldown time, not a fixed 60s.
        // The circuit transitions OPEN→HALF_OPEN after cbCooldownMinutes; sleeping
        // less than that means it's still OPEN after reload → tight exit loop.
        const openedAt = cb.opened_at ? new Date(cb.opened_at).getTime() : Date.now()
        const cooldownMs = this.config.cbCooldownMinutes * 60_000
        const remainingMs = Math.max(5_000, openedAt + cooldownMs - Date.now())
        const remainingMin = Math.ceil(remainingMs / 60_000)
        this._log('WARN', `│ ✗ Circuit OPEN: ${cb.reason}`)
        this._log('WARN', `│   Waiting ${remainingMin}m for cooldown to elapse…`)
        this._writeStatus('halted', 'circuit_open_waiting')
        await this._sleep(remainingMs)
        if (this.stopped) return
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
      this._log('INFO', `│ [4/5] Spawning Claude via PTY (call ${usedNow}/${maxNow})`)
      if (this.lastSessionId) this._log('INFO', `│   session: ${this.lastSessionId}`)
      this._writeStatus('running', 'claude_execution')

      const claudeStart = Date.now()
      let rawOutput = ''
      try {
        rawOutput = await this._runClaude()
        const elapsed = ((Date.now() - claudeStart) / 1000).toFixed(1)
        const cleanLen = stripAnsi(rawOutput).length
        this._log('INFO', `│ ✓ Claude finished in ${elapsed}s (${rawOutput.length} raw bytes / ${cleanLen} clean bytes)`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `│ ✗ Claude error: ${msg}`)
        this.circuit.recordNoProgress(false)
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        this._log('WARN', '│   Continuing to next iteration…')
        continue
      }

      if (this.stopped) break  // stop() was called during Claude run

      // ── 5. Analyse ──────────────────────────────────────────────────────
      this._log('INFO', '│ [5/5] Analysing response…')

      const cleanOutput = stripAnsi(rawOutput)

      if (detectApiLimit(cleanOutput)) {
        this._log('WARN', '│ ✗ API/rate limit message detected — exiting for cooldown')
        this._exit('api_limit')
        return
      }

      const { sessionId } = extractResultFromJsonStream(cleanOutput)
      if (sessionId && sessionId !== this.lastSessionId) {
        this.lastSessionId = sessionId
        this._log('INFO', `│   New session ID: ${sessionId}`)
      }

      const result = analyze(cleanOutput)
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
        this._log('SUCCESS', '└─ ✓ All beads complete')
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

  // ── Claude invocation via PTY ──────────────────────────────────────────────

  private _runClaude(): Promise<string> {
    return new Promise((resolve, reject) => {
      const prompt = this._buildPrompt()
      const env    = buildEnv()

      // Resolve the claude binary to an absolute path.
      // node-pty uses posix_spawnp which requires the command to be findable
      // in the enriched PATH we pass (Electron GUI apps have a stripped PATH).
      const resolvedCmd = resolveCmd(this.config.claudeCodeCmd, env)
      this._log('INFO', `│   Resolved cmd: ${resolvedCmd}`)

      // Pass the prompt via -p so we don't need a shell or stdin redirect.
      // node-pty spawns Claude directly — no shell subprocess needed.
      const args = this._buildArgs(prompt)
      this._log('INFO', `│   Prompt: ${prompt.length} chars`)
      this._log('INFO', `│   Args: ${['(prompt)', ...args.slice(2)].join(' ')}`)

      let proc: IPty
      try {
        proc = pty.spawn(resolvedCmd, args, {
          name: 'xterm-256color',
          cols: 220,
          rows: 50,
          cwd: this.projectPath,
          env
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(
          `Failed to spawn Claude (${resolvedCmd}): ${msg}. ` +
          `Install with: npm install -g @anthropic-ai/claude-code`
        ))
        return
      }

      this.ptyProc = proc

      let rawOutput = ''
      let lastEmit = Date.now()

      // Timestamped log file for this Claude call
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = join(this.logDir, `claude_output_${ts}.log`)

      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* already dead */ }
        this._log('WARN', `│   ⏱ Timeout after ${this.config.claudeTimeoutMinutes}m`)
        if (rawOutput.trim().length > 0) resolve(rawOutput)
        else reject(new Error(`Claude timed out after ${this.config.claudeTimeoutMinutes}m with no output`))
      }, this.config.claudeTimeoutMinutes * 60_000)

      proc.onData(chunk => {
        rawOutput += chunk
        // Forward raw PTY data to Terminal page (ANSI colors preserved)
        this.emit('output', chunk)
        // Append to per-call log file
        appendFileSync(outFile, chunk)
        // Throttle progress logs (max 1 per 2s)
        if (Date.now() - lastEmit > 2000) {
          lastEmit = Date.now()
          this._log('INFO', `│   … Claude running (${rawOutput.length} bytes received)`)
        }
      })

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer)
        this.ptyProc = null
        if (this.stopped) { resolve(rawOutput); return }
        if (exitCode !== 0 && rawOutput.trim().length === 0) {
          reject(new Error(`Claude exited ${exitCode} with no output. Check the Terminal tab for details.`))
          return
        }
        if (exitCode !== 0) {
          this._log('WARN', `│   Claude exited ${exitCode} but had output — continuing`)
        }
        resolve(rawOutput)
      })
    })
  }

  // Pass the prompt as the -p argument so Claude reads it directly.
  // No shell or stdin redirect needed — Claude accepts -p <prompt text>.
  private _buildArgs(prompt: string): string[] {
    const args = [
      '-p', prompt,
      '--output-format', this.config.claudeOutputFormat,
      '--allowedTools', this.config.allowedTools,
    ]
    if (this.config.continueSession && this.lastSessionId) {
      args.push('--resume', this.lastSessionId)
    }
    return args
  }

  private _buildPrompt(): string {
    const promptFile = join(this.ralphDir, 'PROMPT.md')
    const promptContent = existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : ''

    const graph = loadGraph(this.ralphDir)
    const pendingBeads = graph
      ? graph.beads
          .filter(b => b.status === 'pending' || b.status === 'ready')
          .map(b => `- [ ] [${b.id}] ${b.title}`)
          .join('\n')
      : ''

    const circuitInfo = this.circuit.isOpen()
      ? `\n\nNOTE: Circuit breaker is ${this.circuit.snapshot().state}: ${this.circuit.snapshot().reason}`
      : ''

    const context = [
      `## Loop Context`,
      `Loop iteration: ${this.loopCount}`,
      `Session: ${this.lastSessionId ?? 'new'}`,
      pendingBeads ? `\n### Pending beads\n${pendingBeads}` : '',
      circuitInfo
    ].filter(Boolean).join('\n')

    return `${context}\n\n---\n\n${promptContent}`
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _isPlanComplete(): boolean {
    const graph = loadGraph(this.ralphDir)
    if (!graph || graph.beads.length === 0) return false
    return graph.beads.every(b => b.status === 'done' || b.status === 'failed')
  }

  private _remainingTaskCount(): number {
    const graph = loadGraph(this.ralphDir)
    if (!graph) return 0
    return graph.beads.filter(b => b.status === 'pending' || b.status === 'ready' || b.status === 'claimed').length
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
      const poll  = setInterval(() => { if (this.stopped) { clearInterval(poll); clearTimeout(timer); resolve() } }, 250)
      const timer = setTimeout(() => { clearInterval(poll); resolve() }, ms)
    })
  }
}
