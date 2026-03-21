import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BuildMonitor } from './BuildMonitor'

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
const mockExec = vi.mocked(exec)

function makeCoordinator(agents: Array<{ phase: string }> = []) {
  return {
    getAgents: vi.fn(() => agents as never[]),
    postActivity: vi.fn(),
  } as never
}

function makeBd() {
  return {
    create: vi.fn(() => ({ id: 'test-bead', title: 'test' })),
  } as never
}

function makeConfig(cmd = 'npm run build', interval = 60) {
  return { buildMonitorCmd: cmd, buildMonitorInterval: interval }
}

describe('BuildMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockExec.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Helper to simulate exec callback
  function simulateExec(err: Error | null, stdout = '', stderr = '') {
    const cb = mockExec.mock.calls[mockExec.mock.calls.length - 1]?.[2] as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined
    if (cb) cb(err, stdout, stderr)
  }

  it('starts and stops correctly', () => {
    const monitor = new BuildMonitor(makeConfig(), makeCoordinator(), makeBd())
    expect(monitor.isRunning()).toBe(false)
    monitor.start()
    expect(monitor.isRunning()).toBe(true)
    monitor.stop()
    expect(monitor.isRunning()).toBe(false)
  })

  it('does not start with empty buildMonitorCmd', () => {
    const monitor = new BuildMonitor(makeConfig(''), makeCoordinator(), makeBd())
    const logs: string[] = []
    monitor.on('log', (_level, msg) => logs.push(msg))
    monitor.start()
    expect(monitor.isRunning()).toBe(false)
    expect(logs.some(l => l.includes('no buildMonitorCmd'))).toBe(true)
  })

  it('does not start twice', () => {
    const monitor = new BuildMonitor(makeConfig(), makeCoordinator(), makeBd())
    monitor.start()
    // First check is triggered immediately
    expect(mockExec).toHaveBeenCalledTimes(1)
    monitor.start() // no-op
    expect(mockExec).toHaveBeenCalledTimes(1) // still 1
    monitor.stop()
  })

  it('toggle on/off/on works correctly', () => {
    const monitor = new BuildMonitor(makeConfig(), makeCoordinator(), makeBd())
    const result1 = monitor.toggle() // start
    expect(result1).toBe(true)
    expect(monitor.isRunning()).toBe(true)
    const result2 = monitor.toggle() // stop
    expect(result2).toBe(false)
    expect(monitor.isRunning()).toBe(false)
    const result3 = monitor.toggle() // start again
    expect(result3).toBe(true)
    monitor.stop()
  })

  it('calls _runCheck on interval', () => {
    const monitor = new BuildMonitor(makeConfig('npm test', 10), makeCoordinator(), makeBd())
    monitor.start()
    // Immediate call
    expect(mockExec).toHaveBeenCalledTimes(1)
    simulateExec(null, 'ok')
    // Advance timer
    vi.advanceTimersByTime(10_000)
    expect(mockExec).toHaveBeenCalledTimes(2)
    simulateExec(null, 'ok')
    vi.advanceTimersByTime(10_000)
    expect(mockExec).toHaveBeenCalledTimes(3)
    monitor.stop()
  })

  it('skips overlapping checks (guard flag)', () => {
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), makeBd())
    monitor.start()
    // First check is running (no callback yet)
    expect(mockExec).toHaveBeenCalledTimes(1)
    // Advance timer — should try to run but skip because checking=true
    vi.advanceTimersByTime(1_000)
    expect(mockExec).toHaveBeenCalledTimes(1) // still 1
    // Finish first check
    simulateExec(null, 'ok')
    // Next interval should now run
    vi.advanceTimersByTime(1_000)
    expect(mockExec).toHaveBeenCalledTimes(2)
    monitor.stop()
  })

  it('skips check when agent is merging', () => {
    const coord = makeCoordinator([{ phase: 'merging' }])
    const monitor = new BuildMonitor(makeConfig(), coord, makeBd())
    monitor.start()
    // _runCheck was called but should skip due to merging agent
    expect(mockExec).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('creates bead after 3 identical failures', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 60), makeCoordinator(), bd)
    const errorOutput = 'error: something broke'

    monitor.start()
    // Failure 1
    simulateExec(new Error('fail'), '', errorOutput)
    expect(bd.create).not.toHaveBeenCalled()

    // Failure 2
    vi.advanceTimersByTime(60_000)
    simulateExec(new Error('fail'), '', errorOutput)
    expect(bd.create).not.toHaveBeenCalled()

    // Failure 3 — should create bead
    vi.advanceTimersByTime(60_000)
    simulateExec(new Error('fail'), '', errorOutput)
    expect(bd.create).toHaveBeenCalledTimes(1)
    expect(bd.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bug',
      priority: 0,
      labels: ['auto-fix', 'build-monitor'],
    }))
    monitor.stop()
  })

  it('does not create duplicate bead for same fingerprint after filing', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), bd)
    const errorOutput = 'error: same thing'

    monitor.start()
    // 3 failures to trigger bead
    simulateExec(new Error('fail'), '', errorOutput)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)
    expect(bd.create).toHaveBeenCalledTimes(1)

    // 4th identical failure — no new bead (fingerprint removed after filing)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)
    // Count restarted because fingerprint was removed, so needs 3 more
    expect(bd.create).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('handles mixed fingerprints independently', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), bd)

    monitor.start()
    // Error A x2
    simulateExec(new Error('fail'), '', 'error A')
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', 'error A')
    // Error B x1
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', 'error B')

    // Neither should have triggered a bead yet
    expect(bd.create).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('resets failure counters on pass', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), bd)
    const errorOutput = 'error: flaky'

    monitor.start()
    // Fail 2x
    simulateExec(new Error('fail'), '', errorOutput)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)

    // Pass — resets counters
    vi.advanceTimersByTime(1_000)
    simulateExec(null, 'ok')

    // Fail 2x again — should not create bead (counter was reset)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), '', errorOutput)

    expect(bd.create).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('caps output at 2048 characters in bead description', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), bd)
    const bigOutput = 'X'.repeat(5000)

    monitor.start()
    for (let i = 0; i < 3; i++) {
      simulateExec(new Error('fail'), '', bigOutput)
      if (i < 2) vi.advanceTimersByTime(1_000)
    }

    expect(bd.create).toHaveBeenCalledTimes(1)
    const desc = (bd.create as ReturnType<typeof vi.fn>).mock.calls[0][0].description as string
    // The capped output portion should be 2048 chars, description has additional text around it
    expect(desc).toContain('X'.repeat(100))
    expect(desc.indexOf('X'.repeat(2048))).toBeGreaterThan(-1)
    // Should not contain the full 5000 X's
    expect(desc).not.toContain('X'.repeat(2049))
    monitor.stop()
  })

  it('emits status events', () => {
    const monitor = new BuildMonitor(makeConfig('npm test', 60), makeCoordinator(), makeBd())
    const statuses: Array<[string, string?]> = []
    monitor.on('status', (status: string, fp?: string) => statuses.push([status, fp]))

    monitor.start()
    simulateExec(new Error('fail'), '', 'build error')
    expect(statuses).toHaveLength(1)
    expect(statuses[0][0]).toBe('failed')

    vi.advanceTimersByTime(60_000)
    simulateExec(null, 'ok')
    expect(statuses).toHaveLength(2)
    expect(statuses[1][0]).toBe('passed')
    monitor.stop()
  })

  it('uses stderr for error output, falls back to stdout', () => {
    const bd = makeBd()
    const monitor = new BuildMonitor(makeConfig('npm test', 1), makeCoordinator(), bd)

    monitor.start()
    // stderr present — should use it
    simulateExec(new Error('fail'), 'stdout stuff', 'stderr error')
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), 'stdout stuff', 'stderr error')
    vi.advanceTimersByTime(1_000)
    simulateExec(new Error('fail'), 'stdout stuff', 'stderr error')

    const desc = (bd.create as ReturnType<typeof vi.fn>).mock.calls[0][0].description as string
    expect(desc).toContain('stderr error')
    monitor.stop()
  })
})
