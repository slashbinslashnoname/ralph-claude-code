import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
import { EventEmitter } from 'events'
import { PlanLoop } from './PlanLoop'
import { RalphConfig } from '../types'

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
    const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
    expect(loop).toBeDefined()
    expect(loop.stopped).toBe(false)
  })

  it('creates log directory on construction', () => {
    new PlanLoop('/project', makeConfig(), makeCoordinator())
    expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot/logs', { recursive: true })
  })

  it('stop() sets stopped flag', () => {
    const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
    loop.stop()
    expect(loop.stopped).toBe(true)
  })

  describe('run', () => {
    it('emits phase events in order: planning → encoding → done', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop('/project', makeConfig(), coord)
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
      encodeProc.simulateStdout('[{"id":"b1","title":"Setup Express","type":"epic","priority":1,"deps":[],"description":"setup","tags":[]}]')
      encodeProc.simulateExit(0)

      await runPromise
      expect(phases).toEqual(['planning', 'encoding', 'done'])
    })

    it('emits error when plan phase fails with non-zero exit', async () => {
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())

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
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
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
      const loop = new PlanLoop('/project', makeConfig(), coord)

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode phase — 2 beads
      mockProcesses[1].simulateStdout('[{"id":"b1","title":"A","type":"task","priority":1,"deps":[],"description":"a","tags":[]},{"id":"b2","title":"B","type":"task","priority":2,"deps":["b1"],"description":"b","tags":["api"]}]')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(doneCount).toBe(2)
      expect(coord.bd.createMany).toHaveBeenCalled()
      expect(coord.bd.addDep).toHaveBeenCalled()
    })

    it('handles invalid JSON in encode output', async () => {
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())

      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })

      const runPromise = loop.run('test')

      // Plan phase
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode phase — no valid JSON array
      mockProcesses[1].simulateStdout('This is not JSON at all')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(doneCount).toBe(0)
    })

    it('reads AGENT.md and PROMPT.md for plan context when they exist', async () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('AGENT.md') || s.endsWith('PROMPT.md')
      })
      ;(fs.readFileSync as any).mockReturnValue('project context here')

      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
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

      const loop = new PlanLoop('/project', makeConfig(), coord)
      const runPromise = loop.run('test')

      // Plan
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      // Encode — mixed types
      const beads = [
        { id: 'b1', title: 'Task A', type: 'task', priority: 1, deps: ['b0'], description: '', tags: [] },
        { id: 'b0', title: 'Epic', type: 'epic', priority: 0, deps: [], description: '', tags: [] },
        { id: 'b2', title: 'Sub', type: 'subtask', priority: 2, deps: ['b1'], description: '', tags: [] }
      ]
      mockProcesses[1].simulateStdout(JSON.stringify(beads))
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(createOrder).toEqual(['epic', 'task', 'subtask'])
    })

    it('posts activity when beads are created', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop('/project', makeConfig(), coord)

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      mockProcesses[1].simulateStdout('[{"id":"b1","title":"T","type":"task","priority":1,"deps":[],"description":"d","tags":[]}]')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'planner',
        type: 'info',
        summary: expect.stringContaining('1 beads created')
      }))
    })

    it('logs partial failures from createMany', async () => {
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

      const loop = new PlanLoop('/project', makeConfig(), coord)
      const logs: [string, string][] = []
      loop.on('log', (level: string, msg: string) => logs.push([level, msg]))

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      const beads = [
        { id: 'b1', title: 'Good task', type: 'task', priority: 1, deps: [], description: '', tags: [] },
        { id: 'b2', title: 'Fail task', type: 'task', priority: 1, deps: [], description: '', tags: [] },
      ]
      mockProcesses[1].simulateStdout(JSON.stringify(beads))
      mockProcesses[1].simulateExit(0)

      await runPromise

      const warnLogs = logs.filter(([level]) => level === 'WARN')
      expect(warnLogs.length).toBe(1)
      expect(warnLogs[0][1]).toContain('Fail task')
      expect(warnLogs[0][1]).toContain('quota exceeded')

      // Activity should report 1 bead created (not 2)
      expect(coord.postActivity).toHaveBeenCalledWith(expect.objectContaining({
        summary: expect.stringContaining('1 beads created')
      }))
    })

    it('emits output events during plan phase', async () => {
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
      const outputs: string[] = []
      loop.on('output', (s: string) => outputs.push(s))
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      // Emit output then exit with code 0 but produce output for plan phase
      mockProcesses[0].simulateStdout('chunk1')
      mockProcesses[0].simulateStdout('chunk2')
      mockProcesses[0].simulateExit(0)

      await new Promise(r => setTimeout(r, 10))

      // Encode phase — just complete it
      mockProcesses[1].simulateStdout('no json')
      mockProcesses[1].simulateExit(0)

      await runPromise
      expect(outputs).toContain('chunk1')
      expect(outputs).toContain('chunk2')
    })

    it('writes output to log file', async () => {
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
      loop.on('error', () => {}) // prevent unhandled error throw

      const runPromise = loop.run('test')

      mockProcesses[0].simulateStdout('log data')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))

      mockProcesses[1].simulateStdout('no json')
      mockProcesses[1].simulateExit(0)
      await runPromise

      expect(fs.appendFileSync).toHaveBeenCalled()
    })

    it('routes --model per phase: claudeModelThink for plan, claudeModelExecute for encode', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop('/project', makeConfig(), coord)

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

      mockProcesses[1].simulateStdout('[{"id":"b1","title":"T","type":"task","priority":1,"deps":[],"description":"d","tags":[]}]')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })

    it('uses custom model values from config', async () => {
      const coord = makeCoordinator()
      const loop = new PlanLoop('/project', makeConfig({ claudeModelThink: 'haiku', claudeModelExecute: 'sonnet' }), coord)

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

    it('resolves with raw output even on non-zero exit if output exists', async () => {
      const loop = new PlanLoop('/project', makeConfig(), makeCoordinator())
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
      if (mockProcesses[1]) {
        mockProcesses[1].simulateStdout('no json')
        mockProcesses[1].simulateExit(0)
      }

      await runPromise
      // The plan had output, so it should have resolved (not rejected)
      expect(phases).toContain('planning')
      expect(phases).toContain('encoding')
    })
  })
})
