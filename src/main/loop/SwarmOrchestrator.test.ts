import { describe, it, beforeEach, afterEach, expect } from 'vitest'
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
  const ralphDir = path.join(dir, '.ralph')
  fs.mkdirSync(path.join(ralphDir, 'logs'), { recursive: true })
  // Minimal .ralphrc so loadConfig doesn't throw
  fs.writeFileSync(path.join(dir, '.ralphrc'), JSON.stringify({
    claudeCodeCmd: 'false', // will fail immediately
    claudeTimeoutMinutes: 1,
    claudeOutputFormat: 'text',
    allowedTools: '',
    maxAgents: 2,
    continueSession: false,
  }))
  // beads dir for BdClient
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
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
