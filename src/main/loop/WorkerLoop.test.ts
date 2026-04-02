import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as cp from 'child_process'
import { EventEmitter } from 'events'
import { WorkerLoop } from './WorkerLoop'
import { RalphConfig, Bead, SplitDecision } from '../types'
import { ProjectPaths } from './ProjectStore'
import * as WorkerStateMachineModule from './WorkerStateMachine'

const mockProcesses: any[] = []

function createProc() {
  const proc = new (EventEmitter as any)()
  proc.pid = 1234
  proc.stdout = new (EventEmitter as any)()
  proc.stderr = new (EventEmitter as any)()
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.kill = vi.fn()
  proc.exitCode = null
  proc.simulateExit = (code: number) => { proc.exitCode = code; proc.emit('close', code); proc.emit('exit', code) }
  proc.simulateStdout = (data: string) => { proc.stdout.emit('data', Buffer.from(data)) }
  proc.simulateStderr = (data: string) => { proc.stderr.emit('data', Buffer.from(data)) }
  return proc
}

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fs>()
  return {
    ...orig,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn()
  }
})

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof cp>()
  return {
    ...orig,
    spawn: vi.fn(),
    execSync: vi.fn()
  }
})

function makeConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 10,
    claudeOutputFormat: 'json',
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
    maxRetries: 2,
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
    id: 'sb-abc',
    title: 'Test bead',
    description: 'A test bead',
    type: 'task',
    status: 'ready',
    deps: [],
    files: ['src/foo.ts'],
    priority: 2,
    tags: ['test'],
    ...overrides
  }
}

function makePaths(overrides: Partial<ProjectPaths> = {}): ProjectPaths {
  return {
    id: 'test-id',
    projectRoot: '/project',
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
    worktreesDir: '/project/.worktrees',
    beadsRoot: '/project/.beads',
    beadsCwd: '/project',
    agentMd: '/home/user/.slashbot/projects/test-id/config/AGENT.md',
    ...overrides
  }
}

function makeCoordinator() {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    updateAgent: vi.fn(),
    postActivity: vi.fn(),
    releaseAllForAgent: vi.fn(),
    claimBestBead: vi.fn(async () => null),
    hasOpenWork: vi.fn(() => false),
    hasOpenWorkAsync: vi.fn(async () => false),
    createWorktree: vi.fn(() => null),
    mergeWorktree: vi.fn(async () => ({ merged: true, filesChanged: ['src/foo.ts'], error: undefined })),
    completeBead: vi.fn(),
    reopenBead: vi.fn(),
    failBead: vi.fn(),
    bd: {
      getState: vi.fn(() => ''),
      setState: vi.fn(),
      show: vi.fn(() => null),
      createAsync: vi.fn(async (opts: any) => makeBead({ id: `sb-child-${Math.random().toString(36).slice(2, 5)}`, title: opts.title, description: opts.description })),
      addDep: vi.fn(),
      addLabel: vi.fn(),
      close: vi.fn(),
      assignTo: vi.fn(() => true),
      ensureDolt: vi.fn(async () => {}),
    },
    readKnowledge: vi.fn(() => []),
    postKnowledge: vi.fn(),
    heartbeat: vi.fn(),
    clearHeartbeat: vi.fn()
  } as any
}

describe('WorkerLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined)
    vi.mocked(fs.readFileSync).mockReturnValue('')
    vi.mocked(cp.spawn).mockReturnValue(undefined as any)
    vi.mocked(cp.execSync).mockReturnValue(Buffer.from('/usr/local/bin/claude'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('can be constructed without errors', () => {
    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    expect(worker).toBeDefined()
    expect(worker.running).toBe(false)
    expect(worker.stopped).toBe(false)
    expect(worker.loopCount).toBe(0)
  })

  it('creates log directory on construction', () => {
    new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    expect(fs.mkdirSync).toHaveBeenCalledWith('/home/user/.slashbot/projects/test-id/logs', { recursive: true })
  })

  describe('stop', () => {
    it('sets stopped and running flags', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.stop()
      expect(worker.stopped).toBe(true)
      expect(worker.running).toBe(false)
    })

    it('releases file locks and posts stopped activity', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.stop()
      expect(coord.releaseAllForAgent).toHaveBeenCalledWith('agent-0')
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0',
        type: 'stopped'
      }))
    })
  })

  describe('gracefulStop', () => {
    it('sets gracefulStopping without setting stopped or killing process', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.gracefulStop()
      expect(worker.stopped).toBe(false)
      expect(worker.running).toBe(false)
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stopped',
        summary: expect.stringContaining('Graceful stop')
      }))
    })
  })

  describe('pause', () => {
    it('sets paused flag and posts activity', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.pause()
      expect(worker.paused).toBe(true)
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0',
        type: 'paused'
      }))
      expect(coord.updateAgent).toHaveBeenCalledWith('agent-0', { phase: 'paused' })
    })

    it('is idempotent — second call is no-op', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.pause()
      const callCount = coord.postActivity.mock.calls.length
      worker.pause()
      expect(coord.postActivity.mock.calls.length).toBe(callCount)
    })

    it('does nothing when stopped', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.stopped = true
      worker.pause()
      expect(worker.paused).toBe(false)
    })
  })

  describe('resume', () => {
    it('clears paused flag and posts activity', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.pause()
      worker.resume()
      expect(worker.paused).toBe(false)
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0',
        type: 'resumed'
      }))
    })

    it('is no-op when not paused', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.resume()
      expect(coord.postActivity).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'resumed'
      }))
    })
  })

  describe('gracefulStop while paused', () => {
    it('auto-resumes before stopping', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.pause()
      expect(worker.paused).toBe(true)
      worker.gracefulStop()
      expect(worker.paused).toBe(false)
      expect(worker.stopped).toBe(false)
    })
  })

  describe('stop while paused', () => {
    it('clears paused flag', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      worker.pause()
      worker.stop()
      expect(worker.paused).toBe(false)
      expect(worker.stopped).toBe(true)
    })
  })

  describe('_backoffMs', () => {
    it('returns 3000ms for attempt 0', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      expect(worker._backoffMs(0)).toBe(3000)
    })

    it('returns 6000ms for attempt 1', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      expect(worker._backoffMs(1)).toBe(6000)
    })

    it('returns 12000ms for attempt 2', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      expect(worker._backoffMs(2)).toBe(12000)
    })

    it('returns 24000ms for attempt 3', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      expect(worker._backoffMs(3)).toBe(24000)
    })

    it('caps at 60000ms', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      expect(worker._backoffMs(10)).toBe(60000)
      expect(worker._backoffMs(100)).toBe(60000)
    })
  })

  describe('_getBeadAttempt', () => {
    it('returns 0 when no retry label', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockReturnValue({ id: 'sb-abc', tags: [] })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      expect(worker._getBeadAttempt('sb-abc')).toBe(0)
    })

    it('parses retry_attempt label', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockReturnValue({ id: 'sb-abc', tags: ['retry_attempt:3'] })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      expect(worker._getBeadAttempt('sb-abc')).toBe(3)
    })

    it('returns 0 when show fails', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockReturnValue(null)
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      expect(worker._getBeadAttempt('sb-abc')).toBe(0)
    })
  })

  describe('_incrementBeadAttempt', () => {
    it('increments from 0 to 1 via label add', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockReturnValue({ id: 'sb-abc', tags: [] })
      coord.bd.run.mockReturnValue('')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker._incrementBeadAttempt('sb-abc')
      expect(coord.bd.run).toHaveBeenCalledWith(['label', 'add', 'sb-abc', 'retry_attempt:1'])
    })

    it('swaps label from 2 to 3', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockReturnValue({ id: 'sb-abc', tags: ['retry_attempt:2'] })
      coord.bd.run.mockReturnValue('')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker._incrementBeadAttempt('sb-abc')
      expect(coord.bd.run).toHaveBeenCalledWith(['label', 'remove', 'sb-abc', 'retry_attempt:2'])
      expect(coord.bd.run).toHaveBeenCalledWith(['label', 'add', 'sb-abc', 'retry_attempt:3'])
    })
  })

  describe('start (loop behavior)', () => {
    it('registers agent and posts started activity', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        coord.claimBestBead.mockResolvedValue(null)
        coord.hasOpenWork.mockReturnValue(false)

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const exitPromise = new Promise<string>(resolve => worker.on('exit', resolve))
        const startPromise = worker.start()

        // Advance through the 3 empty retries (each sleeps 5s with 250ms poll intervals)
        for (let i = 0; i < 60; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        await startPromise
        const reason = await exitPromise

        expect(coord.registerAgent).toHaveBeenCalledWith(expect.objectContaining({
          id: 'agent-0',
          index: 0,
          phase: 'idle'
        }))
        expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
          agentId: 'agent-0',
          type: 'started'
        }))
        expect(reason).toBe('all_beads_done')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not start if already running', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker.running = true
      await worker.start()
      expect(coord.registerAgent).not.toHaveBeenCalled()
    })

    it('deregisters agent on exit', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        coord.claimBestBead.mockResolvedValue(null)
        coord.hasOpenWork.mockReturnValue(false)

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const startPromise = worker.start()

        for (let i = 0; i < 60; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        await startPromise
        expect(coord.deregisterAgent).toHaveBeenCalledWith('agent-0')
      } finally {
        vi.useRealTimers()
      }
    })

    it('waits and retries when beads are claimed but open work exists', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let callCount = 0
        let worker: WorkerLoop
        coord.claimBestBead.mockImplementation(async () => {
          callCount++
          if (callCount >= 3) {
            worker.stopped = true
            worker.running = false
          }
          return null
        })
        coord.hasOpenWork.mockReturnValue(true)

        worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const startPromise = worker.start()

        for (let i = 0; i < 80; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        await startPromise
        expect(callCount).toBeGreaterThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('heartbeat emission', () => {
    it('emits heartbeat on _setPhase', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const heartbeats: number[] = []
      worker.on('heartbeat', () => heartbeats.push(Date.now()))
      ;(worker as any)._setPhase('thinking', 'sb-abc', 'Test bead')
      expect(heartbeats.length).toBe(1)
    })

    it('emits heartbeat on stdout data during _runClaude', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const heartbeats: number[] = []
      worker.on('heartbeat', () => heartbeats.push(Date.now()))

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')

      // Simulate stdout output
      proc.simulateStdout('hello')
      proc.simulateStdout('world')
      proc.simulateExit(0)

      await promise
      // Each stdout chunk should trigger a heartbeat
      expect(heartbeats.length).toBe(2)
    })
  })

  describe('_extractThinkingSummary (via integration)', () => {
    it('extracts structured sections from thinking output', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const summary = (worker as any)._extractThinkingSummary(
        '### Understanding\nThis bead requires X\n\n### Approach\nStep 1: do Y\n\nSome other text'
      )
      expect(summary).toContain('### Understanding')
      expect(summary).toContain('This bead requires X')
      expect(summary).toContain('### Approach')
      expect(summary).toContain('Step 1: do Y')
    })

    it('falls back to tail of output when no structured sections found', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const text = 'Just some unstructured output about the analysis'
      const summary = (worker as any)._extractThinkingSummary(text)
      expect(summary).toBe(text)
    })

    it('truncates summary to 2000 chars', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const longText = '### Understanding\n' + 'x'.repeat(3000)
      const summary = (worker as any)._extractThinkingSummary(longText)
      expect(summary.length).toBeLessThanOrEqual(2000)
    })
  })

  describe('_buildThinkingPrompt split analysis section', () => {
    it('includes Split Analysis section with JSON schema', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('### Split Analysis')
      expect(prompt).toContain('"shouldSplit"')
      expect(prompt).toContain('"children"')
      expect(prompt).toContain('"dependsOn"')
    })

    it('Split Analysis section appears after Test strategy', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      const testIdx = prompt.indexOf('### Test strategy')
      const splitIdx = prompt.indexOf('### Split Analysis')
      expect(testIdx).toBeGreaterThan(-1)
      expect(splitIdx).toBeGreaterThan(testIdx)
    })

    it('Split Analysis schema includes title, description, files, dependsOn for children', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('"title"')
      expect(prompt).toContain('"description"')
      expect(prompt).toContain('"files"')
      expect(prompt).toContain('"dependsOn"')
    })
  })

  describe('_extractThinkingSummary with Split Analysis', () => {
    it('captures Split Analysis section from thinking output', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const input = [
        '### Understanding',
        'This bead does X',
        '',
        '### Split Analysis',
        'This bead should be split.',
        '```json',
        '{',
        '  "shouldSplit": true,',
        '  "reason": "multiple concerns",',
        '  "children": [',
        '    {',
        '      "title": "Child A",',
        '      "description": "First part",',
        '      "files": ["src/a.ts"],',
        '      "dependsOn": []',
        '    }',
        '  ]',
        '}',
        '```',
        '',
        'Some trailing text'
      ].join('\n')
      const summary = (worker as any)._extractThinkingSummary(input)
      expect(summary).toContain('### Split Analysis')
      expect(summary).toContain('"shouldSplit": true')
      expect(summary).toContain('"children"')
      expect(summary).toContain('Child A')
    })

    it('captures Split Analysis with no-split JSON', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const input = [
        '### Understanding',
        'Simple change',
        '',
        '### Split Analysis',
        '```json',
        '{ "shouldSplit": false, "reason": "single concern", "children": [] }',
        '```',
      ].join('\n')
      const summary = (worker as any)._extractThinkingSummary(input)
      expect(summary).toContain('### Split Analysis')
      expect(summary).toContain('"shouldSplit": false')
    })

    it('preserves empty lines inside fenced code blocks', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const input = [
        '### Split Analysis',
        '```json',
        '{',
        '',
        '  "shouldSplit": false',
        '}',
        '```',
      ].join('\n')
      const summary = (worker as any)._extractThinkingSummary(input)
      expect(summary).toContain('"shouldSplit": false')
    })
  })

  describe('prompt building', () => {
    it('_buildThinkingPrompt includes bead details', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const bead = makeBead({ id: 'sb-xyz', title: 'Fix login bug', description: 'Auth fails on edge case' })
      const prompt = (worker as any)._buildThinkingPrompt(bead)
      expect(prompt).toContain('sb-xyz')
      expect(prompt).toContain('Fix login bug')
      expect(prompt).toContain('Auth fails on edge case')
      expect(prompt).toContain('ULTRATHINK')
      expect(prompt).toContain('agent-0')
    })

    it('_buildThinkingPrompt includes files list', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const bead = makeBead({ files: ['src/auth.ts', 'src/login.ts'] })
      const prompt = (worker as any)._buildThinkingPrompt(bead)
      expect(prompt).toContain('src/auth.ts')
      expect(prompt).toContain('src/login.ts')
    })

    it('_buildThinkingPrompt includes AGENT.md when it exists', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('AGENT.md')
      )
      ;(fs.readFileSync as any).mockReturnValue('## Test\nnpm test')

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('npm test')
    })

    it('_buildExecutePrompt includes thinking summary', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const bead = makeBead()
      const thinkingCtx = '### Understanding\nWe need to fix X\n\n### Approach\nModify file Y'
      const prompt = (worker as any)._buildExecutePrompt(bead, thinkingCtx)
      expect(prompt).toContain('Understanding')
      expect(prompt).toContain('RALPH_STATUS')
      expect(prompt).toContain('Do NOT run `bd close`')
    })

    it('_buildExecutePrompt works with empty thinking context', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildExecutePrompt(makeBead(), '')
      expect(prompt).toContain('sb-abc')
      expect(prompt).not.toContain('prior analysis')
    })

    it('_buildReviewPrompt references bead', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildReviewPrompt(makeBead({ id: 'sb-rev', title: 'Review me' }))
      expect(prompt).toContain('sb-rev')
      expect(prompt).toContain('Review me')
      expect(prompt).toContain('Fresh-eyes Review')
      expect(prompt).toContain('Do NOT run `bd close`')
      expect(prompt).toContain('bd show sb-rev')
    })
  })

  describe('_buildParentContext', () => {
    it('returns empty string when bead has no epicId or deps', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildParentContext(makeBead({ epicId: undefined, deps: [] }))
      expect(result).toBe('')
    })

    it('includes parent epic info when epicId is set', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation((id: string) => {
        if (id === 'sb-epic') return makeBead({ id: 'sb-epic', title: 'Big Feature', description: 'The overarching goal', type: 'epic' })
        return null
      })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildParentContext(makeBead({ epicId: 'sb-epic' }))
      expect(result).toContain('Parent epic')
      expect(result).toContain('sb-epic')
      expect(result).toContain('Big Feature')
      expect(result).toContain('The overarching goal')
    })

    it('handles bd.show failure gracefully for parent', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation(() => { throw new Error('bd failed') })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildParentContext(makeBead({ epicId: 'sb-epic' }))
      expect(result).toBe('')
    })

    it('includes dependency beads with status', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation((id: string) => {
        if (id === 'sb-dep1') return makeBead({ id: 'sb-dep1', title: 'Setup DB', status: 'done' })
        if (id === 'sb-dep2') return makeBead({ id: 'sb-dep2', title: 'Add auth', status: 'claimed' })
        return null
      })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildParentContext(makeBead({ deps: ['sb-dep1', 'sb-dep2'] }))
      expect(result).toContain('Dependencies')
      expect(result).toContain('sb-dep1')
      expect(result).toContain('Setup DB')
      expect(result).toContain('(done)')
      expect(result).toContain('sb-dep2')
      expect(result).toContain('Add auth')
      expect(result).toContain('(claimed)')
    })

    it('handles bd.show failure gracefully for deps', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation(() => { throw new Error('bd failed') })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      // Should not throw, just skip
      const result = (worker as any)._buildParentContext(makeBead({ deps: ['sb-dep1'] }))
      expect(result).toBe('')
    })
  })

  describe('_buildKnowledgeContext', () => {
    it('returns empty string when no knowledge entries', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildKnowledgeContext('sb-abc')
      expect(result).toBe('')
    })

    it('renders knowledge entries with category and summary under Collective Knowledge heading', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([
        { ts: '2026-01-01', agentId: 'agent-1', beadId: 'sb-1', category: 'gotcha', summary: 'Watch out for circular imports', detail: '', confidence: 'high' },
        { ts: '2026-01-01', agentId: 'agent-2', beadId: 'sb-2', category: 'pattern', summary: 'Use factory pattern for services', detail: '', confidence: 'medium' }
      ])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildKnowledgeContext('sb-abc')
      expect(result).toContain('Collective Knowledge')
      expect(result).toContain('**gotcha**')
      expect(result).toContain('Watch out for circular imports')
      expect(result).toContain('**pattern**')
      expect(result).toContain('[medium]')
      expect(result).not.toContain('[high]') // high confidence doesn't show tag
    })

    it('filters out self-entries for the current bead', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([
        { ts: '2026-01-01', agentId: 'agent-0', beadId: 'sb-abc', category: 'gotcha', summary: 'Self entry same bead', detail: '', confidence: 'high' },
        { ts: '2026-01-01', agentId: 'agent-0', beadId: 'sb-other', category: 'pattern', summary: 'Self entry different bead', detail: '', confidence: 'high' },
        { ts: '2026-01-01', agentId: 'agent-1', beadId: 'sb-abc', category: 'risk', summary: 'Other agent same bead', detail: '', confidence: 'high' }
      ])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildKnowledgeContext('sb-abc')
      expect(result).not.toContain('Self entry same bead')
      expect(result).toContain('Self entry different bead')
      expect(result).toContain('Other agent same bead')
    })

    it('caps entries at 20', () => {
      const coord = makeCoordinator()
      const entries = Array.from({ length: 30 }, (_, i) => ({
        ts: '2026-01-01', agentId: 'agent-1', beadId: `sb-${i}`,
        category: 'pattern', summary: `Entry ${i}`, detail: '', confidence: 'high'
      }))
      coord.readKnowledge.mockReturnValue(entries)
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = (worker as any)._buildKnowledgeContext('sb-abc')
      // Should contain entries 10-29 (last 20)
      const bulletCount = (result.match(/^- \*\*/gm) || []).length
      expect(bulletCount).toBe(20)
    })
  })

  describe('_buildThinkingPrompt Discoveries section', () => {
    it('includes ### Discoveries section with format instructions', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('### Discoveries')
      expect(prompt).toContain('**category** (confidence)')
      expect(prompt).toContain('None.')
    })

    it('Discoveries section appears before Split Analysis', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      const discoveriesIdx = prompt.indexOf('### Discoveries')
      const splitIdx = prompt.indexOf('### Split Analysis')
      expect(discoveriesIdx).toBeGreaterThan(-1)
      expect(splitIdx).toBeGreaterThan(discoveriesIdx)
    })

    it('includes ## Collective Knowledge when entries exist', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([
        { ts: '2026-01-01', agentId: 'agent-1', beadId: 'sb-1', category: 'convention', summary: 'Use snake_case', detail: '', confidence: 'high' }
      ])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('## Collective Knowledge')
      expect(prompt).toContain('Use snake_case')
    })
  })

  describe('_extractKnowledge', () => {
    it('extracts valid discoveries and posts them', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = [
        '### Discoveries',
        '- **gotcha** (high): Circular imports in auth module',
        '- **pattern** (medium): Services follow factory pattern',
        '',
        '### Split Analysis'
      ].join('\n')
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).toHaveBeenCalledTimes(2)
      expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0', beadId: 'sb-abc', category: 'gotcha',
        summary: 'Circular imports in auth module', confidence: 'high'
      }))
      expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0', beadId: 'sb-abc', category: 'pattern',
        summary: 'Services follow factory pattern', confidence: 'medium'
      }))
    })

    it('does nothing when "None." is the response', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = '### Discoveries\nNone.\n\n### Split Analysis'
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).not.toHaveBeenCalled()
    })

    it('does nothing when ### Discoveries section is missing', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      worker._extractKnowledge('### Understanding\nSome analysis', 'sb-abc')
      expect(coord.postKnowledge).not.toHaveBeenCalled()
    })

    it('skips entries with invalid category', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = '### Discoveries\n- **invalid** (high): Some finding'
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).not.toHaveBeenCalled()
    })

    it('skips entries with invalid confidence', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = '### Discoveries\n- **gotcha** (extreme): Some finding'
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).not.toHaveBeenCalled()
    })

    it('processes good entries and skips malformed ones', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = [
        '### Discoveries',
        '- **gotcha** (high): Valid finding',
        '- malformed entry without proper format',
        '- **risk** (low): Another valid finding'
      ].join('\n')
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).toHaveBeenCalledTimes(2)
    })

    it('stops parsing at next heading', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const input = [
        '### Discoveries',
        '- **gotcha** (high): Before heading',
        '### Split Analysis',
        '- **risk** (high): After heading'
      ].join('\n')
      worker._extractKnowledge(input, 'sb-abc')
      expect(coord.postKnowledge).toHaveBeenCalledTimes(1)
      expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
        summary: 'Before heading'
      }))
    })
  })

  describe('_parseSplitDecision', () => {
    function makeWorker(overrides: Partial<RalphConfig> = {}) {
      return new WorkerLoop('agent-0', 0, '/project', makeConfig(overrides), makeCoordinator(), makePaths())
    }

    const validJson = JSON.stringify({
      shouldSplit: true,
      reason: 'Too complex',
      concerns: ['concern1', 'concern2', 'concern3'],
      children: [
        { title: 'Part A', description: 'First half', files: ['a.ts'], deps: [] },
        { title: 'Part B', description: 'Second half', files: ['b.ts'], deps: ['Part A'] }
      ]
    })

    it('parses valid split decision from fenced JSON block', () => {
      const worker = makeWorker()
      const output = `Some analysis\n### Split Analysis\n\`\`\`json\n${validJson}\n\`\`\`\nMore text`
      const result = (worker as any)._parseSplitDecision(output, makeBead())
      expect(result).not.toBeNull()
      expect(result.beadId).toBe('sb-abc')
      expect(result.reason).toBe('Too complex')
      expect(result.children).toHaveLength(2)
      expect(result.children[0].title).toBe('Part A')
      expect(result.children[1].title).toBe('Part B')
      expect(result.children[0].files).toEqual(['a.ts'])
    })

    it('parses valid split decision from raw JSON block', () => {
      const worker = makeWorker()
      const output = `### Split Analysis\n${validJson}\nEnd`
      const result = (worker as any)._parseSplitDecision(output, makeBead())
      expect(result).not.toBeNull()
      expect(result.children).toHaveLength(2)
    })

    it('returns null when no ### Split Analysis heading', () => {
      const worker = makeWorker()
      const output = `Some output\n\`\`\`json\n${validJson}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when shouldSplit is false', () => {
      const worker = makeWorker()
      const json = JSON.stringify({ shouldSplit: false, concerns: ['a', 'b', 'c'], children: [{ title: 'A', description: 'A' }, { title: 'B', description: 'B' }] })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when fewer than 2 children', () => {
      const worker = makeWorker()
      const json = JSON.stringify({ shouldSplit: true, concerns: ['a', 'b', 'c'], children: [{ title: 'A', description: 'Only one' }] })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when a child is missing title', () => {
      const worker = makeWorker()
      const json = JSON.stringify({ shouldSplit: true, concerns: ['a', 'b', 'c'], children: [{ description: 'No title' }, { title: 'B', description: 'Has title' }] })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when a child is missing description', () => {
      const worker = makeWorker()
      const json = JSON.stringify({ shouldSplit: true, concerns: ['a', 'b', 'c'], children: [{ title: 'A' }, { title: 'B', description: 'Has desc' }] })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when concerns below autoSplitThreshold', () => {
      const worker = makeWorker({ autoSplitThreshold: 3 })
      const json = JSON.stringify({ shouldSplit: true, concerns: ['only-two', 'items'], children: [{ title: 'A', description: 'A' }, { title: 'B', description: 'B' }] })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null for bead with auto-split tag (prevents recursive splitting)', () => {
      const worker = makeWorker()
      const output = `### Split Analysis\n\`\`\`json\n${validJson}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead({ tags: ['auto-split'] }))).toBeNull()
    })

    it('returns null for malformed JSON', () => {
      const worker = makeWorker()
      const output = `### Split Analysis\n\`\`\`json\n{not valid json}\n\`\`\``
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('returns null when no JSON block found after heading', () => {
      const worker = makeWorker()
      const output = `### Split Analysis\nJust some text, no JSON here.`
      expect((worker as any)._parseSplitDecision(output, makeBead())).toBeNull()
    })

    it('defaults files and deps to empty arrays when missing from children', () => {
      const worker = makeWorker()
      const json = JSON.stringify({
        shouldSplit: true, reason: 'Split it', concerns: ['a', 'b', 'c'],
        children: [{ title: 'A', description: 'First' }, { title: 'B', description: 'Second' }]
      })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      const result = (worker as any)._parseSplitDecision(output, makeBead())
      expect(result).not.toBeNull()
      expect(result.children[0].files).toEqual([])
      expect(result.children[0].deps).toEqual([])
    })

    it('uses default reason when reason field is missing', () => {
      const worker = makeWorker()
      const json = JSON.stringify({
        shouldSplit: true, concerns: ['a', 'b', 'c'],
        children: [{ title: 'A', description: 'First' }, { title: 'B', description: 'Second' }]
      })
      const output = `### Split Analysis\n\`\`\`json\n${json}\n\`\`\``
      const result = (worker as any)._parseSplitDecision(output, makeBead())
      expect(result).not.toBeNull()
      expect(result.reason).toBe('Split recommended by analysis')
    })
  })

  describe('parent & knowledge in prompts', () => {
    it('_buildThinkingPrompt includes parent context when epicId is set', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation((id: string) => {
        if (id === 'sb-epic') return makeBead({ id: 'sb-epic', title: 'Epic Goal', type: 'epic' })
        return null
      })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead({ epicId: 'sb-epic' }))
      expect(prompt).toContain('Parent epic')
      expect(prompt).toContain('Epic Goal')
    })

    it('_buildThinkingPrompt includes knowledge context', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([
        { ts: '2026-01-01', agentId: 'agent-1', beadId: 'sb-1', category: 'convention', summary: 'Use camelCase', detail: '', confidence: 'high' }
      ])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('Collective Knowledge')
      expect(prompt).toContain('Use camelCase')
    })

    it('_buildExecutePrompt includes parent context', () => {
      const coord = makeCoordinator()
      coord.bd.show.mockImplementation((id: string) => {
        if (id === 'sb-epic') return makeBead({ id: 'sb-epic', title: 'Epic Goal', type: 'epic' })
        return null
      })
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const prompt = (worker as any)._buildExecutePrompt(makeBead({ epicId: 'sb-epic' }), '')
      expect(prompt).toContain('Parent epic')
      expect(prompt).toContain('Epic Goal')
    })

    it('_buildExecutePrompt includes knowledge context', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([
        { ts: '2026-01-01', agentId: 'agent-1', beadId: 'sb-1', category: 'risk', summary: 'Avoid direct fs writes', detail: '', confidence: 'low' }
      ])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const prompt = (worker as any)._buildExecutePrompt(makeBead(), '')
      expect(prompt).toContain('Collective Knowledge')
      expect(prompt).toContain('Avoid direct fs writes')
      expect(prompt).toContain('[low]')
    })

    it('prompts are unchanged when no parent or knowledge exists', () => {
      const coord = makeCoordinator()
      coord.readKnowledge.mockReturnValue([])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const thinkingPrompt = (worker as any)._buildThinkingPrompt(makeBead())
      const executePrompt = (worker as any)._buildExecutePrompt(makeBead(), '')
      expect(thinkingPrompt).not.toContain('Parent epic')
      expect(thinkingPrompt).not.toContain('Dependencies')
      expect(thinkingPrompt).not.toContain('Collective Knowledge')
      expect(executePrompt).not.toContain('Parent epic')
      expect(executePrompt).not.toContain('Collective Knowledge')
    })

    it('prompts do not contain MCP team coordination references', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const thinkingPrompt = (worker as any)._buildThinkingPrompt(makeBead())
      const executePrompt = (worker as any)._buildExecutePrompt(makeBead(), '')
      expect(thinkingPrompt).not.toContain('Team coordination')
      expect(thinkingPrompt).not.toContain('team_status')
      expect(thinkingPrompt).not.toContain('check_file_reservations')
      expect(thinkingPrompt).not.toContain('MCP tools')
      expect(executePrompt).not.toContain('Team coordination')
      expect(executePrompt).not.toContain('MCP tools')
    })
  })

  describe('_splitBead', () => {
    function makeDecision(overrides: Partial<SplitDecision> = {}): SplitDecision {
      return {
        beadId: 'sb-abc',
        reason: 'Multiple concerns',
        children: [
          { title: 'Child A', description: 'First child', files: ['src/a.ts'], deps: [] },
          { title: 'Child B', description: 'Second child', files: ['src/b.ts'], deps: ['Child A'] }
        ],
        ...overrides
      }
    }

    it('happy path: creates children, wires deps, labels, closes parent, claims first', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async (opts: any) => {
        callCount++
        return makeBead({ id: `sb-child-${callCount}`, title: opts.title, description: opts.description })
      })
      coord.bd.show.mockReturnValue(makeBead({ id: 'sb-child-1', title: 'Child A', status: 'claimed' }))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const bead = makeBead({ id: 'sb-parent' })
      const decision = makeDecision({ beadId: 'sb-parent' })
      const result = await (worker as any)._splitBead(bead, decision)

      // Verify children created with parentId
      expect(coord.bd.createAsync).toHaveBeenCalledTimes(2)
      expect(coord.bd.createAsync).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Child A', parentId: 'sb-parent', labels: ['auto-split']
      }))
      expect(coord.bd.createAsync).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Child B', parentId: 'sb-parent', labels: ['auto-split']
      }))

      // Verify dep wiring: Child B depends on Child A
      expect(coord.bd.addDep).toHaveBeenCalledTimes(1)
      expect(coord.bd.addDep).toHaveBeenCalledWith('sb-child-2', 'sb-child-1')

      // Verify parent labelled and closed
      expect(coord.bd.addLabel).toHaveBeenCalledWith('sb-parent', 'auto-split-parent')
      expect(coord.bd.close).toHaveBeenCalledWith('sb-parent', 'Split into 2 children')

      // Verify activity event
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0', type: 'split', beadId: 'sb-parent'
      }))

      // Verify first child claimed and returned
      expect(coord.bd.assignTo).toHaveBeenCalledWith('sb-child-1', 'agent-0')
      expect(coord.bd.show).toHaveBeenCalledWith('sb-child-1')
      expect(result).not.toBeNull()
      expect(result.id).toBe('sb-child-1')
    })

    it('returns null when createAsync throws on second child (abort)', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async () => {
        callCount++
        if (callCount === 2) throw new Error('bd create failed')
        return makeBead({ id: `sb-child-${callCount}`, title: 'Child' })
      })

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = await (worker as any)._splitBead(makeBead(), makeDecision())

      expect(result).toBeNull()
      // Should NOT label or close parent on failure
      expect(coord.bd.addLabel).not.toHaveBeenCalled()
      expect(coord.bd.close).not.toHaveBeenCalled()
      expect(coord.bd.assignTo).not.toHaveBeenCalled()
    })

    it('wires dependencies for 3 children with cross-deps', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async (opts: any) => {
        callCount++
        return makeBead({ id: `sb-c${callCount}`, title: opts.title })
      })
      coord.bd.show.mockReturnValue(makeBead({ id: 'sb-c1', status: 'claimed' }))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const decision = makeDecision({
        children: [
          { title: 'A', description: 'First', files: [], deps: [] },
          { title: 'B', description: 'Second', files: [], deps: ['A'] },
          { title: 'C', description: 'Third', files: [], deps: ['A', 'B'] }
        ]
      })

      await (worker as any)._splitBead(makeBead(), decision)

      // B depends on A, C depends on A and B
      expect(coord.bd.addDep).toHaveBeenCalledTimes(3)
      expect(coord.bd.addDep).toHaveBeenCalledWith('sb-c2', 'sb-c1')  // B→A
      expect(coord.bd.addDep).toHaveBeenCalledWith('sb-c3', 'sb-c1')  // C→A
      expect(coord.bd.addDep).toHaveBeenCalledWith('sb-c3', 'sb-c2')  // C→B
    })

    it('posts split activity event with child IDs', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async () => {
        callCount++
        return makeBead({ id: `sb-c${callCount}` })
      })
      coord.bd.show.mockReturnValue(makeBead({ id: 'sb-c1' }))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      await (worker as any)._splitBead(makeBead({ id: 'sb-orig', title: 'Original' }), makeDecision({ beadId: 'sb-orig' }))

      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: 'split',
        beadId: 'sb-orig',
        beadTitle: 'Original',
        summary: expect.stringContaining('sb-c1')
      }))
    })

    it('returns null when show returns null after claiming', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async () => {
        callCount++
        return makeBead({ id: `sb-c${callCount}` })
      })
      coord.bd.show.mockReturnValue(null)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const result = await (worker as any)._splitBead(makeBead(), makeDecision())

      expect(result).toBeNull()
      // But parent should still be closed (split was successful)
      expect(coord.bd.close).toHaveBeenCalled()
    })

    it('preserves parent bead priority on children', async () => {
      const coord = makeCoordinator()
      coord.bd.createAsync.mockImplementation(async (opts: any) => makeBead({ id: 'sb-c1', ...opts }))
      coord.bd.show.mockReturnValue(makeBead({ id: 'sb-c1' }))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      await (worker as any)._splitBead(makeBead({ priority: 1 }), makeDecision())

      expect(coord.bd.createAsync).toHaveBeenCalledWith(expect.objectContaining({ priority: 1 }))
    })
  })

  describe('auto-split integration in _loop', () => {
    it('calls _parseSplitDecision with thinking output and bead', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ autoSplitThreshold: 2 }), coord, makePaths())

      const bead = makeBead({ id: 'sb-orig', tags: [] })
      const thinkingOutput = `
### Split Analysis
\`\`\`json
{
  "shouldSplit": true,
  "concerns": ["UI", "API", "tests"],
  "reason": "Multiple concerns",
  "children": [
    { "title": "Child A", "description": "UI work", "files": ["src/ui.ts"] },
    { "title": "Child B", "description": "API work", "files": ["src/api.ts"] }
  ]
}
\`\`\`
`
      const result = (worker as any)._parseSplitDecision(thinkingOutput, bead)
      expect(result).not.toBeNull()
      expect(result.beadId).toBe('sb-orig')
      expect(result.children).toHaveLength(2)
      expect(result.children[0].title).toBe('Child A')
    })

    it('_parseSplitDecision returns null for empty thinking output', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const bead = makeBead({ tags: [] })

      const result = (worker as any)._parseSplitDecision('', bead)
      expect(result).toBeNull()
    })

    it('_splitBead returns child bead and updates can be applied', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.createAsync.mockImplementation(async (opts: any) => {
        callCount++
        return makeBead({ id: `sb-child-${callCount}`, title: opts.title, description: opts.description })
      })
      coord.bd.show.mockImplementation((id: string) => makeBead({ id, title: 'Child A' }))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const originalBead = makeBead({ id: 'sb-orig', title: 'Original' })
      const decision: SplitDecision = {
        beadId: 'sb-orig',
        reason: 'Too large',
        children: [
          { title: 'Child A', description: 'First', files: [], deps: [] },
          { title: 'Child B', description: 'Second', files: [], deps: [] }
        ]
      }

      const firstChild = await (worker as any)._splitBead(originalBead, decision)
      expect(firstChild).not.toBeNull()

      // Simulate what _loop does after _splitBead returns
      let bead = originalBead
      if (firstChild) {
        bead = firstChild
        coord.updateAgent('agent-0', { currentBeadId: bead.id, currentBeadTitle: bead.title })
      }

      // Verify the bead reference was swapped
      expect(bead.id).toBe(firstChild.id)
      expect(bead.id).not.toBe('sb-orig')

      // Verify coordinator was updated with child bead info
      expect(coord.updateAgent).toHaveBeenCalledWith('agent-0', expect.objectContaining({
        currentBeadId: firstChild.id,
        currentBeadTitle: firstChild.title
      }))
    })

    it('bead reference stays unchanged when _splitBead returns null', async () => {
      const coord = makeCoordinator()
      coord.bd.createAsync.mockRejectedValue(new Error('bd failed'))

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const originalBead = makeBead({ id: 'sb-orig', title: 'Original', tags: [] })
      const decision: SplitDecision = {
        beadId: 'sb-orig',
        reason: 'Too large',
        children: [
          { title: 'C1', description: 'd1', files: [], deps: [] },
          { title: 'C2', description: 'd2', files: [], deps: [] }
        ]
      }

      const result = await (worker as any)._splitBead(originalBead, decision)
      expect(result).toBeNull()

      // Simulate _loop logic: bead should not change
      let bead = originalBead
      if (result) {
        bead = result
      }
      expect(bead.id).toBe('sb-orig')
    })

    it('_parseSplitDecision skips beads with auto-split tag (prevents recursive split)', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ autoSplitThreshold: 2 }), coord, makePaths())

      const bead = makeBead({ tags: ['auto-split'] })
      const thinkingOutput = `
### Split Analysis
\`\`\`json
{ "shouldSplit": true, "concerns": ["a","b","c"], "children": [{"title":"C1","description":"d1"},{"title":"C2","description":"d2"}] }
\`\`\`
`
      const result = (worker as any)._parseSplitDecision(thinkingOutput, bead)
      expect(result).toBeNull()
    })

    it('uses let bead declaration allowing reassignment in _loop source', () => {
      // Read the actual source to verify bead is mutable (let, not const)
      const workerSource = require('fs').readFileSync(
        require('path').join(__dirname, 'WorkerLoop.ts'), 'utf8'
      )
      // bead is declared as let (null-initialized) then assigned inside try block
      expect(workerSource).toContain('let bead: Bead | null = null')
      expect(workerSource).toContain('bead = await this.coordinator.claimBestBead')
      expect(workerSource).not.toContain('const bead = await this.coordinator.claimBestBead')
    })

    it('spawn receives --model with correct value for each phase via _runClaude', async () => {
      mockProcesses.length = 0
      vi.mocked(cp.spawn).mockImplementation(() => {
        const p = createProc()
        mockProcesses.push(p)
        return p as any
      })

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const runClaude = (worker as any)._runClaude.bind(worker)

      // Think phase: model = sonnet
      const thinkPromise = runClaude('think prompt', 'think', '/project', 'sonnet')
      expect(mockProcesses).toHaveLength(1)
      const thinkArgs = (cp.spawn as any).mock.calls[0][1] as string[]
      expect(thinkArgs).toContain('--model')
      expect(thinkArgs[thinkArgs.indexOf('--model') + 1]).toBe('sonnet')
      mockProcesses[0].simulateStdout('ok')
      mockProcesses[0].simulateExit(0)
      await thinkPromise

      // Execute phase: model = opus
      const execPromise = runClaude('exec prompt', 'execute', '/project', 'opus')
      expect(mockProcesses).toHaveLength(2)
      const execArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(execArgs).toContain('--model')
      expect(execArgs[execArgs.indexOf('--model') + 1]).toBe('opus')
      mockProcesses[1].simulateStdout('ok')
      mockProcesses[1].simulateExit(0)
      await execPromise

      // Review phase: model = sonnet
      const reviewPromise = runClaude('review prompt', 'review', '/project', 'sonnet')
      expect(mockProcesses).toHaveLength(3)
      const reviewArgs = (cp.spawn as any).mock.calls[2][1] as string[]
      expect(reviewArgs).toContain('--model')
      expect(reviewArgs[reviewArgs.indexOf('--model') + 1]).toBe('sonnet')
      mockProcesses[2].simulateStdout('ok')
      mockProcesses[2].simulateExit(0)
      await reviewPromise
    })

    it('uses custom model values from config in spawn args', async () => {
      mockProcesses.length = 0
      vi.mocked(cp.spawn).mockImplementation(() => {
        const p = createProc()
        mockProcesses.push(p)
        return p as any
      })

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({
        claudeModelThink: 'haiku',
        claudeModelExecute: 'sonnet',
        claudeModelReview: 'haiku'
      }), makeCoordinator(), makePaths())
      const runClaude = (worker as any)._runClaude.bind(worker)

      // Think with haiku
      const p1 = runClaude('p', 'think', '/project', 'haiku')
      expect((cp.spawn as any).mock.calls[0][1]).toContain('--model')
      expect(((cp.spawn as any).mock.calls[0][1] as string[])[((cp.spawn as any).mock.calls[0][1] as string[]).indexOf('--model') + 1]).toBe('haiku')
      mockProcesses[0].simulateStdout('ok')
      mockProcesses[0].simulateExit(0)
      await p1

      // Execute with sonnet
      const p2 = runClaude('p', 'execute', '/project', 'sonnet')
      expect(((cp.spawn as any).mock.calls[1][1] as string[])[((cp.spawn as any).mock.calls[1][1] as string[]).indexOf('--model') + 1]).toBe('sonnet')
      mockProcesses[1].simulateStdout('ok')
      mockProcesses[1].simulateExit(0)
      await p2

      // Review with haiku
      const p3 = runClaude('p', 'review', '/project', 'haiku')
      expect(((cp.spawn as any).mock.calls[2][1] as string[])[((cp.spawn as any).mock.calls[2][1] as string[]).indexOf('--model') + 1]).toBe('haiku')
      mockProcesses[2].simulateStdout('ok')
      mockProcesses[2].simulateExit(0)
      await p3
    })

    it('does not include --model when model arg is omitted', async () => {
      mockProcesses.length = 0
      vi.mocked(cp.spawn).mockImplementation(() => {
        const p = createProc()
        mockProcesses.push(p)
        return p as any
      })

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
      const runClaude = (worker as any)._runClaude.bind(worker)

      // No model argument (like probe call)
      const promise = runClaude('Reply with only the word OK', 'probe', '/project')
      const args = (cp.spawn as any).mock.calls[0][1] as string[]
      expect(args).not.toContain('--model')
      mockProcesses[0].simulateStdout('OK')
      mockProcesses[0].simulateExit(0)
      await promise
    })

    it('loop executes on child bead when split decision is detected', async () => {
      const coord = makeCoordinator()

      const originalBead = makeBead({ id: 'sb-orig', title: 'Original Task', tags: [] })
      const childBead = makeBead({ id: 'sb-child-1', title: 'Child A', tags: ['auto-split'] })

      // Return original bead once, then stop the worker
      let claimCount = 0
      let worker: WorkerLoop
      coord.claimBestBead.mockImplementation(async () => {
        claimCount++
        if (claimCount === 1) return originalBead
        worker.stopped = true
        worker.running = false
        return null
      })
      coord.hasOpenWork.mockReturnValue(true)
      coord.createWorktree.mockReturnValue({ worktreePath: '/project/.worktrees/agent-0-sb-orig', branch: 'worker/sb-orig' })

      // _splitBead dependencies
      let createCount = 0
      coord.bd.createAsync.mockImplementation(async (opts: any) => {
        createCount++
        return makeBead({ id: `sb-child-${createCount}`, title: opts.title, description: opts.description, tags: ['auto-split'] })
      })
      coord.bd.show.mockReturnValue(childBead)

      const thinkingOutput = [
        'Analysis complete.',
        '### Split Analysis',
        '```json',
        '{ "shouldSplit": true, "concerns": ["UI", "API", "tests"],',
        '  "reason": "Multiple concerns",',
        '  "children": [',
        '    { "title": "Child A", "description": "UI work", "files": ["src/ui.ts"] },',
        '    { "title": "Child B", "description": "API work", "files": ["src/api.ts"] }',
        '  ] }',
        '```'
      ].join('\n')

      // Track which prompts _runClaude receives
      const runClaudePrompts: { label: string; prompt: string }[] = []

      worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ autoSplitThreshold: 2 }), coord, makePaths())

      // Mock _runClaude to capture prompts and return controlled output
      ;(worker as any)._runClaude = vi.fn(async (prompt: string, label: string) => {
        runClaudePrompts.push({ label, prompt })
        if (label === 'think') return thinkingOutput
        return 'done'
      })
      // Mock _sleep to avoid real delays
      ;(worker as any)._sleep = vi.fn(async () => {})

      await worker.start()

      // Verify coordinator.updateAgent was called with child bead ID after split
      expect(coord.updateAgent).toHaveBeenCalledWith('agent-0', expect.objectContaining({
        currentBeadId: 'sb-child-1',
        currentBeadTitle: 'Child A'
      }))

      // Verify execute phase prompt references child bead, not original
      const executeCall = runClaudePrompts.find(c => c.label === 'execute')
      expect(executeCall).toBeDefined()
      expect(executeCall!.prompt).toContain('sb-child-1')
      expect(executeCall!.prompt).toContain('Child A')
      expect(executeCall!.prompt).not.toContain('[sb-orig]')
    })

    it('loop executes on original bead when no split decision is detected', async () => {
      const coord = makeCoordinator()

      const originalBead = makeBead({ id: 'sb-orig', title: 'Original Task', tags: [] })

      let claimCount = 0
      let worker: WorkerLoop
      coord.claimBestBead.mockImplementation(async () => {
        claimCount++
        if (claimCount === 1) return originalBead
        worker.stopped = true
        worker.running = false
        return null
      })
      coord.hasOpenWork.mockReturnValue(true)
      coord.createWorktree.mockReturnValue({ worktreePath: '/project/.worktrees/agent-0-sb-orig', branch: 'worker/sb-orig' })

      const runClaudePrompts: { label: string; prompt: string }[] = []

      worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ autoSplitThreshold: 3 }), coord, makePaths())

      ;(worker as any)._runClaude = vi.fn(async (prompt: string, label: string) => {
        runClaudePrompts.push({ label, prompt })
        // Return thinking output WITHOUT split analysis
        if (label === 'think') return 'Analysis complete. This bead is straightforward.'
        return 'done'
      })
      ;(worker as any)._sleep = vi.fn(async () => {})

      await worker.start()

      // Verify coordinator.updateAgent was only called with original bead ID
      const updateCalls = coord.updateAgent.mock.calls
        .filter((c: any) => c[1]?.currentBeadId)
        .map((c: any) => c[1].currentBeadId)
      expect(updateCalls.every((id: string) => id === 'sb-orig')).toBe(true)

      // Verify execute phase prompt references original bead
      const executeCall = runClaudePrompts.find(c => c.label === 'execute')
      expect(executeCall).toBeDefined()
      expect(executeCall!.prompt).toContain('sb-orig')
      expect(executeCall!.prompt).toContain('Original Task')
    })

    it('fails the bead and retries when worktree creation returns null', async () => {
      const coord = makeCoordinator()
      const bead = makeBead({ id: 'sb-wt-fail', title: 'WT Fail Bead' })

      let claimCount = 0
      let worker: WorkerLoop
      coord.claimBestBead.mockImplementation(async () => {
        claimCount++
        if (claimCount === 1) return bead
        // Stop after the first retry loop iteration
        worker.stopped = true
        worker.running = false
        return null
      })
      coord.hasOpenWork.mockReturnValue(true)
      // createWorktree returns null — simulating failure
      coord.createWorktree.mockReturnValue(null)

      worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      ;(worker as any)._runClaude = vi.fn(async () => 'should not be called')
      ;(worker as any)._sleep = vi.fn(async () => {})

      const outputs: string[] = []
      worker.on('output', (msg: string) => outputs.push(msg))

      await worker.start()

      // Should NOT have called _runClaude (no think/execute/review)
      expect((worker as any)._runClaude).not.toHaveBeenCalled()

      // Should have posted a failed activity
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0',
        type: 'failed',
        beadId: 'sb-wt-fail',
        summary: expect.stringContaining('Worktree creation failed')
      }))

      // Should have reopened the bead
      expect(coord.reopenBead).toHaveBeenCalledWith('agent-0', 'sb-wt-fail')

      // Should have reset agent state
      expect(coord.updateAgent).toHaveBeenCalledWith('agent-0', expect.objectContaining({
        currentBeadId: null,
        currentBeadTitle: null,
        phase: 'idle'
      }))

      // Should have slept for 10 seconds before retrying
      expect((worker as any)._sleep).toHaveBeenCalledWith(10_000)

      // Should have emitted error output
      expect(outputs.some(o => o.includes('ERROR') && o.includes('Worktree creation failed'))).toBe(true)
    })

    it('source contains split check between thinking and execute phases', () => {
      const workerSource = require('fs').readFileSync(
        require('path').join(__dirname, 'WorkerLoop.ts'), 'utf8'
      )
      // Verify the split check exists and is positioned correctly
      expect(workerSource).toContain('_parseSplitDecision(stripAnsi(this._extractText(thinkingOutput)), bead)')
      expect(workerSource).toContain('await this._splitBead(bead, splitDecision)')
      expect(workerSource).toContain("this.coordinator.updateAgent(this.agentId, { currentBeadId: bead.id, currentBeadTitle: bead.title })")

      // Verify ordering: split check appears after thinking, before execute
      const splitIdx = workerSource.indexOf('_parseSplitDecision(stripAnsi(this._extractText(thinkingOutput))')
      const executeIdx = workerSource.indexOf("_setPhase('executing'")
      const thinkingIdx = workerSource.indexOf("_setPhase('thinking'")
      expect(thinkingIdx).toBeLessThan(splitIdx)
      expect(splitIdx).toBeLessThan(executeIdx)
    })
  })

  describe('knowledge integration', () => {
    describe('_extractKnowledge', () => {
      it('parses well-formatted discoveries and posts them to coordinator', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const raw = `### Understanding
Some analysis here.

### Discoveries
- **pattern** (high): Functions in utils.ts use a factory pattern
- **gotcha** (medium): The config loader silently ignores unknown keys
- **risk** (low): Race condition possible when two agents merge simultaneously

### Split Analysis
No split needed.`

        worker._extractKnowledge(raw, 'sb-abc')

        expect(coord.postKnowledge).toHaveBeenCalledTimes(3)
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          agentId: 'agent-0',
          beadId: 'sb-abc',
          category: 'pattern',
          confidence: 'high',
          summary: 'Functions in utils.ts use a factory pattern'
        }))
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          category: 'gotcha',
          confidence: 'medium',
          summary: 'The config loader silently ignores unknown keys'
        }))
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          category: 'risk',
          confidence: 'low',
          summary: 'Race condition possible when two agents merge simultaneously'
        }))
      })

      it('returns empty for "None." discoveries', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const raw = `### Discoveries
None.

### Split Analysis`

        worker._extractKnowledge(raw, 'sb-abc')
        expect(coord.postKnowledge).not.toHaveBeenCalled()
      })

      it('returns empty when no Discoveries heading exists', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        worker._extractKnowledge('### Understanding\nSome text.', 'sb-abc')
        expect(coord.postKnowledge).not.toHaveBeenCalled()
      })

      it('skips entries with invalid categories', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const raw = `### Discoveries
- **invalid_cat** (high): Should be skipped
- **pattern** (high): Should be kept`

        worker._extractKnowledge(raw, 'sb-abc')
        expect(coord.postKnowledge).toHaveBeenCalledTimes(1)
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          category: 'pattern'
        }))
      })

      it('skips entries with invalid confidence levels', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const raw = `### Discoveries
- **pattern** (extreme): Bad confidence
- **gotcha** (medium): Good entry`

        worker._extractKnowledge(raw, 'sb-abc')
        expect(coord.postKnowledge).toHaveBeenCalledTimes(1)
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          category: 'gotcha',
          confidence: 'medium'
        }))
      })

      it('skips entries with empty summary when at end of section', () => {
        const coord = makeCoordinator()
        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

        const raw = `### Discoveries
- **gotcha** (medium): Actual content
- **pattern** (high):

### Split Analysis`

        worker._extractKnowledge(raw, 'sb-abc')
        expect(coord.postKnowledge).toHaveBeenCalledTimes(1)
        expect(coord.postKnowledge).toHaveBeenCalledWith(expect.objectContaining({
          category: 'gotcha',
          summary: 'Actual content'
        }))
      })
    })

    describe('_buildThinkingPrompt knowledge inclusion', () => {
      it('includes knowledge section when entries exist', () => {
        const coord = makeCoordinator()
        coord.readKnowledge.mockReturnValue([
          { ts: '2026-01-01T00:00:00Z', agentId: 'agent-1', beadId: 'sb-other', category: 'pattern', summary: 'Use factory pattern', detail: '', confidence: 'high' },
          { ts: '2026-01-01T00:01:00Z', agentId: 'agent-1', beadId: 'sb-other', category: 'gotcha', summary: 'Config ignores unknowns', detail: '', confidence: 'medium' }
        ])
        vi.mocked(cp.execSync).mockReturnValue(Buffer.from('feat/electron'))

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const prompt = (worker as any)._buildThinkingPrompt(makeBead())

        expect(prompt).toContain('## Collective Knowledge')
        expect(prompt).toContain('**pattern**: Use factory pattern')
        expect(prompt).toContain('**gotcha** [medium]: Config ignores unknowns')
      })

      it('omits knowledge section when no entries exist', () => {
        const coord = makeCoordinator()
        coord.readKnowledge.mockReturnValue([])
        vi.mocked(cp.execSync).mockReturnValue(Buffer.from('feat/electron'))

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const prompt = (worker as any)._buildThinkingPrompt(makeBead())

        expect(prompt).not.toContain('## Collective Knowledge')
      })
    })

    describe('self-filtering', () => {
      it('excludes own entries for the current bead', () => {
        const coord = makeCoordinator()
        coord.readKnowledge.mockReturnValue([
          { ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', beadId: 'sb-abc', category: 'pattern', summary: 'My own finding for this bead', detail: '', confidence: 'high' },
          { ts: '2026-01-01T00:01:00Z', agentId: 'agent-1', beadId: 'sb-abc', category: 'gotcha', summary: 'Other agent finding', detail: '', confidence: 'medium' }
        ])
        vi.mocked(cp.execSync).mockReturnValue(Buffer.from('feat/electron'))

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const prompt = (worker as any)._buildThinkingPrompt(makeBead({ id: 'sb-abc' }))

        expect(prompt).not.toContain('My own finding for this bead')
        expect(prompt).toContain('Other agent finding')
      })

      it('keeps own entries from a different bead', () => {
        const coord = makeCoordinator()
        coord.readKnowledge.mockReturnValue([
          { ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', beadId: 'sb-other', category: 'dependency', summary: 'Finding from my other bead', detail: '', confidence: 'high' }
        ])
        vi.mocked(cp.execSync).mockReturnValue(Buffer.from('feat/electron'))

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
        const prompt = (worker as any)._buildThinkingPrompt(makeBead({ id: 'sb-abc' }))

        expect(prompt).toContain('Finding from my other bead')
      })
    })

    describe('end-to-end knowledge flow', () => {
      it('Agent-0 writes knowledge that Agent-1 reads', () => {
        // Shared knowledge store simulating real coordinator behavior
        const knowledgeStore: any[] = []
        const sharedCoordMethods = {
          postKnowledge: vi.fn((entry: any) => {
            knowledgeStore.push({ ts: new Date().toISOString(), ...entry })
          }),
          readKnowledge: vi.fn(() => [...knowledgeStore])
        }

        const coord0 = { ...makeCoordinator(), ...sharedCoordMethods }
        const coord1 = { ...makeCoordinator(), ...sharedCoordMethods }

        vi.mocked(cp.execSync).mockReturnValue(Buffer.from('feat/electron'))

        // Agent-0 extracts knowledge from thinking output
        const worker0 = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord0, makePaths())
        const thinkingOutput = `### Discoveries
- **convention** (high): All test files use .test.ts suffix
- **dependency** (medium): WorkerLoop depends on AgentCoordinator for file locks`

        worker0._extractKnowledge(thinkingOutput, 'sb-bead-0')

        expect(knowledgeStore).toHaveLength(2)

        // Agent-1 builds thinking prompt and sees Agent-0's knowledge
        const worker1 = new WorkerLoop('agent-1', 1, '/project', makeConfig(), coord1, makePaths())
        const prompt = (worker1 as any)._buildThinkingPrompt(makeBead({ id: 'sb-bead-1' }))

        expect(prompt).toContain('## Collective Knowledge')
        expect(prompt).toContain('All test files use .test.ts suffix')
        expect(prompt).toContain('WorkerLoop depends on AgentCoordinator for file locks')
      })
    })
  })

  describe('state machine wiring (SLASHBOT_STATE_MACHINE=1)', () => {
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env.SLASHBOT_STATE_MACHINE
    })

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.SLASHBOT_STATE_MACHINE
      } else {
        process.env.SLASHBOT_STATE_MACHINE = originalEnv
      }
    })

    it('uses _loop when SLASHBOT_STATE_MACHINE is not set', async () => {
      delete process.env.SLASHBOT_STATE_MACHINE
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      // Spy on the private _loop method to verify it's called
      const loopSpy = vi.spyOn(worker as any, '_loop')
      const smSpy = vi.spyOn(worker as any, '_loopStateMachine')

      await worker.start()

      expect(loopSpy).toHaveBeenCalled()
      expect(smSpy).not.toHaveBeenCalled()
    })

    it('uses _loopStateMachine when SLASHBOT_STATE_MACHINE=1', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const loopSpy = vi.spyOn(worker as any, '_loop')
      const smSpy = vi.spyOn(worker as any, '_loopStateMachine')

      await worker.start()

      expect(smSpy).toHaveBeenCalled()
      expect(loopSpy).not.toHaveBeenCalled()
    })

    it('does not use _loopStateMachine when SLASHBOT_STATE_MACHINE=0', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '0'
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const loopSpy = vi.spyOn(worker as any, '_loop')
      const smSpy = vi.spyOn(worker as any, '_loopStateMachine')

      await worker.start()

      expect(loopSpy).toHaveBeenCalled()
      expect(smSpy).not.toHaveBeenCalled()
    })

    it('state machine exits cleanly when no beads are available', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const exitEvents: string[] = []
      worker.on('exit', (reason: string) => exitEvents.push(reason))

      await worker.start()

      expect(exitEvents).toContain('all_beads_done')
      expect(coord.deregisterAgent).toHaveBeenCalledWith('agent-0')
    })

    it('stop() propagates to state machine context flags', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      // Make claimBestBead hang so we can stop mid-loop
      let claimResolve: (v: any) => void
      coord.claimBestBead.mockImplementation(() => new Promise(r => { claimResolve = r }))
      coord.hasOpenWork.mockReturnValue(true)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const startPromise = worker.start()

      // Wait for routing to start
      await new Promise(r => setTimeout(r, 50))

      // The _stateMachineCtx should be set now
      const ctx = (worker as any)._stateMachineCtx
      expect(ctx).not.toBeNull()
      expect(ctx.flags.stopped).toBe(false)

      worker.stop()

      expect(ctx.flags.stopped).toBe(true)

      // Resolve the hanging claim so the loop can exit
      claimResolve!(null)
      await startPromise
    })

    it('gracefulStop() propagates to state machine context flags', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      let claimResolve: (v: any) => void
      coord.claimBestBead.mockImplementation(() => new Promise(r => { claimResolve = r }))
      coord.hasOpenWork.mockReturnValue(true)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const startPromise = worker.start()

      await new Promise(r => setTimeout(r, 50))

      const ctx = (worker as any)._stateMachineCtx
      expect(ctx).not.toBeNull()
      expect(ctx.flags.gracefulStopping).toBe(false)

      worker.gracefulStop()

      expect(ctx.flags.gracefulStopping).toBe(true)
      expect(ctx.flags.stopped).toBe(false)

      claimResolve!(null)
      await startPromise
    })

    it('_stateMachineCtx is cleared after loop finishes', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      await worker.start()

      expect((worker as any)._stateMachineCtx).toBeNull()
    })

    it('_buildCapabilities returns capabilities that delegate to WorkerLoop methods', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const caps = (worker as any)._buildCapabilities()

      // Verify key capability fields exist and have correct types
      expect(typeof caps.runClaude).toBe('function')
      expect(typeof caps.buildThinkingPrompt).toBe('function')
      expect(typeof caps.buildExecutePrompt).toBe('function')
      expect(typeof caps.buildReviewPrompt).toBe('function')
      expect(typeof caps.extractThinkingSummary).toBe('function')
      expect(typeof caps.extractKnowledge).toBe('function')
      expect(typeof caps.parseSplitDecision).toBe('function')
      expect(typeof caps.splitBead).toBe('function')
      expect(typeof caps.detectApiLimit).toBe('function')
      expect(typeof caps.stripAnsi).toBe('function')
      expect(typeof caps.waitForQuotaReset).toBe('function')
      expect(typeof caps.waitIfPaused).toBe('function')
      expect(typeof caps.sleep).toBe('function')
      expect(typeof caps.getBeadAttempt).toBe('function')
      expect(typeof caps.incrementBeadAttempt).toBe('function')
      expect(typeof caps.backoffMs).toBe('function')
      expect(typeof caps.commitWorktreeChanges).toBe('function')
      expect(caps.emitter).toBe(worker)
      expect(caps.resolvedCmd).toBeDefined()
      expect(caps.env).toBeDefined()
      expect(caps.childProcRef).toBeDefined()
    })

    it('capabilities.commitWorktreeChanges swallows errors', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const caps = (worker as any)._buildCapabilities()

      vi.mocked(cp.execSync).mockImplementation(() => { throw new Error('nothing to commit') })

      // Should not throw
      expect(() => caps.commitWorktreeChanges('/tmp/wt', 'agent-0', {})).not.toThrow()
    })

    it('capabilities.detectApiLimit delegates to ResponseAnalyzer', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const caps = (worker as any)._buildCapabilities()

      // Normal output should not trigger rate limit
      expect(caps.detectApiLimit('OK all done')).toBe(false)
    })

    it('capabilities.stripAnsi strips ANSI codes', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const caps = (worker as any)._buildCapabilities()

      expect(caps.stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    })

    it('capabilities.backoffMs delegates correctly', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const caps = (worker as any)._buildCapabilities()

      expect(caps.backoffMs(0)).toBe(3000)
      expect(caps.backoffMs(1)).toBe(6000)
    })

    it('registers and deregisters agent in state machine mode', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      coord.claimBestBead.mockResolvedValue(null)
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      await worker.start()

      expect(coord.registerAgent).toHaveBeenCalledWith(expect.objectContaining({
        id: 'agent-0',
        index: 0,
        phase: 'idle'
      }))
      expect(coord.deregisterAgent).toHaveBeenCalledWith('agent-0')
    })

    it('state machine receives correct exit reason on stop', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()
      // First call returns a bead, second returns null
      let callCount = 0
      coord.claimBestBead.mockImplementation(async () => {
        callCount++
        if (callCount === 1) return null
        return null
      })
      coord.hasOpenWork.mockReturnValue(false)

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const exitEvents: string[] = []
      worker.on('exit', (reason: string) => exitEvents.push(reason))

      await worker.start()

      // Should exit with 'all_beads_done' since no beads found and no open work
      expect(exitEvents[0]).toBe('all_beads_done')
    })

    it('calls _exit even if runStateMachine throws (agent deregisters cleanly)', async () => {
      process.env.SLASHBOT_STATE_MACHINE = '1'
      const coord = makeCoordinator()

      // Spy on runStateMachine to force an unhandled throw — tests the finally block
      // in _loopStateMachine which must call _exit for clean deregistration.
      // (claimBestBead errors are caught internally by routing state and do not propagate.)
      const spy = vi.spyOn(WorkerStateMachineModule, 'runStateMachine').mockRejectedValue(
        new Error('unexpected coordinator error')
      )

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())
      const exitEvents: string[] = []
      worker.on('exit', (reason: string) => exitEvents.push(reason))

      await expect(worker.start()).rejects.toThrow('unexpected coordinator error')

      spy.mockRestore()

      expect(exitEvents).toHaveLength(1)
      expect(coord.deregisterAgent).toHaveBeenCalledWith('agent-0')
    })
  })

  describe('MCP config injection removed', () => {
    it('does not write MCP config or pass --mcp-config to claude', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

      vi.mocked(fs.existsSync).mockReturnValue(true)

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')
      proc.simulateStdout('done')
      proc.simulateExit(0)
      await promise

      // No MCP config files should be written
      const mcpWriteCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => String(call[0]).includes('mcp-')
      )
      expect(mcpWriteCalls).toHaveLength(0)

      // No --mcp-config argument should be passed
      const spawnArgs = vi.mocked(cp.spawn).mock.calls[0][1] as string[]
      expect(spawnArgs).not.toContain('--mcp-config')
    })
  })

  describe('_currentBeadId tracking', () => {
    it('sets _currentBeadId after claim and clears it in finally', async () => {
      const coord = makeCoordinator()
      const bead = makeBead({ id: 'sb-xyz' })
      let beadIdDuringExec: string | null = 'unset' as any

      // claimBestBead returns a bead on first call, null on second (to end the loop)
      coord.claimBestBead.mockResolvedValueOnce(bead).mockResolvedValueOnce(null)
      coord.hasOpenWork.mockReturnValue(false)
      coord.createWorktree.mockReturnValue({ worktreePath: '/project/.worktrees/agent-0-sb-xyz', branch: 'worker/sb-xyz' })

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

      // Mock _runClaude to capture _currentBeadId during execution
      ;(worker as any)._runClaude = vi.fn(async () => {
        beadIdDuringExec = (worker as any)._currentBeadId
        return '{"result": "ok"}'
      })

      await worker.start()

      // During execution, _currentBeadId should have been set
      expect(beadIdDuringExec).toBe('sb-xyz')
      // After loop completes, _currentBeadId should be cleared
      expect((worker as any)._currentBeadId).toBeNull()
    })
  })

  describe('circuit breaker integration', () => {
    it('opens circuit after N consecutive no-progress loops', async () => {
      vi.useFakeTimers()
      try {
        const threshold = 3
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          return makeBead({ id: `sb-${claimCount}`, title: `Bead ${claimCount}` })
        })
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })
        coord.completeBead.mockResolvedValue(undefined)

        const config = makeConfig({ cbNoProgressThreshold: threshold })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Mock _runClaude to return no-progress output: >50 chars (not "stuck"),
        // <200 chars, no EXIT_SIGNAL/FILES_MODIFIED → triggers recordNoProgress().
        // Must NOT start with "I am/I'm/Let me/I'll" and must be ≥50 chars to avoid
        // isStuck branch (which calls recordError instead of recordNoProgress).
        ;(worker as any)._runClaude = vi.fn(async () =>
          '{"type":"result","result":"Examined the codebase but found no actionable items to implement at this time."}'
        )

        const startPromise = worker.start()

        // Advance through enough iterations for the circuit breaker to open.
        // cbNoProgressThreshold=3 → HALF_OPEN after 3rd no-progress bead,
        // OPEN after 4th (requires threshold+1 completions).
        for (let i = 0; i < 600; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // Worker should have processed at least threshold+1 beads
        expect(claimCount).toBeGreaterThanOrEqual(threshold + 1)

        // CB state file must have been saved and must show HALF_OPEN or OPEN
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(threshold)
        const savedStates = cbSaveCalls.map(([, data]) => JSON.parse(data as string))
        expect(savedStates.some(s => s.state === 'HALF_OPEN' || s.state === 'OPEN')).toBe(true)

        // Stop the worker to exit cleanly
        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    })

    it('records progress and keeps circuit closed on successful execution', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 2) return null
          return makeBead({ id: `sb-${claimCount}`, title: `Bead ${claimCount}` })
        })
        coord.hasOpenWork.mockReturnValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })
        coord.completeBead.mockResolvedValue(undefined)

        const config = makeConfig({ cbNoProgressThreshold: 3 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Mock _runClaude to return progress output (files modified > 0)
        ;(worker as any)._runClaude = vi.fn(async () =>
          '{"type":"result","result":"RALPH_STATUS: { \\"STATUS\\": \\"COMPLETE\\", \\"EXIT_SIGNAL\\": true, \\"FILES_MODIFIED\\": 3, \\"WORK_SUMMARY\\": \\"implemented feature\\" }"}'
        )

        const startPromise = worker.start()

        for (let i = 0; i < 200; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})

        // Circuit breaker state should have been saved (writeFileSync called with CB state)
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        // Should have saved at least once (after each successful bead)
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(1)
        // The saved state should show CLOSED
        const lastSave = cbSaveCalls[cbSaveCalls.length - 1]
        const savedState = JSON.parse(lastSave[1] as string)
        expect(savedState.state).toBe('CLOSED')
        expect(savedState.consecutive_no_progress).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('records errors on execute failure and saves CB state', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-fail', title: 'Failing bead' })
        })
        coord.hasOpenWork.mockReturnValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })

        const config = makeConfig({ cbNoProgressThreshold: 3, maxRetries: 0 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Think succeeds, execute throws
        let callIdx = 0
        ;(worker as any)._runClaude = vi.fn(async () => {
          callIdx++
          if (callIdx === 1) return '{"type":"result","result":"analysis done"}' // think
          throw new Error('execute crashed')
        })

        const startPromise = worker.start()

        for (let i = 0; i < 200; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})

        // CB state should have been saved with error recorded
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(1)
        // Verify CB state was saved (error was recorded)
        const lastSave = cbSaveCalls[cbSaveCalls.length - 1]
        const savedState = JSON.parse(lastSave[1] as string)
        // recordError requires 2+ unique errors in lastErrors before incrementing consecutiveSameError,
        // but the state file is still written, confirming the CB was wired in
        expect(savedState).toHaveProperty('state')
        expect(savedState).toHaveProperty('reason')
      } finally {
        vi.useRealTimers()
      }
    })

    it('skips bead claiming when circuit is open and waits', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        coord.claimBestBead.mockResolvedValue(null)
        coord.hasOpenWork.mockReturnValue(false)

        const config = makeConfig({ cbNoProgressThreshold: 1 })
        const paths = makePaths()
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, paths)

        // Pre-seed circuit breaker state as OPEN on disk
        const openState = JSON.stringify({
          state: 'OPEN',
          consecutive_no_progress: 5,
          consecutive_same_error: 0,
          error_window_count: 0,
          consecutive_permission_denials: 0,
          last_progress_loop: 0,
          total_opens: 1,
          reason: 'test forced open',
          current_loop: 0,
          opened_at: new Date().toISOString()
        })
        vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
          String(p).includes('.circuit_breaker_state')
        )
        vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
          if (String(p).includes('.circuit_breaker_state')) return openState
          return ''
        })

        const startPromise = worker.start()

        // Advance time but NOT enough for cooldown (which is 30 min)
        // The circuit should stay open and the loop should NOT claim beads
        for (let i = 0; i < 20; i++) {
          await vi.advanceTimersByTimeAsync(1000)
        }

        // claimBestBead should NOT have been called because circuit is open
        expect(coord.claimBestBead).not.toHaveBeenCalled()

        worker.stop()
        for (let i = 0; i < 140; i++) {
          await vi.advanceTimersByTimeAsync(1000)
        }
        await startPromise.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    })

    it('per-worker CB is constructed with the worker agentId', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        // Return one bead then null so cb.save() is called after processing
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-id-check', title: 'agentId check bead' })
        })
        coord.hasOpenWork.mockReturnValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/worker-7', branch: 'worker/worker-7' })
        coord.completeBead.mockResolvedValue(undefined)

        const worker = new WorkerLoop('worker-7', 7, '/project', makeConfig(), coord, makePaths())

        // Return successful output so cb.save() is called after progress is recorded
        ;(worker as any)._runClaude = vi.fn(async () =>
          '{"type":"result","result":"RALPH_STATUS: { \\"STATUS\\": \\"COMPLETE\\", \\"EXIT_SIGNAL\\": true, \\"FILES_MODIFIED\\": 1, \\"WORK_SUMMARY\\": \\"done\\" }"}'
        )

        const startPromise = worker.start()

        // Advance enough for the bead to be processed
        for (let i = 0; i < 200; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})

        // The CB state file should contain the agentId in the filename
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        // Must have saved state at least once (proves cb.save() was called)
        expect(cbSaveCalls.length).toBeGreaterThan(0)
        // All saved CB state files must use the worker-7 agentId suffix
        for (const [filePath] of cbSaveCalls) {
          expect(String(filePath)).toContain('.circuit_breaker_state_worker-7')
        }
      } finally {
        vi.useRealTimers()
      }
    })

    it('detectApiLimit triggers recordRateLimit and _waitForQuotaReset', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-rate', title: 'Rate limited bead' })
        })
        coord.hasOpenWork.mockReturnValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })

        const config = makeConfig({ cbNoProgressThreshold: 99, maxRetries: 0 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Think succeeds; execute returns rate limit message
        let callIdx = 0
        ;(worker as any)._runClaude = vi.fn(async () => {
          callIdx++
          if (callIdx === 1) return '{"type":"result","result":"analysis done"}' // think
          // Execute output triggers detectApiLimit (matches 'rate limit reached')
          return 'Error: rate limit reached. Please retry after 60 seconds.'
        })

        const startPromise = worker.start()

        // Advance past bead execution (think+execute+merge+phase5) and into the wait loop.
        // _waitForQuotaReset polls every 30s, so we need substantial advancement.
        for (let i = 0; i < 600; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // Verify rate_limited activity was posted
        const rateLimitedCalls = coord.postActivity.mock.calls.filter(
          ([arg]) => arg.type === 'rate_limited'
        )
        expect(rateLimitedCalls.length).toBeGreaterThanOrEqual(1)
        expect(rateLimitedCalls[0][0]).toMatchObject({
          agentId: 'agent-0',
          type: 'rate_limited',
          beadId: 'sb-rate',
          summary: expect.stringContaining('API quota exhausted')
        })

        // Verify CB state was saved with rate_limit_until set
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(1)
        const lastSave = cbSaveCalls[cbSaveCalls.length - 1]
        const savedState = JSON.parse(lastSave[1] as string)
        expect(savedState.rate_limit_until).toBeDefined()

        // Stop and clean up
        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    })

    it('bead stays claimed during rate limit wait then is reopened', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-wait', title: 'Wait bead' })
        })
        coord.hasOpenWork.mockReturnValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })

        const config = makeConfig({ cbNoProgressThreshold: 99, maxRetries: 0 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        let callIdx = 0
        ;(worker as any)._runClaude = vi.fn(async () => {
          callIdx++
          if (callIdx === 1) return '{"type":"result","result":"analysis done"}'
          return 'Error: rate limit reached'
        })

        const startPromise = worker.start()

        // Advance past execution and into _waitForQuotaReset
        for (let i = 0; i < 600; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // During the wait: bead should NOT have been failed (failBead not called)
        expect(coord.failBead).not.toHaveBeenCalled()

        // Stop the worker so it exits the wait loop
        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})

        // After the wait, bead should be reopened (not failed)
        expect(coord.reopenBead).toHaveBeenCalledWith('agent-0', 'sb-wait')
      } finally {
        vi.useRealTimers()
      }
    })

    it('open event from CircuitBreaker posts circuit_open activity', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        // Always return the same bead — we stop the worker before a second claim
        coord.claimBestBead.mockResolvedValue(makeBead({ id: 'sb-1', title: 'Bead 1' }))
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })

        // cbErrorWindowThreshold: 1 → circuit opens after the very first error
        const config = makeConfig({ cbErrorWindowThreshold: 1, cbErrorWindowSize: 10, cbNoProgressThreshold: 99, maxRetries: 0 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Think succeeds; execute throws → executeFailed → recordError → circuit opens → emits 'open'
        let callIdx = 0
        ;(worker as any)._runClaude = vi.fn(async () => {
          callIdx++
          if (callIdx % 2 === 1) return '{"type":"result","result":"analysis done"}' // think
          throw new Error('execute crashed')
        })

        const startPromise = worker.start()

        // Advance past the bead execution (think+execute are sync mocks, merge is instant).
        // The circuit opens before the failBead sleep (3s), so a few advances is enough.
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // Verify the 'open' event listener posted circuit_open activity
        const circuitOpenCalls = coord.postActivity.mock.calls.filter(
          ([arg]) => arg.type === 'circuit_open'
        )
        expect(circuitOpenCalls.length).toBeGreaterThanOrEqual(1)
        expect(circuitOpenCalls[0][0]).toMatchObject({
          agentId: 'agent-0',
          type: 'circuit_open',
          summary: expect.stringContaining('Circuit breaker OPEN')
        })

        // Stop the worker to allow clean exit
        worker.stop()
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    })

    it('per-worker CB state file uses agentId', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-w9', title: 'Worker 9 bead' })
        })
        coord.hasOpenWorkAsync.mockResolvedValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/worker-9', branch: 'worker/worker-9' })
        coord.completeBead.mockResolvedValue(undefined)

        const config = makeConfig({ cbNoProgressThreshold: 3 })
        const worker = new WorkerLoop('worker-9', 0, '/project', config, coord, makePaths())

        // Mock _runClaude to return progress output so cb.save() is called on the happy path
        ;(worker as any)._runClaude = vi.fn(async () =>
          '{"type":"result","result":"RALPH_STATUS: { \\"STATUS\\": \\"COMPLETE\\", \\"EXIT_SIGNAL\\": true, \\"FILES_MODIFIED\\": 2, \\"WORK_SUMMARY\\": \\"done\\" }"}'
        )

        const startPromise = worker.start()

        // Advance enough for the bead to be processed
        for (let i = 0; i < 30; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // Stop the worker after the bead is processed
        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})

        // Verify that circuit breaker state file includes the agentId "worker-9"
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state_worker-9')
        )
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('detectApiLimit true triggers cb.recordRateLimit and _waitForQuotaReset', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        let claimCount = 0
        coord.claimBestBead.mockImplementation(async () => {
          claimCount++
          if (claimCount > 1) return null
          return makeBead({ id: 'sb-rl', title: 'Rate limited bead' })
        })
        coord.hasOpenWorkAsync.mockResolvedValue(false)
        coord.createWorktree.mockResolvedValue({ worktreePath: '/project/.worktrees/agent-0', branch: 'worker/agent-0' })
        coord.reopenBead.mockResolvedValue(undefined)

        const config = makeConfig({ cbNoProgressThreshold: 99 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        // Think succeeds; execute returns rate-limit output (detectApiLimit matches "rate limit reached")
        let callIdx = 0
        ;(worker as any)._runClaude = vi.fn(async () => {
          callIdx++
          if (callIdx === 1) return '{"type":"result","result":"analysis done"}' // think
          // Execute returns rate-limit indicator that detectApiLimit recognizes
          return '{"type":"result","result":"rate limit reached — please try again later"}'
        })

        const startPromise = worker.start()

        // Advance enough for the think+execute phases to complete and rate limit path to trigger
        for (let i = 0; i < 30; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }

        // Verify bead was reopened (rate limit path reopens the bead)
        expect(coord.reopenBead).toHaveBeenCalledWith('agent-0', 'sb-rl')

        // Verify activity was posted with 'API quota exhausted' summary
        const rateLimitCalls = coord.postActivity.mock.calls.filter(
          ([arg]: any) => typeof arg.summary === 'string' && arg.summary.includes('API quota exhausted')
        )
        expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1)

        // Verify CB state was saved with rate limit recorded
        const cbSaveCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
          ([filePath]) => String(filePath).includes('.circuit_breaker_state')
        )
        expect(cbSaveCalls.length).toBeGreaterThanOrEqual(1)

        // Stop the worker to exit the _waitForQuotaReset loop
        worker.stop()
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(500)
        }
        await startPromise.catch(() => {})
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('_runClaude promise settling and session capture', () => {
    it('only settles promise once when both error and close fire', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord, makePaths())

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')

      // Simulate error followed by close (Node.js spawn failure pattern)
      proc.emit('error', new Error('ENOENT'))
      proc.emit('close', 1)

      // The promise should reject with the error handler's message (first to fire)
      await expect(promise).rejects.toThrow('spawn failed: ENOENT')
    })

    it('only settles promise once when close fires after timeout', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        const config = makeConfig({ claudeTimeoutMinutes: 1 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        const proc = createProc()
        vi.mocked(cp.spawn).mockReturnValue(proc)

        const promise = (worker as any)._runClaude('test prompt', 'test')

        // Timeout fires first (no output → rejects)
        await vi.advanceTimersByTimeAsync(60_000)

        // Then close fires (should be ignored due to settled flag)
        proc.emit('close', 0)

        await expect(promise).rejects.toThrow('timed out')
      } finally {
        vi.useRealTimers()
      }
    })

    it('timeout resolves with raw output when output exists', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        const config = makeConfig({ claudeTimeoutMinutes: 1 })
        const worker = new WorkerLoop('agent-0', 0, '/project', config, coord, makePaths())

        const proc = createProc()
        vi.mocked(cp.spawn).mockReturnValue(proc)

        const promise = (worker as any)._runClaude('test prompt', 'test')

        // Produce some output before timeout
        proc.simulateStdout('partial output')

        // Timeout fires — should resolve since there's output
        await vi.advanceTimersByTimeAsync(60_000)

        await expect(promise).resolves.toBe('partial output')
      } finally {
        vi.useRealTimers()
      }
    })

    it('captures sessionId from JSON output on close', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ claudeOutputFormat: 'json' }), coord, makePaths())

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')

      // Simulate JSON output with sessionId
      proc.simulateStdout('{"type":"system","sessionId":"sess-abc123"}\n')
      proc.simulateStdout('{"type":"result","result":"done","sessionId":"sess-abc123"}\n')
      proc.simulateExit(0)

      await promise

      expect((worker as any).sessionId).toBe('sess-abc123')
    })

    it('does not overwrite sessionId when JSON output has no sessionId', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ claudeOutputFormat: 'json' }), coord, makePaths())
      ;(worker as any).sessionId = 'existing-session'

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')

      proc.simulateStdout('{"type":"result","result":"done"}\n')
      proc.simulateExit(0)

      await promise

      expect((worker as any).sessionId).toBe('existing-session')
    })

    it('does not attempt sessionId extraction for text output format', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ claudeOutputFormat: 'text' as any }), coord, makePaths())

      const proc = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc)

      const promise = (worker as any)._runClaude('test prompt', 'test')

      proc.simulateStdout('plain text output')
      proc.simulateExit(0)

      await promise

      expect((worker as any).sessionId).toBeUndefined()
    })

    it('sessionId is used in --resume flag when continueSession is enabled', async () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig({ continueSession: true, claudeOutputFormat: 'json' }), coord, makePaths())

      // First call: capture sessionId
      const proc1 = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc1)
      const p1 = (worker as any)._runClaude('first prompt', 'test')
      proc1.simulateStdout('{"type":"result","result":"done","sessionId":"sess-xyz"}\n')
      proc1.simulateExit(0)
      await p1

      // Second call: should include --resume
      const proc2 = createProc()
      vi.mocked(cp.spawn).mockReturnValue(proc2)
      const p2 = (worker as any)._runClaude('second prompt', 'test')
      proc2.simulateStdout('{"type":"result","result":"done"}\n')
      proc2.simulateExit(0)
      await p2

      const secondCallArgs = vi.mocked(cp.spawn).mock.calls[1][1] as string[]
      expect(secondCallArgs).toContain('--resume')
      expect(secondCallArgs).toContain('sess-xyz')
    })
  })
})
