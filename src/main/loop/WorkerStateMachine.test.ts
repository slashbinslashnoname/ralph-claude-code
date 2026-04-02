import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  StateId,
  WorkerContext,
  WorkerFlags,
  WorkerCapabilities,
  idle,
  routing,
  executing,
  reviewing,
  merging,
  closing,
  cleanup,
  stopping,
  runStateMachine,
  createWorkerContext,
  STATE_TABLE
} from './WorkerStateMachine'
import { RalphConfig, Bead } from '../types'
import { ProjectPaths } from './ProjectStore'

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 10,
    claudeOutputFormat: 'text',
    claudeCodeCmd: 'claude',
    allowedTools: '*',
    sleepDuration: 1,
    continueSession: false,
    cbNoProgressThreshold: 3,
    cbSameErrorThreshold: 3,
    cbErrorWindowSize: 20,
    cbErrorWindowThreshold: 5,
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 30,
    cbMaxCooldownMinutes: 480,
    autoPush: false,
    maxRetries: 3,
    autoSplitThreshold: 3,
    buildMonitorCmd: '',
    buildMonitorInterval: 0,
    claudeModelThink: 'sonnet',
    claudeModelExecute: 'opus',
    claudeModelReview: 'sonnet',
    ...overrides
  }
}

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'sb-1',
    title: 'Test bead',
    description: 'A test bead',
    type: 'task',
    status: 'claimed',
    deps: [],
    files: [],
    priority: 2,
    tags: [],
    ...overrides
  }
}

function makeFlags(overrides: Partial<WorkerFlags> = {}): WorkerFlags {
  return {
    executeFailed: false,
    apiLimited: false,
    mergeFailed: false,
    stopped: false,
    gracefulStopping: false,
    filesChanged: [],
    emptyRetries: 0,
    loopCount: 0,
    ...overrides
  }
}

function makeCapabilities(overrides: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return {
    runClaude: vi.fn().mockResolvedValue('output'),
    buildExecutePrompt: vi.fn().mockReturnValue('exec prompt'),
    buildReviewPrompt: vi.fn().mockReturnValue('review prompt'),
    getCassContext: vi.fn().mockResolvedValue(''),
    detectApiLimit: vi.fn().mockReturnValue(false),
    stripAnsi: vi.fn().mockImplementation((s: string) => s),
    extractText: vi.fn().mockImplementation((s: string) => s),
    waitForQuotaReset: vi.fn().mockResolvedValue(undefined),
    extractRetryAfter: vi.fn().mockReturnValue(undefined),
    waitIfPaused: vi.fn().mockResolvedValue(false),
    sleep: vi.fn().mockResolvedValue(undefined),
    emitter: new EventEmitter(),
    getBeadAttempt: vi.fn().mockReturnValue(0),
    incrementBeadAttempt: vi.fn(),
    backoffMs: vi.fn().mockReturnValue(3000),
    childProcRef: { childProc: null },
    commitWorktreeChanges: vi.fn(),
    resolvedCmd: 'claude',
    env: {},
    ...overrides
  }
}

function makeCoordinator() {
  return {
    updateAgent: vi.fn(),
    claimBestBead: vi.fn().mockResolvedValue(null),
    hasOpenWork: vi.fn().mockReturnValue(false),
    createWorktree: vi.fn().mockReturnValue(null),
    mergeWorktree: vi.fn().mockResolvedValue({ merged: true, filesChanged: ['a.ts'], commitSha: 'abc123' }),
    postActivity: vi.fn(),
    completeBead: vi.fn().mockResolvedValue(undefined),
    reopenBead: vi.fn(),
    failBead: vi.fn(),
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    readKnowledge: vi.fn().mockReturnValue([]),
    postKnowledge: vi.fn(),
    heartbeat: vi.fn(),
    clearHeartbeat: vi.fn(),
    getAgents: vi.fn().mockReturnValue([]),
    releaseAllForAgent: vi.fn(),
    bd: { getState: vi.fn().mockReturnValue(''), setState: vi.fn() }
  } as any
}

function makePaths(overrides: Partial<ProjectPaths> = {}): ProjectPaths {
  return {
    id: 'test-id',
    projectRoot: '/tmp/test-project',
    storeDir: '/home/user/.slashbot/projects/test-id',
    logsDir: '/home/user/.slashbot/projects/test-id/logs',
    circuitBreakerState: '/home/user/.slashbot/projects/test-id/.circuit_breaker_state',
    callCount: '/home/user/.slashbot/projects/test-id/.call_count',
    activity: '/home/user/.slashbot/projects/test-id/activity.jsonl',
    knowledge: '/home/user/.slashbot/projects/test-id/knowledge.jsonl',
    agents: '/home/user/.slashbot/projects/test-id/agents.json',
    fileLocks: '/home/user/.slashbot/projects/test-id/file_locks.json',
    configDir: '/home/user/.slashbot/projects/test-id/config',
    slashbotrc: '/home/user/.slashbot/projects/test-id/config/.slashbotrc',
    worktreesDir: '/tmp/test-project/.worktrees',
    beadsRoot: '/tmp/test-project/.beads',
    agentMd: '/home/user/.slashbot/projects/test-id/config/AGENT.md',
    ...overrides
  }
}

function makeCtx(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    agentId: 'worker-0',
    agentIndex: 0,
    paths: makePaths(),
    config: makeConfig(),
    coordinator: makeCoordinator(),
    currentBead: null,
    worktreePath: null,
    worktreeBranch: null,
    executeOutput: '',
    flags: makeFlags(),
    capabilities: makeCapabilities(),
    circuitBreaker: null,
    ...overrides
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkerStateMachine', () => {
  describe('STATE_TABLE', () => {
    it('contains all 8 state functions', () => {
      const expected: StateId[] = ['idle', 'routing', 'executing', 'reviewing', 'merging', 'closing', 'cleanup', 'stopping']
      expect(Object.keys(STATE_TABLE).sort()).toEqual(expected.sort())
      for (const key of expected) {
        expect(typeof STATE_TABLE[key]).toBe('function')
      }
    })
  })

  describe('createWorkerContext', () => {
    it('creates a context with default values', () => {
      const caps = makeCapabilities()
      const coord = makeCoordinator()
      const ctx = createWorkerContext('worker-0', 0, makePaths(), makeConfig(), coord, caps)
      expect(ctx.agentId).toBe('worker-0')
      expect(ctx.currentBead).toBeNull()
      expect(ctx.flags.stopped).toBe(false)
      expect(ctx.flags.loopCount).toBe(0)
    })
  })

  describe('idle', () => {
    it('resets per-bead state and transitions to routing', async () => {
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'agent/test',
        flags: makeFlags({ executeFailed: true, filesChanged: ['x.ts'] })
      })

      const next = await idle(ctx)

      expect(next).toBe('routing')
      expect(ctx.currentBead).toBeNull()
      expect(ctx.worktreePath).toBeNull()
      expect(ctx.worktreeBranch).toBeNull()
      expect(ctx.flags.executeFailed).toBe(false)
      expect(ctx.flags.filesChanged).toEqual([])
      // When agentId already matches slot ID, uses updateAgent path
      expect(ctx.coordinator.updateAgent).toHaveBeenCalledWith('worker-0', expect.objectContaining({
        phase: 'idle', currentBeadId: null
      }))
    })

    it('re-registers with slot-based ID when agentId was bead-based', async () => {
      const ctx = makeCtx({
        agentId: 'worker-sb-1',
        currentBead: makeBead(),
      })

      const next = await idle(ctx)

      expect(next).toBe('routing')
      expect(ctx.agentId).toBe('worker-0')
      expect(ctx.coordinator.deregisterAgent).toHaveBeenCalledWith('worker-sb-1')
      expect(ctx.coordinator.registerAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-0' }))
    })

    it('transitions to stopping when stopped', async () => {
      const ctx = makeCtx({ flags: makeFlags({ stopped: true }) })
      expect(await idle(ctx)).toBe('stopping')
    })

    it('transitions to stopping when paused then stopped', async () => {
      const ctx = makeCtx({
        capabilities: makeCapabilities({ waitIfPaused: vi.fn().mockResolvedValue(true) })
      })
      expect(await idle(ctx)).toBe('stopping')
    })
  })

  describe('routing', () => {
    it('transitions to executing when a bead is claimed', async () => {
      const bead = makeBead()
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(bead)
      coordinator.createWorktree.mockReturnValue({ worktreePath: '/tmp/wt', branch: 'worker-sb-1' })
      const ctx = makeCtx({ coordinator })

      const next = await routing(ctx)

      expect(next).toBe('executing')
      expect(ctx.currentBead).toBe(bead)
      expect(ctx.agentId).toBe('worker-sb-1')
      expect(ctx.worktreePath).toBe('/tmp/wt')
      expect(ctx.worktreeBranch).toBe('worker-sb-1')
      expect(coordinator.deregisterAgent).toHaveBeenCalledWith('worker-0')
      expect(coordinator.registerAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-sb-1' }))
    })

    it('retries routing when no bead available but open work exists', async () => {
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(null)
      coordinator.hasOpenWork.mockReturnValue(true)
      const ctx = makeCtx({ coordinator })

      const next = await routing(ctx)

      expect(next).toBe('routing')
      expect(ctx.flags.emptyRetries).toBe(1) // incremented, keeps retrying with backoff
    })

    it('increments emptyRetries and stops after 3 when no open work', async () => {
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(null)
      coordinator.hasOpenWork.mockReturnValue(false)
      const ctx = makeCtx({ coordinator, flags: makeFlags({ emptyRetries: 2 }) })

      const next = await routing(ctx)

      expect(next).toBe('stopping')
      expect(ctx.flags.emptyRetries).toBe(3)
    })

    it('transitions to stopping when stopped', async () => {
      const ctx = makeCtx({ flags: makeFlags({ stopped: true }) })
      expect(await routing(ctx)).toBe('stopping')
    })

    it('handles worktree creation failure gracefully', async () => {
      const bead = makeBead()
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(bead)
      coordinator.createWorktree.mockReturnValue(null)
      const ctx = makeCtx({ coordinator })

      const next = await routing(ctx)

      expect(next).toBe('executing')
      expect(ctx.worktreePath).toBeNull()
      expect(ctx.worktreeBranch).toBeNull()
    })
  })

  describe('executing', () => {
    it('runs execution and transitions to reviewing', async () => {
      const bead = makeBead()
      const ctx = makeCtx({ currentBead: bead })

      const next = await executing(ctx)

      expect(next).toBe('reviewing')
      expect(ctx.capabilities.runClaude).toHaveBeenCalledWith('exec prompt', 'execute', ctx.paths.projectRoot, 'opus')
    })

    it('sets executeFailed and transitions to merging on error', async () => {
      const caps = makeCapabilities({
        runClaude: vi.fn().mockRejectedValue(new Error('exec boom'))
      })
      const ctx = makeCtx({ currentBead: makeBead(), capabilities: caps })

      const next = await executing(ctx)

      expect(next).toBe('merging')
      expect(ctx.flags.executeFailed).toBe(true)
    })

    it('sets apiLimited and transitions to merging on rate limit', async () => {
      const caps = makeCapabilities({
        detectApiLimit: vi.fn().mockReturnValue(true)
      })
      const ctx = makeCtx({ currentBead: makeBead(), capabilities: caps })

      const next = await executing(ctx)

      expect(next).toBe('merging')
      expect(ctx.flags.apiLimited).toBe(true)
    })

    it('transitions to merging when stopped after execution', async () => {
      const ctx = makeCtx({
        currentBead: makeBead(),
        flags: makeFlags({ stopped: true })
      })

      expect(await executing(ctx)).toBe('merging')
    })

    it('transitions to merging when paused then stopped', async () => {
      const caps = makeCapabilities({
        waitIfPaused: vi.fn().mockResolvedValue(true)
      })
      const ctx = makeCtx({ currentBead: makeBead(), capabilities: caps })

      expect(await executing(ctx)).toBe('merging')
    })

    it('posts executing activity event', async () => {
      const bead = makeBead()
      const ctx = makeCtx({ currentBead: bead })

      await executing(ctx)

      expect(ctx.coordinator.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: 'executing', beadId: 'sb-1'
      }))
    })
  })

  describe('reviewing', () => {
    it('runs review and transitions to merging', async () => {
      const ctx = makeCtx({ currentBead: makeBead() })

      const next = await reviewing(ctx)

      expect(next).toBe('merging')
      expect(ctx.capabilities.runClaude).toHaveBeenCalledWith('review prompt', 'review', ctx.paths.projectRoot, 'sonnet')
    })

    it('transitions to merging even if review fails', async () => {
      const caps = makeCapabilities({
        runClaude: vi.fn().mockRejectedValue(new Error('review failed'))
      })
      const ctx = makeCtx({ currentBead: makeBead(), capabilities: caps })

      expect(await reviewing(ctx)).toBe('merging')
    })
  })

  describe('merging', () => {
    it('skips to closing when no worktree', async () => {
      const ctx = makeCtx({ currentBead: makeBead() })
      expect(await merging(ctx)).toBe('closing')
    })

    it('merges worktree and transitions to closing on success', async () => {
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'agent/agent-0/sb-1',
        coordinator
      })

      const next = await merging(ctx)

      expect(next).toBe('closing')
      expect(ctx.flags.mergeFailed).toBe(false)
      expect(ctx.flags.filesChanged).toEqual(['a.ts'])
      expect(ctx.capabilities.commitWorktreeChanges).toHaveBeenCalledWith('/tmp/wt', 'worker-0', {})
      expect(coordinator.mergeWorktree).toHaveBeenCalledWith(
        'worker-0', 'sb-1', 'agent/agent-0/sb-1', '/tmp/wt',
        expect.objectContaining({ claudeCmd: 'claude' })
      )
    })

    it('sets mergeFailed when merge returns merged=false', async () => {
      const coordinator = makeCoordinator()
      coordinator.mergeWorktree.mockResolvedValue({ merged: false, filesChanged: [], error: 'conflict' })
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'branch',
        coordinator
      })

      await merging(ctx)

      expect(ctx.flags.mergeFailed).toBe(true)
    })

    it('sets mergeFailed when merge throws', async () => {
      const coordinator = makeCoordinator()
      coordinator.mergeWorktree.mockRejectedValue(new Error('crash'))
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'branch',
        coordinator
      })

      await merging(ctx)

      expect(ctx.flags.mergeFailed).toBe(true)
    })

    it('posts merged activity event on success', async () => {
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'agent/branch',
        coordinator
      })

      await merging(ctx)

      expect(coordinator.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: 'merged', branch: 'agent/branch', commitSha: 'abc123'
      }))
    })
  })

  describe('closing', () => {
    it('completes bead on success and transitions to cleanup', async () => {
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        flags: makeFlags({ filesChanged: ['a.ts'] })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(coordinator.completeBead).toHaveBeenCalledWith('worker-0', 'sb-1', ['a.ts'], false)
    })

    it('retries on mergeFailed with attempt < maxRetries', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(0) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ mergeFailed: true })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(caps.incrementBeadAttempt).toHaveBeenCalledWith('sb-1')
      expect(coordinator.reopenBead).toHaveBeenCalledWith('worker-0', 'sb-1')
      expect(coordinator.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: 'failed', summary: expect.stringContaining('Merge failed')
      }))
    })

    it('permanently fails bead on mergeFailed with exhausted retries', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(3) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ mergeFailed: true }),
        config: makeConfig({ maxRetries: 3 })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(coordinator.failBead).toHaveBeenCalledWith('worker-0', 'sb-1', expect.stringContaining('merge_failed'))
    })

    it('retries on executeFailed with attempt < maxRetries', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(1) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ executeFailed: true }),
        config: makeConfig({ maxRetries: 3 })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(caps.incrementBeadAttempt).toHaveBeenCalledWith('sb-1')
      expect(coordinator.reopenBead).toHaveBeenCalledWith('worker-0', 'sb-1')
    })

    it('permanently fails on executeFailed with exhausted retries', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(3) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ executeFailed: true }),
        config: makeConfig({ maxRetries: 3 })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(coordinator.failBead).toHaveBeenCalledWith('worker-0', 'sb-1', expect.stringContaining('execute_failed'))
    })

    it('waits for quota reset on apiLimited', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities()
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ apiLimited: true })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(coordinator.reopenBead).toHaveBeenCalledWith('worker-0', 'sb-1')
      expect(caps.waitForQuotaReset).toHaveBeenCalled()
    })

    it('reopens bead and transitions to stopping when stopped', async () => {
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        flags: makeFlags({ stopped: true })
      })

      const next = await closing(ctx)

      expect(next).toBe('stopping')
      expect(coordinator.reopenBead).toHaveBeenCalledWith('worker-0', 'sb-1')
    })
  })

  describe('cleanup', () => {
    it('transitions to idle', async () => {
      const ctx = makeCtx()
      expect(await cleanup(ctx)).toBe('idle')
    })
  })

  describe('stopping', () => {
    it('returns stopping (terminal)', async () => {
      const ctx = makeCtx()
      expect(await stopping(ctx)).toBe('stopping')
    })
  })

  describe('runStateMachine', () => {
    it('runs through a complete bead lifecycle: idle → routing → executing → reviewing → merging → closing → cleanup → idle → routing (stop)', async () => {
      const bead = makeBead()
      const coordinator = makeCoordinator()

      // First call returns bead, second call returns null (no work)
      let routingCalls = 0
      coordinator.claimBestBead.mockImplementation(async () => {
        routingCalls++
        return routingCalls === 1 ? bead : null
      })
      coordinator.hasOpenWork.mockReturnValue(false)
      coordinator.createWorktree.mockReturnValue({ worktreePath: '/tmp/wt', branch: 'b' })
      coordinator.mergeWorktree.mockResolvedValue({ merged: true, filesChanged: ['f.ts'], commitSha: 'sha' })

      const ctx = makeCtx({
        coordinator,
        flags: makeFlags({ emptyRetries: 2 }) // will hit 3 on second routing
      })

      const result = await runStateMachine(ctx)

      expect(result).toBe('stopping')
      expect(coordinator.completeBead).toHaveBeenCalledTimes(1)
    })

    it('exits immediately when stopped from idle', async () => {
      const ctx = makeCtx({ flags: makeFlags({ stopped: true }) })

      const result = await runStateMachine(ctx)

      expect(result).toBe('stopping')
    })
  })

  describe('state transition correctness', () => {
    it('merging is always reached before closing', async () => {
      // Verify that executing fails → merging → closing
      const caps = makeCapabilities({
        runClaude: vi.fn().mockRejectedValueOnce(new Error('fail'))
      })
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'b',
        capabilities: caps,
        coordinator
      })

      const afterExec = await executing(ctx)
      expect(afterExec).toBe('merging')
      expect(ctx.flags.executeFailed).toBe(true)

      await merging(ctx)
      expect(coordinator.mergeWorktree).toHaveBeenCalled()
    })

    it('uses worktreePath for Claude calls when available', async () => {
      const caps = makeCapabilities()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/my-worktree',
        capabilities: caps
      })

      await executing(ctx)

      expect(caps.runClaude).toHaveBeenCalledWith(
        expect.any(String), 'execute', '/tmp/my-worktree', expect.any(String)
      )
    })

    it('uses projectRoot for Claude calls when no worktree', async () => {
      const caps = makeCapabilities()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: null,
        paths: makePaths({ projectRoot: '/my/project' }),
        capabilities: caps
      })

      await executing(ctx)

      expect(caps.runClaude).toHaveBeenCalledWith(
        expect.any(String), 'execute', '/my/project', expect.any(String)
      )
    })
  })

  describe('stoppedFn passed to mergeWorktree', () => {
    it('passes a stoppedFn that reads ctx.flags.stopped', async () => {
      const coordinator = makeCoordinator()
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'b',
        coordinator
      })

      await merging(ctx)

      const callArgs = coordinator.mergeWorktree.mock.calls[0]
      const opts = callArgs[4]
      expect(typeof opts.stoppedFn).toBe('function')
      expect(opts.stoppedFn()).toBe(false)
      ctx.flags.stopped = true
      expect(opts.stoppedFn()).toBe(true)
    })
  })

  describe('cleanup → idle → stopping (stopRequested)', () => {
    it('cleanup returns idle, then idle returns stopping when stopped flag is set', async () => {
      const ctx = makeCtx({ flags: makeFlags({ stopped: true }) })

      const afterCleanup = await cleanup(ctx)
      expect(afterCleanup).toBe('idle')

      const afterIdle = await idle(ctx)
      expect(afterIdle).toBe('stopping')
    })
  })

  describe('merging → closing with conflict → cleanup → idle (retry/reopen)', () => {
    it('merge conflict triggers retry via closing, then cleanup returns to idle', async () => {
      const coordinator = makeCoordinator()
      coordinator.mergeWorktree.mockResolvedValue({ merged: false, filesChanged: [], error: 'conflict' })
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(0) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'branch',
        coordinator,
        capabilities: caps
      })

      const afterMerging = await merging(ctx)
      expect(afterMerging).toBe('closing')
      expect(ctx.flags.mergeFailed).toBe(true)

      const afterClosing = await closing(ctx)
      expect(afterClosing).toBe('cleanup')
      expect(coordinator.reopenBead).toHaveBeenCalledWith('worker-0', 'sb-1')
      expect(caps.incrementBeadAttempt).toHaveBeenCalledWith('sb-1')

      const afterCleanup = await cleanup(ctx)
      expect(afterCleanup).toBe('idle')
    })
  })

  describe('routing → idle (no work available)', () => {
    it('routing with no bead and no open work increments emptyRetries, eventually transitions idle → routing → stopping', async () => {
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(null)
      coordinator.hasOpenWork.mockReturnValue(false)
      const ctx = makeCtx({ coordinator, flags: makeFlags({ emptyRetries: 0 }) })

      // First routing: emptyRetries goes to 1, stays in routing
      let next = await routing(ctx)
      expect(next).toBe('routing')
      expect(ctx.flags.emptyRetries).toBe(1)

      // Second routing: emptyRetries goes to 2
      next = await routing(ctx)
      expect(next).toBe('routing')
      expect(ctx.flags.emptyRetries).toBe(2)

      // Third routing: emptyRetries reaches 3 → stopping
      next = await routing(ctx)
      expect(next).toBe('stopping')
      expect(ctx.flags.emptyRetries).toBe(3)
    })
  })

  describe('emitter events', () => {
    it('idle emits no phase event but updates coordinator', async () => {
      const ctx = makeCtx()
      await idle(ctx)
      expect(ctx.coordinator.updateAgent).toHaveBeenCalledWith('worker-0', expect.objectContaining({ phase: 'idle' }))
    })

    it('routing emits phase and heartbeat events', async () => {
      const coordinator = makeCoordinator()
      coordinator.claimBestBead.mockResolvedValue(null)
      coordinator.hasOpenWork.mockReturnValue(true)
      const emitter = new EventEmitter()
      const phases: string[] = []
      let heartbeats = 0
      emitter.on('phase', (p: string) => phases.push(p))
      emitter.on('heartbeat', () => heartbeats++)
      const caps = makeCapabilities({ emitter })
      const ctx = makeCtx({ coordinator, capabilities: caps })

      await routing(ctx)

      expect(phases).toContain('routing')
      expect(phases).toContain('waiting')
      expect(heartbeats).toBeGreaterThanOrEqual(2)
    })

    it('merging emits output event on success', async () => {
      const emitter = new EventEmitter()
      const outputs: string[] = []
      emitter.on('output', (s: string) => outputs.push(s))
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ emitter })
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'agent/b',
        coordinator,
        capabilities: caps
      })

      await merging(ctx)

      expect(outputs.some(o => o.includes('Merged agent/b'))).toBe(true)
    })

    it('merging emits output event on failure', async () => {
      const emitter = new EventEmitter()
      const outputs: string[] = []
      emitter.on('output', (s: string) => outputs.push(s))
      const coordinator = makeCoordinator()
      coordinator.mergeWorktree.mockResolvedValue({ merged: false, filesChanged: [], error: 'conflict' })
      const caps = makeCapabilities({ emitter })
      const ctx = makeCtx({
        currentBead: makeBead(),
        worktreePath: '/tmp/wt',
        worktreeBranch: 'agent/b',
        coordinator,
        capabilities: caps
      })

      await merging(ctx)

      expect(outputs.some(o => o.includes('Merge FAILED'))).toBe(true)
    })
  })

  describe('closing priority order', () => {
    it('mergeFailed takes priority over executeFailed', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(3) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ mergeFailed: true, executeFailed: true }),
        config: makeConfig({ maxRetries: 3 })
      })

      await closing(ctx)

      // mergeFailed branch runs, not executeFailed
      expect(coordinator.failBead).toHaveBeenCalledWith('worker-0', 'sb-1', expect.stringContaining('merge_failed'))
    })

    it('executeFailed takes priority over apiLimited', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities({ getBeadAttempt: vi.fn().mockReturnValue(3) })
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ executeFailed: true, apiLimited: true }),
        config: makeConfig({ maxRetries: 3 })
      })

      await closing(ctx)

      expect(coordinator.failBead).toHaveBeenCalledWith('worker-0', 'sb-1', expect.stringContaining('execute_failed'))
    })

    it('apiLimited takes priority over stopped', async () => {
      const coordinator = makeCoordinator()
      const caps = makeCapabilities()
      const ctx = makeCtx({
        currentBead: makeBead(),
        coordinator,
        capabilities: caps,
        flags: makeFlags({ apiLimited: true, stopped: true })
      })

      const next = await closing(ctx)

      expect(next).toBe('cleanup')
      expect(caps.waitForQuotaReset).toHaveBeenCalled()
    })
  })

  // ── Circuit Breaker integration tests ────────────────────────────────

  describe('CircuitBreaker integration', () => {
    function makeMockCB() {
      return {
        tick: vi.fn(),
        isOpen: vi.fn().mockReturnValue(false),
        load: vi.fn(),
        save: vi.fn(),
        recordError: vi.fn(),
        recordRateLimit: vi.fn(),
        recordProgress: vi.fn(),
        rateLimitLifted: vi.fn().mockReturnValue(true),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      } as any
    }

    describe('routing', () => {
      it('ticks the circuit breaker on each routing call', async () => {
        const cb = makeMockCB()
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          coordinator,
          circuitBreaker: cb,
          flags: makeFlags({ loopCount: 5 })
        })

        await routing(ctx)

        // loopCount incremented to 6, tick called with 6
        expect(cb.tick).toHaveBeenCalledWith(6)
      })

      it('waits and reloads when circuit is open', async () => {
        const cb = makeMockCB()
        cb.isOpen.mockReturnValue(true)
        const caps = makeCapabilities()
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          coordinator,
          capabilities: caps,
          circuitBreaker: cb
        })

        const next = await routing(ctx)

        expect(caps.sleep).toHaveBeenCalledWith(60_000)
        expect(cb.load).toHaveBeenCalled()
        expect(next).toBe('routing')
      })
    })

    describe('closing with CB', () => {
      it('records error on CB when merge fails', async () => {
        const cb = makeMockCB()
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          circuitBreaker: cb,
          flags: makeFlags({ mergeFailed: true })
        })

        await closing(ctx)

        expect(cb.recordError).toHaveBeenCalledWith('merge failed', expect.any(String))
        expect(cb.save).toHaveBeenCalled()
      })

      it('records error on CB when execute fails', async () => {
        const cb = makeMockCB()
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          circuitBreaker: cb,
          flags: makeFlags({ executeFailed: true })
        })

        await closing(ctx)

        expect(cb.recordError).toHaveBeenCalledWith('execution failed', expect.any(String))
        expect(cb.save).toHaveBeenCalled()
      })

      it('records rate limit on CB when apiLimited, using executeOutput', async () => {
        const cb = makeMockCB()
        const caps = makeCapabilities()
        ;(caps.extractRetryAfter as any).mockReturnValue(30000)
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          capabilities: caps,
          circuitBreaker: cb,
          executeOutput: '{"retry_after":30}',
          flags: makeFlags({ apiLimited: true })
        })

        await closing(ctx)

        // extractRetryAfter should be called with executeOutput
        expect(caps.extractRetryAfter).toHaveBeenCalledWith('{"retry_after":30}')
        expect(cb.recordRateLimit).toHaveBeenCalledWith(30000)
        expect(cb.save).toHaveBeenCalled()
        expect(caps.waitForQuotaReset).toHaveBeenCalledWith(cb)
      })

      it('uses empty string when executeOutput is empty on apiLimited', async () => {
        const cb = makeMockCB()
        const caps = makeCapabilities()
        ;(caps.extractRetryAfter as any).mockReturnValue(undefined)
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          capabilities: caps,
          circuitBreaker: cb,
          executeOutput: '',
          flags: makeFlags({ apiLimited: true })
        })

        await closing(ctx)

        expect(caps.extractRetryAfter).toHaveBeenCalledWith('')
        expect(cb.recordRateLimit).toHaveBeenCalledWith(undefined)
      })

      it('records progress on CB on success', async () => {
        const cb = makeMockCB()
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          circuitBreaker: cb,
          flags: makeFlags({ loopCount: 7 })
        })

        const next = await closing(ctx)

        expect(next).toBe('cleanup')
        expect(cb.recordProgress).toHaveBeenCalledWith(7)
        expect(cb.save).toHaveBeenCalled()
      })

      it('works without CB (null) — no errors', async () => {
        const coordinator = makeCoordinator()
        const ctx = makeCtx({
          currentBead: makeBead(),
          coordinator,
          circuitBreaker: null,
          flags: makeFlags({ mergeFailed: true })
        })

        // Should not throw
        const next = await closing(ctx)
        expect(next).toBe('cleanup')
      })
    })

    describe('per-worker CB has correct agentId', () => {
      it('createWorkerContext stores the passed circuitBreaker', () => {
        const cb = makeMockCB()
        const ctx = createWorkerContext(
          'worker-1',
          1,
          makePaths(),
          makeConfig(),
          makeCoordinator(),
          makeCapabilities(),
          cb
        )
        expect(ctx.circuitBreaker).toBe(cb)
        expect(ctx.agentId).toBe('worker-1')
      })

      it('createWorkerContext defaults circuitBreaker to null', () => {
        const ctx = createWorkerContext(
          'worker-2',
          2,
          makePaths(),
          makeConfig(),
          makeCoordinator(),
          makeCapabilities()
        )
        expect(ctx.circuitBreaker).toBeNull()
      })
    })
  })
})
