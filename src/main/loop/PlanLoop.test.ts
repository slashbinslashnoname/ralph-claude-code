import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
import { EventEmitter } from 'events'
import { PlanLoop } from './PlanLoop'
import { RalphConfig } from '../types'
import type { ProjectPaths } from './ProjectStore'

import * as cp from 'child_process'
import { EventEmitter as EE } from 'events'

const mockProcesses: any[] = []

function createProc() {
  const proc = new (EE as any)()
  proc.pid = 1234
  proc.stdout = new (EE as any)()
  proc.stderr = new (EE as any)()
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.kill = vi.fn()
  proc.exitCode = null
  proc.simulateExit = (code: number) => { proc.exitCode = code; proc.emit('close', code); proc.emit('exit', code) }
  proc.simulateStdout = (data: string) => { proc.stdout.emit('data', Buffer.from(data)) }
  proc.simulateStderr = (data: string) => { proc.stderr.emit('data', Buffer.from(data)) }
  return proc
}

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

function makePaths(overrides: Partial<ProjectPaths> = {}): ProjectPaths {
  return {
    id: 'abc123',
    projectRoot: '/project',
    storeDir: '/store',
    logsDir: '/store/logs',
    circuitBreakerState: '/store/.circuit_breaker_state',
    callCount: '/store/.call_count',
    activity: '/store/activity.jsonl',
    knowledge: '/store/knowledge.jsonl',
    agents: '/store/agents.json',
    fileLocks: '/store/file_locks.json',
    configDir: '/store/config',
    slashbotrc: '/store/config/.slashbotrc',
    worktreesDir: '/project/.worktrees',
    beadsRoot: '/project/.beads',
    agentMd: '/store/config/AGENT.md',
    ...overrides
  }
}

function makeCoordinator() {
  let counter = 0
  const createAsync = vi.fn(async (opts: any) => ({ id: `sb-${++counter}`, ...opts }))
  return {
    bd: {
      listAll: vi.fn(() => []),
      createAsync,
      createMany: vi.fn(async (beads: any[]) => {
        const created: any[] = []
        const failed: any[] = []
        for (const b of beads) {
          try {
            const bead = await createAsync(b)
            created.push(bead)
          } catch (err: any) {
            failed.push({ opts: b, error: err.message })
          }
        }
        return { created, failed }
      }),
      addDep: vi.fn()
    },
    post: vi.fn(),
    postActivity: vi.fn()
  } as any
}

describe('PlanLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProcesses.length = 0
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    vi.spyOn(cp, 'execSync').mockReturnValue(Buffer.from('/usr/local/bin/claude'))
    vi.spyOn(cp, 'spawn').mockImplementation(() => {
      const p = createProc()
      mockProcesses.push(p)
      return p as any
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('can be constructed without errors', () => {
    const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    expect(loop).toBeDefined()
    expect(loop.stopped).toBe(false)
  })

  it('creates log directory on construction', () => {
    new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    expect(fs.mkdirSync).toHaveBeenCalledWith('/store/logs', { recursive: true })
  })

  it('stop() sets stopped flag', () => {
    const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    loop.stop()
    expect(loop.stopped).toBe(true)
  })

  describe('run', () => {
    it('emits phase events in order: planning → encoding → done', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))

      const runPromise = loop.run('Build a REST API')

      // Simulate plan phase completion
      const planProc = mockProcesses[0]
      planProc.simulateStdout('# Plan\n## Architecture\nREST API with Express\n')
      planProc.simulateExit(0)

      // Wait for encoding phase to start
      await new Promise(r => setTimeout(r, 10))

      // Simulate encode phase completion with valid JSON
      const encodeProc = mockProcesses[1]
      encodeProc.simulateStdout('[{"id":"b1","title":"Setup Express","type":"epic","priority":1,"deps":[],"description":"Set up Express server with middleware","tags":[]}]')
      encodeProc.simulateExit(0)

      await runPromise
      expect(phases).toEqual(['planning', 'encoding', 'done'])
    })

    it('emits error when plan phase fails with non-zero exit', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())

      const errors: string[] = []
      loop.on('error', (e: string) => errors.push(e))

      const runPromise = loop.run('Build something')

      const proc = mockProcesses[0]
      proc.simulateStderr('Command not found')
      proc.simulateExit(1)

      await runPromise
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('Claude exited 1')
    })

    it('does not proceed to encoding when stopped after planning', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))

      const runPromise = loop.run('Build something')

      const proc = mockProcesses[0]
      proc.simulateStdout('plan output')
      loop.stop()
      proc.simulateExit(0)

      await runPromise
      expect(phases).not.toContain('encoding')
    })

    it('emits done with bead count on successful encoding', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode phase — 2 beads (valid titles >3, descriptions >10)
      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Setup server","type":"task","priority":1,"deps":[],"description":"Set up the server infrastructure","tags":[]},{"id":"b2","title":"Build API endpoints","type":"task","priority":2,"deps":["b1"],"description":"Build all REST API endpoints","tags":["api"]}]')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(doneCount).toBe(2)
      expect(coord.bd.createMany).toHaveBeenCalled()
      expect(coord.bd.addDep).toHaveBeenCalled()
    })

    it('handles invalid JSON in encode output after all retries', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode attempts — all produce no valid JSON (attempt 0 + 2 retries = 3 total)
      for (let i = 0; i < 3; i++) {
        mockProcesses[1 + i].simulateStdout('This is not JSON at all')
        mockProcesses[1 + i].simulateExit(0)
        await new Promise(r => setTimeout(r, 10))
      }

      await runPromise
      expect(doneCount).toBe(0)
    })

    it('reads AGENT.md and PROMPT.md for plan context when they exist', async () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('AGENT.md') || s.endsWith('PROMPT.md')
      })
      ;(fs.readFileSync as any).mockReturnValue('project context here')

      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      // Just fail it quickly
      mockProcesses[0].simulateExit(1)
      await runPromise

      // Verify spawn was called with -p flag containing the prompt
      const { spawn } = await import('child_process')
      expect(spawn).toHaveBeenCalled()
      const spawnCall = (spawn as any).mock.calls[0]
      const promptArg = spawnCall[1]![1] // args[1] is the prompt (after '-p')
      expect(promptArg).toContain('ULTRATHINK')
    })

    it('creates beads in order: epics → tasks → subtasks', async () => {
      const coord = makeCoordinator()
      const createOrder: string[] = []
      let counter = 0
      coord.bd.createMany.mockImplementation(async (beads: any[]) => {
        const created: any[] = []
        for (const b of beads) {
          createOrder.push(b.type)
          created.push({ id: `sb-${++counter}`, ...b })
        }
        return { created, failed: [] }
      })

      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const runPromise = loop.run('test')

      // Plan
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode — mixed types
      const beads = [
        { id: 'b1', title: 'Task Alpha', type: 'task', priority: 1, deps: ['b0'], description: 'Implement the alpha task logic', tags: [] },
        { id: 'b0', title: 'Epic grouping', type: 'epic', priority: 0, deps: [], description: 'Parent epic for the project', tags: [] },
        { id: 'b2', title: 'Sub detail', type: 'subtask', priority: 2, deps: ['b1'], description: 'Subtask for detail work here', tags: [] }
      ]
      mockProcesses[1].simulateStdout(JSON.stringify(beads))
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(createOrder).toEqual(['epic', 'task', 'subtask'])
    })

    it('posts activity when beads are created', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Build feature","type":"task","priority":1,"deps":[],"description":"Build the main feature module","tags":[]}]')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'planner',
        type: 'info',
        summary: expect.stringContaining('1 beads created')
      }))
    })

    it('logs partial failures from createMany and throws on high fail rate', async () => {
      const coord = makeCoordinator()
      coord.bd.createMany.mockImplementation(async (beads: any[]) => {
        const created: any[] = []
        const failed: any[] = []
        for (const b of beads) {
          if (b.title.includes('Fail')) {
            failed.push({ opts: b, error: 'bd create failed: quota exceeded' })
          } else {
            created.push({ id: `sb-ok`, ...b })
          }
        }
        return { created, failed }
      })

      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const logs: [string, string][] = []
      loop.on('log', (level: string, msg: string) => logs.push([level, msg]))
      const errors: string[] = []
      loop.on('error', (e: string) => errors.push(e))

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // 1 of 2 fails = 50% > 20% threshold
      const beads = [
        { id: 'b1', title: 'Good task', type: 'task', priority: 1, deps: [], description: 'A good description here', tags: [] },
        { id: 'b2', title: 'Fail task', type: 'task', priority: 1, deps: [], description: 'A fail description here', tags: [] },
      ]
      mockProcesses[1].simulateStdout(JSON.stringify(beads))
      mockProcesses[1].simulateExit(0)

      await runPromise

      const warnLogs = logs.filter(([level]) => level === 'WARN')
      expect(warnLogs.some(([, msg]) => msg.includes('Fail task') && msg.includes('quota exceeded'))).toBe(true)

      // Should emit error due to high failure rate
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('failure rate')
    })

    it('emits output events during plan phase', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const outputs: string[] = []
      loop.on('output', (s: string) => outputs.push(s))
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      // Emit output then exit with code 0 but produce output for plan phase
      mockProcesses[0].simulateStdout('chunk1')
      mockProcesses[0].simulateStdout('chunk2')
      mockProcesses[0].simulateExit(0)

      await new Promise(r => setTimeout(r, 10))

      // Encode phase — all retries produce no json
      for (let i = 0; i < 3; i++) {
        mockProcesses[1 + i].simulateStdout('no json')
        mockProcesses[1 + i].simulateExit(0)
        await new Promise(r => setTimeout(r, 10))
      }

      await runPromise
      expect(outputs).toContain('chunk1')
      expect(outputs).toContain('chunk2')
    })

    it('writes output to log file', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('log data')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // All retries produce no json
      for (let i = 0; i < 3; i++) {
        mockProcesses[1 + i].simulateStdout('no json')
        mockProcesses[1 + i].simulateExit(0)
        await new Promise(r => setTimeout(r, 10))
      }
      await runPromise

      expect(fs.appendFileSync).toHaveBeenCalled()
    })

    it('routes --model per phase: claudeModelThink for plan, claudeModelExecute for encode', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      const runPromise = loop.run('test')

      // Plan phase spawned
      expect(cp.spawn).toHaveBeenCalledTimes(1)
      const planArgs = (cp.spawn as any).mock.calls[0][1] as string[]
      expect(planArgs).toContain('--model')
      expect(planArgs[planArgs.indexOf('--model') + 1]).toBe('sonnet')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode phase spawned
      expect(cp.spawn).toHaveBeenCalledTimes(2)
      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(encodeArgs).toContain('--model')
      expect(encodeArgs[encodeArgs.indexOf('--model') + 1]).toBe('opus')

      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Build feature","type":"task","priority":1,"deps":[],"description":"Build the main feature module","tags":[]}]')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })

    it('uses custom model values from config', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig({ claudeModelThink: 'haiku', claudeModelExecute: 'sonnet' }), coord)

      const runPromise = loop.run('test')

      const planArgs = (cp.spawn as any).mock.calls[0][1] as string[]
      expect(planArgs[planArgs.indexOf('--model') + 1]).toBe('haiku')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(encodeArgs[encodeArgs.indexOf('--model') + 1]).toBe('sonnet')

      mockProcesses[1].simulateStdout('[]')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })

    it('retries encode on validation failure and succeeds on second attempt', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // First encode attempt — short title triggers validation error
      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Ab","type":"task","priority":1,"deps":[],"description":"short","tags":[]}]')
      mockProcesses[1].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Second encode attempt — valid beads
      mockProcesses[2].simulateStdout('[{"id":"b1","title":"Build feature","type":"task","priority":1,"deps":[],"description":"Build the main feature module","tags":[]}]')
      mockProcesses[2].simulateExit(0)

      await runPromise
      expect(doneCount).toBe(1)
      // Should have spawned 3 processes: plan + 2 encode attempts
      expect(cp.spawn).toHaveBeenCalledTimes(3)
    })

    it('emits error when failure rate exceeds 20%', async () => {
      const coord = makeCoordinator()
      // Make all createMany calls fail
      coord.bd.createMany.mockImplementation(async (beads: any[]) => ({
        created: [],
        failed: beads.map((b: any) => ({ opts: b, error: 'bd error' }))
      }))

      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const errors: string[] = []
      loop.on('error', (e: string) => errors.push(e))

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Build feature","type":"task","priority":1,"deps":[],"description":"Build the main feature module","tags":[]}]')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('failure rate')
    })

    it('retry prompt includes validation errors', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // First encode — invalid beads
      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Ab","type":"task","priority":1,"deps":[],"description":"x","tags":[]}]')
      mockProcesses[1].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Check the retry prompt contains error feedback
      expect(cp.spawn).toHaveBeenCalledTimes(3) // plan + encode + retry
      const retryArgs = (cp.spawn as any).mock.calls[2][1] as string[]
      const retryPrompt = retryArgs[1] // -p <prompt>
      expect(retryPrompt).toContain('PREVIOUS ATTEMPT FAILED VALIDATION')
      expect(retryPrompt).toContain('Title too short')
      expect(retryPrompt).toContain('Description too short')

      // Complete the retry
      mockProcesses[2].simulateStdout('[{"id":"b1","title":"Build feature","type":"task","priority":1,"deps":[],"description":"Build the main feature module","tags":[]}]')
      mockProcesses[2].simulateExit(0)
      await runPromise
    })

    it('retries twice on validation failure then succeeds on third (final) attempt', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Attempt 0 — invalid (short title + short desc)
      mockProcesses[1].simulateStdout('[{"id":"b1","title":"Ab","type":"task","priority":1,"deps":[],"description":"x","tags":[]}]')
      mockProcesses[1].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Attempt 1 — still invalid (short title)
      mockProcesses[2].simulateStdout('[{"id":"b1","title":"No","type":"task","priority":1,"deps":[],"description":"short desc","tags":[]}]')
      mockProcesses[2].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Attempt 2 (final) — valid
      mockProcesses[3].simulateStdout('[{"id":"b1","title":"Build the feature","type":"task","priority":1,"deps":[],"description":"Implement the feature module fully","tags":[]}]')
      mockProcesses[3].simulateExit(0)

      await runPromise
      expect(doneCount).toBe(1)
      // plan + 3 encode attempts
      expect(cp.spawn).toHaveBeenCalledTimes(4)
    })

    it('proceeds despite validation errors after exhausting all retries', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)

      const logs: [string, string][] = []
      loop.on('log', (level: string, msg: string) => logs.push([level, msg]))
      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // All 3 attempts produce validation-failing beads (short desc)
      for (let i = 0; i < 3; i++) {
        mockProcesses[1 + i].simulateStdout('[{"id":"b1","title":"Valid title","type":"task","priority":1,"deps":[],"description":"bad","tags":[]}]')
        mockProcesses[1 + i].simulateExit(0)
        await new Promise(r => setTimeout(r, 10))
      }

      await runPromise
      // Should proceed and create the bead despite validation errors
      expect(coord.bd.createMany).toHaveBeenCalled()
      expect(doneCount).toBe(1)

      // Should log the "Proceeding despite" warning
      const proceedingLog = logs.find(([level, msg]) => level === 'WARN' && msg.includes('Proceeding despite'))
      expect(proceedingLog).toBeDefined()
    })

    it('emits error when all retries fail validation and creation also fails', async () => {
      const coord = makeCoordinator()
      coord.bd.createMany.mockImplementation(async (beads: any[]) => ({
        created: [],
        failed: beads.map((b: any) => ({ opts: b, error: 'bd error' }))
      }))

      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const errors: string[] = []
      loop.on('error', (e: string) => errors.push(e))

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // All 3 attempts produce validation-failing beads
      for (let i = 0; i < 3; i++) {
        mockProcesses[1 + i].simulateStdout('[{"id":"b1","title":"Valid title","type":"task","priority":1,"deps":[],"description":"bad","tags":[]}]')
        mockProcesses[1 + i].simulateExit(0)
        await new Promise(r => setTimeout(r, 10))
      }

      await runPromise
      // Proceeded despite validation errors, but creation failed → high failure rate → error
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('failure rate')
    })

    it('resolves with raw output even on non-zero exit if output exists', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      // Plan phase produces output but exits with code 1
      // _runClaude resolves (not rejects) when there's output even on non-zero exit
      mockProcesses[0].simulateStdout('partial plan output')
      mockProcesses[0].simulateExit(1)

      await new Promise(r => setTimeout(r, 10))

      // Should still proceed to encoding since output was produced
      // All retries produce no json
      for (let i = 0; i < 3; i++) {
        if (mockProcesses[1 + i]) {
          mockProcesses[1 + i].simulateStdout('no json')
          mockProcesses[1 + i].simulateExit(0)
          await new Promise(r => setTimeout(r, 10))
        }
      }

      await runPromise
      // The plan had output, so it should have resolved (not rejected)
      expect(phases).toContain('planning')
      expect(phases).toContain('encoding')
    })
  })

  describe('_validateCandidates', () => {
    it('returns no errors for valid candidates', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: [], type: 'task' },
        { id: 'b2', title: 'Another valid', description: 'Another valid desc here', deps: ['b1'], type: 'task' }
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors).toEqual([])
    })

    it('flags titles with 3 or fewer chars', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Ab', description: 'A valid description here', deps: [], type: 'task' },
        { id: 'b2', title: 'OK!', description: 'A valid description here', deps: [], type: 'task' }, // exactly 3 chars
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(2)
      expect(errors[0].errors[0]).toContain('Title too short')
      expect(errors[1].errors[0]).toContain('Title too short')
    })

    it('flags descriptions with 10 or fewer chars', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'short', deps: [], type: 'task' },
        { id: 'b2', title: 'Another ok', description: '1234567890', deps: [], type: 'task' }, // exactly 10
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(2)
      expect(errors[0].errors[0]).toContain('Description too short')
    })

    it('flags unresolvable dependencies', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: ['nonexistent'], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(1)
      expect(errors[0].errors[0]).toContain('Unresolvable dependency')
      expect(errors[0].errors[0]).toContain('nonexistent')
    })

    it('resolves deps against batch IDs', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: [], type: 'task' },
        { id: 'b2', title: 'Another task', description: 'Depends on b1 in batch', deps: ['b1'], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors).toEqual([])
    })

    it('resolves deps against live open beads', () => {
      const coord = makeCoordinator()
      coord.bd.listAll.mockReturnValue([
        { id: 'live-1', status: 'ready', title: 'Live bead' }
      ])
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: ['live-1'], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors).toEqual([])
    })

    it('flags duplicates of closed beads', () => {
      const coord = makeCoordinator()
      coord.bd.listAll.mockReturnValue([
        { id: 'old-1', status: 'done', title: 'Already done task' }
      ])
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const candidates = [
        { id: 'b1', title: 'Already done task', description: 'A valid description here', deps: [], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(1)
      expect(errors[0].errors[0]).toContain('Duplicate of closed bead')
    })

    it('flags batch exceeding hard cap of 50', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = Array.from({ length: 51 }, (_, i) => ({
        id: `b${i}`, title: `Task number ${i}`, description: 'A valid description here', deps: [], type: 'task'
      }))
      const errors = loop._validateCandidates(candidates)
      const batchError = errors.find(e => e.id === '_batch_' && e.errors[0].includes('hard cap'))
      expect(batchError).toBeDefined()
    })

    it('warns on batch larger than 20 (soft ratio)', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = Array.from({ length: 21 }, (_, i) => ({
        id: `b${i}`, title: `Task number ${i}`, description: 'A valid description here', deps: [], type: 'task'
      }))
      const errors = loop._validateCandidates(candidates)
      const softWarning = errors.find(e => e.id === '_batch_' && e.errors[0].includes('Large batch'))
      expect(softWarning).toBeDefined()
    })

    it('handles missing/null title and description gracefully', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', deps: [], type: 'task' }, // no title, no description
      ]
      const errors = loop._validateCandidates(candidates as any)
      expect(errors.length).toBe(1)
      expect(errors[0].errors.some(e => e.includes('Title too short'))).toBe(true)
      expect(errors[0].errors.some(e => e.includes('Description too short'))).toBe(true)
    })

    it('duplicate detection is case-insensitive', () => {
      const coord = makeCoordinator()
      coord.bd.listAll.mockReturnValue([
        { id: 'old-1', status: 'done', title: 'Setup Database' }
      ])
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const candidates = [
        { id: 'b1', title: 'setup database', description: 'A valid description here', deps: [], type: 'task' },
        { id: 'b2', title: 'SETUP DATABASE', description: 'Another valid description', deps: [], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(2)
      expect(errors[0].errors[0]).toContain('Duplicate of closed bead')
      expect(errors[1].errors[0]).toContain('Duplicate of closed bead')
    })

    it('resolves deps against both batch IDs and live open beads together', () => {
      const coord = makeCoordinator()
      coord.bd.listAll.mockReturnValue([
        { id: 'live-1', status: 'claimed', title: 'Active bead' },
        { id: 'live-2', status: 'done', title: 'Closed bead' }
      ])
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: ['live-1'], type: 'task' }, // dep on live open
        { id: 'b2', title: 'Another task', description: 'Depends on batch sibling', deps: ['b1'], type: 'task' }, // dep on batch
        { id: 'b3', title: 'Bad dep task', description: 'Depends on closed bead ID', deps: ['live-2'], type: 'task' }, // dep on closed (not open)
      ]
      const errors = loop._validateCandidates(candidates)
      // Only b3 should have an error — live-2 is closed, so not in liveOpenIds
      expect(errors.length).toBe(1)
      expect(errors[0].id).toBe('b3')
      expect(errors[0].errors[0]).toContain('Unresolvable dependency')
    })

    it('does not error when listAll throws', () => {
      const coord = makeCoordinator()
      coord.bd.listAll.mockImplementation(() => { throw new Error('bd not found') })
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      const candidates = [
        { id: 'b1', title: 'Valid title', description: 'A valid description here', deps: [], type: 'task' },
      ]
      // Should not throw — the try/catch ignores listAll errors
      const errors = loop._validateCandidates(candidates)
      expect(errors).toEqual([])
    })

    it('accumulates multiple errors per bead', () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const candidates = [
        { id: 'b1', title: 'Ab', description: 'x', deps: ['nope'], type: 'task' },
      ]
      const errors = loop._validateCandidates(candidates)
      expect(errors.length).toBe(1)
      expect(errors[0].errors.length).toBe(3) // title, desc, dep
    })
  })
})
