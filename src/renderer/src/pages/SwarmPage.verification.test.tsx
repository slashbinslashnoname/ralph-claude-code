/**
 * Manual-verification scenarios for all UI locking fixes.
 *
 * Covers:
 * 1. Swarm start phase transitions (starting → health-check → spawning-workers)
 * 2. Swarm stop countdown with force-stop button
 * 3. Agent stuck >15 min badge
 * 4. Start button disabled during startup phases
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import ReactDOM from 'react-dom/client'
import type { SwarmPhase, AgentInfo } from '../types/ipc'

let swarmPhaseCallback: ((path: string, phase: SwarmPhase) => void) | null = null
let agentsCallback: ((path: string, agents: AgentInfo[]) => void) | null = null

const mocks = vi.hoisted(() => {
  const mockSwarmStatus = vi.fn().mockResolvedValue({
    agents: [],
    stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 },
    swarmPhase: 'idle',
    workerCount: 2,
  })
  const mockTelegramStatus = vi.fn().mockResolvedValue({
    connected: false,
    botUsername: null,
    lastError: null,
    messagesSent: 0,
    messagesReceived: 0,
  })
  const mockKnowledge = vi.fn().mockResolvedValue([])
  const mockBuildMonitorStatus = vi.fn().mockResolvedValue({ enabled: false, running: false })
  const mockBuildMonitorToggle = vi.fn().mockResolvedValue({ ok: true, enabled: true, running: true })
  const mockStart = vi.fn().mockResolvedValue(undefined)
  const mockStop = vi.fn().mockResolvedValue(undefined)
  const mockGracefulStop = vi.fn().mockResolvedValue(undefined)
  const noop = vi.fn().mockReturnValue(() => {})

  // Preserve jsdom window; only inject slashbot namespace.
  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).window.slashbot = {
    swarm: {
      status: mockSwarmStatus,
      queue: vi.fn().mockResolvedValue([]),
      activity: vi.fn().mockResolvedValue([]),
      knowledge: mockKnowledge,
      agentOutput: vi.fn().mockResolvedValue(''),
      agentLogs: vi.fn().mockResolvedValue([]),
      agentLogContent: vi.fn().mockResolvedValue(''),
      start: mockStart,
      stop: mockStop,
      gracefulStop: mockGracefulStop,
      pauseAgent: vi.fn().mockResolvedValue(undefined),
      resumeAgent: vi.fn().mockResolvedValue(undefined),
      pauseAll: vi.fn().mockResolvedValue(undefined),
      resumeAll: vi.fn().mockResolvedValue(undefined),
      onLog: noop,
      onOutput: noop,
      onGraph: noop,
      onAgents: vi.fn().mockImplementation((cb: (path: string, agents: AgentInfo[]) => void) => {
        agentsCallback = cb
        return () => { agentsCallback = null }
      }),
      onActivity: noop,
      onPlanPhase: noop,
      onPlanQueue: noop,
      onStopped: noop,
      onSwarmPhase: vi.fn().mockImplementation((cb: (path: string, phase: SwarmPhase) => void) => {
        swarmPhaseCallback = cb
        return () => { swarmPhaseCallback = null }
      }),
      buildMonitor: {
        status: mockBuildMonitorStatus,
        toggle: mockBuildMonitorToggle,
      },
      onBuildStatus: noop,
    },
    telegram: {
      status: mockTelegramStatus,
    },
  }

  return {
    mockSwarmStatus,
    mockTelegramStatus,
    mockKnowledge,
    mockBuildMonitorStatus,
    mockBuildMonitorToggle,
    mockStart,
    mockStop,
    mockGracefulStop,
  }
})

// Mock App module to avoid transitive Dashboard import
vi.mock('../App', () => ({
  globalAgentOutputs: {},
}))

// Mock AgentOutputRenderer
vi.mock('../components/AgentOutputRenderer', () => ({
  default: ({ output }: { output: string }) => React.createElement('div', null, output),
}))

import SwarmPage from './SwarmPage'
import { ToastProvider } from '../components/Toast'

let container: HTMLElement
let root: ReturnType<typeof ReactDOM.createRoot>

beforeEach(() => {
  swarmPhaseCallback = null
  agentsCallback = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = ReactDOM.createRoot(container)
  // Reset specific mocks (don't use clearAllMocks — it wipes implementations)
  mocks.mockSwarmStatus.mockReset().mockResolvedValue({
    agents: [],
    stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 },
    swarmPhase: 'idle',
    workerCount: 2,
  })
  mocks.mockTelegramStatus.mockReset().mockResolvedValue({
    connected: false,
    botUsername: null,
    lastError: null,
    messagesSent: 0,
    messagesReceived: 0,
  })
  mocks.mockKnowledge.mockReset().mockResolvedValue([])
  mocks.mockBuildMonitorStatus.mockReset().mockResolvedValue({ enabled: false, running: false })
  mocks.mockStart.mockReset().mockResolvedValue(undefined)
  mocks.mockStop.mockReset().mockResolvedValue(undefined)
  mocks.mockGracefulStop.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  document.body.removeChild(container)
})

function renderSwarmPage() {
  return act(async () => {
    root.render(
      <ToastProvider>
        <SwarmPage
          projectPath="/tmp/test"
          agentOutputs={{}}
          setAgentOutputs={vi.fn()}
          activity={[]}
          setActivity={vi.fn()}
        />
      </ToastProvider>,
    )
  })
}

// ---------------------------------------------------------------------------
// 1. Swarm start phase transitions
// ---------------------------------------------------------------------------
describe('Swarm start phase transitions', () => {
  test('shows phase card with Initialize step active when phase is starting', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'starting',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    const card = container.querySelector('[data-testid="swarm-phase-card"]')
    expect(card).not.toBeNull()

    const steps = card!.querySelectorAll('.swarm-phase-step')
    expect(steps.length).toBe(3)

    // Initialize should be active
    expect(steps[0].className).toContain('active')
    expect(steps[0].textContent).toContain('Initialize')
    // Health Check and Spawn Workers should be pending
    expect(steps[1].className).toContain('pending')
    expect(steps[2].className).toContain('pending')
  })

  test('shows Health Check active and Initialize done when phase is health-check', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'health-check',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    const card = container.querySelector('[data-testid="swarm-phase-card"]')
    expect(card).not.toBeNull()
    const steps = card!.querySelectorAll('.swarm-phase-step')

    expect(steps[0].className).toContain('done')
    expect(steps[1].className).toContain('active')
    expect(steps[1].textContent).toContain('Health Check')
    expect(steps[2].className).toContain('pending')
  })

  test('shows Spawn Workers active when phase is spawning-workers', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'spawning-workers',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    const card = container.querySelector('[data-testid="swarm-phase-card"]')
    const steps = card!.querySelectorAll('.swarm-phase-step')

    expect(steps[0].className).toContain('done')
    expect(steps[1].className).toContain('done')
    expect(steps[2].className).toContain('active')
    expect(steps[2].textContent).toContain('Spawn Workers')
  })

  test('phase card disappears when phase transitions to idle/ready', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'starting',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})
    expect(container.querySelector('[data-testid="swarm-phase-card"]')).not.toBeNull()

    // Simulate phase transition to idle via live event
    await act(async () => {
      swarmPhaseCallback?.('/tmp/test', 'idle')
    })

    expect(container.querySelector('[data-testid="swarm-phase-card"]')).toBeNull()
  })

  test('Start Swarm button is disabled during starting phases', async () => {
    // workerCount: 0 because workers haven't spawned yet during health-check
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'health-check',
      workerCount: 0,
    })

    await renderSwarmPage()
    await act(async () => {})

    const startBtn = Array.from(container.querySelectorAll('button.btn-primary')).find(
      b => b.textContent?.includes('health check') || b.textContent?.includes('Start Swarm'),
    ) as HTMLButtonElement
    expect(startBtn).not.toBeUndefined()
    expect(startBtn.disabled).toBe(true)
    expect(startBtn.textContent).toContain('health check')
  })

  test('live swarmPhase event transitions phase card steps', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'starting',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    // Move to health-check via live event
    await act(async () => {
      swarmPhaseCallback?.('/tmp/test', 'health-check')
    })

    const steps = container.querySelectorAll('.swarm-phase-step')
    expect(steps[0].className).toContain('done')
    expect(steps[1].className).toContain('active')
  })
})

// ---------------------------------------------------------------------------
// 2. Swarm stop countdown with force-stop button
// ---------------------------------------------------------------------------
describe('Swarm stop countdown', () => {
  test('shows stop card with countdown when phase is stopping', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'stopping',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    const stopCard = container.querySelector('[data-testid="swarm-stop-card"]')
    expect(stopCard).not.toBeNull()
    expect(stopCard!.textContent).toContain('Stopping')
    expect(stopCard!.textContent).toContain('30s')
  })

  test('force stop button is not visible initially when stopping', async () => {
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [],
      stats: null,
      swarmPhase: 'stopping',
      workerCount: 2,
    })

    await renderSwarmPage()
    await act(async () => {})

    // Force stop button should not be visible at elapsed = 0 (threshold is 10s)
    const forceBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Force stop',
    )
    expect(forceBtn).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Agent stuck >15m badge
// ---------------------------------------------------------------------------
describe('Agent stuck >15m badge', () => {
  test('shows stuck badge when agent lastActivity is older than 15 minutes', async () => {
    const fifteenMinAgo = new Date(Date.now() - 16 * 60_000).toISOString()
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [{
        id: 'worker-0',
        index: 0,
        phase: 'executing',
        currentBeadId: 'sb-1',
        currentBeadTitle: 'Test bead',
        currentBeadDescription: null,
        currentBeadType: 'task',
        loopCount: 3,
        lastActivity: fifteenMinAgo,
        worktreeBranch: 'worker/sb-1',
        thinkingSummary: null,
      }],
      stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 },
      swarmPhase: 'ready',
      workerCount: 1,
    })

    await renderSwarmPage()
    await act(async () => {})

    const stuckBadge = container.querySelector('[data-testid="stuck-badge"]')
    expect(stuckBadge).not.toBeNull()
    expect(stuckBadge!.textContent).toBe('stuck')
    expect(stuckBadge!.className).toContain('badge-warning')
  })

  test('does not show stuck badge when activity is recent', async () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString()
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [{
        id: 'worker-0',
        index: 0,
        phase: 'executing',
        currentBeadId: 'sb-1',
        currentBeadTitle: 'Test bead',
        currentBeadDescription: null,
        currentBeadType: 'task',
        loopCount: 3,
        lastActivity: twoMinAgo,
        worktreeBranch: 'worker/sb-1',
        thinkingSummary: null,
      }],
      stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 },
      swarmPhase: 'ready',
      workerCount: 1,
    })

    await renderSwarmPage()
    await act(async () => {})

    const stuckBadge = container.querySelector('[data-testid="stuck-badge"]')
    expect(stuckBadge).toBeNull()
  })

  test('stuck badge does not show when activity is under 15m', async () => {
    // 14 minutes ago — should NOT show (condition is >15m)
    const exactly15m = new Date(Date.now() - 14 * 60_000).toISOString()
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [{
        id: 'worker-0',
        index: 0,
        phase: 'executing',
        currentBeadId: null,
        currentBeadTitle: null,
        currentBeadDescription: null,
        currentBeadType: null,
        loopCount: 1,
        lastActivity: exactly15m,
        worktreeBranch: null,
        thinkingSummary: null,
      }],
      stats: null,
      swarmPhase: 'ready',
      workerCount: 1,
    })

    await renderSwarmPage()
    await act(async () => {})

    // Exactly 15m — should not show (> not >=)
    const stuckBadge = container.querySelector('[data-testid="stuck-badge"]')
    expect(stuckBadge).toBeNull()
  })

  test('stuck badge appears alongside phase badge', async () => {
    const oldActivity = new Date(Date.now() - 20 * 60_000).toISOString()
    mocks.mockSwarmStatus.mockResolvedValue({
      agents: [{
        id: 'worker-0',
        index: 0,
        phase: 'executing',
        currentBeadId: 'sb-1',
        currentBeadTitle: 'Test',
        currentBeadDescription: null,
        currentBeadType: null,
        loopCount: 1,
        lastActivity: oldActivity,
        worktreeBranch: null,
        thinkingSummary: null,
      }],
      stats: { total: 1, done: 0, claimed: 1, ready: 0, pending: 0, failed: 0, pct: 0 },
      swarmPhase: 'ready',
      workerCount: 1,
    })

    await renderSwarmPage()
    await act(async () => {})

    // Phase badge and stuck badge should both exist within worker-panel-identity
    const identity = container.querySelector('.worker-panel-identity')
    expect(identity).not.toBeNull()
    const badges = identity!.querySelectorAll('.badge')
    expect(badges.length).toBeGreaterThanOrEqual(2)

    const phaseBadge = Array.from(badges).find(b => b.textContent === 'executing')
    const stuckBadge = Array.from(badges).find(b => b.textContent === 'stuck')
    expect(phaseBadge).not.toBeUndefined()
    expect(stuckBadge).not.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Phase transition via live events
// ---------------------------------------------------------------------------
describe('Live event phase transitions', () => {
  test('swarmPhase event updates rendered state in real time', async () => {
    await renderSwarmPage()
    await act(async () => {})

    // Initially idle — no phase card
    expect(container.querySelector('[data-testid="swarm-phase-card"]')).toBeNull()

    // Receive starting event
    await act(async () => {
      swarmPhaseCallback?.('/tmp/test', 'starting')
    })
    expect(container.querySelector('[data-testid="swarm-phase-card"]')).not.toBeNull()

    // Transition through phases
    await act(async () => {
      swarmPhaseCallback?.('/tmp/test', 'health-check')
    })
    const steps = container.querySelectorAll('.swarm-phase-step')
    expect(steps[0].className).toContain('done')
    expect(steps[1].className).toContain('active')

    // Transition to ready — card disappears
    await act(async () => {
      swarmPhaseCallback?.('/tmp/test', 'ready')
    })
    expect(container.querySelector('[data-testid="swarm-phase-card"]')).toBeNull()
  })

  test('agents event updates worker panel list', async () => {
    await renderSwarmPage()
    await act(async () => {})

    expect(container.textContent).toContain('No agents running')

    // Push agents via live event
    await act(async () => {
      agentsCallback?.('/tmp/test', [{
        id: 'worker-0',
        index: 0,
        phase: 'thinking',
        currentBeadId: 'sb-5',
        currentBeadTitle: 'Implement feature',
        currentBeadDescription: null,
        currentBeadType: 'task',
        loopCount: 1,
        lastActivity: new Date().toISOString(),
        worktreeBranch: 'worker/sb-5',
        thinkingSummary: null,
      }])
    })

    expect(container.textContent).not.toContain('No agents running')
    expect(container.textContent).toContain('worker-0')
    expect(container.textContent).toContain('thinking')
    expect(container.textContent).toContain('sb-5')
  })
})
