/**
 * WorkerStateMachine — Pure-function state machine for worker loop execution.
 *
 * Each state is an async function (ctx: WorkerContext) => StateId.
 * Feature-flagged behind SLASHBOT_STATE_MACHINE=1 for parallel burn-in.
 */

import * as cp from 'child_process'
import { EventEmitter } from 'events'
import { RalphConfig, Bead, AgentPhase } from '../types'
import { AgentCoordinator } from './AgentCoordinator'
import { CircuitBreaker } from './CircuitBreaker'
import { classifyError } from './ErrorClassifier'
import { analyze } from './ResponseAnalyzer'
import { ProjectPaths } from './ProjectStore'

// ── State identifiers ─────────────────────────────────────────────────

export type StateId =
  | 'idle'
  | 'routing'
  | 'thinking'
  | 'executing'
  | 'reviewing'
  | 'merging'
  | 'closing'
  | 'cleanup'
  | 'stopping'

// ── WorkerContext ─────────────────────────────────────────────────────

export interface WorkerContext {
  /** Agent identifier, e.g. "agent-0" */
  agentId: string
  /** Numeric index of this agent */
  agentIndex: number
  /** Resolved project paths (centralized storage) */
  paths: ProjectPaths
  /** Resolved configuration */
  config: RalphConfig
  /** Agent coordinator for bead ops, activity, file locks, worktrees */
  coordinator: AgentCoordinator
  /** Current bead being worked on (null when idle/routing) */
  currentBead: Bead | null
  /** Path to the git worktree for isolated work (null if worktree creation failed) */
  worktreePath: string | null
  /** Branch name for the worktree */
  worktreeBranch: string | null
  /** Raw output from the thinking phase */
  thinkingOutput: string
  /** Raw output from the execute phase */
  executeOutput: string
  /** Flags set during execution */
  flags: WorkerFlags
  /** Injected capabilities — IO and side effects separated from state logic */
  capabilities: WorkerCapabilities
  /** Per-worker circuit breaker instance */
  circuitBreaker: CircuitBreaker | null
}

export interface WorkerFlags {
  /** Whether the execute phase failed */
  executeFailed: boolean
  /** Whether an API rate limit was detected */
  apiLimited: boolean
  /** Whether the merge phase failed */
  mergeFailed: boolean
  /** Whether the agent has been told to stop (hard stop) */
  stopped: boolean
  /** Whether the agent has been told to gracefully stop (finish current bead) */
  gracefulStopping: boolean
  /** Files changed during merge */
  filesChanged: string[]
  /** Count of consecutive empty routing attempts */
  emptyRetries: number
  /** Current loop iteration count */
  loopCount: number
}

/** Injected capabilities — allows the state machine to be tested with mocks. */
export interface WorkerCapabilities {
  /** Run a Claude CLI subprocess. Returns raw output. */
  runClaude: (prompt: string, label: string, cwd: string, model?: string) => Promise<string>
  /** Build the thinking prompt for a bead */
  buildThinkingPrompt: (bead: Bead) => string
  /** Build the execute prompt for a bead with thinking context */
  buildExecutePrompt: (bead: Bead, thinkingOutput: string) => string
  /** Build the review prompt for a bead */
  buildReviewPrompt: (bead: Bead) => string
  /** Extract a concise summary from thinking output */
  extractThinkingSummary: (raw: string) => string
  /** Extract and post knowledge discoveries from thinking output */
  extractKnowledge: (raw: string, beadId: string) => void
  /** Parse a split decision from thinking output */
  parseSplitDecision: (thinkingOutput: string, bead: Bead) => import('../types').SplitDecision | null
  /** Split a bead into children and return the first child */
  splitBead: (bead: Bead, decision: import('../types').SplitDecision) => Promise<Bead | null>
  /** Detect API rate limiting in output */
  detectApiLimit: (output: string) => boolean
  /** Strip ANSI codes from output */
  stripAnsi: (s: string) => string
  /** Extract human-readable text from raw Claude output (handles JSON format) */
  extractText: (raw: string) => string
  /** Wait for API quota to reset (optionally polling CB rateLimitLifted) */
  waitForQuotaReset: (cb?: CircuitBreaker) => Promise<void>
  /** Extract retry-after delay from Claude output (returns ms or undefined) */
  extractRetryAfter: (output: string) => number | undefined
  /** Block until resumed (or stopped). Returns true if stopped while paused. */
  waitIfPaused: () => Promise<boolean>
  /** Sleep for a given duration (interruptible by stop) */
  sleep: (ms: number) => Promise<void>
  /** Emit events (phase changes, output, heartbeat, log) */
  emitter: EventEmitter
  /** Get the current retry attempt count for a bead */
  getBeadAttempt: (beadId: string) => number
  /** Increment the retry attempt counter for a bead */
  incrementBeadAttempt: (beadId: string) => void
  /** Compute exponential backoff in ms for an attempt */
  backoffMs: (attempt: number) => number
  /** Reference to the spawned child process (for stop/kill) */
  childProcRef: { childProc: cp.ChildProcess | null }
  /** Commit uncommitted changes in a worktree before merging */
  commitWorktreeChanges: (worktreePath: string, agentId: string, env: NodeJS.ProcessEnv) => void
  /** Resolved Claude command path */
  resolvedCmd: string
  /** Environment variables for subprocesses */
  env: NodeJS.ProcessEnv
}

// ── State function type ──────────────────────────────────────────────

export type StateFn = (ctx: WorkerContext) => Promise<StateId>

// ── Helper: emit phase change ────────────────────────────────────────

function setPhase(ctx: WorkerContext, phase: string, beadId?: string, beadTitle?: string): void {
  ctx.capabilities.emitter.emit('phase', phase, beadId, beadTitle)
  ctx.capabilities.emitter.emit('heartbeat')
  ctx.coordinator.updateAgent(ctx.agentId, { phase })
}

function log(ctx: WorkerContext, level: string, msg: string): void {
  ctx.capabilities.emitter.emit('log', level, msg)
}

// ── State functions ──────────────────────────────────────────────────

/**
 * idle — Reset context between beads. Entry point and post-bead cleanup.
 */
export async function idle(ctx: WorkerContext): Promise<StateId> {
  // Reset per-bead state
  ctx.currentBead = null
  ctx.worktreePath = null
  ctx.worktreeBranch = null
  ctx.thinkingOutput = ''
  ctx.executeOutput = ''
  ctx.flags.executeFailed = false
  ctx.flags.apiLimited = false
  ctx.flags.mergeFailed = false
  ctx.flags.filesChanged = []

  // Re-register with slot-based idle ID (deregister bead-based ID if any)
  const idleId = `worker-${ctx.agentIndex}`
  if (ctx.agentId !== idleId) {
    ctx.coordinator.deregisterAgent(ctx.agentId)
    ctx.agentId = idleId
    ctx.coordinator.registerAgent({
      id: idleId, index: ctx.agentIndex, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: ctx.flags.loopCount,
      lastActivity: new Date().toISOString(),
      worktreeBranch: null, thinkingSummary: null
    })
  } else {
    ctx.coordinator.updateAgent(ctx.agentId, {
      phase: 'idle',
      currentBeadId: null,
      currentBeadTitle: null,
      worktreeBranch: null,
      thinkingSummary: null
    })
  }

  if (ctx.flags.stopped || ctx.flags.gracefulStopping) return 'stopping'

  // Pause gate: wait before claiming next bead
  if (await ctx.capabilities.waitIfPaused()) return 'stopping'

  return 'routing'
}

/**
 * routing — Claim the best available bead.
 */
export async function routing(ctx: WorkerContext): Promise<StateId> {
  if (ctx.flags.stopped || ctx.flags.gracefulStopping) return 'stopping'

  ctx.flags.loopCount++
  const cb = ctx.circuitBreaker
  if (cb) cb.tick(ctx.flags.loopCount)

  // Circuit breaker: if open, wait for cooldown before claiming next bead
  if (cb && cb.isOpen()) {
    log(ctx, 'WARN', `[${ctx.agentId}] Circuit OPEN — pausing before next bead`)
    setPhase(ctx, 'waiting')
    await ctx.capabilities.sleep(60_000)
    cb.load() // re-check cooldown state from disk
    return 'routing'
  }

  setPhase(ctx, 'routing')
  log(ctx, 'INFO', `[${ctx.agentId}] Routing: looking for best available bead…`)

  let bead: Bead | null = null
  try {
    bead = await ctx.coordinator.claimBestBead(ctx.agentId, ctx.config.claudeTimeoutMinutes)
  } catch (err) {
    log(ctx, 'ERROR', `[${ctx.agentId}] claimBestBead failed: ${err instanceof Error ? err.message : err}`)
    setPhase(ctx, 'waiting')
    await ctx.capabilities.sleep(5000)
    return 'routing'
  }

  if (!bead) {
    const hasOpen = await ctx.coordinator.hasOpenWork()
    if (!hasOpen) {
      ctx.flags.emptyRetries++
      if (ctx.flags.emptyRetries >= 3) {
        log(ctx, 'SUCCESS', `[${ctx.agentId}] No open beads — worker done`)
        return 'stopping'
      }
      log(ctx, 'INFO', `[${ctx.agentId}] No open beads detected, rechecking (${ctx.flags.emptyRetries}/3)…`)
      setPhase(ctx, 'waiting')
      await ctx.capabilities.sleep(3000)
      return 'routing'
    }
    // Work exists but nothing claimable right now — keep waiting for other agents to finish.
    ctx.flags.emptyRetries++
    const waitSec = Math.min(10 + ctx.flags.emptyRetries * 5, 30) // 15s, 20s, 25s, 30s...
    log(ctx, 'INFO', `[${ctx.agentId}] No claimable beads (blocked by deps or claimed), waiting ${waitSec}s… (attempt ${ctx.flags.emptyRetries})`)
    setPhase(ctx, 'waiting')
    await ctx.capabilities.sleep(waitSec * 1000)
    return 'routing'
  }

  ctx.flags.emptyRetries = 0
  ctx.currentBead = bead

  // Re-register with bead-based agentId: worker-{beadId}
  const prevAgentId = ctx.agentId
  const beadAgentId = `worker-${bead.id}`
  ctx.coordinator.deregisterAgent(prevAgentId)
  ctx.agentId = beadAgentId
  ctx.coordinator.registerAgent({
    id: beadAgentId, index: ctx.agentIndex, phase: 'claiming',
    currentBeadId: bead.id, currentBeadTitle: bead.title, loopCount: ctx.flags.loopCount,
    lastActivity: new Date().toISOString(),
    worktreeBranch: null, thinkingSummary: null
  })

  setPhase(ctx, 'claiming', bead.id, bead.title)
  log(ctx, 'INFO', `[${ctx.agentId}] Claimed: [${bead.id}] ${bead.title}`)

  // Create worktree for isolated work
  const wt = await ctx.coordinator.createWorktree(ctx.agentId, bead.id)
  if (wt) {
    ctx.worktreePath = wt.worktreePath
    ctx.worktreeBranch = wt.branch
    log(ctx, 'INFO', `[${ctx.agentId}] Worktree created: ${wt.branch}`)
    ctx.capabilities.emitter.emit('output', `\n── Worktree: ${wt.branch} ──\n   ${wt.worktreePath}\n\n`)
    ctx.coordinator.updateAgent(ctx.agentId, { worktreeBranch: wt.branch })
  } else {
    log(ctx, 'WARN', `[${ctx.agentId}] Worktree creation failed, working in main dir`)
    ctx.capabilities.emitter.emit('output', `\n── Working in main directory (no worktree) ──\n\n`)
  }

  return 'thinking'
}

/**
 * thinking — Analyze the bead deeply before implementing.
 */
export async function thinking(ctx: WorkerContext): Promise<StateId> {
  const bead = ctx.currentBead!
  const workDir = ctx.worktreePath ?? ctx.paths.projectRoot

  setPhase(ctx, 'thinking', bead.id, bead.title)
  log(ctx, 'INFO', `[${ctx.agentId}] Thinking: analyzing bead before implementing…`)

  try {
    const raw = await ctx.capabilities.runClaude(
      ctx.capabilities.buildThinkingPrompt(bead), 'think', workDir, ctx.config.claudeModelThink
    )
    ctx.thinkingOutput = raw
    const thinkingText = ctx.capabilities.extractText(raw)
    const stripped = ctx.capabilities.stripAnsi(thinkingText)
    const summary = ctx.capabilities.extractThinkingSummary(stripped)
    ctx.coordinator.updateAgent(ctx.agentId, { thinkingSummary: summary })

    // Extract and share knowledge discoveries
    try { ctx.capabilities.extractKnowledge(stripped, bead.id) } catch { /* best-effort */ }

    ctx.coordinator.postActivity({
      agentId: ctx.agentId, type: 'thinking', beadId: bead.id,
      beadTitle: bead.title, summary
    })
    log(ctx, 'INFO', `[${ctx.agentId}] Thinking complete: ${summary.slice(0, 120)}`)

    // detectApiLimit needs raw output (checks JSON lines for rate limit patterns)
    if (ctx.capabilities.detectApiLimit(ctx.capabilities.stripAnsi(raw))) {
      log(ctx, 'WARN', `[${ctx.agentId}] API limit detected during thinking`)
      ctx.flags.apiLimited = true
      return 'merging'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(ctx, 'WARN', `[${ctx.agentId}] Thinking phase failed (continuing): ${msg}`)
  }

  // Auto-split check
  if (ctx.thinkingOutput && !ctx.flags.apiLimited && !ctx.flags.stopped) {
    const splitDecision = ctx.capabilities.parseSplitDecision(
      ctx.capabilities.stripAnsi(ctx.capabilities.extractText(ctx.thinkingOutput)), bead
    )
    if (splitDecision) {
      log(ctx, 'INFO', `[${ctx.agentId}] Split decision detected for [${bead.id}] — creating ${splitDecision.children.length} children`)
      const firstChild = await ctx.capabilities.splitBead(bead, splitDecision)
      if (firstChild) {
        log(ctx, 'INFO', `[${ctx.agentId}] Split complete — swapping to first child [${firstChild.id}] ${firstChild.title}`)
        ctx.currentBead = firstChild
        ctx.coordinator.updateAgent(ctx.agentId, { currentBeadId: firstChild.id, currentBeadTitle: firstChild.title })
      }
    }
  }

  if (ctx.flags.stopped) return 'merging'
  if (await ctx.capabilities.waitIfPaused()) return 'merging'

  return 'executing'
}

/**
 * executing — Implement the bead via Claude call.
 */
export async function executing(ctx: WorkerContext): Promise<StateId> {
  const bead = ctx.currentBead!
  const workDir = ctx.worktreePath ?? ctx.paths.projectRoot

  setPhase(ctx, 'executing', bead.id, bead.title)
  log(ctx, 'INFO', `[${ctx.agentId}] Executing bead…`)
  ctx.coordinator.postActivity({
    agentId: ctx.agentId, type: 'executing', beadId: bead.id,
    beadTitle: bead.title, summary: 'Implementing…'
  })

  let executeOutput = ''
  try {
    executeOutput = await ctx.capabilities.runClaude(
      ctx.capabilities.buildExecutePrompt(bead, ctx.thinkingOutput),
      'execute', workDir, ctx.config.claudeModelExecute
    )
    ctx.executeOutput = executeOutput
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(ctx, 'ERROR', `[${ctx.agentId}] Execute failed: ${msg}`)
    ctx.flags.executeFailed = true
    return 'merging'
  }

  if (ctx.flags.stopped) return 'merging'

  if (ctx.capabilities.detectApiLimit(ctx.capabilities.stripAnsi(executeOutput))) {
    log(ctx, 'WARN', `[${ctx.agentId}] API limit detected`)
    ctx.flags.apiLimited = true
    return 'merging'
  }

  // Pause gate between execute and review
  if (await ctx.capabilities.waitIfPaused()) return 'merging'

  return 'reviewing'
}

/**
 * reviewing — Fresh-eyes quality pass on the implemented bead.
 */
export async function reviewing(ctx: WorkerContext): Promise<StateId> {
  const bead = ctx.currentBead!
  const workDir = ctx.worktreePath ?? ctx.paths.projectRoot

  setPhase(ctx, 'reviewing', bead.id, bead.title)
  log(ctx, 'INFO', `[${ctx.agentId}] Review: fresh-eyes pass…`)

  try {
    await ctx.capabilities.runClaude(
      ctx.capabilities.buildReviewPrompt(bead), 'review', workDir, ctx.config.claudeModelReview
    )
  } catch (err) {
    log(ctx, 'WARN', `[${ctx.agentId}] Review failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  }

  return 'merging'
}

/**
 * merging — Merge the worktree branch back to main, or discard if stopped.
 */
export async function merging(ctx: WorkerContext): Promise<StateId> {
  if (!ctx.worktreePath || !ctx.worktreeBranch) {
    // No worktree to merge — skip to closing
    return 'closing'
  }

  const bead = ctx.currentBead!

  // If stopped, discard worktree without merging partial work
  if (ctx.flags.stopped) {
    log(ctx, 'INFO', `[${ctx.agentId}] Stopped — discarding worktree ${ctx.worktreeBranch} (no merge)`)
    try {
      cp.execSync(`git worktree remove --force "${ctx.worktreePath}"`, {
        cwd: ctx.paths.projectRoot, timeout: 10000, stdio: 'pipe'
      })
    } catch { /* best-effort cleanup */ }
    await ctx.coordinator.reopenBead(ctx.agentId, bead.id)
    return 'closing'
  }

  try {
    setPhase(ctx, 'merging', bead.id, bead.title)
    log(ctx, 'INFO', `[${ctx.agentId}] Merging worktree branch ${ctx.worktreeBranch}…`)

    // Commit any uncommitted changes in the worktree
    ctx.capabilities.commitWorktreeChanges(ctx.worktreePath, ctx.agentId, ctx.capabilities.env)

    const result = await ctx.coordinator.mergeWorktree(
      ctx.agentId, bead.id, ctx.worktreeBranch, ctx.worktreePath,
      {
        stoppedFn: () => ctx.flags.stopped,
        claudeCmd: ctx.capabilities.resolvedCmd,
        env: ctx.capabilities.env
      }
    )
    ctx.flags.filesChanged = result.filesChanged

    if (result.merged) {
      log(ctx, 'SUCCESS', `[${ctx.agentId}] Merged ${result.filesChanged.length} files from ${ctx.worktreeBranch}`)
      ctx.capabilities.emitter.emit('output',
        `\n── Merged ${ctx.worktreeBranch} → ${result.filesChanged.length} files ──\n${result.filesChanged.map(f => `  ${f}`).join('\n')}\n\n`
      )
      ctx.coordinator.postActivity({
        agentId: ctx.agentId, type: 'merged', beadId: bead.id,
        beadTitle: bead.title, branch: ctx.worktreeBranch,
        filesChanged: result.filesChanged, summary: `Merged ${result.filesChanged.length} files`,
        commitSha: result.commitSha
      })
    } else {
      log(ctx, 'ERROR', `[${ctx.agentId}] Merge failed: ${result.error}`)
      ctx.capabilities.emitter.emit('output', `\n── Merge FAILED: ${ctx.worktreeBranch} ──\n${result.error}\n\n`)
      ctx.flags.mergeFailed = true
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(ctx, 'ERROR', `[${ctx.agentId}] Merge crashed: ${msg}`)
    ctx.capabilities.emitter.emit('output', `\n── Merge ERROR: ${msg} ──\n\n`)
    ctx.flags.mergeFailed = true
  }

  return 'closing'
}

/**
 * closing — Handle bead outcome: retry on failure, wait on rate limit, complete on success.
 */
export async function closing(ctx: WorkerContext): Promise<StateId> {
  const bead = ctx.currentBead!
  const maxRetries = ctx.config.maxRetries
  const cb = ctx.circuitBreaker

  // ── Record CB error for failure paths ──
  if (cb && (ctx.flags.mergeFailed || ctx.flags.executeFailed)) {
    const errorMsg = ctx.flags.mergeFailed ? 'merge failed' : 'execution failed'
    const category = classifyError(errorMsg)
    cb.recordError(errorMsg, category)
    cb.save()
  }

  // ── Merge failed → retry or permanent fail ──
  if (ctx.flags.mergeFailed) {
    const attempt = ctx.capabilities.getBeadAttempt(bead.id)

    if (attempt < maxRetries) {
      ctx.capabilities.incrementBeadAttempt(bead.id)
      await ctx.coordinator.reopenBead(ctx.agentId, bead.id)
      const backoffMs = ctx.capabilities.backoffMs(attempt)
      log(ctx, 'WARN', `[${ctx.agentId}] Bead [${bead.id}] merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
      ctx.coordinator.postActivity({
        agentId: ctx.agentId, type: 'failed', beadId: bead.id,
        beadTitle: bead.title,
        summary: `Merge failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying after backoff`
      })
      await ctx.capabilities.sleep(backoffMs)
      return 'cleanup'
    }

    log(ctx, 'ERROR', `[${ctx.agentId}] Bead [${bead.id}] merge permanently failed after ${maxRetries + 1} attempts`)
    await ctx.coordinator.failBead(ctx.agentId, bead.id, `merge_failed after ${maxRetries + 1} attempts`)
    await ctx.capabilities.sleep(3000)
    return 'cleanup'
  }

  // ── Execute failed → retry or permanent fail ──
  if (ctx.flags.executeFailed) {
    const attempt = ctx.capabilities.getBeadAttempt(bead.id)

    if (attempt < maxRetries) {
      ctx.capabilities.incrementBeadAttempt(bead.id)
      await ctx.coordinator.reopenBead(ctx.agentId, bead.id)
      const backoffMs = ctx.capabilities.backoffMs(attempt)
      log(ctx, 'WARN', `[${ctx.agentId}] Bead [${bead.id}] failed (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${Math.round(backoffMs / 1000)}s`)
      ctx.coordinator.postActivity({
        agentId: ctx.agentId, type: 'failed', beadId: bead.id,
        beadTitle: bead.title,
        summary: `Attempt ${attempt + 1}/${maxRetries + 1} failed — retrying after backoff`
      })
      await ctx.capabilities.sleep(backoffMs)
      return 'cleanup'
    }

    log(ctx, 'ERROR', `[${ctx.agentId}] Bead [${bead.id}] permanently failed after ${maxRetries + 1} attempts`)
    await ctx.coordinator.failBead(ctx.agentId, bead.id, `execute_failed after ${maxRetries + 1} attempts`)
    await ctx.capabilities.sleep(3000)
    return 'cleanup'
  }

  // ── API rate limited → record rate limit on CB, reopen and wait ──
  if (ctx.flags.apiLimited) {
    if (cb) {
      // Use execute output preferentially (rate limit most often appears there);
      // fall back to thinking output if execute phase never ran.
      const rateLimitSource = ctx.executeOutput || ctx.thinkingOutput
      const retryMs = ctx.capabilities.extractRetryAfter(rateLimitSource)
      cb.recordRateLimit(retryMs)
      cb.save()
    }
    await ctx.coordinator.reopenBead(ctx.agentId, bead.id)
    setPhase(ctx, 'rate_limited')
    ctx.coordinator.postActivity({
      agentId: ctx.agentId, type: 'failed', beadId: bead.id,
      beadTitle: bead.title, summary: 'API quota exhausted — waiting for reset'
    })
    await ctx.capabilities.waitForQuotaReset(cb ?? undefined)
    return 'cleanup'
  }

  // ── Stopped → reopen bead for future pickup ──
  if (ctx.flags.stopped) {
    await ctx.coordinator.reopenBead(ctx.agentId, bead.id)
    log(ctx, 'INFO', `[${ctx.agentId}] Stopped — reopened bead [${bead.id}] for future pickup`)
    return 'stopping'
  }

  // ── Success → record progress on CB, complete the bead ──
  if (cb) {
    cb.recordProgress(ctx.flags.loopCount)
    cb.save()
  }
  setPhase(ctx, 'closing', bead.id, bead.title)
  await ctx.coordinator.completeBead(ctx.agentId, bead.id, ctx.flags.filesChanged, ctx.config.autoPush)
  log(ctx, 'SUCCESS', `[${ctx.agentId}] ✓ Closed bead [${bead.id}]`)
  await ctx.capabilities.sleep(1500)

  return 'cleanup'
}

/**
 * cleanup — Transition back to idle for the next bead iteration.
 * Bead reopen/fail decisions are made in closing before reaching here.
 */
export async function cleanup(ctx: WorkerContext): Promise<StateId> {
  // All bead-specific state will be reset in idle
  return 'idle'
}

/**
 * stopping — Terminal state. Signals the run loop to exit.
 * Agent deregistration and activity posting are the caller's responsibility.
 */
export async function stopping(ctx: WorkerContext): Promise<StateId> {
  return 'stopping'
}

// ── State table ──────────────────────────────────────────────────────

export const STATE_TABLE: Record<StateId, StateFn> = {
  idle,
  routing,
  thinking,
  executing,
  reviewing,
  merging,
  closing,
  cleanup,
  stopping
}

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run the state machine until it reaches the terminal 'stopping' state.
 * Returns the final StateId (always 'stopping').
 */
export async function runStateMachine(ctx: WorkerContext): Promise<StateId> {
  let state: StateId = 'idle'

  while (state !== 'stopping') {
    const fn = STATE_TABLE[state]
    state = await fn(ctx)
  }

  return 'stopping'
}

// ── Context factory ──────────────────────────────────────────────────

export function createWorkerContext(
  agentId: string,
  agentIndex: number,
  paths: ProjectPaths,
  config: RalphConfig,
  coordinator: AgentCoordinator,
  capabilities: WorkerCapabilities,
  circuitBreaker?: CircuitBreaker
): WorkerContext {
  return {
    agentId,
    agentIndex,
    paths,
    config,
    coordinator,
    currentBead: null,
    worktreePath: null,
    worktreeBranch: null,
    thinkingOutput: '',
    executeOutput: '',
    flags: {
      executeFailed: false,
      apiLimited: false,
      mergeFailed: false,
      stopped: false,
      gracefulStopping: false,
      filesChanged: [],
      emptyRetries: 0,
      loopCount: 0
    },
    capabilities,
    circuitBreaker: circuitBreaker ?? null
  }
}
