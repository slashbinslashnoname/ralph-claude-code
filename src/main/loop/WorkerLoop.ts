/**
 * WorkerLoop.ts — one Claude worker agent (Steps 3–5).
 *
 * Each instance represents one parallel Claude instance with its own terminal tab.
 * Workers share state only through AgentCoordinator (file locks, bead graph).
 *
 * Loop per worker:
 *   Route  — find the highest-score ready bead with no file conflicts
 *   Claim  — atomically claim it via AgentCoordinator
 *   Execute — spawn Claude to implement the bead
 *   Review  — spawn Claude again for a "fresh-eyes" review pass
 *   Close  — mark done, release file locks, pick next bead
 */

import { EventEmitter } from 'events'
import * as pty          from 'node-pty'
import { IPty }          from 'node-pty'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join }          from 'path'
import { execSync }      from 'child_process'

import { AgentCoordinator, AgentPhase }    from './AgentCoordinator'
import { Bead }                            from './Bead'
import { RalphConfig }                     from './types'
import { detectApiLimit }                  from './ResponseAnalyzer'

// ── Helpers (shared with RalphLoop) ───────────────────────────────────────

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function buildEnv(): Record<string, string> {
  const extras = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
    `${process.env.HOME ?? ''}/.volta/bin`,
  ]
  let loginPath = ''
  try { loginPath = execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim() } catch { /* ignore */ }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extras].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged } as Record<string, string>
}

function resolveCmd(cmd: string, env: Record<string, string>): string {
  if (cmd.startsWith('/')) {
    if (existsSync(cmd)) return cmd
    cmd = cmd.split('/').pop() ?? cmd
  }
  try {
    const r = execSync(`which ${cmd}`, { env, timeout: 3000 }).toString().trim()
    if (r.startsWith('/')) return r
  } catch { /* ignore */ }
  return cmd
}

// ── WorkerLoop events ─────────────────────────────────────────────────────

export interface WorkerEvents {
  log:    (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string) => void
  output: (chunk: string) => void
  phase:  (phase: AgentPhase, beadId?: string, beadTitle?: string) => void
  exit:   (reason: string) => void
}

interface TypedEmitter extends EventEmitter {
  on<K extends keyof WorkerEvents>(event: K, listener: WorkerEvents[K]): this
  emit<K extends keyof WorkerEvents>(event: K, ...args: Parameters<WorkerEvents[K]>): boolean
}

// ── WorkerLoop ─────────────────────────────────────────────────────────────

export class WorkerLoop extends (EventEmitter as new () => TypedEmitter) {
  private running   = false
  private stopped   = false
  private ptyProc: IPty | null = null
  private loopCount = 0
  private sessionId?: string

  private readonly ralphDir: string
  private readonly logDir:   string
  private readonly env:      Record<string, string>
  private readonly resolvedCmd: string

  constructor(
    public  readonly agentId:      string,
    public  readonly agentIndex:   number,
    private readonly projectPath:  string,
    private readonly config:       RalphConfig,
    private readonly coordinator:  AgentCoordinator
  ) {
    super()
    this.ralphDir    = join(projectPath, '.ralph')
    this.logDir      = join(this.ralphDir, 'logs')
    this.env         = buildEnv()
    this.resolvedCmd = resolveCmd(config.claudeCodeCmd, this.env)
    mkdirSync(this.logDir, { recursive: true })
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false

    this._log('INFO', `━━ Worker ${this.agentId} starting (cmd: ${this.resolvedCmd}) ━━`)
    this.coordinator.registerAgent({
      id: this.agentId, index: this.agentIndex, phase: 'idle',
      currentBeadId: null, loopCount: 0, lastActivity: new Date().toISOString()
    })
    this.coordinator.post({ from: this.agentId, type: 'started', text: `Worker ${this.agentId} online` })

    await this._loop()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.ptyProc) {
      try { this.ptyProc.kill('SIGTERM') } catch { /* ignore */ }
      const p = this.ptyProc
      setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ignore */ } }, 3000)
    }
    this.coordinator.releaseAllForAgent(this.agentId)
    this.coordinator.deregisterAgent(this.agentId)
    this.coordinator.post({ from: this.agentId, type: 'stopped' })
    this._exit('stopped')
  }

  // ── Main loop (Steps 3 → 5) ──────────────────────────────────────────────

  private async _loop(): Promise<void> {
    while (this.running && !this.stopped) {
      this.loopCount++

      // ── Step 3: Route ──────────────────────────────────────────────────
      this._setPhase('routing')
      this._log('INFO', `[${this.agentId}] Step 3 — Routing: looking for best available bead…`)

      const bead = this.coordinator.claimBestBead(this.agentId)
      if (!bead) {
        // No work available — check if graph is fully done
        const graph = this.coordinator.loadGraph()
        if (graph) {
          const remaining = graph.beads.filter(b => b.status !== 'done' && b.status !== 'failed')
          if (remaining.length === 0) {
            this._log('SUCCESS', `[${this.agentId}] All beads complete — worker done`)
            this._exit('all_beads_done')
            return
          }
          this._log('INFO', `[${this.agentId}] No available beads (${remaining.filter(b => b.status === 'claimed').length} claimed by others) — waiting…`)
        } else {
          this._log('WARN', `[${this.agentId}] No bead graph found — waiting for Plan/Encode phase…`)
        }
        this._setPhase('waiting')
        await this._sleep(5_000)
        continue
      }

      // ── Step 4: Coordinate ─────────────────────────────────────────────
      this._setPhase('claiming', bead.id, bead.title)
      this._log('INFO', `[${this.agentId}] Step 4 — Claimed: [${bead.id}] ${bead.title}`)
      this._log('INFO', `[${this.agentId}]   type=${bead.type}  priority=${bead.priority}  files=${bead.files.length}`)
      this.coordinator.updateAgent(this.agentId, { currentBeadId: bead.id, loopCount: this.loopCount })

      // ── Step 5a: Execute ───────────────────────────────────────────────
      this._setPhase('executing', bead.id, bead.title)
      this._log('INFO', `[${this.agentId}] Step 5 — Executing bead…`)
      let executeOutput = ''
      try {
        executeOutput = await this._runClaude(this._buildExecutePrompt(bead), 'execute')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('ERROR', `[${this.agentId}] Execute failed: ${msg}`)
        this.coordinator.failBead(this.agentId, bead.id, msg)
        this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null })
        await this._sleep(3_000)
        continue
      }

      if (this.stopped) break

      // Detect API limit in output
      if (detectApiLimit(stripAnsi(executeOutput))) {
        this._log('WARN', `[${this.agentId}] API limit detected — stopping worker`)
        this.coordinator.failBead(this.agentId, bead.id, 'api_limit')
        this._exit('api_limit')
        return
      }

      // ── Step 5b: Fresh-eyes review ─────────────────────────────────────
      this._setPhase('reviewing', bead.id, bead.title)
      this._log('INFO', `[${this.agentId}] Step 5 — Review: fresh-eyes pass…`)
      try {
        await this._runClaude(this._buildReviewPrompt(bead, executeOutput), 'review')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('WARN', `[${this.agentId}] Review failed (non-fatal): ${msg}`)
        // Review failure is non-fatal — we still close the bead
      }

      if (this.stopped) break

      // ── Step 5c: Close bead ────────────────────────────────────────────
      this._setPhase('closing', bead.id, bead.title)
      const unlocked = this.coordinator.completeBead(this.agentId, bead.id)
      this._log('SUCCESS', `[${this.agentId}] ✓ Closed bead [${bead.id}] — unlocked ${unlocked.length} beads`)
      this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null })

      // Brief pause before picking next bead
      await this._sleep(1_500)
    }

    this._exit('stopped')
  }

  // ── Claude invocation ─────────────────────────────────────────────────────

  private _runClaude(prompt: string, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = this._buildArgs(prompt)

      const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = join(this.logDir, `${this.agentId}_${label}_${ts}.log`)

      let proc: IPty
      try {
        proc = pty.spawn(this.resolvedCmd, args, {
          name: 'xterm-256color', cols: 220, rows: 50,
          cwd: this.projectPath, env: this.env
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(`${this.agentId}: spawn failed (${this.resolvedCmd}): ${msg}`))
        return
      }

      this.ptyProc = proc
      let raw = ''

      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        this._log('WARN', `[${this.agentId}] Timeout after ${this.config.claudeTimeoutMinutes}m`)
        if (raw.trim()) resolve(raw)
        else reject(new Error(`${this.agentId}: timed out with no output`))
      }, this.config.claudeTimeoutMinutes * 60_000)

      proc.onData(chunk => {
        raw += chunk
        this.emit('output', chunk)
        appendFileSync(outFile, chunk)
      })

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer)
        this.ptyProc = null
        if (this.stopped) { resolve(raw); return }
        if (exitCode !== 0 && !raw.trim()) {
          reject(new Error(`${this.agentId}: Claude exited ${exitCode} with no output`))
          return
        }
        resolve(raw)
      })
    })
  }

  private _buildArgs(prompt: string): string[] {
    const args = [
      '-p', prompt,
      '--output-format', this.config.claudeOutputFormat,
      '--allowedTools', this.config.allowedTools,
    ]
    if (this.config.continueSession && this.sessionId) {
      args.push('--resume', this.sessionId)
    }
    return args
  }

  // ── Prompt builders ───────────────────────────────────────────────────────

  private _buildExecutePrompt(bead: Bead): string {
    const agentMd = join(this.ralphDir, 'AGENT.md')
    const agentContext = existsSync(agentMd) ? readFileSync(agentMd, 'utf8') : ''
    const siblings = this._getSiblingContext(bead)

    return [
      `## Agent: ${this.agentId} | Bead: [${bead.id}] ${bead.title}`,
      `Type: ${bead.type} | Priority: ${bead.priority}/10`,
      bead.description ? `\n### Description\n${bead.description}` : '',
      bead.files.length > 0 ? `\n### Files to modify\n${bead.files.map(f => `- ${f}`).join('\n')}` : '',
      siblings ? `\n### Context (sibling beads)\n${siblings}` : '',
      agentContext ? `\n---\n${agentContext}` : '',
      `\n---\n## Task\nImplement this bead completely. Write tests. Commit when done.\n`,
      `When finished, output exactly:\nRALPH_STATUS: COMPLETE\nEXIT_SIGNAL: true`
    ].filter(Boolean).join('\n')
  }

  private _buildReviewPrompt(bead: Bead, _executeOutput: string): string {
    return [
      `## Fresh-eyes Review: [${bead.id}] ${bead.title}`,
      `Agent ${this.agentId} has implemented this bead. Review the changes critically:`,
      `- Are the tests adequate?`,
      `- Are there any edge cases missed?`,
      `- Is the code idiomatic and consistent with the rest of the codebase?`,
      `- Are there any obvious bugs?`,
      `\nIf issues are found, fix them now. If the implementation looks good, say so briefly.`,
      `Commit any fixes. Do NOT re-implement from scratch.`
    ].join('\n')
  }

  private _getSiblingContext(bead: Bead): string {
    const graph = this.coordinator.loadGraph()
    if (!graph) return ''
    const done = graph.beads
      .filter(b => b.status === 'done' && (b.epicId === bead.epicId || b.taskId === bead.taskId))
      .slice(-5)
      .map(b => `✓ [${b.id}] ${b.title}`)
    return done.join('\n')
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private _setPhase(phase: AgentPhase, beadId?: string, beadTitle?: string): void {
    this.emit('phase', phase, beadId, beadTitle)
    this.coordinator.updateAgent(this.agentId, { phase })
  }

  private _exit(reason: string): void {
    this.running = false
    this._log('INFO', `[${this.agentId}] exit: ${reason}`)
    this.emit('exit', reason)
  }

  private _log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string): void {
    appendFileSync(join(this.logDir, 'ralph.log'), `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    this.emit('log', level, msg)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const poll  = setInterval(() => { if (this.stopped) { clearInterval(poll); clearTimeout(t); resolve() } }, 250)
      const t     = setTimeout(() => { clearInterval(poll); resolve() }, ms)
    })
  }
}
