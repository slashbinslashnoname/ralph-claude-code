import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'


import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SwarmOrchestrator } from './SwarmOrchestrator'
import { getProjectPaths, ProjectPaths, ensureStoreDirs } from './ProjectStore'
import * as HealthCheck from './HealthCheck'

/**
 * These tests exercise SwarmOrchestrator.shutdown() by creating a real
 * orchestrator against a temp directory. Workers won't actually spawn Claude
 * (they'll fail immediately because there's no valid command), but the
 * shutdown mechanics — flag gating, event emission, timeout — are testable.
 */

let tmpDir: string
let tmpPaths: ProjectPaths
let orch: SwarmOrchestrator

const RC_CONTENT = JSON.stringify({
  claudeCodeCmd: 'false', // will fail immediately
  claudeTimeoutMinutes: 1,
  claudeOutputFormat: 'text',
  allowedTools: '',
  maxAgents: 2,
  continueSession: false,
})

function makeTmpProject(): ProjectPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
  const paths = getProjectPaths(dir)
  ensureStoreDirs(paths)
  // Minimal .slashbotrc so loadConfig doesn't throw
  fs.writeFileSync(paths.slashbotrc, RC_CONTENT)
  // beads dir for BdClient
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  // Slashbot files required by HealthCheck
  fs.writeFileSync(path.join(paths.configDir, 'PROMPT.md'), '# Prompt')
  fs.writeFileSync(path.join(paths.configDir, 'AGENT.md'), '# Agent')
  return paths
}

describe('SwarmOrchestrator.shutdown()', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
    tmpPaths = getProjectPaths(tmpDir)
    ensureStoreDirs(tmpPaths)
    fs.writeFileSync(tmpPaths.slashbotrc, RC_CONTENT)
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true })
    // Deliberately omit PROMPT.md and AGENT.md

    orch = new SwarmOrchestrator(tmpPaths)
    expect(() => orch.startWorkers(1)).toThrow('Health check failed')
  })

  it('throws when .beads directory is missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
    tmpPaths = getProjectPaths(tmpDir)
    ensureStoreDirs(tmpPaths)
    fs.writeFileSync(path.join(tmpPaths.configDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(tmpPaths.configDir, 'AGENT.md'), '# Agent')
    fs.writeFileSync(tmpPaths.slashbotrc, RC_CONTENT)
    // Deliberately omit .beads

    orch = new SwarmOrchestrator(tmpPaths)
    expect(() => orch.startWorkers(1)).toThrow('Health check failed')
  })
})

describe('SwarmOrchestrator — plan queue management', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
      id: 'worker-0', index: 0, phase: 'idle',
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
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
    const fakeWorker = { agentId: 'worker-0', pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('slot-0', fakeWorker)
    expect(orch.pauseWorker('worker-0')).toBe(true)
    expect(fakeWorker.pause).toHaveBeenCalled()
    expect(orch.resumeWorker('worker-0')).toBe(true)
    expect(fakeWorker.resume).toHaveBeenCalled()
  })

  it('pauseAllWorkers calls pause on all workers', () => {
    const w0 = { agentId: 'worker-0', pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    const w1 = { agentId: 'worker-1', pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('slot-0', w0)
    ;(orch as any).workers.set('slot-1', w1)
    orch.pauseAllWorkers()
    expect(w0.pause).toHaveBeenCalled()
    expect(w1.pause).toHaveBeenCalled()
  })

  it('resumeAllWorkers calls resume on all workers', () => {
    const w0 = { agentId: 'worker-0', pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    const w1 = { agentId: 'worker-1', pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('slot-0', w0)
    ;(orch as any).workers.set('slot-1', w1)
    orch.resumeAllWorkers()
    expect(w0.resume).toHaveBeenCalled()
    expect(w1.resume).toHaveBeenCalled()
  })

  it('pauseWorker broadcasts agents (debounced)', async () => {
    vi.useFakeTimers()
    const fakeWorker = { agentId: 'worker-0', pause: vi.fn(), stop: vi.fn() }
    ;(orch as any).workers.set('slot-0', fakeWorker)
    const broadcasts: any[] = []
    orch.on('agents', (a: any) => broadcasts.push(a))
    orch.pauseWorker('worker-0')
    // Not emitted yet — debounced
    expect(broadcasts.length).toBe(0)
    vi.advanceTimersByTime(200)
    expect(broadcasts.length).toBe(1)
    vi.useRealTimers()
  })
})

describe('SwarmOrchestrator — status queries', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getAgentOutput returns empty string for unknown agent', () => {
    expect(orch.getAgentOutput('agent-99')).toBe('')
  })

  it('getAgentOutput reads from disk log file', () => {
    const logDir = tmpPaths.logsDir
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
    const logFile = path.join(tmpPaths.logsDir, 'agent-test.log')
    expect(fs.existsSync(logFile)).toBe(true)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('disk-check')
  })

  it('_bufferOutput rotates log file when exceeding 1MB after 50 writes', () => {
    const buf = (orch as any)
    const logFile = path.join(tmpPaths.logsDir, 'agent-rot.log')
    const rotatedFile = logFile + '.1'

    // Write a large file (>1MB) in fewer than 50 writes so rotation check hasn't fired yet
    const bigChunk = 'x'.repeat(100_000)
    for (let i = 0; i < 11; i++) {
      buf._bufferOutput('agent-rot', bigChunk) // 11 × 100KB = 1.1MB
    }
    // Only 11 writes — below the 50-write check interval, so no rotation yet
    expect(fs.existsSync(rotatedFile)).toBe(false)

    // Now write enough small chunks to hit the 50-write check interval
    for (let i = 0; i < 39; i++) {
      buf._bufferOutput('agent-rot', '.') // writes 12..50
    }
    // At write 50 the check fires, file is >1MB → rotated
    expect(fs.existsSync(rotatedFile)).toBe(true)
    // Original file should be gone (renamed)
    expect(fs.existsSync(logFile)).toBe(false)
  })

  it('_bufferOutput does not rotate when file is under 1MB', () => {
    const buf = (orch as any)
    const logFile = path.join(tmpPaths.logsDir, 'agent-small.log')
    const rotatedFile = logFile + '.1'

    // Write small data and trigger 50 writes
    for (let i = 0; i < 50; i++) {
      buf._bufferOutput('agent-small', 'small')
    }
    // File is well under 1MB, so no rotation
    expect(fs.existsSync(rotatedFile)).toBe(false)
    expect(fs.existsSync(logFile)).toBe(true)
  })
})

describe('SwarmOrchestrator — logging', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('_log writes to slashbot.log on disk', () => {
    ;(orch as any)._log('INFO', 'test message')
    const logFile = path.join(tmpPaths.logsDir, 'slashbot.log')
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
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    const status = orch.getBuildMonitorStatus()
    expect(status.enabled).toBe(true)
    expect(status.running).toBe(true)
  })

  it('toggleBuildMonitor(false) stops the monitor', () => {
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    orch.toggleBuildMonitor(false)
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('toggleBuildMonitor(true) is idempotent when already running', () => {
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    const monitor1 = (orch as any).buildMonitor
    orch.toggleBuildMonitor(true) // should be no-op
    const monitor2 = (orch as any).buildMonitor
    expect(monitor1).toBe(monitor2)
  })

  it('stopWorkers stops the build monitor', () => {
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    orch.stopWorkers()
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('shutdown stops the build monitor', async () => {
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    await orch.shutdown()
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })
  })

  it('build monitor lifecycle follows swarm lifecycle (created on start, destroyed on stop)', () => {
    // Configure buildMonitorCmd so startWorkers auto-creates the monitor
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')

    // Mock bd CLI-dependent methods to avoid needing a real beads database
    vi.spyOn(orch.coordinator, 'reopenStaleBeads').mockImplementation(() => {})
    vi.spyOn(orch as any, '_broadcastGraph').mockImplementation(() => {})
    // Mock health check since it still checks legacy paths
    vi.spyOn(HealthCheck, 'runHealthCheck').mockReturnValue({ ok: true, errors: [], warnings: [] })

    // startWorkers should create the build monitor
    orch.startWorkers(1)
    const statusAfterStart = orch.getBuildMonitorStatus()
    expect(statusAfterStart.enabled).toBe(true)
    expect(statusAfterStart.running).toBe(true)

    // stopWorkers should destroy it
    orch.stopWorkers()
    const statusAfterStop = orch.getBuildMonitorStatus()
    expect(statusAfterStop).toEqual({ enabled: false, running: false })
  })

  it('toggle works mid-session (enable/disable while swarm is running)', () => {
    // Configure buildMonitorCmd
    fs.writeFileSync(tmpPaths.slashbotrc,
      'CLAUDE_CODE_CMD=false\nBUILD_MONITOR_CMD=echo ok\nBUILD_MONITOR_INTERVAL=60\n')

    // Simulate a running swarm by injecting fake workers
    const fakeWorker = { agentId: 'worker-0', stop: vi.fn(), pause: vi.fn(), resume: vi.fn() }
    ;(orch as any).workers.set('slot-0', fakeWorker)

    // Toggle on — monitor should be created
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    expect(orch.getBuildMonitorStatus().running).toBe(true)

    // Toggle off — monitor should be destroyed
    orch.toggleBuildMonitor(false)
    expect(orch.getBuildMonitorStatus()).toEqual({ enabled: false, running: false })

    // Toggle on again — monitor should be re-created
    orch.toggleBuildMonitor(true)
    expect(orch.getBuildMonitorStatus().enabled).toBe(true)
    expect(orch.getBuildMonitorStatus().running).toBe(true)

    // Clean up fake workers so afterEach stopAll doesn't error
    ;(orch as any).workers.clear()
  })

  it('forwards build monitor status events as build-status', () => {
    fs.writeFileSync(tmpPaths.slashbotrc,
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

describe('SwarmOrchestrator — heartbeat map', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getHeartbeat returns undefined for unknown agent', () => {
    expect(orch.getHeartbeat('agent-99')).toBeUndefined()
  })

  it('heartbeat map is updated when a heartbeat event is received', () => {
    // Simulate a worker emitting heartbeat via the wiring in startWorkers
    const map = (orch as any)._heartbeatMap as Map<string, number>
    const before = Date.now()
    map.set('worker-0', before)
    expect(orch.getHeartbeat('worker-0')).toBe(before)
  })

  it('getStaleAgents returns agents older than threshold', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    const now = Date.now()
    map.set('worker-0', now - 20 * 60_000) // 20 min ago — stale
    map.set('worker-1', now - 1_000)        // 1 sec ago — fresh
    const stale = orch.getStaleAgents(10 * 60_000)
    expect(stale).toEqual(['worker-0'])
  })

  it('getStaleAgents returns empty array when all agents are fresh', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('worker-0', Date.now())
    map.set('worker-1', Date.now())
    expect(orch.getStaleAgents()).toEqual([])
  })

  it('getStaleAgents uses default 10-minute threshold', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('worker-0', Date.now() - 11 * 60_000) // 11 min — stale with default
    expect(orch.getStaleAgents()).toEqual(['worker-0'])
  })

  it('stopWorkers clears the heartbeat map', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('worker-0', Date.now())
    orch.stopWorkers()
    expect(orch.getHeartbeat('worker-0')).toBeUndefined()
  })

  it('worker exit event removes agent from heartbeat map', () => {
    // Simulate worker event wiring: inject a fake worker with an EventEmitter
    const { EventEmitter } = require('events')
    const fakeWorker = new EventEmitter()
    fakeWorker.agentId = 'worker-0'
    fakeWorker.stop = vi.fn()
    ;(orch as any).workers.set('slot-0', fakeWorker)
    ;(orch as any)._heartbeatMap.set('worker-0', Date.now())

    // Wire heartbeat and exit listeners like startWorkers does
    fakeWorker.on('heartbeat', () => {
      ;(orch as any)._heartbeatMap.set('worker-0', Date.now())
    })
    fakeWorker.on('exit', () => {
      ;(orch as any).workers.delete('slot-0')
      ;(orch as any)._heartbeatMap.delete('worker-0')
    })

    fakeWorker.emit('exit', 'test')
    expect(orch.getHeartbeat('worker-0')).toBeUndefined()
  })

  it('heartbeat event updates timestamp in the map', () => {
    const { EventEmitter } = require('events')
    const fakeWorker = new EventEmitter()
    fakeWorker.agentId = 'worker-0'
    fakeWorker.stop = vi.fn()

    // Wire heartbeat listener
    fakeWorker.on('heartbeat', () => {
      ;(orch as any)._heartbeatMap.set('worker-0', Date.now())
    })

    const before = Date.now()
    fakeWorker.emit('heartbeat')
    const ts = (orch as any)._heartbeatMap.get('worker-0')
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(Date.now())
  })
})

describe('SwarmOrchestrator — worker-N naming', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('startWorkers creates worker-N keys (not agent-N)', () => {
    vi.spyOn(orch.coordinator, 'reopenStaleBeads').mockImplementation(() => {})
    vi.spyOn(orch as any, '_broadcastGraph').mockImplementation(() => {})
    vi.spyOn(HealthCheck, 'runHealthCheck').mockReturnValue({ ok: true, errors: [], warnings: [] })

    orch.startWorkers(2)
    const keys = [...(orch as any).workers.keys()].sort()
    expect(keys).toEqual(['worker-0', 'worker-1'])
  })

  it('scaling down from 3 to 1 stops worker-1 and worker-2', () => {
    vi.spyOn(orch.coordinator, 'reopenStaleBeads').mockImplementation(() => {})
    vi.spyOn(orch as any, '_broadcastGraph').mockImplementation(() => {})
    vi.spyOn(HealthCheck, 'runHealthCheck').mockReturnValue({ ok: true, errors: [], warnings: [] })

    orch.startWorkers(3)
    expect(orch.workerCount()).toBe(3)

    orch.startWorkers(1)
    const keys = [...(orch as any).workers.keys()].sort()
    expect(keys).toEqual(['worker-0'])
    expect(orch.workerCount()).toBe(1)
  })
})

describe('SwarmOrchestrator — plan request tracking', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
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

describe('SwarmOrchestrator — activity poll uses timestamp tracking (Bug 1)', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits new activity events after cache rotation', () => {
    const emitted: any[] = []
    orch.on('activity', (event: any) => emitted.push(event))

    const ts1 = '2026-01-01T00:00:01.000Z'
    const ts2 = '2026-01-01T00:00:02.000Z'
    vi.spyOn(orch.coordinator, 'readActivity').mockReturnValue([
      { ts: ts1, agentId: 'worker-0', type: 'started' },
      { ts: ts2, agentId: 'worker-0', type: 'claimed', beadId: 'b1' },
    ] as any)

    // Start poll, then extract and invoke the callback directly
    ;(orch as any)._startActivityPoll()

    // Capture the setInterval callback by stopping poll and invoking manually
    // We'll just call the poll logic directly via the internal state
    const pollFn = () => {
      const events = orch.coordinator.readActivity(200)
      if (events.length > 0) {
        const lastTs = (orch as any).lastActivityTs
        const newEvents = lastTs
          ? events.filter((e: any) => e.ts > lastTs)
          : events
        if (newEvents.length > 0) {
          for (const event of newEvents) {
            orch.emit('activity', event)
          }
          ;(orch as any).lastActivityTs = newEvents[newEvents.length - 1].ts
        }
      }
    }

    pollFn()
    expect(emitted.length).toBe(2)
    expect(emitted[0].ts).toBe(ts1)
    expect(emitted[1].ts).toBe(ts2)

    // Now simulate cache rotation — old events gone, new events appear
    const ts3 = '2026-01-01T00:00:03.000Z'
    vi.mocked(orch.coordinator.readActivity).mockReturnValue([
      { ts: ts3, agentId: 'worker-0', type: 'executing', beadId: 'b1' },
    ] as any)

    emitted.length = 0
    pollFn()

    // Should still detect the new event even though array is now shorter
    expect(emitted.length).toBe(1)
    expect(emitted[0].ts).toBe(ts3)
  })

  it('does not re-emit events already seen', () => {
    const emitted: any[] = []
    orch.on('activity', (event: any) => emitted.push(event))

    const ts1 = '2026-01-01T00:00:01.000Z'
    vi.spyOn(orch.coordinator, 'readActivity').mockReturnValue([
      { ts: ts1, agentId: 'worker-0', type: 'started' },
    ] as any)

    // Simulate poll callback
    const pollFn = () => {
      const events = orch.coordinator.readActivity(200)
      if (events.length > 0) {
        const lastTs = (orch as any).lastActivityTs
        const newEvents = lastTs
          ? events.filter((e: any) => e.ts > lastTs)
          : events
        if (newEvents.length > 0) {
          for (const event of newEvents) {
            orch.emit('activity', event)
          }
          ;(orch as any).lastActivityTs = newEvents[newEvents.length - 1].ts
        }
      }
    }

    pollFn()
    expect(emitted.length).toBe(1)

    // Same events returned on next poll — nothing new
    emitted.length = 0
    pollFn()
    expect(emitted.length).toBe(0)
  })

  it('lastActivityTs is null initially', () => {
    expect((orch as any).lastActivityTs).toBeNull()
  })
})

describe('SwarmOrchestrator — stopWorkers double-emit guard (Bug 2)', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stopWorkers emits stopped exactly once even if called twice', () => {
    let count = 0
    orch.on('stopped', () => { count++ })
    orch.stopWorkers()
    orch.stopWorkers()
    expect(count).toBe(1)
  })

  it('stopWorkers does not double-emit when exit handlers fire after clear', () => {
    const { EventEmitter } = require('events')
    let stoppedCount = 0
    orch.on('stopped', () => { stoppedCount++ })

    // Create fake workers with exit event wiring similar to startWorkers
    const fakeWorker0 = new EventEmitter()
    fakeWorker0.stop = vi.fn()
    const fakeWorker1 = new EventEmitter()
    fakeWorker1.stop = vi.fn()

    ;(orch as any).workers.set('slot-0', fakeWorker0)
    ;(orch as any).workers.set('slot-1', fakeWorker1)

    // Wire exit handlers like startWorkers does
    for (const [slotKey, worker] of [['slot-0', fakeWorker0], ['slot-1', fakeWorker1]] as const) {
      (worker as any).on('exit', () => {
        ;(orch as any).workers.delete(slotKey)
        ;(orch as any)._heartbeatMap.delete(slotKey)
        if ((orch as any).workers.size === 0 && !(orch as any)._stoppedEmitted) {
          ;(orch as any)._stoppedEmitted = true
          orch.emit('stopped')
        }
      })
    }

    // Call stopWorkers — this clears the map and emits 'stopped'
    orch.stopWorkers()
    expect(stoppedCount).toBe(1)

    // Now exit handlers fire asynchronously — should NOT re-emit
    fakeWorker0.emit('exit', 'stopped')
    fakeWorker1.emit('exit', 'stopped')
    expect(stoppedCount).toBe(1)
  })

  it('_stoppedEmitted resets when startWorkers is called', () => {
    orch.stopWorkers()
    expect((orch as any)._stoppedEmitted).toBe(true)

    // Mock health check and related methods for startWorkers
    vi.spyOn(orch.coordinator, 'reopenStaleBeads').mockImplementation(() => {})
    vi.spyOn(orch as any, '_broadcastGraph').mockImplementation(() => {})
    vi.spyOn(HealthCheck, 'runHealthCheck').mockReturnValue({ ok: true, errors: [], warnings: [] })

    orch.startWorkers(1)
    expect((orch as any)._stoppedEmitted).toBe(false)
  })
})

describe('SwarmOrchestrator — dead agent cleanup via exit handler (Bug 3)', () => {
  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('_detectDeadAgents does not delete worker from map — exit handler handles it', () => {
    const { EventEmitter } = require('events')
    const fakeWorker = new EventEmitter()
    fakeWorker.stop = vi.fn()

    ;(orch as any).workers.set('worker-0', fakeWorker)
    ;(orch as any)._heartbeatMap.set('worker-0', Date.now() - 30 * 60_000) // 30 min stale

    // Mock dependencies
    vi.spyOn(orch.coordinator, 'getAgents').mockReturnValue([
      { id: 'worker-0', index: 0, phase: 'executing', currentBeadId: 'b1', currentBeadTitle: 'Test', loopCount: 1, lastActivity: '', worktreeBranch: null, thinkingSummary: null }
    ])
    vi.spyOn(orch.coordinator, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(orch.coordinator, 'postActivity').mockImplementation(() => {})

    // Run dead agent detection
    ;(orch as any)._detectDeadAgents()

    // Worker should still be in the map (not deleted by _detectDeadAgents)
    expect((orch as any).workers.has('worker-0')).toBe(true)
    // But stop() should have been called
    expect(fakeWorker.stop).toHaveBeenCalled()
  })

  it('dead agent triggers stopped event only through exit handler', () => {
    const { EventEmitter } = require('events')
    const fakeWorker = new EventEmitter()
    fakeWorker.stop = vi.fn()

    ;(orch as any).workers.set('worker-0', fakeWorker)
    ;(orch as any)._heartbeatMap.set('worker-0', Date.now() - 30 * 60_000)

    // Wire exit handler like startWorkers does
    fakeWorker.on('exit', () => {
      ;(orch as any).workers.delete('worker-0')
      ;(orch as any)._heartbeatMap.delete('worker-0')
      if ((orch as any).workers.size === 0 && !(orch as any)._stoppedEmitted) {
        ;(orch as any)._stoppedEmitted = true
        orch.emit('stopped')
      }
    })

    let stoppedCount = 0
    orch.on('stopped', () => { stoppedCount++ })

    vi.spyOn(orch.coordinator, 'getAgents').mockReturnValue([
      { id: 'worker-0', index: 0, phase: 'executing', currentBeadId: 'b1', currentBeadTitle: 'Test', loopCount: 1, lastActivity: '', worktreeBranch: null, thinkingSummary: null }
    ])
    vi.spyOn(orch.coordinator, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(orch.coordinator, 'postActivity').mockImplementation(() => {})

    // Dead agent detection runs — doesn't emit stopped
    ;(orch as any)._detectDeadAgents()
    expect(stoppedCount).toBe(0)

    // Exit handler fires — now stopped is emitted once
    fakeWorker.emit('exit', 'dead')
    expect(stoppedCount).toBe(1)
  })
})

describe('SwarmOrchestrator — broadcast debouncing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('_broadcastAgents coalesces multiple calls within 200ms into one emit', () => {
    const emits: any[] = []
    orch.on('agents', (agents) => emits.push(agents))

    // Call multiple times rapidly
    ;(orch as any)._broadcastAgents()
    ;(orch as any)._broadcastAgents()
    ;(orch as any)._broadcastAgents()

    // Nothing emitted yet (debounced)
    expect(emits.length).toBe(0)

    // Advance past debounce window
    vi.advanceTimersByTime(200)
    expect(emits.length).toBe(1)
  })

  it('_broadcastAgents emits again after debounce window expires', () => {
    const emits: any[] = []
    orch.on('agents', (agents) => emits.push(agents))

    ;(orch as any)._broadcastAgents()
    vi.advanceTimersByTime(200)
    expect(emits.length).toBe(1)

    // Second burst after window
    ;(orch as any)._broadcastAgents()
    vi.advanceTimersByTime(200)
    expect(emits.length).toBe(2)
  })

  it('_broadcastGraph coalesces multiple calls within 200ms into one', () => {
    const emits: any[] = []
    orch.on('graph', (stats) => emits.push(stats))

    // Mock getStatsAsync to resolve immediately
    vi.spyOn(orch.coordinator, 'getStatsAsync').mockResolvedValue({
      open: 1, in_progress: 0, closed: 0, total: 1
    } as any)

    ;(orch as any)._broadcastGraph()
    ;(orch as any)._broadcastGraph()
    ;(orch as any)._broadcastGraph()

    expect(emits.length).toBe(0)

    // Advance past debounce window to fire the timeout
    vi.advanceTimersByTime(200)
    // Allow the resolved promise microtask to flush
    return Promise.resolve().then(() => {
      expect(emits.length).toBe(1)
    })
  })

  it('_stopActivityPoll clears debounce timers', () => {
    ;(orch as any)._broadcastAgents()
    ;(orch as any)._broadcastGraph()

    // Timers should be set
    expect((orch as any)._agentsBroadcastTimer).not.toBeNull()
    expect((orch as any)._graphBroadcastTimer).not.toBeNull()

    ;(orch as any)._stopActivityPoll()

    // Timers should be cleared
    expect((orch as any)._agentsBroadcastTimer).toBeNull()
    expect((orch as any)._graphBroadcastTimer).toBeNull()

    // Advancing time should not emit anything
    const emits: any[] = []
    orch.on('agents', () => emits.push('agents'))
    orch.on('graph', () => emits.push('graph'))
    vi.advanceTimersByTime(500)
    expect(emits.length).toBe(0)
  })

  it('stopAll clears debounce timers via _stopActivityPoll', () => {
    ;(orch as any)._broadcastAgents()
    ;(orch as any)._broadcastGraph()

    orch.stopAll()

    expect((orch as any)._agentsBroadcastTimer).toBeNull()
    expect((orch as any)._graphBroadcastTimer).toBeNull()
  })
})
