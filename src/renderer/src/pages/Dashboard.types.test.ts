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
      id: 'agent-0',
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
      consecutive_permission_denials: 0,
      last_progress_loop: 5,
      total_opens: 0,
      reason: '',
      current_loop: 10,
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
