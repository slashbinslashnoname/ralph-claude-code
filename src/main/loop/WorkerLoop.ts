import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import { RalphConfig, Bead, SplitDecision } from '../types'
import { AgentCoordinator } from './AgentCoordinator'
import { detectApiLimit, extractResultFromJsonStream } from './ResponseAnalyzer'
import { stripAnsi, buildEnv, resolveCmd } from './utils'
import { runStateMachine, createWorkerContext, WorkerContext, WorkerCapabilities } from './WorkerStateMachine'
import { ProjectPaths } from './ProjectStore'

/** System prompt for agent context */
const BD_SYSTEM_PROMPT = `
## Important
- Do NOT run \`bd close\`, \`bd reopen\`, \`bd claim\`, \`bd create\`, or \`bd delete\` — the orchestrator manages bead lifecycle.
- You CAN and SHOULD use \`bd\` read commands to gain context:
  - \`bd show <id>\` — view bead details, description, dependencies
  - \`bd list\` — see all open beads and their status
  - \`bd comments <id>\` — read comments and discussion on a bead
  - \`bd children <id>\` — list child beads of a parent
  - \`bd search <query>\` — find related beads by text
  - \`bd history <id>\` — view bead change history
  - \`bd status\` — overview of the bead database
- Use these to understand context, check what other agents are working on, and find related work.
- Focus on implementing the assigned bead.
- Commit your changes with a descriptive message when done.
- If you discover new issues, note them in your output — do not try to fix everything.
`

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

  constructor(
    private agentId: string,
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

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this._gracefulStopping = false
    this._log('INFO', `━━ Worker ${this.agentId} starting (cmd: ${this.resolvedCmd}) ━━`)
    this.coordinator.registerAgent({
      id: this.agentId, index: this.agentIndex, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(),
      worktreeBranch: null, thinkingSummary: null
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
      buildExecutePrompt: (bead, thinkingOutput) => this._buildExecutePrompt(bead, thinkingOutput),
      buildReviewPrompt: (bead) => this._buildReviewPrompt(bead),
      extractThinkingSummary: (raw) => this._extractThinkingSummary(raw),
      extractKnowledge: (raw, beadId) => this._extractKnowledge(raw, beadId),
      parseSplitDecision: (thinkingOutput, bead) => this._parseSplitDecision(thinkingOutput, bead),
      splitBead: (bead, decision) => this._splitBead(bead, decision),
      detectApiLimit: (output) => detectApiLimit(output),
      stripAnsi: (s) => stripAnsi(s),
      extractText: (raw) => this._extractText(raw),
      waitForQuotaReset: () => this._waitForQuotaReset(),
      waitIfPaused: () => this._waitIfPaused(),
      sleep: (ms) => this._sleep(ms),
      emitter: this,
      getBeadAttempt: (beadId) => this._getBeadAttempt(beadId),
      incrementBeadAttempt: (beadId) => this._incrementBeadAttempt(beadId),
      backoffMs: (attempt) => this._backoffMs(attempt),
      childProcRef: { childProc: this.childProc },
      commitWorktreeChanges: (worktreePath, agentId, env) => {
        try {
          cp.execSync('git add -A && git diff --cached --quiet || git commit -m "agent work on bead"', {
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
    const ctx = createWorkerContext(
      this.agentId,
      this.agentIndex,
      this.paths,
      this.config,
      this.coordinator,
      capabilities
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

    try {
    while (this.running && !this.stopped && !this._gracefulStopping) {
      // Pause gate: wait before claiming next bead
      if (await this._waitIfPaused()) break
      this.loopCount++
      this._setPhase('routing')
      this._log('INFO', `[${this.agentId}] Routing: looking for best available bead…`)

      let bead = await this.coordinator.claimBestBead(this.agentId, this.config.claudeTimeoutMinutes)
      if (!bead) {
        const hasOpen = this.coordinator.hasOpenWork()
        if (!hasOpen) {
          this.emptyRetries++
          if (this.emptyRetries >= 3) {
            this._log('SUCCESS', `[${this.agentId}] No open beads — worker done`)
            this._exit('all_beads_done')
            return
          }
          this._log('INFO', `[${this.agentId}] No open beads detected, rechecking (${this.emptyRetries}/3)…`)
          this._setPhase('waiting')
          await this._sleep(3000)
          continue
        }
        // There's open/in-progress work but nothing claimable for us.
        // If all remaining claimable beads are blocked by in-progress work,
        // don't spin-wait forever — exit after a few retries so we don't
        // waste resources waiting for a single agent to finish.
        this.emptyRetries++
        if (this.emptyRetries >= 5) {
          this._log('INFO', `[${this.agentId}] No claimable beads after ${this.emptyRetries} attempts — parking worker`)
          this._exit('all_beads_done')
          return
        }
        this._log('INFO', `[${this.agentId}] No claimable beads (work in progress by others), waiting… (${this.emptyRetries}/5)`)
        this._setPhase('waiting')
        await this._sleep(10_000)
        continue
      }
      this.emptyRetries = 0

      this._setPhase('claiming', bead.id, bead.title)
      this._log('INFO', `[${this.agentId}] Claimed: [${bead.id}] ${bead.title}`)
      this.coordinator.updateAgent(this.agentId, { currentBeadId: bead.id, currentBeadTitle: bead.title, loopCount: this.loopCount })

      // ── Create worktree for isolated work ─────────────────────────
      const wt = this.coordinator.createWorktree(this.agentId, bead.id)
      const workDir = wt?.worktreePath ?? this.projectPath
      const branch = wt?.branch ?? null
      if (wt) {
        this._log('INFO', `[${this.agentId}] Worktree created: ${wt.branch}`)
        this.emit('output', `\n── Worktree: ${wt.branch} ──\n   ${wt.worktreePath}\n\n`)
        this.coordinator.updateAgent(this.agentId, { worktreeBranch: branch })
      } else {
        this._log('WARN', `[${this.agentId}] Worktree creation failed, working in main dir`)
        this.emit('output', `\n── Working in main directory (no worktree) ──\n\n`)
      }

      // ── Phases 1-3: Think, Execute, Review ─────────────────────
      // Wrap in try/finally to ensure worktree is always merged back
      let executeFailed = false
      let apiLimited = false
      let mergeFailed = false
      let filesChanged: string[] = []

      try {
        // ── Phase 1: Think — analyze before acting ──────────────────
        this._setPhase('thinking', bead.id, bead.title)
        this._log('INFO', `[${this.agentId}] Thinking: analyzing bead before implementing…`)
        let thinkingOutput = ''
        try {
          thinkingOutput = await this._runClaude(this._buildThinkingPrompt(bead), 'think', workDir, this.config.claudeModelThink)
          const thinkingText = this._extractText(thinkingOutput)
          const strippedThinking = stripAnsi(thinkingText)
          const summary = this._extractThinkingSummary(strippedThinking)
          this.coordinator.updateAgent(this.agentId, { thinkingSummary: summary })
          // Extract and share knowledge discoveries
          try { this._extractKnowledge(strippedThinking, bead.id) } catch { /* best-effort */ }
          this.coordinator.postActivity({
            agentId: this.agentId, type: 'thinking', beadId: bead.id,
            beadTitle: bead.title, summary
          })
          this._log('INFO', `[${this.agentId}] Thinking complete: ${summary.slice(0, 120)}`)
          if (detectApiLimit(stripAnsi(thinkingOutput))) {
            this._log('WARN', `[${this.agentId}] API limit detected during thinking`)
            apiLimited = true
            // Fall through to finally → merge, then Phase 5 handles rate limit
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this._log('WARN', `[${this.agentId}] Thinking phase failed (continuing): ${msg}`)
        }

        // ── Auto-split check: split large beads before executing ──────
        if (thinkingOutput && !apiLimited && !this.stopped) {
          const splitDecision = this._parseSplitDecision(stripAnsi(this._extractText(thinkingOutput)), bead)
          if (splitDecision) {
            this._log('INFO', `[${this.agentId}] Split decision detected for [${bead.id}] — creating ${splitDecision.children.length} children`)
            const firstChild = await this._splitBead(bead, splitDecision)
            if (firstChild) {
              this._log('INFO', `[${this.agentId}] Split complete — swapping to first child [${firstChild.id}] ${firstChild.title}`)
              bead = firstChild
              this.coordinator.updateAgent(this.agentId, { currentBeadId: bead.id, currentBeadTitle: bead.title })
            }
          }
        }

        // Skip remaining phases if stopped, paused, or rate-limited
        if (this.stopped || apiLimited) {
          // Fall through to finally → merge, then Phase 5 handles it
        } else if (await this._waitIfPaused()) {
          // Paused and then stopped — fall through
        } else {
        // ── Phase 2: Execute — implement the bead ───────────────────
        this._setPhase('executing', bead.id, bead.title)
        this._log('INFO', `[${this.agentId}] Executing bead…`)
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'executing', beadId: bead.id,
          beadTitle: bead.title, summary: 'Implementing…'
        })
        let executeOutput = ''
        try {
          executeOutput = await this._runClaude(this._buildExecutePrompt(bead, thinkingOutput), 'execute', workDir, this.config.claudeModelExecute)
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
              // ── Phase 3: Review — fresh-eyes pass ───────────────────────
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
        } // close else block from Phase 1 guard
      } finally {
        // ── Phase 4: Merge worktree back (skip if stopped — no partial work) ──
        if (wt && this.stopped) {
          // Just clean up the worktree without merging
          this._log('INFO', `[${this.agentId}] Stopped — discarding worktree ${wt.branch} (no merge)`)
          try {
            cp.execSync(`git worktree remove --force "${wt.worktreePath}"`, {
              cwd: this.projectPath, timeout: 10000, stdio: 'pipe'
            })
          } catch { /* best-effort cleanup */ }
          this.coordinator.reopenBead(this.agentId, bead.id)
        } else if (wt && !this.stopped) {
          try {
            this._setPhase('merging', bead.id, bead.title)
            this._log('INFO', `[${this.agentId}] Merging worktree branch ${wt.branch}…`)

            // Commit any uncommitted changes in the worktree
            try {
              cp.execSync('git add -A && git diff --cached --quiet || git commit -m "agent work on bead"', {
                cwd: wt.worktreePath, timeout: 10000, stdio: 'pipe',
                env: { ...this.env, GIT_AUTHOR_NAME: this.agentId, GIT_COMMITTER_NAME: this.agentId }
              })
            } catch { /* ignore — may have nothing to commit */ }

            const result = await this.coordinator.mergeWorktree(this.agentId, bead.id, wt.branch, wt.worktreePath, {
              stoppedFn: () => this.stopped,
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
      if (mergeFailed) {
        const attempt = this._getBeadAttempt(bead.id)
        const maxRetries = this.config.maxRetries

        if (attempt < maxRetries) {
          this._incrementBeadAttempt(bead.id)
          this.coordinator.reopenBead(this.agentId, bead.id)
          const backoffMs = this._backoffMs(attempt)
          this._log('WARN', `[${this.agentId}] Bead [${bead.id}] merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
          this.coordinator.postActivity({
            agentId: this.agentId, type: 'failed', beadId: bead.id,
            beadTitle: bead.title,
            summary: `Merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying after backoff`
          })
          this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null, currentBeadTitle: null, worktreeBranch: null, thinkingSummary: null })
          await this._sleep(backoffMs)
          continue
        }

        this._log('ERROR', `[${this.agentId}] Bead [${bead.id}] merge permanently failed after ${maxRetries + 1} attempts`)
        this.coordinator.failBead(this.agentId, bead.id, `merge_failed after ${maxRetries + 1} attempts`)
        this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null, currentBeadTitle: null, worktreeBranch: null, thinkingSummary: null })
        await this._sleep(3000)
        continue
      }
      if (executeFailed) {
        const attempt = this._getBeadAttempt(bead.id)
        const maxRetries = this.config.maxRetries

        if (attempt < maxRetries) {
          // Retry: reopen bead with incremented attempt count
          this._incrementBeadAttempt(bead.id)
          this.coordinator.reopenBead(this.agentId, bead.id)
          const backoffMs = this._backoffMs(attempt)
          this._log('WARN', `[${this.agentId}] Bead [${bead.id}] failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
          this.coordinator.postActivity({
            agentId: this.agentId, type: 'failed', beadId: bead.id,
            beadTitle: bead.title,
            summary: `Attempt ${attempt + 1}/${maxRetries + 1} failed — retrying after backoff`
          })
          this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null, currentBeadTitle: null, worktreeBranch: null, thinkingSummary: null })
          await this._sleep(backoffMs)
          continue
        }

        // Max retries exhausted — permanent failure
        this._log('ERROR', `[${this.agentId}] Bead [${bead.id}] permanently failed after ${maxRetries + 1} attempts`)
        this.coordinator.failBead(this.agentId, bead.id, `execute_failed after ${maxRetries + 1} attempts`)
        this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null, currentBeadTitle: null, worktreeBranch: null, thinkingSummary: null })
        await this._sleep(3000)
        continue
      }
      if (apiLimited) {
        // Don't fail the bead — it's a quota issue, not a bead issue.
        // Reopen the bead so it can be retried after cooldown.
        this.coordinator.reopenBead(this.agentId, bead.id)
        this._setPhase('rate_limited')
        this.coordinator.postActivity({
          agentId: this.agentId, type: 'failed', beadId: bead.id,
          beadTitle: bead.title, summary: 'API quota exhausted — waiting for reset'
        })
        await this._waitForQuotaReset()
        continue
      }
      if (this.stopped) {
        // Reopen the bead so it can be picked up on next restart
        this.coordinator.reopenBead(this.agentId, bead.id)
        this._log('INFO', `[${this.agentId}] Stopped — reopened bead [${bead.id}] for future pickup`)
        break
      }

      this._setPhase('closing', bead.id, bead.title)
      await this.coordinator.completeBead(this.agentId, bead.id, filesChanged, this.config.autoPush)
      this._log('SUCCESS', `[${this.agentId}] ✓ Closed bead [${bead.id}]`)
      this.coordinator.updateAgent(this.agentId, { phase: 'idle', currentBeadId: null, currentBeadTitle: null, worktreeBranch: null, thinkingSummary: null })
      await this._sleep(1500)
    }
    this._exit('stopped')
    } finally {
      clearInterval(heartbeatTimer)
    }
  }

  private _runClaude(prompt: string, label: string, cwd?: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', this.config.claudeOutputFormat,
        '--dangerously-skip-permissions']
      if (model) args.push('--model', model)
      if (this.config.continueSession && this.sessionId) args.push('--resume', this.sessionId)

      // Attach MCP coordination server so the agent can see team status and communicate
      const mcpServerScript = path.join(__dirname, 'mcp-coordination-server.js')
      if (fs.existsSync(mcpServerScript)) {
        const mcpConfig = {
          mcpServers: {
            coordination: {
              command: 'node',
              args: [mcpServerScript],
              env: {
                SLASHBOT_AGENT_ID: this.agentId,
                SLASHBOT_STORE_DIR: this.paths.storeDir,
              },
            },
          },
        }
        const mcpConfigPath = path.join(this.paths.storeDir, `mcp-${this.agentId}.json`)
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig))
        args.push('--mcp-config', mcpConfigPath)
      }
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
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
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
        clearTimeout(timer); this.childProc = null
        if (this.stopped) { resolve(raw); return }
        if (exitCode !== 0 && !raw.trim()) reject(new Error(`${this.agentId}: Claude exited ${exitCode}`))
        else resolve(raw)
      })
      proc.on('error', (err) => {
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

  /** Build context about the parent epic and dependency beads */
  private _buildParentContext(bead: Bead): string {
    const sections: string[] = []

    // Parent epic context
    if (bead.epicId) {
      try {
        const parent = this.coordinator.bd.show(bead.epicId)
        if (parent) {
          sections.push(`## Parent epic: [${parent.id}] ${parent.title}`)
          if (parent.description) sections.push(parent.description)
        }
      } catch { /* bd.show failed — skip parent context */ }
    }

    // Dependency bead context
    if (bead.deps.length > 0) {
      const depLines: string[] = ['## Dependencies']
      for (const depId of bead.deps) {
        try {
          const dep = this.coordinator.bd.show(depId)
          if (dep) {
            const statusIcon = dep.status === 'done' ? '(done)' : `(${dep.status})`
            depLines.push(`- [${dep.id}] ${dep.title} ${statusIcon}`)
          }
        } catch { /* skip unresolvable dep */ }
      }
      if (depLines.length > 1) sections.push(depLines.join('\n'))
    }

    return sections.join('\n\n')
  }

  /** Build context from the shared knowledge log, filtering out self-entries for the current bead */
  private _buildKnowledgeContext(currentBeadId?: string): string {
    const allEntries = this.coordinator.readKnowledge(50)
    // Filter out entries from this agent for the current bead (keep entries from other beads or other agents)
    const filtered = allEntries.filter(
      e => !(e.agentId === this.agentId && e.beadId === currentBeadId)
    )
    // Cap at 20 entries (most recent)
    const entries = filtered.slice(-20)
    if (entries.length === 0) return ''

    const lines: string[] = ['## Collective Knowledge']
    for (const entry of entries) {
      const conf = entry.confidence === 'high' ? '' : ` [${entry.confidence}]`
      lines.push(`- **${entry.category}**${conf}: ${entry.summary}`)
    }
    return lines.join('\n')
  }

  /** Phase 1: Think deeply before acting. Analyze the bead, understand context, plan approach. */
  private _buildThinkingPrompt(bead: Bead): string {
    const agentMd = this.paths.agentMd
    const agentContext = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : ''
    const parentContext = this._buildParentContext(bead)
    const knowledgeContext = this._buildKnowledgeContext(bead.id)

    let currentBranch = ''
    try {
      currentBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 3000
      }).toString().trim()
    } catch { /* ignore */ }

    return `ULTRATHINK

You are ${this.agentId}, a senior software engineer. Before writing ANY code, you must analyze this task deeply.

## Working branch: \`${currentBranch}\`
Base all work on files currently on disk. Do not use git history.

## Your bead assignment
- **ID**: ${bead.id}
- **Title**: ${bead.title}
- **Type**: ${bead.type} | **Priority**: ${bead.priority}/4
${bead.description ? `- **Description**: ${bead.description}` : ''}
${bead.files.length > 0 ? `- **Files**: ${bead.files.join(', ')}` : ''}

${parentContext ? `${parentContext}\n` : ''}## Gather context
Use \`bd\` to understand the bigger picture before coding:
- \`bd show ${bead.id}\` — full details of your assigned bead
- \`bd list\` — see all open beads and what other agents are working on
- \`bd children ${bead.epicId || bead.id}\` — see sibling tasks in the same epic
- \`bd comments ${bead.id}\` — read any discussion or notes on this bead
- \`bd search <keyword>\` — find related beads for context
Do NOT run \`bd close\`, \`bd reopen\`, \`bd claim\`, \`bd create\`, or \`bd delete\`.

## Team coordination
You have MCP tools for coordinating with other agents. Use them:
- \`team_status\` — see what other agents are working on (**call this FIRST**)
- \`check_file_reservations\` — check for file conflicts before editing shared files
- \`send_message\` — notify peers about important decisions or API changes
- \`check_inbox\` — read messages from other agents

## Mandatory analysis (do this FIRST, after checking team_status)
1. **Read the relevant code** — understand the existing architecture, patterns, naming conventions
2. **Identify dependencies** — what other files/modules will be affected?
3. **Spot risks** — what could go wrong? Race conditions? Breaking changes? Edge cases?
4. **Plan your approach** — what's the minimal, correct change? What order should you make changes?

${agentContext ? `## Project context\n${agentContext}\n` : ''}
${knowledgeContext ? `${knowledgeContext}\n` : ''}
## Output format
Write a structured analysis:

### Understanding
What does this bead require? What's the current state of the code?

### Approach
Step-by-step plan (be specific about files and functions).

### Risks
What could go wrong and how will you mitigate it?

### Test strategy
How will you verify correctness?

### Discoveries
Share any non-obvious findings that would help other agents working on related beads.
Format each discovery as a bullet with category, confidence, and summary:
- **category** (confidence): summary text

Valid categories: pattern, gotcha, dependency, convention, environment, risk
Valid confidence levels: high, medium, low

If you have no discoveries, write "None."

### Split Analysis
Evaluate whether this bead is too large or covers multiple concerns that should be separate tasks.
Output a JSON block (fenced with \`\`\`json) with this schema:
\`\`\`json
{
  "shouldSplit": false,
  "reason": "single-concern change touching one module",
  "children": []
}
\`\`\`
If \`shouldSplit\` is true, populate \`children\` with proposed sub-beads:
\`\`\`json
{
  "shouldSplit": true,
  "reason": "bead spans UI, API, and DB layers with independent concerns",
  "children": [
    {
      "title": "Child bead title",
      "description": "What this child accomplishes",
      "files": ["src/relevant-file.ts"],
      "dependsOn": []
    },
    {
      "title": "Second child",
      "description": "Depends on the first child",
      "files": ["src/other.ts"],
      "dependsOn": ["Child bead title"]
    }
  ]
}
\`\`\`
Each child must have: \`title\`, \`description\`, \`files\` (scope), and \`dependsOn\` (titles of sibling children it requires).

DO NOT write any implementation code. Analysis only.`
  }

  /** Phase 2: Execute with the thinking context */
  private _buildExecutePrompt(bead: Bead, thinkingContext: string): string {
    const agentMd = this.paths.agentMd
    const agentContext = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : ''
    const thinkingSummary = thinkingContext ? this._extractThinkingSummary(stripAnsi(this._extractText(thinkingContext))) : ''
    const parentContext = this._buildParentContext(bead)
    const knowledgeContext = this._buildKnowledgeContext(bead.id)

    let currentBranch = ''
    try {
      currentBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 3000
      }).toString().trim()
    } catch { /* ignore */ }

    return [
      `## Agent: ${this.agentId} | Bead: [${bead.id}] ${bead.title}`,
      `Type: ${bead.type} | Priority: ${bead.priority}/4`,
      `\nBranch: \`${currentBranch}\`. Base all work on files currently on disk. Do not use git history.`,
      bead.description ? `\n### Description\n${bead.description}` : '',
      bead.files.length > 0 ? `\n### Files to modify\n${bead.files.map(f => `- ${f}`).join('\n')}` : '',
      parentContext ? `\n${parentContext}` : '',
      knowledgeContext ? `\n${knowledgeContext}` : '',
      `\n### Team coordination\nUse MCP tools: \`team_status\` (check first), \`check_inbox\`, \`send_message\`, \`check_file_reservations\``,
      thinkingSummary ? `\n### Your prior analysis\n${thinkingSummary}` : '',
      BD_SYSTEM_PROMPT,
      agentContext ? `\n---\n${agentContext}` : '',
      `\n---\n## Task`,
      `Implement this bead completely, following your analysis above.`,
      `Write tests. Commit all changes when done with a descriptive commit message.`,
      `\nWhen finished, output:\nRALPH_STATUS: { "STATUS": "COMPLETE", "EXIT_SIGNAL": true, "FILES_MODIFIED": 0, "WORK_SUMMARY": "brief" }`
    ].filter(Boolean).join('\n')
  }

  private _buildReviewPrompt(bead: Bead): string {
    return [
      `## Fresh-eyes Review: [${bead.id}] ${bead.title}`,
      `Agent ${this.agentId} has implemented this bead. Review the changes critically:`,
      `- Are the tests adequate?`,
      `- Are there any edge cases missed?`,
      `- Is the code idiomatic and consistent with the rest of the codebase?`,
      `\nIf issues are found, fix them now. If good, say so briefly.`,
      `Commit any fixes. Do NOT re-implement from scratch.`,
      `You can use \`bd show ${bead.id}\` or \`bd comments ${bead.id}\` to review the bead context.`,
      `Do NOT run \`bd close\`, \`bd reopen\`, \`bd claim\`, \`bd create\`, or \`bd delete\` — the orchestrator handles bead lifecycle.`,
    ].join('\n')
  }

  /** Extract a concise summary from the thinking output */
  private _extractThinkingSummary(raw: string): string {
    // Try to find structured sections
    const lines = raw.split('\n')
    const summary: string[] = []

    let inSection = false
    let inFence = false
    for (const line of lines) {
      if (/^###?\s+(Understanding|Approach|Risks|Test|Discoveries|Split Analysis)/i.test(line)) {
        inSection = true
        summary.push(line)
        continue
      }
      if (inSection) {
        if (/^```/.test(line.trim())) {
          inFence = !inFence
          summary.push(line)
          continue
        }
        if (inFence) {
          summary.push(line)
          continue
        }
        // Include all lines (including empty ones) until we hit a non-matching
        // heading or a separator like ---
        if (/^#{1,3}\s/.test(line) || /^---\s*$/.test(line.trim())) {
          inSection = false
        } else {
          summary.push(line)
        }
      }
    }

    // Trim trailing empty lines from summary
    while (summary.length > 0 && !summary[summary.length - 1].trim()) summary.pop()

    if (summary.length > 0) return summary.join('\n').slice(0, 2000)

    // Fallback: take the last meaningful chunk
    const trimmed = raw.trim()
    return trimmed.slice(Math.max(0, trimmed.length - 2000))
  }

  /** Extract knowledge discoveries from thinking output and post them to the coordinator */
  _extractKnowledge(raw: string, beadId: string): void {
    const headingIdx = raw.indexOf('### Discoveries')
    if (headingIdx === -1) return

    const afterHeading = raw.slice(headingIdx + '### Discoveries'.length)
    // Stop at the next heading (### or ##)
    const nextHeading = afterHeading.search(/\n#{2,3}\s/)
    const section = nextHeading !== -1 ? afterHeading.slice(0, nextHeading) : afterHeading

    // Check for "None." — no discoveries
    if (/^\s*None\.?\s*$/m.test(section.trim())) return

    const validCategories = new Set(['pattern', 'gotcha', 'dependency', 'convention', 'environment', 'risk'])
    const validConfidences = new Set(['high', 'medium', 'low'])

    // Parse bullets: - **category** (confidence): summary
    const bulletRegex = /^-\s+\*\*(\w+)\*\*\s+\((\w+)\):\s*(.+)/gm
    let match: RegExpExecArray | null
    while ((match = bulletRegex.exec(section)) !== null) {
      const [, category, confidence, summary] = match
      if (!validCategories.has(category) || !validConfidences.has(confidence)) continue
      if (!summary.trim()) continue
      this.coordinator.postKnowledge({
        agentId: this.agentId,
        beadId,
        category: category as any,
        summary: summary.trim(),
        detail: '',
        confidence: confidence as any
      })
    }
  }

  /** Wait for API quota to reset, probing periodically. Like main branch: wait 5min, then probe every 5min up to ~60min. */
  private async _waitForQuotaReset(): Promise<void> {
    const probeIntervalMs = 5 * 60_000 // 5 min between probes
    const maxProbes = 12 // up to ~60 min total

    for (let attempt = 1; attempt <= maxProbes; attempt++) {
      const waitMin = (attempt * 5)
      this._log('WARN', `[${this.agentId}] API quota exhausted — probe ${attempt}/${maxProbes}, next check in 5 min (${waitMin} min elapsed)`)
      this.emit('output', `\n── API quota exhausted — waiting (${waitMin}/${maxProbes * 5} min) ──\n\n`)
      await this._sleep(probeIntervalMs)

      if (this.stopped) return

      // Probe: run a minimal Claude call to see if quota is back
      try {
        const output = await this._runClaude('Reply with only the word OK', 'probe', this.projectPath)
        if (!detectApiLimit(stripAnsi(output))) {
          this._log('SUCCESS', `[${this.agentId}] API quota restored after ${waitMin} min`)
          this.emit('output', `\n── API quota restored — resuming ──\n\n`)
          return
        }
      } catch {
        // Probe failed — quota still exhausted, keep waiting
      }
    }

    this._log('WARN', `[${this.agentId}] API quota still exhausted after ${maxProbes * 5} min — resuming anyway`)
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

  /** Get the current retry attempt count for a bead (0 = first attempt). */
  _getBeadAttempt(beadId: string): number {
    const raw = this.coordinator.bd.getState(beadId, 'retry_attempt')
    const n = parseInt(raw, 10)
    return isNaN(n) ? 0 : n
  }

  /** Increment the retry attempt counter for a bead. */
  _incrementBeadAttempt(beadId: string): void {
    const current = this._getBeadAttempt(beadId)
    this.coordinator.bd.setState(beadId, 'retry_attempt', String(current + 1), 'Retry after failure')
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

  /** Parse a split decision from thinking output. Returns null on any failure (fail-safe: don't split). */
  _parseSplitDecision(thinkingOutput: string, bead: Bead): SplitDecision | null {
    try {
      // Guard: skip beads already tagged 'auto-split' to prevent recursive re-splitting
      if (bead.tags.includes('auto-split')) return null

      // Find the '### Split Analysis' heading
      const headingIdx = thinkingOutput.indexOf('### Split Analysis')
      if (headingIdx === -1) return null

      const afterHeading = thinkingOutput.slice(headingIdx)

      // Extract first JSON block: fenced ```json...``` or raw {...}
      let jsonStr: string | null = null
      const fencedMatch = afterHeading.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
      if (fencedMatch) {
        jsonStr = fencedMatch[1].trim()
      } else {
        // Find first '{' and match braces to extract the JSON object
        const braceStart = afterHeading.indexOf('{')
        if (braceStart !== -1) {
          let depth = 0
          for (let i = braceStart; i < afterHeading.length; i++) {
            if (afterHeading[i] === '{') depth++
            else if (afterHeading[i] === '}') depth--
            if (depth === 0) {
              jsonStr = afterHeading.slice(braceStart, i + 1)
              break
            }
          }
        }
      }

      if (!jsonStr) return null

      const parsed = JSON.parse(jsonStr)

      // Validate shouldSplit
      if (parsed.shouldSplit !== true) return null

      // Validate children
      if (!Array.isArray(parsed.children) || parsed.children.length < 2) return null
      for (const child of parsed.children) {
        if (!child.title || typeof child.title !== 'string') return null
        if (!child.description || typeof child.description !== 'string') return null
      }

      // Validate concerns meet threshold
      if (!Array.isArray(parsed.concerns) || parsed.concerns.length < this.config.autoSplitThreshold) return null

      return {
        beadId: bead.id,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'Split recommended by analysis',
        children: parsed.children.map((c: any) => ({
          title: c.title,
          description: c.description,
          files: Array.isArray(c.files) ? c.files : [],
          deps: Array.isArray(c.deps) ? c.deps : []
        }))
      }
    } catch {
      return null
    }
  }

  /**
   * Split a bead into children based on the split decision.
   * Creates child beads, wires inter-child deps, labels everything,
   * closes the original as a container, claims the first child, and returns it.
   * Returns null if any child creation fails (abort entire split).
   */
  async _splitBead(bead: Bead, decision: SplitDecision): Promise<Bead | null> {
    const bd = this.coordinator.bd

    // Phase 1: Create all children — abort entirely if any fails
    const createdChildren: Bead[] = []
    try {
      for (const child of decision.children) {
        const created = await bd.createAsync({
          title: child.title,
          description: child.description,
          parentId: bead.id,
          labels: ['auto-split'],
          priority: bead.priority
        })
        createdChildren.push(created)
      }
    } catch {
      // Abort: a child creation failed — don't label or close anything
      return null
    }

    // Phase 2: Wire inter-child dependencies
    // Build a title→id map for resolving dep references by title
    const titleToId = new Map<string, string>()
    for (let i = 0; i < decision.children.length; i++) {
      titleToId.set(decision.children[i].title, createdChildren[i].id)
    }

    for (let i = 0; i < decision.children.length; i++) {
      const childSpec = decision.children[i]
      for (const depTitle of childSpec.deps) {
        const depId = titleToId.get(depTitle)
        if (depId) {
          bd.addDep(createdChildren[i].id, depId)
        }
      }
    }

    // Phase 3: Label original bead as split parent and close it
    bd.addLabel(bead.id, 'auto-split-parent')
    bd.close(bead.id, `Split into ${createdChildren.length} children`)

    // Phase 4: Post activity event
    this.coordinator.postActivity({
      agentId: this.agentId,
      type: 'split',
      beadId: bead.id,
      beadTitle: bead.title,
      summary: `Split into ${createdChildren.length} children: ${createdChildren.map(c => c.id).join(', ')}`
    })

    // Phase 5: Claim and return the first child
    const firstChild = createdChildren[0]
    bd.assignTo(firstChild.id, this.agentId)
    const refreshed = bd.show(firstChild.id)
    return refreshed ?? null
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
