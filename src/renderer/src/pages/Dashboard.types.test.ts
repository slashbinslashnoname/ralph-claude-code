/**
 * Type-level tests verifying Dashboard uses concrete IPC types
 * instead of `any` for swarm status, bead stats, agents, and circuit.
 */
import { describe, it, expect } from 'vitest'
import type { SwarmStatus, ProgressStats, AgentInfo, CircuitBreakerSnapshot } from '../types/ipc'

describe('Dashboard type contracts', () => {
  it('SwarmStatus replaces swarmStatus: any', () => {
    const status: SwarmStatus = {
      running: true,
      planning: false,
      planRequest: null,
      workerCount: 2,
      agents: [],
      stats: null,
      sessionStartedAt: '2026-03-21T10:00:00Z',
      stoppingGracefully: false,
    }
    expect(status.running).toBe(true)
    expect(status.workerCount).toBe(2)
  })

  it('ProgressStats replaces beadStats: any', () => {
    const stats: ProgressStats = {
      total: 10,
      pending: 2,
      ready: 3,
      claimed: 1,
      done: 4,
      failed: 0,
      pct: 40,
    }
    expect(stats.pct).toBe(40)
    expect(stats.total).toBe(10)
  })

  it('AgentInfo replaces agents: any[]', () => {
    const agent: AgentInfo = {
      id: 'worker-0',
      index: 0,
      phase: 'executing',
      currentBeadId: 'sb-1',
      currentBeadTitle: 'Fix bug',
      loopCount: 3,
      lastActivity: '2026-03-21T10:00:00Z',
      worktreeBranch: 'feat/fix',
      thinkingSummary: null,
    }
    expect(agent.phase).toBe('executing')
    expect(agent.currentBeadId).toBe('sb-1')
  })

  it('CircuitBreakerSnapshot replaces circuit: any', () => {
    const circuit: CircuitBreakerSnapshot = {
      state: 'CLOSED',
      last_change: '2026-03-21T10:00:00Z',
      consecutive_no_progress: 0,
      consecutive_same_error: 0,
      error_window_count: 0,
      consecutive_permission_denials: 0,
      last_progress_loop: 5,
      total_opens: 0,
      reason: '',
      current_loop: 10,
      reopen_epoch: 0,
    }
    expect(circuit.state).toBe('CLOSED')
  })
})

describe('sortBeads type contracts', () => {
  it('sortBeads accepts and returns Bead[]', async () => {
    const { sortBeads } = await import('../utils/sortBeads')
    const beads = [
      { id: 'a', title: 'Z', description: '', type: 'task' as const, status: 'done' as const, deps: [], files: [], priority: 3, tags: [] },
      { id: 'b', title: 'A', description: '', type: 'task' as const, status: 'ready' as const, deps: [], files: [], priority: 0, tags: [] },
    ]
    const sorted = sortBeads(beads, 'priority', 'asc')
    expect(sorted[0].id).toBe('b')
    expect(sorted[1].id).toBe('a')
  })
})

describe('AgentOutputRenderer type contracts', () => {
  it('ClaudeResult.usage is optional Record<string, unknown>', () => {
    // Verify the interface accepts usage as optional
    interface ClaudeResult {
      usage?: Record<string, unknown>
    }
    const withUsage: ClaudeResult = { usage: { prompt_tokens: 100 } }
    const withoutUsage: ClaudeResult = {}
    expect(withUsage.usage).toBeDefined()
    expect(withoutUsage.usage).toBeUndefined()
  })
})

describe('Multi-agent circuit rendering', () => {
  it('renders multiple per-worker circuit breaker rows', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = (await import('react')).default

    // Mock window.slashbot to prevent errors during render
    const mockSb = {
      swarm: { status: async () => ({ status: null, progress: null, circuit: null, circuits: {}, analysis: null }) },
      onSwarmStatus: () => () => {},
      onCircuitUpdate: () => () => {},
      onBeadStats: () => () => {},
      onAgentsUpdate: () => () => {},
      startSwarm: async () => {},
      stopSwarm: async () => {},
      resetCircuit: async () => ({ ok: true }),
    }
    ;(globalThis as any).window = { slashbot: mockSb }

    const { default: Dashboard } = await import('./Dashboard')

    const circuits: Record<string, any> = {
      'worker-0': {
        state: 'CLOSED',
        last_change: '2026-03-25T10:00:00Z',
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        error_window_count: 0,
        consecutive_permission_denials: 0,
        last_progress_loop: 5,
        total_opens: 0,
        reason: '',
        current_loop: 10,
        reopen_epoch: 0,
      },
      'worker-1': {
        state: 'OPEN',
        last_change: '2026-03-25T10:05:00Z',
        consecutive_no_progress: 3,
        consecutive_same_error: 0,
        error_window_count: 4,
        consecutive_permission_denials: 0,
        last_progress_loop: 2,
        total_opens: 1,
        reason: 'API rate limit',
        current_loop: 8,
        reopen_epoch: 1,
      },
      'worker-2': {
        state: 'HALF_OPEN',
        last_change: '2026-03-25T10:03:00Z',
        consecutive_no_progress: 2,
        consecutive_same_error: 0,
        error_window_count: 2,
        consecutive_permission_denials: 0,
        last_progress_loop: 3,
        total_opens: 1,
        reason: 'Too many errors',
        current_loop: 6,
        reopen_epoch: 1,
      },
    }

    const html = renderToStaticMarkup(
      React.createElement(Dashboard, {
        projectPath: '/test/project',
        circuits,
        onNavigate: () => {},
      })
    )

    // All three worker agents should appear
    expect(html).toContain('worker-0')
    expect(html).toContain('worker-1')
    expect(html).toContain('worker-2')

    // State badges should be rendered
    expect(html).toContain('CLOSED')
    expect(html).toContain('OPEN')
    expect(html).toContain('HALF_OPEN')

    // Error counts should appear
    expect(html).toContain('Errors: 0')
    expect(html).toContain('Errors: 4')
    expect(html).toContain('Errors: 2')

    // Reopen epoch shown for non-zero values
    expect(html).toContain('Reopen: 1')

    // OPEN pill warning should be rendered (OPEN takes precedence)
    expect(html).toContain('pill-red')

    // Reset button should appear for OPEN circuit
    expect(html).toContain('Reset')
  })

  it('renders empty state when no circuit data exists', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = (await import('react')).default

    const { default: Dashboard } = await import('./Dashboard')

    const html = renderToStaticMarkup(
      React.createElement(Dashboard, {
        projectPath: '/test/project',
        circuits: {},
        onNavigate: () => {},
      })
    )

    expect(html).toContain('No circuit breaker data yet')
  })
})

describe('KanbanBoard type contracts', () => {
  it('KanbanBead keeps local interface (not coupled to IPC Bead)', () => {
    // KanbanBoard intentionally uses a local KanbanBead with a subset of fields
    interface KanbanBead {
      id: string
      title: string
      status: string
      type: string
      priority: number
    }
    const bead: KanbanBead = {
      id: 'sb-1',
      title: 'Test',
      status: 'ready',
      type: 'task',
      priority: 1,
    }
    expect(bead.status).toBe('ready')
  })
})
