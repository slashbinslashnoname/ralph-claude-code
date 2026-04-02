import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
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
    beadsCwd: '/project',
    agentMd: '/store/config/AGENT.md',
    promptMd: '/store/config/PROMPT.md',
    ...overrides
  }
}

function makeCoordinator() {
  return {
    bd: {
      listAll: vi.fn(() => []),
      ensureDolt: vi.fn(async () => {}),
    },
    post: vi.fn(),
    postActivity: vi.fn()
  } as any
}

async function runThroughApproval(loop: PlanLoop, planOutput = 'plan') {
  await new Promise(r => setTimeout(r, 0))
  mockProcesses[0].simulateStdout(planOutput)
  mockProcesses[0].simulateExit(0)
  await new Promise(r => setTimeout(r, 10))
  loop.approvePlan()
  await new Promise(r => setTimeout(r, 10))
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
    vi.spyOn(cp, 'execFile').mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      if (typeof cb === 'function') cb(null, '', '')
      return {} as any
    })
    vi.spyOn(cp, 'spawn').mockImplementation(() => {
      const p = createProc()
      mockProcesses.push(p)
      return p as any
    })
  })

  afterEach(() => { vi.restoreAllMocks() })

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
    it('emits phase events in order: planning → review → encoding → done', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))
      const runPromise = loop.run('Build a REST API')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStdout('# Plan\n## Architecture\nREST API\n')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))
      loop.approvePlan()
      await new Promise(r => setTimeout(r, 10))
      mockProcesses[1].simulateStdout('Created beads')
      mockProcesses[1].simulateExit(0)
      await runPromise
      expect(phases).toEqual(['planning', 'review', 'encoding', 'done'])
    })

    it('emits error when plan phase fails', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const errors: string[] = []
      loop.on('error', (e: string) => errors.push(e))
      const runPromise = loop.run('Build something')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStderr('Command not found')
      mockProcesses[0].simulateExit(1)
      await runPromise
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('Claude exited 1')
    })

    it('does not proceed to encoding when stopped after planning', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))
      const runPromise = loop.run('Build something')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStdout('plan output')
      loop.stop()
      mockProcesses[0].simulateExit(0)
      await runPromise
      expect(phases).not.toContain('encoding')
    })

    it('does not proceed when plan is rejected', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const phases: string[] = []
      loop.on('phase', (p: string) => phases.push(p))
      const runPromise = loop.run('Build something')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))
      loop.rejectPlan()
      await runPromise
      expect(phases).toContain('review')
      expect(phases).not.toContain('encoding')
      expect(phases).toContain('done')
    })

    it('counts beads created by Claude via bd CLI', async () => {
      const coord = makeCoordinator()
      let callCount = 0
      coord.bd.listAll.mockImplementation(() => {
        callCount++
        if (callCount === 1) return [] // before count
        return [{ id: '1' }, { id: '2' }, { id: '3' }] // after count
      })
      const loop = new PlanLoop(makePaths(), makeConfig(), coord)
      let doneCount: number | undefined
      loop.on('done', (n: number) => { doneCount = n })
      const runPromise = loop.run('test')
      await runThroughApproval(loop)
      mockProcesses[1].simulateStdout('bd create output')
      mockProcesses[1].simulateExit(0)
      await runPromise
      expect(doneCount).toBe(3)
    })

    it('routes --model per phase', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const runPromise = loop.run('test')
      await new Promise(r => setTimeout(r, 0))
      const planArgs = (cp.spawn as any).mock.calls[0][1] as string[]
      expect(planArgs[planArgs.indexOf('--model') + 1]).toBe('sonnet')
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))
      loop.approvePlan()
      await new Promise(r => setTimeout(r, 10))
      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(encodeArgs[encodeArgs.indexOf('--model') + 1]).toBe('opus')
      mockProcesses[1].simulateStdout('done')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })

    it('encode prompt includes bd CLI references', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const runPromise = loop.run('test')
      await runThroughApproval(loop)
      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      const prompt = encodeArgs[1]
      expect(prompt).toContain('bd create')
      expect(prompt).toContain('bd dep add')
      expect(prompt).toContain('fix-later')
      mockProcesses[1].simulateStdout('done')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })

    it('encode prompt tells Claude to check existing beads via bd list', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const runPromise = loop.run('test')
      await runThroughApproval(loop)
      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(encodeArgs[1]).toContain('bd list --json')
      mockProcesses[1].simulateStdout('done')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })
  })

  describe('human-in-the-loop', () => {
    it('pendingApproval is true while waiting', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const runPromise = loop.run('test')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStdout('plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))
      expect(loop.pendingApproval).toBe(true)
      expect(loop.pendingPlanMarkdown).toBe('plan')
      loop.rejectPlan()
      await runPromise
      expect(loop.pendingApproval).toBe(false)
    })

    it('approvePlan with modified plan uses modified version', async () => {
      const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
      const runPromise = loop.run('test')
      await new Promise(r => setTimeout(r, 0))
      mockProcesses[0].simulateStdout('original plan')
      mockProcesses[0].simulateExit(0)
      await new Promise(r => setTimeout(r, 10))
      loop.approvePlan('modified plan')
      await new Promise(r => setTimeout(r, 10))
      const encodeArgs = (cp.spawn as any).mock.calls[1][1] as string[]
      expect(encodeArgs[1]).toContain('modified plan')
      mockProcesses[1].simulateStdout('done')
      mockProcesses[1].simulateExit(0)
      await runPromise
    })
  })
})
