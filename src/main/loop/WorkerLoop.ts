import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import { RalphConfig, Bead } from '../types'
import { AgentCoordinator } from './AgentCoordinator'
import { analyze, detectApiLimit, extractResultFromJsonStream } from './ResponseAnalyzer'
import { CircuitBreaker } from './CircuitBreaker'
import { classifyError } from './ErrorClassifier'
import { stripAnsi, buildEnv, resolveCmd } from './utils'
import { runStateMachine, createWorkerContext, WorkerContext, WorkerCapabilities } from './WorkerStateMachine'
import { ProjectPaths } from './ProjectStore'

/** Beads CLI reference — appended to every prompt */
const BD_SYSTEM_PROMPT = `
## Beads (\`bd\` CLI)

### Lifecycle (orchestrator-managed — do NOT use these)
- Do NOT run \`bd close\`, \`bd reopen\`, \`bd claim\`, or \`bd delete\`.
- Do NOT use \`bd edit\` — it opens an interactive editor that agents cannot use.

### Read commands (use these freely for context)
- \`bd show <id>\` — view bead details, description, dependencies
- \`bd list --json\` — see all open beads and their status
- \`bd ready --json\` — find unblocked beads ready for work
- \`bd comments <id>\` — read comments and discussion on a bead
- \`bd children <id>\` — list child beads of a parent
- \`bd search <query>\` — find related beads by text
- \`bd history <id>\` — view bead change history
- \`bd status\` — overview of the bead database

### Update commands (use \`bd update\` with flags, never \`bd edit\`)
- \`bd update <id> --title "new title"\`
- \`bd update <id> --description "new description"\`
- \`bd update <id> --design "design notes"\`
- \`bd update <id> --notes "additional notes"\`
- \`bd update <id> --acceptance "acceptance criteria"\`
- For text with special characters (backticks, !, nested quotes), use stdin:
  \`echo 'Description with \\\`backticks\\\` and "quotes"' | bd update <id> --description=-\`

### Creating discovered work
If you discover issues outside the scope of the current bead, create a new bead:
\`\`\`bash
bd create "Fix: <description>" -t task -p 2 -d "<details>" -l "fix-later" --json
\`\`\`
Then link it with a discovered-from dependency:
\`\`\`bash
bd dep add <new-bead-id> <current-bead-id>
\`\`\`
Always use \`--json\` flag for programmatic use so you can read the created bead's ID.

### Important rules
- Always use \`--json\` flag when you need to read output programmatically.
- Focus on implementing the assigned bead.
- Commit your changes with a descriptive message when done.
- Do NOT create markdown TODO lists — use \`bd\` for all task tracking.
`

/**
 * Extract a retry-after delay from Claude CLI output.
 * Looks for patterns like `"retry_after": 3600` or `Retry-After: 60`.
 * Returns delay in milliseconds, or undefined if not found.
 */
export function extractRetryAfter(output: string): number | undefined {
  // JSON format: "retry_after": 3600
  const jsonMatch = output.match(/"retry_after"\s*:\s*(\d+)/)
  if (jsonMatch) return parseInt(jsonMatch[1], 10) * 1000

  // HTTP header format: Retry-After: 60
  const headerMatch = output.match(/Retry-After:\s*(\d+)/i)
  if (headerMatch) return parseInt(headerMatch[1], 10) * 1000

  return undefined
}

export class WorkerLoop extends EventEmitter {
  running = false
  stopped = false
  paused = false
  private _gracefulStopping = false
  private _pauseResolve: ((stopped: boolean) => void) | null = null
  private _phaseBeforePause: string | null = null
  private childProc: ReturnType<typeof cp.spawn> | null = null
  loopCount = 0
  private emptyRetries = 0
  private sessionId?: string
  private paths: ProjectPaths
  private logDir: string
  private env: NodeJS.ProcessEnv
  private resolvedCmd: string
  /** Shared context when running in state-machine mode (feature-flagged). */
  private _stateMachineCtx: WorkerContext | null = null
  /** Current bead ID being worked on. */
  private _currentBeadId: string | null = null

  constructor(
    public agentId: string,
    private agentIndex: number,
    private projectPath: string,
    private config: RalphConfig,
    private coordinator: AgentCoordinator,
    paths: ProjectPaths
  ) {
    super()
    this.paths = paths
    this.logDir = paths.logsDir
    this.env = buildEnv()
    this.resolvedCmd = resolveCmd(config.claudeCodeCmd, this.env)
    fs.mkdirSync(this.logDir, { recursive: true })
  }

  /** Re-register with a slot-based idle ID after completing/failing a bead. */
  private _resetAgentIdToIdle(): void {
    this.coordinator.deregisterAgent(this.agentId)
    this.agentId = `worker-${this.agentIndex}`
    this.coordinator.registerAgent({
      id: this.agentId, index: this.agentIndex, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, currentBeadDescription: null, currentBeadType: null,
      loopCount: this.loopCount, lastActivity: new Date().toISOString(),
      worktreeBranch: null, thinkingSummary: null
    })
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this._gracefulStopping = false
    this._log('INFO', `━━ Worker ${this.agentId} starting (cmd: ${this.resolvedCmd}) ━━`)
    this.coordinator.registerAgent({
      id: this.agentId, index: this.agentIndex, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, currentBeadDescription: null, currentBeadType: null,
      loopCount: 0, lastActivity: new Date().toISOString(),
      worktreeBranch: null
    })
    this.coordinator.postActivity({ agentId: this.agentId, type: 'started', summary: `Worker ${this.agentId} online` })
    if (process.env.SLASHBOT_STATE_MACHINE === '1') {
      await this._loopStateMachine()
    } else {
      await this._loop()
    }
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this.paused = false
    // Propagate to state machine context if active
    if (this._stateMachineCtx) this._stateMachineCtx.flags.stopped = true
    // Release pause gate so the loop can exit — signal stopped
    if (this._pauseResolve) { this._pauseResolve(true); this._pauseResolve = null }
    if (this.childProc) {
      try { this.childProc.kill('SIGTERM') } catch { /* ignore */ }
      const p = this.childProc
      setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ignore */ } }, 3000)
    }
    // Release file locks immediately but defer deregistration —
    // the loop's finally block may still be merging and needs the agent state.
    this.coordinator.releaseAllForAgent(this.agentId)
    this.coordinator.postActivity({ agentId: this.agentId, type: 'stopped' })
    // Do NOT call deregisterAgent() here — it will be called in _exit()
  }

  /** Signal worker to stop after current bead finishes (no process kill). */
  gracefulStop(): void {
    // Auto-resume if paused so the worker can finish its current bead and exit
    if (this.paused) this.resume()
    this._gracefulStopping = true
    this.running = false
    // Propagate to state machine context if active
    if (this._stateMachineCtx) this._stateMachineCtx.flags.gracefulStopping = true
    this._log('INFO', `[${this.agentId}] Graceful stop requested — will finish current bead`)
    this.coordinator.postActivity({ agentId: this.agentId, type: 'stopped', summary: 'Graceful stop — finishing current bead' })
  }

  /** Pause the worker after the current phase completes. */
  pause(): void {
    if (this.paused || this.stopped) return
    this.paused = true
    this._phaseBeforePause = this.coordinator.getAgents().find(a => a.id === this.agentId)?.phase ?? null
    this._setPhase('paused')
    this._log('INFO', `[${this.agentId}] Paused`)
    this.coordinator.postActivity({ agentId: this.agentId, type: 'paused', summary: 'Agent paused' })
  }

  /** Resume a paused worker. */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this._log('INFO', `[${this.agentId}] Resumed`)
    this.coordinator.postActivity({ agentId: this.agentId, type: 'resumed', summary: 'Agent resumed' })
    // Restore previous phase if available, otherwise idle
    if (this._phaseBeforePause && this._phaseBeforePause !== 'paused') {
      this._setPhase(this._phaseBeforePause)
    }
    this._phaseBeforePause = null
    // Release the pause gate so the loop continues
    if (this._pauseResolve) {
      this._pauseResolve(false)
      this._pauseResolve = null
    }
  }

  /** Build capabilities that delegate to WorkerLoop's private methods/fields. */
  private _buildCapabilities(): WorkerCapabilities {
    return {
      runClaude: (prompt, label, cwd, model) => this._runClaude(prompt, label, cwd, model),
      buildThinkingPrompt: (bead) => this._buildThinkingPrompt(bead),
      buildExecutePrompt: (bead, thinkingSummary) => this._buildExecutePrompt(bead, thinkingSummary),
      buildReviewPrompt: (bead) => this._buildReviewPrompt(bead),
      detectApiLimit: (output) => detectApiLimit(output),
      stripAnsi: (s) => stripAnsi(s),
      extractText: (raw) => this._extractText(raw),
      extractThinkingSummary: (raw) => this._extractThinkingSummary(raw),
      extractKnowledge: (output, beadId) => this._extractKnowledge(output, beadId),
      parseSplitDecision: (output, bead) => this._parseSplitDecision(output, bead),
      splitBead: async (_decision) => { /* split logic handled by orchestrator */ },
      waitForQuotaReset: (cb?: CircuitBreaker) => this._waitForQuotaReset(cb),
      extractRetryAfter: (output: string) => extractRetryAfter(output),
      waitIfPaused: () => this._waitIfPaused(),
      sleep: (ms) => this._sleep(ms),
      emitter: this,
      getBeadAttempt: (beadId) => this._getBeadAttempt(beadId),
      incrementBeadAttempt: (beadId) => this._incrementBeadAttempt(beadId),
      backoffMs: (attempt) => this._backoffMs(attempt),
      childProcRef: { childProc: this.childProc },
      commitWorktreeChanges: (worktreePath, agentId, env) => {
        try {
          cp.execSync('git add -A && git reset HEAD -- .beads .slashbot .slashbotrc 2>/dev/null; git diff --cached --quiet || git commit -m "agent work on bead"', {
            cwd: worktreePath, timeout: 10000, stdio: 'pipe',
            env: { ...env, GIT_AUTHOR_NAME: agentId, GIT_COMMITTER_NAME: agentId }
          })
        } catch { /* ignore — may have nothing to commit */ }
      },
      resolvedCmd: this.resolvedCmd,
      env: this.env
    }
  }

  /** State-machine driven loop (feature-flagged behind SLASHBOT_STATE_MACHINE=1). */
  private async _loopStateMachine(): Promise<void> {
    const capabilities = this._buildCapabilities()

    const cb = new CircuitBreaker(this.paths.storeDir, this.config, this.agentId)
    cb.load()

    // Listen for circuit state changes and post activity
    cb.on('open', (payload: { agentId: string; reason: string; totalOpens: number }) => {
      this.coordinator.postActivity({
        agentId: this.agentId, type: 'circuit_open',
        summary: `Circuit breaker OPEN: ${payload.reason} (opens: ${payload.totalOpens})`
      })
    })
    cb.on('closed', (payload: { agentId: string }) => {
      this.coordinator.postActivity({
        agentId: this.agentId, type: 'circuit_closed',
        summary: 'Circuit breaker recovered (CLOSED)'
      })
    })

    const ctx = createWorkerContext(
      this.agentId,
      this.agentIndex,
      this.paths,
      this.config,
      this.coordinator,
      capabilities,
      cb
    )
    this._stateMachineCtx = ctx

    // Emit heartbeat every 30s so the orchestrator can detect dead agents
    const heartbeatTimer = setInterval(() => {
      this.coordinator.heartbeat(this.agentId)
      this.emit('heartbeat')
    }, 30_000)
    this.coordinator.heartbeat(this.agentId)
    this.emit('heartbeat')

    try {
      await runStateMachine(ctx)
    } finally {
      cb.removeAllListeners()
      clearInterval(heartbeatTimer)
      this._stateMachineCtx = null
      this._exit(ctx.flags.stopped || ctx.flags.gracefulStopping ? 'stopped' : 'all_beads_done')
    }
  }

  private async _loop(): Promise<void> {
    // Emit heartbeat every 30s so the orchestrator can detect dead agents
    const heartbeatTimer = setInterval(() => {
      this.coordinator.heartbeat(this.agentId)
      this.emit('heartbeat')
    }, 30_000)
    // Emit initial heartbeat immediately
    this.coordinator.heartbeat(this.agentId)
    this.emit('heartbeat')

    const cb = new CircuitBreaker(this.paths.storeDir, this.config, this.agentId)
    cb.load()

    // Listen for circuit state changes and post activity
    cb.on('open', (payload: { agentId: string; reason: string; totalOpens: number }) => {
      this.coordinator.postActivity({
        agentId: this.agentId, type: 'circuit_open',
        summary: `Circuit breaker OPEN: ${payload.reason} (opens: ${payload.totalOpens})`
      })
    })
    cb.on('closed', (payload: { agentId: string }) => {
      this.coordinator.postActivity({
        agentId: this.agentId, type: 'circuit_closed',
        summary: 'Circuit breaker recovered (CLOSED)'
      })
    })

    try {
    while (this.running && !this.stopped && !this._gracefulStopping) {
      // Pause gate: wait before claiming next bead
      if (await this._waitIfPaused()) break
      this.loopCount++
      cb.tick(this.loopCount)

      // Circuit breaker: if open, wait for cooldown before claiming next bead
      if (cb.isOpen()) {
        this._log('WARN', `[${this.agentId}] Circuit OPEN — pausing before next bead`)
        this._setPhase('waiting')
        await this._sleep(60_000)
        cb.load() // re-check cooldown state from disk
        continue
      }

      this._setPhase('routing')
      this._log('INFO', `[${this.agentId}] Routing: looking for best available bead…`)

      let bead: Bead | null = null
      try {
        bead = await this.coordinator.claimBestBead(this.agentId, this.config.claudeTimeoutMinutes)
      } catch (err) {
        this._log('ERROR', `[${this.agentId}] claimBestBead failed: ${err instanceof Error ? err.message : err}`)
        this._setPhase('waiting')
        await this._sleep(5000)
        continue
      }
      if (!bead) {
        const hasOpen = await this.coordinator.hasOpenWorkAsync()
        if (!hasOpen) {
          // No open beads — stay alive and poll with increasing backoff.
          // New beads may arrive via plan injection at any time.
          this.emptyRetries++
          const waitSec = Math.min(10 + this.emptyRetries * 5, 60) // 15s, 20s, … capped at 60s
          this._log('INFO', `[${this.agentId}] No open beads — idle, polling in ${waitSec}s (attempt ${this.emptyRetries})`)
          this._setPhase('idle')
          await this._sleep(waitSec * 1000)
          continue
        }
        // There's open/in-progress work but nothing claimable for us right now.
        // After 5 consecutive failures, try to auto-unblock the routing.
        this.emptyRetries++
        if (this.emptyRetries >= 5 && this.emptyRetries % 5 === 0) {
          this._log('WARN', `[${this.agentId}] Routing stuck for ${this.emptyRetries} attempts — attempting auto-unblock`)
          const unblocked = await this.coordinator.tryUnblockRouting(this.agentId)
          if (unblocked) {
            this._log('INFO', `[${this.agentId}] Auto-unblock took corrective action — retrying immediately`)
            continue
          }
        }
        const waitSec = Math.min(10 + this.emptyRetries * 5, 30) // 15s, 20s, 25s, 30s...
        this._log('INFO', `[${this.agentId}] No claimable beads (blocked by deps or claimed), waiting ${waitSec}s… (attempt ${this.emptyRetries})`)
        this._setPhase('waiting')
        await this._sleep(waitSec * 1000)
        continue
      }
      this.emptyRetries = 0

      // Re-register with bead-based agentId: worker-{beadId}
      const prevAgentId = this.agentId
      const beadAgentId = `worker-${bead.id}`
      this.coordinator.deregisterAgent(prevAgentId)
      this.agentId = beadAgentId
      this.coordinator.registerAgent({
        id: beadAgentId, index: this.agentIndex, phase: 'claiming',
        currentBeadId: bead.id, currentBeadTitle: bead.title,
        currentBeadDescription: bead.description || null, currentBeadType: bead.type || null,
        loopCount: this.loopCount, lastActivity: new Date().toISOString(),
        worktreeBranch: null, thinkingSummary: null
      })

      this._setPhase('claiming', bead.id, bead.title)
      this._log('INFO', `[${this.agentId}] Claimed: [${bead.id}] ${bead.title}`)
      this._currentBeadId = bead.id

      // ── Create worktree for isolated work ─────────────────────────
      const wt = await this.coordinator.createWorktree(this.agentId, bead.id)
      if (!wt) {
        this._log('ERROR', `[${this.agentId}] Worktree creation failed for bead [${bead.id}] — refusing to proceed without isolation`)
        this.emit('output', `\n── ERROR: Worktree creation failed for [${bead.id}] — reopening bead and retrying ──\n\n`)
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'failed', beadId: bead.id,
          beadTitle: bead.title, summary: `Worktree creation failed for [${bead.id}]`
        })
        await this.coordinator.reopenBead(this.agentId, bead.id)
        this._currentBeadId = null
        this._resetAgentIdToIdle()
        await this._sleep(10_000)
        continue
      }
      const workDir = wt.worktreePath
      const branch = wt.branch
      this._log('INFO', `[${this.agentId}] Worktree created: ${wt.branch}`)
      this.emit('output', `\n── Worktree: ${wt.branch} ──\n   ${wt.worktreePath}\n\n`)
      this.coordinator.updateAgent(this.agentId, { worktreeBranch: branch })

      // ── Phases 0-3: Think, Execute, Review ─────────────────────
      // Wrap in try/finally to ensure worktree is always merged back
      let executeFailed = false
      let apiLimited = false
      let mergeFailed = false
      let filesChanged: string[] = []
      let executeOutput = ''
      let thinkingSummary = ''

      try {
        // Skip execute if stopped or paused
        if (this.stopped) {
          // Fall through to finally → merge, then Phase 5 handles it
        } else if (await this._waitIfPaused()) {
          // Paused and then stopped — fall through
        } else {
        // ── Ensure Dolt server is alive before Claude shells out to bd ──
        await this.coordinator.bd.ensureDolt()

        // ── Phase 0: Think — gather context, plan approach ──────────
        this._setPhase('thinking', bead.id, bead.title)
        this._log('INFO', `[${this.agentId}] Thinking: gathering context…`)
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'thinking', beadId: bead.id,
          beadTitle: bead.title, summary: 'Gathering context and planning…'
        })
        try {
          const thinkingOutput = await this._runClaude(this._buildThinkingPrompt(bead), 'think', workDir, this.config.claudeModelThink)
          if (detectApiLimit(stripAnsi(thinkingOutput))) {
            this._log('WARN', `[${this.agentId}] API limit detected during thinking`)
            apiLimited = true
            executeOutput = thinkingOutput
          } else {
            const rawText = this._extractText(thinkingOutput)
            thinkingSummary = this._extractThinkingSummary(rawText)
            try { this._extractKnowledge(rawText, bead.id) } catch { /* non-fatal */ }
            this.coordinator.updateAgent(this.agentId, { thinkingSummary: thinkingSummary.slice(0, 2000) })
          }
        } catch (err) {
          this._log('WARN', `[${this.agentId}] Thinking phase failed (non-fatal): ${err instanceof Error ? err.message : err}`)
        }

        if (apiLimited) {
          // Fall through to finally → merge, then Phase 5 handles rate limit
        } else if (this.stopped) {
          // Fall through
        } else if (await this._waitIfPaused()) {
          // Paused and then stopped — fall through
        } else {

        // ── Phase 1: Execute — implement the bead ───────────────────
        this._setPhase('executing', bead.id, bead.title)
        this._log('INFO', `[${this.agentId}] Executing bead…`)
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'executing', beadId: bead.id,
          beadTitle: bead.title, summary: 'Implementing…'
        })
        executeOutput = ''
        try {
          executeOutput = await this._runClaude(this._buildExecutePrompt(bead, thinkingSummary || undefined), 'execute', workDir, this.config.claudeModelExecute)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this._log('ERROR', `[${this.agentId}] Execute failed: ${msg}`)
          executeFailed = true
          // Fall through to finally → merge, then Phase 5 handles retry/fail
        }

        if (!executeFailed) {
          if (this.stopped) {
            // Fall through to finally → merge, then Phase 5 handles reopen
          } else if (detectApiLimit(stripAnsi(executeOutput))) {
            this._log('WARN', `[${this.agentId}] API limit detected`)
            apiLimited = true
            // Fall through to finally → merge, then Phase 5 handles rate limit
          } else {
            // Pause gate: wait between executing and reviewing
            if (!(await this._waitIfPaused())) {
              // ── Phase 2: Review — fresh-eyes pass ───────────────────────
              this._setPhase('reviewing', bead.id, bead.title)
              this._log('INFO', `[${this.agentId}] Review: fresh-eyes pass…`)
              try {
                await this._runClaude(this._buildReviewPrompt(bead), 'review', workDir, this.config.claudeModelReview)
              } catch (err) {
                this._log('WARN', `[${this.agentId}] Review failed (non-fatal): ${err instanceof Error ? err.message : err}`)
              }
            }
          }
        }
        } // close else block from apiLimited/stopped/paused guard
        } // close else block from stopped/paused guard
      } finally {
        this._currentBeadId = null
        // ── Phase 4: Merge worktree back (skip if stopped — no partial work) ──
        if (wt && this.stopped) {
          // Just clean up the worktree without merging
          this._log('INFO', `[${this.agentId}] Stopped — discarding worktree ${wt.branch} (no merge)`)
          try {
            cp.execSync(`git worktree remove --force "${wt.worktreePath}"`, {
              cwd: this.projectPath, timeout: 10000, stdio: 'pipe'
            })
          } catch { /* best-effort cleanup */ }
          await this.coordinator.reopenBead(this.agentId, bead.id)
        } else if (wt && !this.stopped) {
          try {
            this._setPhase('merging', bead.id, bead.title)
            this._log('INFO', `[${this.agentId}] Merging worktree branch ${wt.branch}…`)

            // Commit any uncommitted changes in the worktree
            try {
              cp.execSync('git add -A && git reset HEAD -- .beads .slashbot .slashbotrc 2>/dev/null; git diff --cached --quiet || git commit -m "agent work on bead"', {
                cwd: wt.worktreePath, timeout: 10000, stdio: 'pipe',
                env: { ...this.env, GIT_AUTHOR_NAME: this.agentId, GIT_COMMITTER_NAME: this.agentId }
              })
            } catch { /* ignore — may have nothing to commit */ }

            const result = await this.coordinator.mergeWorktree(this.agentId, bead.id, wt.branch, wt.worktreePath, {
              // During graceful stop, never abort the merge — let the bead complete
              stoppedFn: this._gracefulStopping ? undefined : () => this.stopped,
              claudeCmd: this.resolvedCmd,
              env: this.env
            })
            filesChanged = result.filesChanged

            if (result.merged) {
              this._log('SUCCESS', `[${this.agentId}] Merged ${filesChanged.length} files from ${wt.branch}`)
              this.emit('output', `\n── Merged ${wt.branch} → ${filesChanged.length} files ──\n${filesChanged.map(f => `  ${f}`).join('\n')}\n\n`)
              this.coordinator.postActivity({
                agentId: this.agentId, type: 'merged', beadId: bead.id,
                beadTitle: bead.title, branch: wt.branch,
                filesChanged, summary: `Merged ${filesChanged.length} files`,
                commitSha: result.commitSha
              })
            } else {
              this._log('ERROR', `[${this.agentId}] Merge failed: ${result.error}`)
              this.emit('output', `\n── Merge FAILED: ${wt.branch} ──\n${result.error}\n\n`)
              mergeFailed = true
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this._log('ERROR', `[${this.agentId}] Merge crashed: ${msg}`)
            this.emit('output', `\n── Merge ERROR: ${msg} ──\n\n`)
            mergeFailed = true
          }
        }
      }

      // ── Phase 5: Close, retry, or permanently fail bead ──────────
      // Record circuit breaker outcome for error paths (success path is below)
      if (mergeFailed || executeFailed) {
        const errorMsg = mergeFailed ? 'merge failed' : 'execution failed'
        const category = classifyError(errorMsg)
        cb.recordError(errorMsg, category)
        cb.save()
      }

      if (mergeFailed) {
        const attempt = this._getBeadAttempt(bead.id)
        const maxRetries = this.config.maxRetries

        if (attempt < maxRetries) {
          this._incrementBeadAttempt(bead.id)
          await this.coordinator.reopenBead(this.agentId, bead.id)
          const backoffMs = this._backoffMs(attempt)
          this._log('WARN', `[${this.agentId}] Bead [${bead.id}] merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
          this.coordinator.postActivity({
            agentId: this.agentId, type: 'failed', beadId: bead.id,
            beadTitle: bead.title,
            summary: `Merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying after backoff`
          })
          this._resetAgentIdToIdle()
          await this._sleep(backoffMs)
          continue
        }

        this._log('ERROR', `[${this.agentId}] Bead [${bead.id}] merge permanently failed after ${maxRetries + 1} attempts`)
        await this.coordinator.failBead(this.agentId, bead.id, `merge_failed after ${maxRetries + 1} attempts`)
        this._resetAgentIdToIdle()
        await this._sleep(3000)
        continue
      }
      if (executeFailed) {
        const attempt = this._getBeadAttempt(bead.id)
        const maxRetries = this.config.maxRetries

        if (attempt < maxRetries) {
          // Retry: reopen bead with incremented attempt count
          this._incrementBeadAttempt(bead.id)
          await this.coordinator.reopenBead(this.agentId, bead.id)
          const backoffMs = this._backoffMs(attempt)
          this._log('WARN', `[${this.agentId}] Bead [${bead.id}] failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
          this.coordinator.postActivity({
            agentId: this.agentId, type: 'failed', beadId: bead.id,
            beadTitle: bead.title,
            summary: `Attempt ${attempt + 1}/${maxRetries + 1} failed — retrying after backoff`
          })
          this._resetAgentIdToIdle()
          await this._sleep(backoffMs)
          continue
        }

        // Max retries exhausted — permanent failure
        this._log('ERROR', `[${this.agentId}] Bead [${bead.id}] permanently failed after ${maxRetries + 1} attempts`)
        await this.coordinator.failBead(this.agentId, bead.id, `execute_failed after ${maxRetries + 1} attempts`)
        this._resetAgentIdToIdle()
        await this._sleep(3000)
        continue
      }
      if (apiLimited) {
        // Don't fail or reopen the bead — keep it claimed (in_progress) so:
        // 1. The beads page shows it as "In Progress" during the wait
        // 2. Other workers don't try to claim and rate-limit on the same bead
        // 3. After the wait, we go back to routing and pick up where we left off
        const retryMs = extractRetryAfter(executeOutput)
        cb.recordRateLimit(retryMs)
        cb.save()
        this._setPhase('rate_limited')
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'rate_limited', beadId: bead.id,
          beadTitle: bead.title, summary: 'API quota exhausted — keeping bead claimed, waiting for reset'
        })
        await this._waitForQuotaReset(cb)
        // Now reopen so it goes back to the pool for a fresh attempt
        await this.coordinator.reopenBead(this.agentId, bead.id)
        this._resetAgentIdToIdle()
        continue
      }
      if (this.stopped) {
        // Reopen the bead so it can be picked up on next restart
        await this.coordinator.reopenBead(this.agentId, bead.id)
        this._log('INFO', `[${this.agentId}] Stopped — reopened bead [${bead.id}] for future pickup`)
        break
      }

      // ── Circuit breaker: record outcome based on execute output ──
      if (executeOutput) {
        const analysis = analyze(stripAnsi(executeOutput))
        if (analysis.hasPermissionDenials) {
          cb.recordPermissionDenial()
        } else if (analysis.hasProgress) {
          cb.recordProgress(this.loopCount)
        } else if (analysis.isStuck) {
          const category = classifyError(analysis.workSummary)
          cb.recordError(analysis.workSummary, category)
        } else {
          cb.recordNoProgress(analysis.askingQuestions)
        }
      } else {
        cb.recordNoProgress(false)
      }
      cb.save()

      this._setPhase('closing', bead.id, bead.title)
      await this.coordinator.completeBead(this.agentId, bead.id, filesChanged, this.config.autoPush)
      this._log('SUCCESS', `[${this.agentId}] ✓ Closed bead [${bead.id}]`)
      this._resetAgentIdToIdle()
      await this._sleep(1500)
    }
    this._exit('stopped')
    } finally {
      cb.removeAllListeners()
      clearInterval(heartbeatTimer)
    }
  }

  private _runClaude(prompt: string, label: string, cwd?: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', this.config.claudeOutputFormat,
        '--verbose', '--dangerously-skip-permissions']
      if (model) args.push('--model', model)
      if (this.config.continueSession && this.sessionId) args.push('--resume', this.sessionId)

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = path.join(this.logDir, `${this.agentId}_${label}_${ts}.log`)

      let proc: ReturnType<typeof cp.spawn>
      try {
        proc = cp.spawn(this.resolvedCmd, args, {
          cwd: cwd ?? this.projectPath, env: this.env, stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(new Error(`${this.agentId}: spawn failed: ${err instanceof Error ? err.message : err}`))
        return
      }
      this.childProc = proc
      let raw = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        this.childProc = null
        if (raw.trim()) resolve(raw)
        else reject(new Error(`${this.agentId}: timed out`))
      }, this.config.claudeTimeoutMinutes * 60_000)

      proc.stdout!.on('data', (chunk: Buffer) => {
        const s = chunk.toString(); raw += s
        this.emit('output', s)
        this.emit('heartbeat')
        fs.appendFileSync(outFile, s)
      })
      proc.stderr!.on('data', (chunk: Buffer) => fs.appendFileSync(outFile, chunk.toString()))
      proc.on('close', (exitCode) => {
        if (settled) return
        settled = true
        clearTimeout(timer); this.childProc = null
        // Capture sessionId from JSON output for continueSession support
        if (this.config.claudeOutputFormat === 'json') {
          const { sessionId } = extractResultFromJsonStream(raw)
          if (sessionId) this.sessionId = sessionId
        }
        if (this.stopped) { resolve(raw); return }
        if (exitCode !== 0 && !raw.trim()) reject(new Error(`${this.agentId}: Claude exited ${exitCode}`))
        else resolve(raw)
      })
      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer); this.childProc = null
        reject(new Error(`${this.agentId}: spawn failed: ${err.message}`))
      })
    })
  }

  /** Extract human-readable text from raw Claude output. For JSON format, extracts the result text. For text format, returns as-is. */
  private _extractText(raw: string): string {
    if (this.config.claudeOutputFormat === 'json') {
      const { text } = extractResultFromJsonStream(raw)
      return text || raw // fall back to raw if no result found (e.g. incomplete output)
    }
    return raw
  }

  private _buildParentContext(bead: Bead): string {
    const parts: string[] = []

    // Parent epic context
    if (bead.epicId) {
      try {
        const parent = this.coordinator.bd.show(bead.epicId)
        if (parent) {
          let ctx = `\n### Parent epic: [${parent.id}] ${parent.title}`
          if (parent.description) ctx += `\n${parent.description}`
          parts.push(ctx)
        }
      } catch { /* ignore */ }
    }

    // Dependencies context
    if (bead.deps.length > 0) {
      const depDetails: string[] = []
      for (const depId of bead.deps) {
        try {
          const dep = this.coordinator.bd.show(depId)
          if (dep) depDetails.push(`- [${dep.id}] ${dep.title} (${dep.status})`)
        } catch { /* ignore */ }
      }
      if (depDetails.length > 0) {
        parts.push(`\n### Dependencies\n${depDetails.join('\n')}`)
      }
    }

    return parts.join('\n')
  }

  private _buildKnowledgeContext(beadId: string): string {
    try {
      const entries = this.coordinator.readKnowledge()
      const relevant = entries
        .filter(e => !(e.agentId === this.agentId && e.beadId === beadId))
        .slice(-20)
      if (relevant.length > 0) {
        const lines = relevant.map(e => {
          const conf = e.confidence === 'high' ? '' : ` [${e.confidence}]`
          return `- **${e.category}**${conf}: ${e.summary}`
        })
        return `\n## Collective Knowledge\n${lines.join('\n')}`
      }
    } catch { /* ignore */ }
    return ''
  }

  private _buildThinkingPrompt(bead: Bead): string {
    const agentMd = this.paths.agentMd
    const agentContext = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : ''

    // Gather context: memories, comments, sibling beads
    let memoriesCtx = ''
    try {
      const memories = this.coordinator.bd.memories()
      if (memories.length > 0) {
        memoriesCtx = `\n### Project Memories\n${memories.map(m => `- **${m.key}**: ${m.text}`).join('\n')}`
      }
    } catch { /* ignore — memories are optional context */ }

    let commentsCtx = ''
    try {
      const comments = this.coordinator.bd.comments(bead.id)
      if (comments.length > 0) {
        commentsCtx = `\n### Bead Comments\n${comments.map(c => `- [${c.author}] ${c.text}`).join('\n')}`
      }
    } catch { /* ignore */ }

    let siblingBeadsCtx = ''
    try {
      const readyBeads = this.coordinator.bd.ready()
      const otherBeads = readyBeads.filter(b => b.id !== bead.id).slice(0, 10)
      if (otherBeads.length > 0) {
        siblingBeadsCtx = `\n### Upcoming Beads (for coordination)\n${otherBeads.map(b => `- [${b.id}] ${b.title} (P${b.priority})`).join('\n')}`
      }
    } catch { /* ignore */ }

    const parentCtx = this._buildParentContext(bead)
    const knowledgeCtx = this._buildKnowledgeContext(bead.id)

    return [
      `## ULTRATHINK: [${bead.id}] ${bead.title}`,
      `Agent: ${this.agentId} | Type: ${bead.type} | Priority: ${bead.priority}/4`,
      bead.description ? `\n### Description\n${bead.description}` : '',
      bead.files.length > 0 ? `\n### Files to modify\n${bead.files.map(f => `- ${f}`).join('\n')}` : '',
      parentCtx,
      memoriesCtx,
      commentsCtx,
      siblingBeadsCtx,
      knowledgeCtx,
      agentContext ? `\n---\n${agentContext}` : '',
      `\n### Your Task`,
      `You are in the **thinking phase** — do NOT implement anything yet. Instead:`,
      `1. Run \`bd show ${bead.id}\` to read the full bead details`,
      `2. Read relevant source files and understand the project's conventions`,
      `3. Identify which files need to change and what risks exist`,
      `4. Note any relevant memory context or coordination concerns`,
      `\n**Output a brief structured summary (3-5 bullet points per section):**`,
      `- ### Understanding — what this bead should accomplish`,
      `- ### Files — which files to create or modify`,
      `- ### Risks — edge cases, breaking changes, or coordination concerns`,
      `- ### Discoveries`,
      `Record any reusable findings as bullet points in this format:`,
      `\`- **category** (confidence): summary\``,
      `Valid categories: pattern, gotcha, dependency, convention, environment, risk`,
      `Valid confidence: high, medium, low`,
      `If no discoveries, write "None."`,
      `- ### Split Analysis`,
      `If this bead is too large for a single implementation pass, recommend splitting.`,
      `Output a JSON block:`,
      '```json',
      `{`,
      `  "shouldSplit": false,`,
      `  "reason": "why or why not",`,
      `  "children": [`,
      `    {`,
      `      "title": "Child bead title",`,
      `      "description": "What this child covers",`,
      `      "files": ["src/file.ts"],`,
      `      "dependsOn": []`,
      `    }`,
      `  ]`,
      `}`,
      '```',
      `\nDo NOT write any code or make any changes. This is analysis only.`,
      BD_SYSTEM_PROMPT
    ].filter(Boolean).join('\n')
  }

  private _buildExecutePrompt(bead: Bead, thinkingSummary?: string): string {
    const agentMd = this.paths.agentMd
    const agentContext = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : ''
    const promptMd = this.paths.promptMd
    const promptContext = fs.existsSync(promptMd) ? fs.readFileSync(promptMd, 'utf8') : ''

    let currentBranch = ''
    try {
      currentBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 3000
      }).toString().trim()
    } catch { /* ignore */ }

    const parentCtx = this._buildParentContext(bead)
    const knowledgeCtx = this._buildKnowledgeContext(bead.id)

    return [
      thinkingSummary ? `### Thinking Phase Summary\nThe following analysis was produced during the thinking phase. Use it to guide your implementation:\n\n${thinkingSummary}` : '',
      `## Agent: ${this.agentId} | Bead: [${bead.id}] ${bead.title}`,
      `Type: ${bead.type} | Priority: ${bead.priority}/4`,
      `\nBranch: \`${currentBranch}\`. Base all work on files currently on disk. Do not use git history.`,
      bead.description ? `\n### Description\n${bead.description}` : '',
      bead.files.length > 0 ? `\n### Files to modify\n${bead.files.map(f => `- ${f}`).join('\n')}` : '',
      parentCtx,
      knowledgeCtx,
      `\n### Before starting`,
      `1. Run \`bd show ${bead.id}\` to get full bead details, dependencies, and parent context`,
      bead.epicId ? `2. Run \`bd show ${bead.epicId}\` to understand the parent epic` : '',
      bead.deps.length > 0 ? `${bead.epicId ? '3' : '2'}. Check dependency status: ${bead.deps.map(d => `\`bd show ${d}\``).join(', ')}` : '',
      BD_SYSTEM_PROMPT,
      agentContext ? `\n---\n${agentContext}` : '',
      promptContext ? `\n---\n${promptContext}` : '',
      `\n---\n## Task`,
      `Implement this bead completely.`,
      `Run the project test command only if you are changing logic and the test suite is fast. Commit all changes when done with a descriptive commit message.`,
      ``,
      `\nWhen finished, output:\nRALPH_STATUS: { "STATUS": "COMPLETE", "EXIT_SIGNAL": true, "FILES_MODIFIED": 0, "WORK_SUMMARY": "brief" }`
    ].filter(Boolean).join('\n')
  }

  private _buildReviewPrompt(bead: Bead): string {
    const promptMd = this.paths.promptMd
    const promptContext = fs.existsSync(promptMd) ? fs.readFileSync(promptMd, 'utf8') : ''

    return [
      `## Review: [${bead.id}] ${bead.title}`,
      `Verify the change is complete and does not introduce obvious regressions.`,
      `If issues are found, fix them now. Commit any fixes. Do NOT re-implement from scratch.`,
      `\nIf you discover issues outside the scope of this bead, do NOT fix them — create a fix-later bead and link it (see bd CLI reference below).`,
      `Use \`bd show ${bead.id}\` or \`bd comments ${bead.id}\` to review the bead context.`,
      BD_SYSTEM_PROMPT,
      promptContext ? `\n---\n${promptContext}` : '',
      `\nWhen finished, output:\nRALPH_STATUS: { "STATUS": "COMPLETE", "EXIT_SIGNAL": true, "FILES_MODIFIED": 0, "WORK_SUMMARY": "brief" }`
    ].filter(Boolean).join('\n')
  }


  /**
   * Extract a thinking summary from raw Claude thinking output.
   * Preserves all ### sections and their content.
   */
  _extractThinkingSummary(raw: string): string {
    // Keep all lines from the first ### heading onwards
    const lines = raw.split('\n')
    let startIdx = lines.findIndex(l => l.startsWith('### '))
    if (startIdx === -1) return raw.trim()

    // Collapse runs of 3+ blank lines into 2, but preserve blank lines inside fenced code blocks
    const result: string[] = []
    let blankRun = 0
    let inFence = false
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('```')) inFence = !inFence
      if (!inFence && line.trim() === '') {
        blankRun++
        if (blankRun <= 2) result.push(line)
      } else {
        blankRun = 0
        result.push(line)
      }
    }
    return result.join('\n').trim()
  }

  /**
   * Extract knowledge discoveries from thinking output and post them to the coordinator.
   */
  _extractKnowledge(output: string, beadId: string): void {
    const discIdx = output.indexOf('### Discoveries')
    if (discIdx === -1) return

    // Extract the section between ### Discoveries and the next ### heading
    const section = output.slice(discIdx)
    const nextHeading = section.indexOf('\n### ', 1)
    const discSection = nextHeading > 0 ? section.slice(0, nextHeading) : section

    if (discSection.includes('None.')) return

    const validCategories = ['pattern', 'gotcha', 'dependency', 'convention', 'environment', 'risk']
    const validConfidence = ['high', 'medium', 'low']

    const entryRegex = /^- \*\*(\w+)\*\* \((\w+)\): (.+)$/gm
    let match: RegExpExecArray | null
    while ((match = entryRegex.exec(discSection)) !== null) {
      const [, category, confidence, summary] = match
      if (!validCategories.includes(category)) continue
      if (!validConfidence.includes(confidence)) continue
      this.coordinator.postKnowledge({
        agentId: this.agentId,
        beadId,
        category: category as import('../types').KnowledgeCategory,
        summary,
        detail: '',
        confidence: confidence as import('../types').KnowledgeConfidence
      })
    }
  }

  /**
   * Parse a split decision from thinking output.
   * Returns null if no split is recommended.
   */
  _parseSplitDecision(output: string, bead: Bead): import('../types').SplitDecision | null {
    const splitIdx = output.indexOf('### Split Analysis')
    if (splitIdx === -1) return null

    const section = output.slice(splitIdx)
    // Extract JSON from fenced code block
    const jsonStart = section.indexOf('```json')
    const jsonEnd = section.indexOf('```', jsonStart + 7)
    if (jsonStart === -1 || jsonEnd === -1) return null

    const jsonStr = section.slice(jsonStart + 7, jsonEnd).trim()
    try {
      const parsed = JSON.parse(jsonStr)
      if (!parsed.shouldSplit) return null
      return {
        beadId: bead.id,
        reason: parsed.reason || 'Split recommended by analysis',
        children: (parsed.children || []).map((c: any) => ({
          title: c.title || '',
          description: c.description || '',
          files: c.files || [],
          deps: c.dependsOn || []
        }))
      }
    } catch {
      return null
    }
  }

  /**
   * Wait for API quota to reset by polling the circuit breaker's rateLimitLifted().
   * Falls back to a max wait of ~60 min with periodic checks every 30s.
   */
  private async _waitForQuotaReset(cb?: CircuitBreaker): Promise<void> {
    const pollIntervalMs = 30_000 // 30s between checks
    const maxPolls = 120 // up to ~60 min total

    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      const elapsedMin = Math.round((attempt * pollIntervalMs) / 60_000)
      this._log('WARN', `[${this.agentId}] API quota exhausted — poll ${attempt}/${maxPolls} (${elapsedMin} min elapsed)`)
      this.emit('output', `\n── API quota exhausted — waiting (${elapsedMin} min) ──\n\n`)
      await this._sleep(pollIntervalMs)

      if (this.stopped) return

      // Check if rate limit has lifted via CB
      if (cb && cb.rateLimitLifted()) {
        this._log('SUCCESS', `[${this.agentId}] Rate limit lifted after ${elapsedMin} min`)
        this.emit('output', `\n── API quota restored — resuming ──\n\n`)
        return
      }
    }

    this._log('WARN', `[${this.agentId}] API quota still exhausted after ${Math.round((maxPolls * pollIntervalMs) / 60_000)} min — resuming anyway`)
  }

  private _setPhase(phase: string, beadId?: string, beadTitle?: string): void {
    this.emit('phase', phase, beadId, beadTitle)
    this.emit('heartbeat')
    this.coordinator.updateAgent(this.agentId, { phase })
  }

  private _exit(reason: string): void {
    this.running = false
    // Deregister after loop fully exits (including finally-block merges)
    this.coordinator.deregisterAgent(this.agentId)
    this.coordinator.clearHeartbeat(this.agentId)
    this._log('INFO', `[${this.agentId}] exit: ${reason}`)
    this.emit('exit', reason)
  }

  private _log(level: string, msg: string): void {
    this.emit('log', level, msg)
  }

  /** Get the current retry attempt count for a bead (0 = first attempt).
   *  Reads from bd labels (retry_attempt:N) instead of set-state to avoid
   *  creating event beads that overwrite the bead title/description. */
  _getBeadAttempt(beadId: string): number {
    try {
      const bead = this.coordinator.bd.show(beadId)
      if (!bead) return 0
      const tag = bead.tags.find(t => t.startsWith('retry_attempt:'))
      if (!tag) return 0
      const n = parseInt(tag.split(':')[1], 10)
      return isNaN(n) ? 0 : n
    } catch { return 0 }
  }

  /** Increment the retry attempt counter for a bead.
   *  Uses bd label add/remove instead of set-state to avoid creating event beads. */
  _incrementBeadAttempt(beadId: string): void {
    const current = this._getBeadAttempt(beadId)
    // Remove old label if present
    if (current > 0) {
      try { this.coordinator.bd.run(['label', 'remove', beadId, `retry_attempt:${current}`]) } catch { /* ignore */ }
    }
    // Add new label
    try { this.coordinator.bd.run(['label', 'add', beadId, `retry_attempt:${current + 1}`]) } catch { /* ignore */ }
  }

  /** Exponential backoff: 3s * 2^attempt, capped at 60s. */
  _backoffMs(attempt: number): number {
    return Math.min(3000 * Math.pow(2, attempt), 60_000)
  }

  /** Block until resumed (or stopped). Returns true if stopped while paused. */
  private _waitIfPaused(): Promise<boolean> {
    if (!this.paused) return Promise.resolve(false)
    return new Promise(resolve => {
      this._pauseResolve = resolve
      // Safety poll: detect stop/resume even if _pauseResolve was missed
      const poll = setInterval(() => {
        if (this.stopped || !this.paused) {
          clearInterval(poll)
          this._pauseResolve = null
          resolve(this.stopped)
        }
      }, 250)
    })
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (this.stopped) { clearInterval(poll); clearTimeout(t); resolve() }
      }, 250)
      const t = setTimeout(() => { clearInterval(poll); resolve() }, ms)
    })
  }
}
