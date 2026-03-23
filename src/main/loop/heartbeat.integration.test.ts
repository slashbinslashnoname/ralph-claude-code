import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import * as fs from 'fs'
import { AgentCoordinator } from './AgentCoordinator'
import { Bead } from '../types'
import { makeTmpGitProject, makeTmpPaths } from './testHelpers'

/**
 * Integration tests for heartbeat watchdog / claim timeout detection.
 *
 * When an agent has been inactive for >2× claudeTimeoutMinutes and has
 * no live heartbeat, _checkClaimTimeouts (called inside claimBestBead)
 * should reopen the bead and reset the agent's claim.
 */

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'sb-stuck',
    title: 'Stuck bead',
    description: 'A bead stuck in progress',
    type: 'task',
    status: 'in_progress',
    deps: [],
    files: ['src/foo.ts'],
    priority: 2,
    tags: [],
    claimedBy: 'agent-0',
    ...overrides
  }
}

describe('heartbeat watchdog — _checkClaimTimeouts via claimBestBead', () => {
  let tmpDir: string
  let coord: AgentCoordinator
  const claudeTimeoutMinutes = 5

  beforeEach(() => {
    tmpDir = makeTmpGitProject('hb-watchdog-')
    coord = new AgentCoordinator(makeTmpPaths(tmpDir))
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reopens a bead when agent has no heartbeat and activity is stale', async () => {
    const stuckBead = makeBead()

    // Mock bd to return the stuck bead as in_progress
    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    // Post a stale activity event for agent-0 (well past 2× timeout)
    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({
      agentId: 'agent-0',
      type: 'claimed',
      beadId: 'sb-stuck',
      beadTitle: 'Stuck bead',
      summary: 'Claimed bead',
      ts: staleTs
    })

    // No heartbeat set — agent is dead
    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})

    // Mock ready/listAll/assignTo so claimBestBead can proceed after timeout check
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    // claimBestBead triggers _checkClaimTimeouts internally
    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // Bead should have been reopened
    expect(reopenSpy).toHaveBeenCalledWith('agent-0', 'sb-stuck')
  })

  it('does NOT reopen a bead when agent has a fresh heartbeat', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    // Post stale activity
    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({
      agentId: 'agent-0',
      type: 'claimed',
      beadId: 'sb-stuck',
      beadTitle: 'Stuck bead',
      summary: 'Claimed bead',
      ts: staleTs
    })

    // But agent has a fresh heartbeat — it's still alive
    coord.heartbeat('agent-0')

    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // Should NOT reopen — heartbeat is fresh
    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('does NOT reopen a bead when activity is recent', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    // Post fresh activity (within 2× threshold)
    coord.postActivity({
      agentId: 'agent-0',
      type: 'executing',
      beadId: 'sb-stuck',
      beadTitle: 'Stuck bead',
      summary: 'Still executing'
    })

    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // Activity is fresh — no reopen
    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('posts claim_timeout activity event when reopening a timed-out bead', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({
      agentId: 'agent-0',
      type: 'claimed',
      beadId: 'sb-stuck',
      beadTitle: 'Stuck bead',
      summary: 'Claimed bead',
      ts: staleTs
    })

    vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    const activitySpy = vi.spyOn(coord, 'postActivity')
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // Should have posted a claim_timeout event
    expect(activitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'system',
        type: 'claim_timeout',
        beadId: 'sb-stuck'
      })
    )
  })

  it('reopens multiple timed-out beads from different agents', async () => {
    const stuckA = makeBead({ id: 'sb-a', claimedBy: 'agent-0', title: 'Bead A' })
    const stuckB = makeBead({ id: 'sb-b', claimedBy: 'agent-1', title: 'Bead B' })

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckA, stuckB]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({ agentId: 'agent-0', type: 'claimed', beadId: 'sb-a', beadTitle: 'Bead A', summary: 'Claimed', ts: staleTs })
    coord.postActivity({ agentId: 'agent-1', type: 'claimed', beadId: 'sb-b', beadTitle: 'Bead B', summary: 'Claimed', ts: staleTs })

    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-2', claudeTimeoutMinutes)

    expect(reopenSpy).toHaveBeenCalledWith('agent-0', 'sb-a')
    expect(reopenSpy).toHaveBeenCalledWith('agent-1', 'sb-b')
    expect(reopenSpy).toHaveBeenCalledTimes(2)
  })

  it('heartbeat then clear makes agent eligible for timeout', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [stuckBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({
      agentId: 'agent-0',
      type: 'claimed',
      beadId: 'sb-stuck',
      beadTitle: 'Stuck bead',
      summary: 'Claimed',
      ts: staleTs
    })

    // Agent had a heartbeat but it was cleared (agent deregistered)
    coord.heartbeat('agent-0')
    coord.clearHeartbeat('agent-0')

    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // Heartbeat was cleared, so agent is considered dead
    expect(reopenSpy).toHaveBeenCalledWith('agent-0', 'sb-stuck')
  })

  it('skips beads with no claimedBy field', async () => {
    const unclaimedBead = makeBead({ claimedBy: undefined })

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [unclaimedBead]
      if (status === 'open') return []
      if (status === 'closed') return []
      return []
    })

    const reopenSpy = vi.spyOn(coord, 'reopenBead').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-1', claudeTimeoutMinutes)

    // No claimedBy — should not attempt reopen
    expect(reopenSpy).not.toHaveBeenCalled()
  })
})
