/**
 * Type-level tests verifying BeadsPage uses concrete IPC types
 * instead of `any` for beads, planQueue, and editing state.
 */
import { describe, it, expect } from 'vitest'
import type { Bead, PlanQueueItem, CircuitBreakerSnapshot } from '../types/ipc'

describe('BeadsPage type contracts', () => {
  it('Bead replaces beads: any[]', () => {
    const bead: Bead = {
      id: 'sb-1',
      title: 'Fix login',
      description: 'Handle edge case',
      type: 'task',
      status: 'ready',
      deps: [],
      files: [],
      priority: 2,
      tags: ['auth'],
    }
    expect(bead.status).toBe('ready')
    expect(bead.priority).toBe(2)
    expect(bead.tags).toEqual(['auth'])
  })

  it('Bead with optional fields', () => {
    const bead: Bead = {
      id: 'sb-2',
      title: 'Claimed bead',
      description: '',
      type: 'subtask',
      status: 'claimed',
      deps: ['sb-1'],
      files: ['src/app.ts'],
      priority: 1,
      tags: [],
      claimedBy: 'agent-0',
      claimedAt: '2026-03-21T10:00:00Z',
      epicId: 'sb-0',
    }
    expect(bead.claimedBy).toBe('agent-0')
    expect(bead.epicId).toBe('sb-0')
    expect(bead.completedAt).toBeUndefined()
  })

  it('PlanQueueItem replaces planQueue: any[]', () => {
    const item: PlanQueueItem = {
      id: 'plan-1',
      request: 'Build a dashboard component',
    }
    expect(item.id).toBe('plan-1')
    expect(item.request).toContain('dashboard')
  })

  it('Bead.status union covers all expected values', () => {
    const statuses: Bead['status'][] = ['pending', 'ready', 'claimed', 'done', 'failed']
    expect(statuses).toHaveLength(5)
  })

  it('Bead.type union covers all expected values', () => {
    const types: Bead['type'][] = ['epic', 'task', 'subtask']
    expect(types).toHaveLength(3)
  })
})

describe('App TabState type contracts', () => {
  it('CircuitBreakerSnapshot replaces circuit: any', () => {
    const snapshot: CircuitBreakerSnapshot = {
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
      error_window_count: 0,
    }
    expect(snapshot.state).toBe('CLOSED')
    expect(snapshot.total_opens).toBe(0)
  })

  it('CircuitBreakerSnapshot can be null in TabState', () => {
    const circuit: CircuitBreakerSnapshot | null = null
    // This mirrors TabState.circuit — accessing .state on null would throw
    expect(circuit).toBeNull()
  })

  it('CircuitBreakerSnapshot.state union covers all values', () => {
    const states: CircuitBreakerSnapshot['state'][] = ['CLOSED', 'HALF_OPEN', 'OPEN']
    expect(states).toHaveLength(3)
  })

  it('CircuitBreakerSnapshot with opened_at', () => {
    const snapshot: CircuitBreakerSnapshot = {
      state: 'OPEN',
      last_change: '2026-03-21T10:05:00Z',
      consecutive_no_progress: 3,
      consecutive_same_error: 2,
      error_window_count: 2,
      consecutive_permission_denials: 0,
      last_progress_loop: 7,
      total_opens: 1,
      reason: 'No progress detected',
      current_loop: 10,
      reopen_epoch: 0,
      error_window_count: 0,
      opened_at: '2026-03-21T10:05:00Z',
    }
    expect(snapshot.opened_at).toBe('2026-03-21T10:05:00Z')
    expect(snapshot.reason).toContain('No progress')
  })
})
