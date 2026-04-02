/**
 * Compile-time type tests for renderer IPC types.
 * These verify that the exported types are structurally correct.
 */
import { describe, it, expect } from 'vitest'
import type {
  Bead,
  BeadStatus,
  BeadType,
  AgentInfo,
  AgentPhase,
  ActivityEvent,
  KnowledgeEntry,
  KnowledgeCategory,
  KnowledgeConfidence,
  CircuitBreakerSnapshot,
  SwarmStatus,
  ProgressStats,
  PlanQueueItem,
  UpdateState,
  UpdateInfo,
  UpdateProgress,
  UpdateEvent
} from './ipc'

describe('IPC types', () => {
  it('Bead has required fields', () => {
    const bead: Bead = {
      id: 'sb-1',
      title: 'Test bead',
      description: 'A test',
      type: 'task',
      status: 'pending',
      deps: [],
      files: ['src/foo.ts'],
      priority: 1,
      tags: ['test']
    }
    expect(bead.id).toBe('sb-1')
    expect(bead.claimedBy).toBeUndefined()
  })

  it('Bead accepts optional fields', () => {
    const bead: Bead = {
      id: 'sb-2',
      title: 'Claimed bead',
      description: 'With optionals',
      type: 'subtask',
      status: 'claimed',
      deps: ['sb-1'],
      files: [],
      priority: 2,
      tags: [],
      claimedBy: 'worker-0',
      claimedAt: '2026-03-21T10:00:00Z',
      epicId: 'sb-epic',
      taskId: 'sb-task'
    }
    expect(bead.claimedBy).toBe('worker-0')
  })

  it('BeadStatus covers all values', () => {
    const statuses: BeadStatus[] = ['pending', 'ready', 'claimed', 'done', 'failed']
    expect(statuses).toHaveLength(5)
  })

  it('BeadType covers all values', () => {
    const types: BeadType[] = ['epic', 'task', 'subtask']
    expect(types).toHaveLength(3)
  })

  it('AgentPhase covers all values', () => {
    const phases: AgentPhase[] = [
      'idle', 'routing', 'waiting', 'claiming', 'thinking',
      'executing', 'reviewing', 'merging', 'closing', 'paused'
    ]
    expect(phases).toHaveLength(10)
  })

  it('AgentInfo has all required fields', () => {
    const agent: AgentInfo = {
      id: 'worker-0',
      index: 0,
      phase: 'executing',
      currentBeadId: 'sb-1',
      currentBeadTitle: 'Test',
      loopCount: 5,
      lastActivity: '2026-03-21T10:00:00Z',
      worktreeBranch: 'feat/test',
      thinkingSummary: 'Analyzing...'
    }
    expect(agent.id).toBe('worker-0')
  })

  it('AgentInfo accepts null nullable fields', () => {
    const agent: AgentInfo = {
      id: 'worker-1',
      index: 1,
      phase: 'idle',
      currentBeadId: null,
      currentBeadTitle: null,
      loopCount: 0,
      lastActivity: '2026-03-21T09:00:00Z',
      worktreeBranch: null,
      thinkingSummary: null
    }
    expect(agent.currentBeadId).toBeNull()
  })

  it('ActivityEvent has required and optional fields', () => {
    const event: ActivityEvent = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'worker-0',
      type: 'completed',
      beadId: 'sb-1',
      summary: 'Done'
    }
    expect(event.type).toBe('completed')
    expect(event.filesChanged).toBeUndefined()
  })

  it('KnowledgeEntry is structurally valid', () => {
    const entry: KnowledgeEntry = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'worker-0',
      beadId: 'sb-1',
      category: 'gotcha',
      summary: 'Watch out',
      detail: 'Details here',
      confidence: 'high'
    }
    expect(entry.category).toBe('gotcha')
  })

  it('KnowledgeCategory and KnowledgeConfidence cover all values', () => {
    const cats: KnowledgeCategory[] = ['pattern', 'gotcha', 'dependency', 'convention', 'environment', 'risk']
    const confs: KnowledgeConfidence[] = ['high', 'medium', 'low']
    expect(cats).toHaveLength(6)
    expect(confs).toHaveLength(3)
  })

  it('CircuitBreakerSnapshot has all fields', () => {
    const cb: CircuitBreakerSnapshot = {
      state: 'CLOSED',
      last_change: '2026-03-21T10:00:00Z',
      consecutive_no_progress: 0,
      consecutive_same_error: 0,
      error_window_count: 0,
      consecutive_permission_denials: 0,
      last_progress_loop: 0,
      total_opens: 0,
      reason: '',
      current_loop: 1,
      reopen_epoch: 0,
      error_window_count: 0
    }
    expect(cb.state).toBe('CLOSED')
    expect(cb.opened_at).toBeUndefined()
  })

  it('SwarmStatus has all fields', () => {
    const status: SwarmStatus = {
      running: true,
      planning: false,
      planRequest: null,
      workerCount: 2,
      agents: [],
      stats: { total: 10, pending: 3, ready: 2, claimed: 1, done: 3, failed: 1, pct: 30 },
      sessionStartedAt: '2026-03-21T08:00:00Z',
      stoppingGracefully: false
    }
    expect(status.running).toBe(true)
    expect(status.stats?.pct).toBe(30)
  })

  it('SwarmStatus with null stats', () => {
    const status: SwarmStatus = {
      running: false,
      planning: false,
      planRequest: null,
      workerCount: 0,
      agents: [],
      stats: null,
      sessionStartedAt: null,
      stoppingGracefully: false
    }
    expect(status.stats).toBeNull()
  })

  it('ProgressStats has all numeric fields', () => {
    const stats: ProgressStats = {
      total: 20,
      pending: 5,
      ready: 4,
      claimed: 3,
      done: 6,
      failed: 2,
      pct: 30
    }
    expect(stats.total).toBe(20)
  })

  it('PlanQueueItem has id and request', () => {
    const item: PlanQueueItem = {
      id: 'plan-1',
      request: 'Add auth middleware'
    }
    expect(item.id).toBe('plan-1')
    expect(item.request).toBe('Add auth middleware')
  })

  it('UpdateState covers all values', () => {
    const states: UpdateState[] = [
      'idle', 'checking', 'available', 'not-available',
      'downloading', 'downloaded', 'error'
    ]
    expect(states).toHaveLength(7)
  })

  it('UpdateInfo has all required fields', () => {
    const info: UpdateInfo = {
      version: '1.2.0',
      releaseDate: '2026-03-24',
      releaseNotes: 'Bug fixes and improvements'
    }
    expect(info.version).toBe('1.2.0')
  })

  it('UpdateInfo accepts null releaseNotes', () => {
    const info: UpdateInfo = {
      version: '1.2.0',
      releaseDate: '2026-03-24',
      releaseNotes: null
    }
    expect(info.releaseNotes).toBeNull()
  })

  it('UpdateProgress has all numeric fields', () => {
    const progress: UpdateProgress = {
      percent: 45.5,
      bytesPerSecond: 1048576,
      transferred: 5242880,
      total: 11534336
    }
    expect(progress.percent).toBe(45.5)
    expect(progress.total).toBe(11534336)
  })

  it('UpdateEvent discriminated union covers all event types', () => {
    const events: UpdateEvent[] = [
      { type: 'checking' },
      { type: 'available', info: { version: '1.2.0', releaseDate: '2026-03-24', releaseNotes: null } },
      { type: 'not-available', info: { version: '1.1.0', releaseDate: '2026-03-20', releaseNotes: null } },
      { type: 'progress', progress: { percent: 50, bytesPerSecond: 1024, transferred: 512, total: 1024 } },
      { type: 'downloaded', info: { version: '1.2.0', releaseDate: '2026-03-24', releaseNotes: 'Fixes' } },
      { type: 'error', error: 'Network timeout' }
    ]
    expect(events).toHaveLength(6)
    expect(events[0].type).toBe('checking')
    expect(events[5].type).toBe('error')
  })

  it('UpdateEvent narrowing works via type discriminant', () => {
    const event: UpdateEvent = {
      type: 'available',
      info: { version: '2.0.0', releaseDate: '2026-03-24', releaseNotes: 'Major release' }
    }
    if (event.type === 'available') {
      expect(event.info.version).toBe('2.0.0')
    }
  })
})
