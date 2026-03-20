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
  const ralphDir = path.join(dir, '.slashbot')
  fs.mkdirSync(path.join(ralphDir, 'logs'), { recursive: true })
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
  // Ralph files required by HealthCheck
  fs.writeFileSync(path.join(ralphDir, 'PROMPT.md'), '# Prompt')
  fs.writeFileSync(path.join(ralphDir, 'AGENT.md'), '# Agent')
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

  it('clears plan queue during shutdown', async () => {
    orch.on('log', () => {}) // swallow log events
    await orch.shutdown()
    expect(orch.getPlanQueue()).toEqual([])
    expect(orch.isPlanning()).toBe(false)
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

  it('throws when required Ralph files are missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'))
    const ralphDir = path.join(tmpDir, '.slashbot')
    fs.mkdirSync(path.join(ralphDir, 'logs'), { recursive: true })
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
    const ralphDir = path.join(tmpDir, '.slashbot')
    fs.mkdirSync(path.join(ralphDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(ralphDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(ralphDir, 'AGENT.md'), '# Agent')
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

  it('stopAll clears plan queue', () => {
    // Directly set queue to avoid triggering async _drainQueue
    ;(orch as any).planQueue = [{ id: 'plan-1', request: 'A' }]
    orch.stopAll()
    expect(orch.getPlanQueue()).toEqual([])
    expect(orch.isPlanning()).toBe(false)
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

  it('_log writes to ralph.log on disk', () => {
    ;(orch as any)._log('INFO', 'test message')
    const logFile = path.join(tmpDir, '.slashbot', 'logs', 'ralph.log')
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
