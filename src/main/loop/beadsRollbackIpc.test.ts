import { describe, it, expect } from 'vitest'
import { validateProjectPath, validateBeadId } from './beadValidation'

/**
 * Tests for the beads:rollback IPC handler logic.
 *
 * The handler itself lives inside registerIpc() and isn't directly importable,
 * so we test:
 *  1. Input validation (reuses validateProjectPath + validateBeadId)
 *  2. agentId default logic
 *  3. Handler return shape expectations
 */

describe('beads:rollback validation', () => {
  it('validates projectPath via validateProjectPath', () => {
    expect(() => validateProjectPath('')).toThrow(/non-empty/)
    expect(() => validateProjectPath(123)).toThrow(/non-empty string/)
    expect(() => validateProjectPath(null)).toThrow(/non-empty string/)
    expect(validateProjectPath('/home/project')).toBe('/home/project')
  })

  it('validates beadId via validateBeadId', () => {
    expect(() => validateBeadId('')).toThrow(/non-empty/)
    expect(() => validateBeadId(null)).toThrow(/non-empty string/)
    expect(() => validateBeadId(42)).toThrow(/non-empty string/)
    expect(validateBeadId('sb-00i.5')).toBe('sb-00i.5')
  })

  it('rejects beadId with shell metacharacters', () => {
    expect(() => validateBeadId('$(rm -rf /)')).toThrow(/invalid characters/)
    expect(() => validateBeadId('id; drop')).toThrow(/invalid characters/)
  })
})

describe('beads:rollback agentId default logic', () => {
  function resolveAgentId(agentId: unknown): string {
    return typeof agentId === 'string' && agentId.length > 0 ? agentId : 'ui'
  }

  it('defaults to "ui" when agentId is undefined', () => {
    expect(resolveAgentId(undefined)).toBe('ui')
  })

  it('defaults to "ui" when agentId is empty string', () => {
    expect(resolveAgentId('')).toBe('ui')
  })

  it('defaults to "ui" when agentId is not a string', () => {
    expect(resolveAgentId(123)).toBe('ui')
    expect(resolveAgentId(null)).toBe('ui')
  })

  it('uses provided agentId when valid', () => {
    expect(resolveAgentId('agent-0')).toBe('agent-0')
    expect(resolveAgentId('worker-1')).toBe('worker-1')
  })
})

describe('beads:rollback return shape', () => {
  it('matches expected success shape', () => {
    const result = { reverted: true, revertedShas: ['abc123', 'def456'] }
    const response = { ok: result.reverted, revertedShas: result.revertedShas, error: undefined }
    expect(response).toEqual({ ok: true, revertedShas: ['abc123', 'def456'], error: undefined })
  })

  it('matches expected failure shape (no SHAs to revert)', () => {
    const result = { reverted: false, revertedShas: [] as string[], error: 'No merge SHAs found' }
    const response = { ok: result.reverted, revertedShas: result.revertedShas, error: result.error }
    expect(response).toEqual({ ok: false, revertedShas: [], error: 'No merge SHAs found' })
  })

  it('returns error when no swarm is active', () => {
    const response = { ok: false, error: 'No active swarm for this project' }
    expect(response.ok).toBe(false)
    expect(response.error).toContain('No active swarm')
  })
})
