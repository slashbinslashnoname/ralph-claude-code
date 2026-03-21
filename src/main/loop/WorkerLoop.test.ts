import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
import * as cp from 'child_process'
import { WorkerLoop } from './WorkerLoop'
import { RalphConfig, Bead } from '../types'

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fs>()
  return {
    ...orig,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn()
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
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 30,
    autoPush: false,
    maxRetries: 2,
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

function makeCoordinator() {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    updateAgent: vi.fn(),
    postActivity: vi.fn(),
    releaseAllForAgent: vi.fn(),
    claimBestBead: vi.fn(async () => null),
    hasOpenWork: vi.fn(() => false),
    createWorktree: vi.fn(() => null),
    mergeWorktree: vi.fn(async () => ({ merged: true, filesChanged: ['src/foo.ts'], error: undefined })),
    completeBead: vi.fn(),
    reopenBead: vi.fn(),
    failBead: vi.fn(),
    bd: {
      getState: vi.fn(() => ''),
      setState: vi.fn()
    }
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
    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
    expect(worker).toBeDefined()
    expect(worker.running).toBe(false)
    expect(worker.stopped).toBe(false)
    expect(worker.loopCount).toBe(0)
  })

  it('creates log directory on construction', () => {
    new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
    expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot/logs', { recursive: true })
  })

  describe('stop', () => {
    it('sets stopped and running flags', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.running = true
      worker.stop()
      expect(worker.stopped).toBe(true)
      expect(worker.running).toBe(false)
    })

    it('releases file locks and posts stopped activity', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.stop()
      expect(coord.releaseAllForAgent).toHaveBeenCalledWith('agent-0')
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-0',
        type: 'stopped'
      }))
    })
  })

  describe('gracefulStop', () => {
    it('sets stopped without killing process', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.running = true
      worker.gracefulStop()
      expect(worker.stopped).toBe(true)
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
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
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
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.running = true
      worker.pause()
      const callCount = coord.postActivity.mock.calls.length
      worker.pause()
      expect(coord.postActivity.mock.calls.length).toBe(callCount)
    })

    it('does nothing when stopped', () => {
      const coord = makeCoordinator()
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.stopped = true
      worker.pause()
      expect(worker.paused).toBe(false)
    })
  })

  describe('resume', () => {
    it('clears paused flag and posts activity', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
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
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
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
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.running = true
      worker.pause()
      expect(worker.paused).toBe(true)
      worker.gracefulStop()
      expect(worker.paused).toBe(false)
      expect(worker.stopped).toBe(true)
    })
  })

  describe('stop while paused', () => {
    it('clears paused flag', () => {
      const coord = makeCoordinator()
      coord.getAgents = vi.fn(() => [{ id: 'agent-0', phase: 'executing' }])
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker.running = true
      worker.pause()
      worker.stop()
      expect(worker.paused).toBe(false)
      expect(worker.stopped).toBe(true)
    })
  })

  describe('_backoffMs', () => {
    it('returns 3000ms for attempt 0', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      expect(worker._backoffMs(0)).toBe(3000)
    })

    it('returns 6000ms for attempt 1', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      expect(worker._backoffMs(1)).toBe(6000)
    })

    it('returns 12000ms for attempt 2', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      expect(worker._backoffMs(2)).toBe(12000)
    })

    it('returns 24000ms for attempt 3', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      expect(worker._backoffMs(3)).toBe(24000)
    })

    it('caps at 60000ms', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      expect(worker._backoffMs(10)).toBe(60000)
      expect(worker._backoffMs(100)).toBe(60000)
    })
  })

  describe('_getBeadAttempt', () => {
    it('returns 0 when no state set', () => {
      const coord = makeCoordinator()
      coord.bd.getState.mockReturnValue('')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      expect(worker._getBeadAttempt('sb-abc')).toBe(0)
    })

    it('parses stored attempt number', () => {
      const coord = makeCoordinator()
      coord.bd.getState.mockReturnValue('3')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      expect(worker._getBeadAttempt('sb-abc')).toBe(3)
    })

    it('returns 0 for NaN state', () => {
      const coord = makeCoordinator()
      coord.bd.getState.mockReturnValue('not-a-number')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      expect(worker._getBeadAttempt('sb-abc')).toBe(0)
    })
  })

  describe('_incrementBeadAttempt', () => {
    it('increments from 0 to 1', () => {
      const coord = makeCoordinator()
      coord.bd.getState.mockReturnValue('')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker._incrementBeadAttempt('sb-abc')
      expect(coord.bd.setState).toHaveBeenCalledWith('sb-abc', 'retry_attempt', '1', 'Retry after failure')
    })

    it('increments existing value', () => {
      const coord = makeCoordinator()
      coord.bd.getState.mockReturnValue('2')
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
      worker._incrementBeadAttempt('sb-abc')
      expect(coord.bd.setState).toHaveBeenCalledWith('sb-abc', 'retry_attempt', '3', 'Retry after failure')
    })
  })

  describe('start (loop behavior)', () => {
    it('registers agent and posts started activity', async () => {
      vi.useFakeTimers()
      try {
        const coord = makeCoordinator()
        coord.claimBestBead.mockResolvedValue(null)
        coord.hasOpenWork.mockReturnValue(false)

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)

        const exitPromise = new Promise<string>(resolve => worker.on('exit', resolve))
        const startPromise = worker.start()

        // Advance through the 3 empty retries (each sleeps 5s with 250ms poll intervals)
        for (let i = 0; i < 60; i++) {
          vi.advanceTimersByTime(500)
          await new Promise(r => setImmediate(r))
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
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
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

        const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
        const startPromise = worker.start()

        for (let i = 0; i < 60; i++) {
          vi.advanceTimersByTime(500)
          await new Promise(r => setImmediate(r))
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

        worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), coord)
        const startPromise = worker.start()

        for (let i = 0; i < 80; i++) {
          vi.advanceTimersByTime(500)
          await new Promise(r => setImmediate(r))
        }

        await startPromise
        expect(callCount).toBeGreaterThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('_extractThinkingSummary (via integration)', () => {
    it('extracts structured sections from thinking output', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const summary = (worker as any)._extractThinkingSummary(
        '### Understanding\nThis bead requires X\n\n### Approach\nStep 1: do Y\n\nSome other text'
      )
      expect(summary).toContain('### Understanding')
      expect(summary).toContain('This bead requires X')
      expect(summary).toContain('### Approach')
      expect(summary).toContain('Step 1: do Y')
    })

    it('falls back to tail of output when no structured sections found', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const text = 'Just some unstructured output about the analysis'
      const summary = (worker as any)._extractThinkingSummary(text)
      expect(summary).toBe(text)
    })

    it('truncates summary to 2000 chars', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const longText = '### Understanding\n' + 'x'.repeat(3000)
      const summary = (worker as any)._extractThinkingSummary(longText)
      expect(summary.length).toBeLessThanOrEqual(2000)
    })
  })

  describe('prompt building', () => {
    it('_buildThinkingPrompt includes bead details', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const bead = makeBead({ id: 'sb-xyz', title: 'Fix login bug', description: 'Auth fails on edge case' })
      const prompt = (worker as any)._buildThinkingPrompt(bead)
      expect(prompt).toContain('sb-xyz')
      expect(prompt).toContain('Fix login bug')
      expect(prompt).toContain('Auth fails on edge case')
      expect(prompt).toContain('ULTRATHINK')
      expect(prompt).toContain('agent-0')
    })

    it('_buildThinkingPrompt includes files list', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
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

      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const prompt = (worker as any)._buildThinkingPrompt(makeBead())
      expect(prompt).toContain('npm test')
    })

    it('_buildExecutePrompt includes thinking summary', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const bead = makeBead()
      const thinkingCtx = '### Understanding\nWe need to fix X\n\n### Approach\nModify file Y'
      const prompt = (worker as any)._buildExecutePrompt(bead, thinkingCtx)
      expect(prompt).toContain('Understanding')
      expect(prompt).toContain('RALPH_STATUS')
      expect(prompt).toContain('Do NOT run `bd close`')
    })

    it('_buildExecutePrompt works with empty thinking context', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const prompt = (worker as any)._buildExecutePrompt(makeBead(), '')
      expect(prompt).toContain('sb-abc')
      expect(prompt).not.toContain('prior analysis')
    })

    it('_buildReviewPrompt references bead', () => {
      const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator())
      const prompt = (worker as any)._buildReviewPrompt(makeBead({ id: 'sb-rev', title: 'Review me' }))
      expect(prompt).toContain('sb-rev')
      expect(prompt).toContain('Review me')
      expect(prompt).toContain('Fresh-eyes Review')
      expect(prompt).toContain('Do NOT run any `bd` commands')
    })
  })
})
