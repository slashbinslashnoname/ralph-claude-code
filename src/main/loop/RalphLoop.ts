import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'

// Use createRequire to load node-pty at runtime (prevents rollup from bundling the native module)
import { createRequire } from 'module'
const _require = createRequire(import.meta.url ?? __filename)
const pty: typeof import('node-pty') = _require('node-pty')
import { RalphConfig, LoopStatus } from '../types'
import { CircuitBreaker } from './CircuitBreaker'
import { RateLimit } from './RateLimit'
import { loadConfig } from './RcParser'
import { validateIntegrity } from './FileGuard'
import { analyze, extractResultFromJsonStream, detectApiLimit } from './ResponseAnalyzer'
import { BdClient } from './BdClient'

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function buildEnv(): NodeJS.ProcessEnv {
  const extraPaths = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
    `${process.env.HOME ?? ''}/.volta/bin`,
    `${process.env.HOME ?? ''}/.cargo/bin`,
  ]
  let loginPath = ''
  try {
    loginPath = child_process.execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim()
  } catch { /* ignore */ }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extraPaths].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged }
}

function resolveCmd(cmd: string, env: NodeJS.ProcessEnv): string {
  if (cmd.startsWith('/')) {
    if (fs.existsSync(cmd)) return cmd
    cmd = cmd.split('/').pop() ?? cmd
  }
  try {
    const result = child_process.execSync(`which ${cmd}`, { env, timeout: 3000 }).toString().trim()
    if (result.startsWith('/')) return result
  } catch { /* ignore */ }
  return cmd
}

export class RalphLoop extends EventEmitter {
  running = false
  stopped = false
  private exited = false
  loopCount = 0
  private testOnlyCount = 0
  private lastSessionId?: string
  private ptyProc: pty.IPty | null = null
  private ralphDir: string
  private logDir: string
  private config!: RalphConfig
  private circuit!: CircuitBreaker
  private rate!: RateLimit
  private bd!: BdClient

  constructor(private projectPath: string) {
    super()
    this.ralphDir = path.join(projectPath, '.ralph')
    this.logDir = path.join(this.ralphDir, 'logs')
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this._setup()
    this._log('INFO', '\u2501'.repeat(40))
    this._log('INFO', '  Slashbot \u2014 TypeScript loop engine')
    this._log('INFO', `  Project: ${this.projectPath}`)
    this._log('INFO', `  Claude cmd: ${this.config.claudeCodeCmd}`)
    this._log('INFO', `  Max calls/hr: ${this.config.maxCallsPerHour}`)
    this._log('INFO', `  Timeout: ${this.config.claudeTimeoutMinutes}m`)
    this._log('INFO', '\u2501'.repeat(40))
    this._clearStaleState()
    await this._loop()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this._log('INFO', 'Stop requested \u2014 terminating Claude subprocess\u2026')
    if (this.ptyProc) {
      try { this.ptyProc.kill('SIGTERM') } catch { /* ignore */ }
      const proc = this.ptyProc
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* ignore */ } }, 3000)
    }
    this._exit('stopped')
  }

  private _setup(): void {
    fs.mkdirSync(this.logDir, { recursive: true })
    this._rotateLog()
    this.config = loadConfig(this.projectPath)
    this.circuit = new CircuitBreaker(this.ralphDir, this.config)
    this.rate = new RateLimit(this.ralphDir, this.config.maxCallsPerHour)
    this.bd = new BdClient(this.projectPath)
    this.circuit.load()
    this.circuit.save()
    this.emit('circuit', this.circuit.snapshot())
  }

  private _rotateLog(maxLines = 2000): void {
    const logFile = path.join(this.logDir, 'ralph.log')
    if (!fs.existsSync(logFile)) return
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      if (lines.length > maxLines) {
        fs.writeFileSync(logFile, lines.slice(-maxLines).join('\n') + '\n')
      }
    } catch { /* ignore */ }
  }

  private _clearStaleState(): void {
    const exitSignals = path.join(this.ralphDir, '.exit_signals')
    if (fs.existsSync(exitSignals)) fs.writeFileSync(exitSignals, '0')
    const analysis = path.join(this.ralphDir, '.response_analysis')
    if (fs.existsSync(analysis)) fs.writeFileSync(analysis, '{}')
  }

  private async _loop(): Promise<void> {
    while (this.running && !this.stopped) {
      this.loopCount++
      this.circuit.tick(this.loopCount)

      this._log('INFO', '')
      this._log('INFO', `\u250C\u2500 Loop ${this.loopCount} ${'\u2500'.repeat(Math.max(0, 32 - String(this.loopCount).length))}`)

      // [1/5] Integrity
      this._log('INFO', '\u2502 [1/5] Checking file integrity\u2026')
      const integrity = validateIntegrity(this.projectPath)
      if (!integrity.ok) {
        this._log('ERROR', `\u2502 \u2717 Missing: ${integrity.missing.join(', ')}`)
        this._exit('file_integrity', integrity.missing.join(', '))
        return
      }
      this._log('INFO', '\u2502 \u2713 Integrity OK')

      // [2/5] Circuit breaker
      const cb = this.circuit.snapshot()
      this._log('INFO', `\u2502 [2/5] Circuit: ${cb.state} (no-progress: ${cb.consecutive_no_progress}/${this.config.cbNoProgressThreshold})`)
      if (this.circuit.isOpen()) {
        const openedAt = cb.opened_at ? new Date(cb.opened_at).getTime() : Date.now()
        const cooldownMs = this.config.cbCooldownMinutes * 60_000
        const remainingMs = Math.max(5000, openedAt + cooldownMs - Date.now())
        this._log('WARN', `\u2502 \u2717 Circuit OPEN: ${cb.reason}`)
        this._writeStatus('halted', 'circuit_open_waiting')
        await this._sleep(remainingMs)
        if (this.stopped) return
        this.circuit.load()
        if (this.circuit.isOpen()) { this._exit('circuit_open'); return }
      }

      // [3/5] Rate limit
      const { used, max, resetIn } = this.rate.status()
      this._log('INFO', `\u2502 [3/5] Rate limit: ${used}/${max} (resets ${resetIn})`)
      if (!this.rate.canCall()) {
        this._writeStatus('rate_limited', 'waiting_for_reset')
        await this.rate.waitForReset()
      }
      this.rate.record()

      // [4/5] Run Claude
      const { used: usedNow, max: maxNow } = this.rate.status()
      this._log('INFO', `\u2502 [4/5] Spawning Claude (call ${usedNow}/${maxNow})`)
      this._writeStatus('running', 'claude_execution')

      let rawOutput = ''
      try {
        rawOutput = await this._runClaude()
        const elapsed = ((Date.now() - Date.now()) / 1000).toFixed(1)
        this._log('INFO', `\u2502 \u2713 Claude finished (${rawOutput.length} bytes)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `\u2502 \u2717 Claude error: ${msg}`)
        this.circuit.recordNoProgress(false)
        this.circuit.save()
        this.emit('circuit', this.circuit.snapshot())
        continue
      }

      if (this.stopped) break

      // [5/5] Analyze
      this._log('INFO', '\u2502 [5/5] Analysing response\u2026')
      const cleanOutput = stripAnsi(rawOutput)

      if (detectApiLimit(cleanOutput)) {
        this._log('WARN', '\u2502 \u2717 API/rate limit detected')
        this._exit('api_limit')
        return
      }

      const { sessionId } = extractResultFromJsonStream(cleanOutput)
      if (sessionId && sessionId !== this.lastSessionId) {
        this.lastSessionId = sessionId
      }

      const result = analyze(cleanOutput)
      this._log('INFO', `\u2502   exit=${result.exitSignal} files=${result.filesModified} progress=${result.hasProgress}`)

      // Circuit breaker updates
      if (result.hasPermissionDenials) {
        this.circuit.recordPermissionDenial()
        if (this.circuit.isOpen()) { this._exit('permission_denied'); return }
      } else if (result.hasProgress) {
        this.circuit.recordProgress(this.loopCount)
      } else {
        this.circuit.recordNoProgress(result.askingQuestions)
      }
      this.circuit.save()
      this.emit('circuit', this.circuit.snapshot())

      // Exit conditions
      if (result.hasCompletionSignal && result.exitSignal) {
        this._log('SUCCESS', '\u2514\u2500 \u2713 Project complete')
        this._exit('project_complete')
        return
      }

      if (result.isTestOnly) this.testOnlyCount++
      else this.testOnlyCount = 0
      if (this.testOnlyCount >= 3) {
        this._exit('project_complete')
        return
      }

      // Check bd for remaining work
      if (!this.bd.hasOpenWork()) {
        this._log('SUCCESS', '\u2514\u2500 \u2713 All beads complete')
        this._exit('plan_complete')
        return
      }

      this._log('INFO', `\u2514\u2500 Sleeping ${this.config.sleepDuration}s`)
      this._writeStatus('running', 'sleeping')
      await this._sleep(this.config.sleepDuration * 1000)
    }
    this._exit('stopped')
  }

  private _runClaude(): Promise<string> {
    return new Promise((resolve, reject) => {
      const prompt = this._buildPrompt()
      const env = buildEnv()
      const resolvedCmd = resolveCmd(this.config.claudeCodeCmd, env)
      const args = this._buildArgs(prompt)

      let proc: pty.IPty
      try {
        proc = pty.spawn(resolvedCmd, args, {
          name: 'xterm-256color', cols: 220, rows: 50,
          cwd: this.projectPath, env
        })
      } catch (err) {
        reject(new Error(`Failed to spawn Claude (${resolvedCmd}): ${err instanceof Error ? err.message : err}`))
        return
      }
      this.ptyProc = proc
      let rawOutput = ''
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = path.join(this.logDir, `claude_output_${ts}.log`)

      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        if (rawOutput.trim()) resolve(rawOutput)
        else reject(new Error(`Claude timed out after ${this.config.claudeTimeoutMinutes}m`))
      }, this.config.claudeTimeoutMinutes * 60_000)

      proc.onData(chunk => {
        rawOutput += chunk
        this.emit('output', chunk)
        fs.appendFileSync(outFile, chunk)
      })

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer)
        this.ptyProc = null
        if (this.stopped) { resolve(rawOutput); return }
        if (exitCode !== 0 && !rawOutput.trim()) {
          reject(new Error(`Claude exited ${exitCode} with no output`))
          return
        }
        resolve(rawOutput)
      })
    })
  }

  private _buildArgs(prompt: string): string[] {
    const args = ['-p', prompt, '--output-format', this.config.claudeOutputFormat, '--allowedTools', this.config.allowedTools]
    if (this.config.continueSession && this.lastSessionId) {
      args.push('--resume', this.lastSessionId)
    }
    return args
  }

  private _buildPrompt(): string {
    const promptFile = path.join(this.ralphDir, 'PROMPT.md')
    const promptContent = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : ''

    // Get pending beads from bd
    let pendingBeads = ''
    try {
      const ready = this.bd.ready()
      if (ready.length > 0) {
        pendingBeads = ready.map(b => `- [ ] [${b.id}] ${b.title}`).join('\n')
      }
    } catch { /* bd might not be available */ }

    const circuitInfo = this.circuit.isOpen()
      ? `\nNOTE: Circuit breaker is ${this.circuit.snapshot().state}: ${this.circuit.snapshot().reason}` : ''

    return [
      '## Loop Context',
      `Loop iteration: ${this.loopCount}`,
      `Session: ${this.lastSessionId ?? 'new'}`,
      pendingBeads ? `\n### Pending beads\n${pendingBeads}` : '',
      circuitInfo,
      '\n---\n',
      promptContent
    ].filter(Boolean).join('\n')
  }

  private _writeStatus(status: string, lastAction: string, exitReason = ''): void {
    const { used, max, resetIn } = this.rate.status()
    const s: LoopStatus = {
      timestamp: new Date().toISOString(),
      loop_count: this.loopCount,
      calls_made_this_hour: used,
      max_calls_per_hour: max,
      last_action: lastAction,
      status,
      exit_reason: exitReason,
      next_reset: resetIn
    }
    fs.writeFileSync(path.join(this.ralphDir, 'status.json'), JSON.stringify(s, null, 2))
    this.emit('status', s)
  }

  private _exit(reason: string, detail?: string): void {
    if (this.exited) return
    this.exited = true
    this.running = false
    this._log('INFO', `Exit: ${reason}${detail ? ` \u2014 ${detail}` : ''}`)
    try { this._writeStatus('completed', 'graceful_exit', reason) } catch { /* ignore */ }
    this.emit('exit', reason, detail)
  }

  private _log(level: string, msg: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `[${ts}] [${level}] ${msg}`
    fs.appendFileSync(path.join(this.logDir, 'ralph.log'), line + '\n')
    this.emit('log', level, msg)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (this.stopped) { clearInterval(poll); clearTimeout(timer); resolve() }
      }, 250)
      const timer = setTimeout(() => { clearInterval(poll); resolve() }, ms)
    })
  }
}
