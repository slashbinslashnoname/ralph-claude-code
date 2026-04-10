/**
 * Type-level tests verifying BeadsPage uses concrete IPC types
 * instead of `any` for beads, planQueue, and editing state.
 */
import { describe, it, expect } from 'vitest'
import type { Bead, PlanQueueItem, CircuitBreakerSnapshot, FileLock } from '../types/ipc'

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
      claimedBy: 'worker-0',
      claimedAt: '2026-03-21T10:00:00Z',
      epicId: 'sb-0',
    }
    expect(bead.claimedBy).toBe('worker-0')
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

describe('FileLock type contracts', () => {
  it('FileLock has required fields', () => {
    const lock: FileLock = {
      file: 'src/app.ts',
      agentId: 'worker-0',
      beadId: 'sb-1',
      reservedAt: '2026-04-10T10:00:00Z',
    }
    expect(lock.file).toBe('src/app.ts')
    expect(lock.agentId).toBe('worker-0')
    expect(lock.beadId).toBe('sb-1')
    expect(lock.reservedAt).toBeTruthy()
  })

  it('stale lock detection uses 30-minute threshold', () => {
    const STALE_LOCK_THRESHOLD_MS = 30 * 60_000
    const now = Date.now()
    const staleLock: FileLock = {
      file: 'old.ts',
      agentId: 'agent-0',
      beadId: 'b1',
      reservedAt: new Date(now - 40 * 60_000).toISOString(),
    }
    const freshLock: FileLock = {
      file: 'new.ts',
      agentId: 'agent-1',
      beadId: 'b2',
      reservedAt: new Date(now - 5 * 60_000).toISOString(),
    }
    const staleAge = now - new Date(staleLock.reservedAt).getTime()
    const freshAge = now - new Date(freshLock.reservedAt).getTime()
    expect(staleAge).toBeGreaterThan(STALE_LOCK_THRESHOLD_MS)
    expect(freshAge).toBeLessThan(STALE_LOCK_THRESHOLD_MS)
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
