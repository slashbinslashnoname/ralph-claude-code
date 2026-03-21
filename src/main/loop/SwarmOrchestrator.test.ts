import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'


import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SwarmOrchestrator } from './SwarmOrchestrator'

/**
 * These tests exercise SwarmOrchestrator.shutdown() by creating a real
 * orchestrator against a temp directory. Workers won't actually spawn Claude
 * (they'll fail immediately because there's no valid command), but the
 * shutdown mechanics — flag gating, event emission, timeout — are testable.
 */

let tmpDir: string
let orch: SwarmOrchestrator

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
  const slashbotDir = path.join(dir, '.slashbot')
  fs.mkdirSync(path.join(slashbotDir, 'logs'), { recursive: true })
  // Minimal .slashbotrc so loadConfig doesn't throw
  fs.writeFileSync(path.join(dir, '.slashbotrc'), JSON.stringify({
    claudeCodeCmd: 'false', // will fail immediately
    claudeTimeoutMinutes: 1,
    claudeOutputFormat: 'text',
    allowedTools: '',
    maxAgents: 2,
    continueSession: false,
  }))
  // beads dir for BdClient
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  // Slashbot files required by HealthCheck
  fs.writeFileSync(path.join(slashbotDir, 'PROMPT.md'), '# Prompt')
  fs.writeFileSync(path.join(slashbotDir, 'AGENT.md'), '# Agent')
  return dir
}

describe('SwarmOrchestrator.shutdown()', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    // Clean up timers
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits shutdown-complete on idle swarm', async () => {
    let emitted = false
    orch.on('shutdown-complete', () => { emitted = true })
    await orch.shutdown()
    expect(emitted).toBe(true)
  })

  it('resets shuttingDown flag after completion', async () => {
    await orch.shutdown()
    expect(orch.isShuttingDown()).toBe(false)
  })

  it('is idempotent — second call returns immediately', async () => {
    // Manually set shuttingDown to simulate concurrent call
    const p1 = orch.shutdown()
    const p2 = orch.shutdown() // should be a no-op
    await Promise.all([p1, p2])
    // If we got here without hanging, the test passes
    expect(true).toBe(true)
  })

  it('clears plan queue and currentPlanRequest during shutdown', async () => {
    ;(orch as any).planning = true
    ;(orch as any).currentPlanRequest = 'Build something'
    orch.on('log', () => {}) // swallow log events
    await orch.shutdown()
    expect(orch.getPlanQueue()).toEqual([])
    expect(orch.isPlanning()).toBe(false)
    expect(orch.getPlanRequest()).toBeNull()
  })

  it('blocks startWorkers during shutdown', async () => {
    // Inject a hanging promise so shutdown stays in-flight
    const neverResolve = new Promise<void>(() => {})
    ;(orch as any).workerLoopPromises.set('agent-fake', neverResolve)

    const logs: string[] = []
    orch.on('log', (_level: string, msg: string) => logs.push(msg))

    // Start shutdown (will block on the fake promise until timeout)
    const shutdownPromise = orch.shutdown(200)

    // shuttingDown is true synchronously after the call
    expect(orch.isShuttingDown()).toBe(true)

    // Attempt to start workers during shutdown — should be rejected
    orch.startWorkers(1)
    expect(
      logs.some(m => m.includes('Cannot start workers during shutdown'))
    ).toBe(true)

    await shutdownPromise
    expect(orch.isShuttingDown()).toBe(false)
  })

  it('handles shutdown with timeout when workers hang', async () => {
    // Simulate a never-resolving worker loop promise
    const neverResolve = new Promise<void>(() => {})
    ;(orch as any).workerLoopPromises.set('agent-fake', neverResolve)

    const start = Date.now()
    let emitted = false
    orch.on('shutdown-complete', () => { emitted = true })

    await orch.shutdown(200) // 200ms timeout

    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(1000)
    expect(emitted).toBe(true)
  })

  it('cleans up workers map after shutdown', async () => {
    // Inject a fake worker entry
    ;(orch as any).workers.set('agent-fake', { stop: () => {} })
    ;(orch as any).workerLoopPromises.set('agent-fake', Promise.resolve())

    await orch.shutdown()

    expect(orch.workerCount()).toBe(0)
    expect((orch as any).workerLoopPromises.size).toBe(0)
  })

  it('emits shutdown-complete exactly once', async () => {
    let count = 0
    orch.on('shutdown-complete', () => { count++ })
    await orch.shutdown()
    expect(count).toBe(1)
  })
})

describe('SwarmOrchestrator.startWorkers() health check', () => {
  afterEach(() => {
    if (tmpDir) {
      try { orch?.stopAll() } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws when required Slashbot files are missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
    const slashbotDir = path.join(tmpDir, '.slashbot')
    fs.mkdirSync(path.join(slashbotDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), JSON.stringify({
      claudeCodeCmd: 'false',
      claudeTimeoutMinutes: 1,
      claudeOutputFormat: 'text',
      allowedTools: '',
      maxAgents: 2,
      continueSession: false,
    }))
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true })
    // Deliberately omit PROMPT.md and AGENT.md

    orch = new SwarmOrchestrator(tmpDir)
    expect(() => orch.startWorkers(1)).toThrow('Health check failed')
  })

  it('throws when .beads directory is missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
    const slashbotDir = path.join(tmpDir, '.slashbot')
    fs.mkdirSync(path.join(slashbotDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(slashbotDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(slashbotDir, 'AGENT.md'), '# Agent')
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), JSON.stringify({
      claudeCodeCmd: 'false',
      claudeTimeoutMinutes: 1,
      claudeOutputFormat: 'text',
      allowedTools: '',
      maxAgents: 2,
      continueSession: false,
    }))
    // Deliberately omit .beads

    orch = new SwarmOrchestrator(tmpDir)
    expect(() => orch.startWorkers(1)).toThrow('Health check failed')
  })
})

describe('SwarmOrchestrator — plan queue management', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getPlanQueue returns a copy', () => {
    // Directly manipulate queue to avoid triggering _drainQueue
    ;(orch as any).planQueue = [{ id: 'plan-1', request: 'A' }]
    const q1 = orch.getPlanQueue()
    const q2 = orch.getPlanQueue()
    expect(q1).toEqual([{ id: 'plan-1', request: 'A' }])
    expect(q1).not.toBe(q2)
  })

  it('removeQueuedPlan removes an existing plan', () => {
    ;(orch as any).planQueue = [
      { id: 'plan-1', request: 'A' },
      { id: 'plan-2', request: 'B' },
    ]
    const removed = orch.removeQueuedPlan('plan-2')
    expect(removed).toBe(true)
    expect(orch.getPlanQueue().length).toBe(1)
  })

  it('removeQueuedPlan returns false for non-existent id', () => {
    expect(orch.removeQueuedPlan('plan-nonexistent')).toBe(false)
  })

  it('removeQueuedPlan emits planQueue event', () => {
    ;(orch as any).planQueue = [{ id: 'plan-1', request: 'A' }]
    const queues: any[] = []
    orch.on('planQueue', (q: any) => queues.push(q))
    orch.removeQueuedPlan('plan-1')
    expect(queues.length).toBe(1)
    expect(queues[0]).toEqual([])
  })
})

describe('SwarmOrchestrator — stopWorkers and stopAll', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stopWorkers emits stopped event', () => {
    let stopped = false
    orch.on('stopped', () => { stopped = true })
    orch.stopWorkers()
    expect(stopped).toBe(true)
  })

  it('stopWorkers deregisters all agents from coordinator', () => {
    // Register a fake agent
    orch.coordinator.registerAgent({
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })
    expect(orch.coordinator.getAgents().length).toBe(1)
    orch.stopWorkers()
    expect(orch.coordinator.getAgents().length).toBe(0)
  })

  it('stopAll clears plan queue and currentPlanRequest', () => {
    // Directly set queue and planning state to avoid triggering async _drainQueue
    ;(orch as any).planQueue = [{ id: 'plan-1', request: 'A' }]
    ;(orch as any).planning = true
    ;(orch as any).currentPlanRequest = 'Build a widget'
    orch.stopAll()
    expect(orch.getPlanQueue()).toEqual([])
    expect(orch.isPlanning()).toBe(false)
    expect(orch.getPlanRequest()).toBeNull()
  })

  it('stopAll emits stopped event', () => {
    let stopped = false
    orch.on('stopped', () => { stopped = true })
    orch.stopAll()
    expect(stopped).toBe(true)
  })

  it('gracefulStopWorkers sets stoppingGracefully flag', () => {
    orch.gracefulStopWorkers()
    expect(orch.stoppingGracefully).toBe(true)
  })
})

describe('SwarmOrchestrator — pause/resume workers', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('pauseWorker returns false for unknown agent', () => {
    expect(orch.pauseWorker('agent-99')).toBe(false)
  })

  it('resumeWorker returns false for unknown agent', () => {
    expect(orch.resumeWorker('agent-99')).toBe(false)
  })

  it('pauseWorker/resumeWorker returns true for existing worker', () => {
    const fakeWorker = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('agent-0', fakeWorker)
    expect(orch.pauseWorker('agent-0')).toBe(true)
    expect(fakeWorker.pause).toHaveBeenCalled()
    expect(orch.resumeWorker('agent-0')).toBe(true)
    expect(fakeWorker.resume).toHaveBeenCalled()
  })

  it('pauseAllWorkers calls pause on all workers', () => {
    const w0 = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    const w1 = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('agent-0', w0)
    ;(orch as any).workers.set('agent-1', w1)
    orch.pauseAllWorkers()
    expect(w0.pause).toHaveBeenCalled()
    expect(w1.pause).toHaveBeenCalled()
  })

  it('resumeAllWorkers calls resume on all workers', () => {
    const w0 = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    const w1 = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('agent-0', w0)
    ;(orch as any).workers.set('agent-1', w1)
    orch.resumeAllWorkers()
    expect(w0.resume).toHaveBeenCalled()
    expect(w1.resume).toHaveBeenCalled()
  })

  it('pauseWorker broadcasts agents', () => {
    const fakeWorker = { pause: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('agent-0', fakeWorker)
    const broadcasts: any[] = []
    orch.on('agents', (a: any) => broadcasts.push(a))
    orch.pauseWorker('agent-0')
    expect(broadcasts.length).toBe(1)
  })
})

describe('SwarmOrchestrator — status queries', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('workerCount returns 0 initially', () => {
    expect(orch.workerCount()).toBe(0)
  })

  it('isPlanning returns false initially', () => {
    expect(orch.isPlanning()).toBe(false)
  })

  it('getPlanRequest returns null initially', () => {
    expect(orch.getPlanRequest()).toBeNull()
  })

  it('isShuttingDown returns false initially', () => {
    expect(orch.isShuttingDown()).toBe(false)
  })

  it('getAgents returns empty array initially', () => {
    expect(orch.getAgents()).toEqual([])
  })

  it('getActivity returns empty array initially', () => {
    expect(orch.getActivity()).toEqual([])
  })

  it('sessionStartedAt is null initially', () => {
    expect(orch.sessionStartedAt).toBeNull()
  })
})

describe('SwarmOrchestrator — agent output buffer', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getAgentOutput returns empty string for unknown agent', () => {
    expect(orch.getAgentOutput('agent-99')).toBe('')
  })

  it('getAgentOutput reads from disk log file', () => {
    const logDir = path.join(tmpDir, '.slashbot', 'logs')
    fs.writeFileSync(path.join(logDir, 'agent-0.log'), 'hello world')
    expect(orch.getAgentOutput('agent-0')).toBe('hello world')
  })

  it('_bufferOutput caps at 50KB', () => {
    // Access private method for testing
    const buf = (orch as any)
    const bigChunk = 'x'.repeat(60_000)
    buf._bufferOutput('agent-0', bigChunk)
    const output = orch.getAgentOutput('agent-0')
    expect(output.length).toBe(50_000)
  })

  it('_bufferOutput also persists to disk', () => {
    const buf = (orch as any)
    buf._bufferOutput('agent-test', 'disk-check')
    const logFile = path.join(tmpDir, '.slashbot', 'logs', 'agent-test.log')
    expect(fs.existsSync(logFile)).toBe(true)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('disk-check')
  })
})

describe('SwarmOrchestrator — logging', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('_log writes to slashbot.log on disk', () => {
    ;(orch as any)._log('INFO', 'test message')
    const logFile = path.join(tmpDir, '.slashbot', 'logs', 'slashbot.log')
    const content = fs.readFileSync(logFile, 'utf8')
    expect(content).toContain('test message')
    expect(content).toContain('[INFO]')
  })

  it('_log emits log event with level, message, and optional agentId', () => {
    const logs: any[] = []
    orch.on('log', (...args: any[]) => logs.push(args))
    ;(orch as any)._log('WARN', 'warning msg', 'agent-0')
    expect(logs.length).toBe(1)
    expect(logs[0]).toEqual(['WARN', 'warning msg', 'agent-0'])
  })
})

describe('SwarmOrchestrator — build monitor integration', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getBuildMonitorStatus returns disabled when no monitor configured', () => {
    const status = orch.getBuildMonitorStatus()
    expect(status).toEqual({ enabled: false, running: false })
  })

  it('toggleBuildMonitor(true) does nothing without buildMonitorCmd', () => {
    const logs: string[] = []
    orch.on('log', (_level: string, msg: string) => logs.push(msg))
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
    expect(logs.some(m => m.includes('no buildMonitorCmd'))).toBe(true)
  })

  it('toggleBuildMonitor(true) creates and starts monitor when cmd configured', () => {
    // Write config with buildMonitorCmd in KEY=VALUE format
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    const status = orch.getBuildMonitorStatus()
    expect(status.enabled).toBe(true)
    expect(status.running).toBe(true)
  })

  it('toggleBuildMonitor(false) stops the monitor', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    orch.toggleBuildMonitor(false)
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('toggleBuildMonitor(true) is idempotent when already running', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    const monitor1 = (orch as any).buildMonitor
    orch.toggleBuildMonitor(true) // should be no-op
    const monitor2 = (orch as any).buildMonitor
    expect(monitor1).toBe(monitor2)
  })

  it('stopWorkers stops the build monitor', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    orch.stopWorkers()
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('shutdown stops the build monitor', async () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    await orch.shutdown()
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('forwards build monitor status events as build-status', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    const events: Array<[string, unknown]> = []
    orch.on('build-status', (status: string, data: unknown) => events.push([status, data]))

    // Simulate BuildMonitor emitting a 'status' event
    const monitor = (orch as any).buildMonitor
    monitor.emit('status', 'passed')
    expect(events).toEqual([['passed', undefined]])

    // Simulate 'bead-created' event
    monitor.emit('bead-created', { id: 'b-123', title: 'test bead' })
    expect(events).toEqual([
      ['passed', undefined],
      ['bead-created', { id: 'b-123', title: 'test bead' }],
    ])
  })
})

describe('SwarmOrchestrator — plan request tracking', () => {
  beforeEach(() => {
    tmpDir = makeTmpProject()
    orch = new SwarmOrchestrator(tmpDir)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getPlanRequest returns the current request during planning', () => {
    // Simulate planning state without triggering _drainQueue
    ;(orch as any).planning = true
    ;(orch as any).currentPlanRequest = 'Build a login page'
    expect(orch.getPlanRequest()).toBe('Build a login page')
  })

  it('getPlanRequest returns null when not planning', () => {
    expect(orch.getPlanRequest()).toBeNull()
  })

  it('planPhase event includes the request string', () => {
    const events: Array<[string, string]> = []
    orch.on('planPhase', (phase: string, request: string) => events.push([phase, request]))

    // Simulate what _drainQueue does: set up state and emit planPhase with request
    const request = 'Add dark mode support'
    ;(orch as any).currentPlanRequest = request
    orch.emit('planPhase', 'analyzing', request)

    expect(events).toEqual([['analyzing', 'Add dark mode support']])
  })

  it('stopAll clears currentPlanRequest', () => {
    ;(orch as any).planning = true
    ;(orch as any).currentPlanRequest = 'Some plan'
    orch.stopAll()
    expect(orch.getPlanRequest()).toBeNull()
  })
})
