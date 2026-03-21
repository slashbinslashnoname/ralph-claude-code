import { describe, it, expect } from 'vitest'
import type { ActivityEvent } from '../types'

describe('ActivityEvent type', () => {
  it('accepts rollback type with commitSha', () => {
    const event: ActivityEvent = {
      ts: new Date().toISOString(),
      agentId: 'agent-1',
      type: 'rollback',
      beadId: 'sb-001',
      beadTitle: 'Test bead',
      commitSha: 'abc123def456',
      summary: 'Rolled back due to test failure'
    }
    expect(event.type).toBe('rollback')
    expect(event.commitSha).toBe('abc123def456')
  })

  it('allows commitSha on any event type', () => {
    const event: ActivityEvent = {
      ts: new Date().toISOString(),
      agentId: 'agent-1',
      type: 'merged',
      beadId: 'sb-002',
      commitSha: 'def789abc012'
    }
    expect(event.type).toBe('merged')
    expect(event.commitSha).toBe('def789abc012')
  })

  it('does not require commitSha', () => {
    const event: ActivityEvent = {
      ts: new Date().toISOString(),
      agentId: 'agent-1',
      type: 'started'
    }
    expect(event.commitSha).toBeUndefined()
  })
})
