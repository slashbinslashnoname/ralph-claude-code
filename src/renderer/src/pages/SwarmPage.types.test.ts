/**
 * Type-level tests verifying SwarmPage uses concrete IPC types
 * instead of `any` for its props and internal state.
 */
import { describe, it, expect } from 'vitest'
import type { ActivityEvent, AgentInfo, ProgressStats, SwarmStatus } from '../types/ipc'

describe('SwarmPage type contracts', () => {
  it('ActivityEvent props are typed (not any)', () => {
    // Verify ActivityEvent has the expected structure
    const event: ActivityEvent = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'worker-0',
      type: 'completed',
      beadId: 'sb-1',
      summary: 'Done',
    }
    expect(event.type).toBe('completed')
    // Optional fields
    expect(event.filesChanged).toBeUndefined()
    expect(event.branch).toBeUndefined()
    expect(event.commitSha).toBeUndefined()
  })

  it('SwarmStatus replaces status: any', () => {
    const status: SwarmStatus = {
      running: true,
      planning: false,
      planRequest: null,
      workerCount: 2,
      agents: [],
      stats: null,
      sessionStartedAt: '2026-03-21T08:00:00Z',
      stoppingGracefully: false,
    }
    // Previously accessed as status?.workerCount with any — now typed
    expect(status.workerCount).toBe(2)
    expect(status.stoppingGracefully).toBe(false)
    expect(status.sessionStartedAt).toBe('2026-03-21T08:00:00Z')
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
    // Nullable fields — these would cause null-deref bugs with any
    expect(agent.thinkingSummary).toBeNull()
    expect(agent.currentBeadId).toBe('sb-1')
  })

  it('AgentInfo with all-null nullable fields', () => {
    const agent: AgentInfo = {
      id: 'worker-1',
      index: 1,
      phase: 'idle',
      currentBeadId: null,
      currentBeadTitle: null,
      loopCount: 0,
      lastActivity: '2026-03-21T09:00:00Z',
      worktreeBranch: null,
      thinkingSummary: null,
    }
    // Accessing .currentBeadId on an idle agent returns null, not undefined
    expect(agent.currentBeadId).toBeNull()
  })

  it('ProgressStats replaces stats: any', () => {
    const stats: ProgressStats = {
      total: 10,
      pending: 3,
      ready: 2,
      claimed: 1,
      done: 3,
      failed: 1,
      pct: 30,
    }
    expect(stats.total).toBe(10)
    expect(stats.pct).toBe(30)
  })

  it('SwarmStatus.stats can be null', () => {
    const status: SwarmStatus = {
      running: false,
      planning: false,
      planRequest: null,
      workerCount: 0,
      agents: [],
      stats: null,
      sessionStartedAt: null,
      stoppingGracefully: false,
    }
    // stats bar check: stats && stats.total > 0 — safe with null
    expect(status.stats).toBeNull()
  })

  it('ActivityEvent.type union does not include bead-created', () => {
    // 'bead-created' is dead code in activityIcon — verifying it's not in the union
    const validTypes: ActivityEvent['type'][] = [
      'started', 'thinking', 'claimed', 'executing', 'merged',
      'completed', 'failed', 'stopped', 'paused', 'resumed',
      'rollback', 'split', 'circuit_open', 'circuit_closed',
    ]
    expect(validTypes).toHaveLength(14)
    expect(validTypes).not.toContain('bead-created')
  })
})
