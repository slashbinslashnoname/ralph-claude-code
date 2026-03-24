import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import * as fs from 'fs'
import { AgentCoordinator } from './AgentCoordinator'
import { Bead } from '../types'
import { makeTmpGitProject, makeTmpPaths } from './testHelpers'

/**
 * Integration tests for heartbeat watchdog / claim timeout detection.
 *
 * When an agent has been inactive for >2× claudeTimeoutMinutes and has
 * no live heartbeat, _checkClaimTimeouts (run as a background sweep)
 * should reopen the bead and post a claim_timeout activity event.
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

/** Invoke the private _runClaimTimeoutSweep directly */
async function runSweep(coord: AgentCoordinator, minutes: number): Promise<void> {
  await (coord as any)._runClaimTimeoutSweep(minutes)
}

describe('heartbeat watchdog — _checkClaimTimeouts background sweep', () => {
  let tmpDir: string
  let coord: AgentCoordinator
  const claudeTimeoutMinutes = 5

  beforeEach(() => {
    tmpDir = makeTmpGitProject('hb-watchdog-')
    coord = new AgentCoordinator(makeTmpPaths(tmpDir))
  })

  afterEach(() => {
    coord.stopClaimTimeoutSweep()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reopens a bead when agent has no heartbeat and activity is stale', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckBead]
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
    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    // Bead should have been reopened
    expect(reopenSpy).toHaveBeenCalledWith('sb-stuck', expect.any(String))
  })

  it('does NOT reopen a bead when agent has a fresh heartbeat', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckBead]
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

    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    // Should NOT reopen — heartbeat is fresh
    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('does NOT reopen a bead when activity is recent', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckBead]
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

    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    // Activity is fresh — no reopen
    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('posts claim_timeout activity event when reopening a timed-out bead', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckBead]
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

    vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})
    const activitySpy = vi.spyOn(coord, 'postActivity')

    await runSweep(coord, claudeTimeoutMinutes)

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

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckA, stuckB]
      return []
    })

    const staleTs = new Date(Date.now() - 3 * claudeTimeoutMinutes * 60_000).toISOString()
    coord.postActivity({ agentId: 'agent-0', type: 'claimed', beadId: 'sb-a', beadTitle: 'Bead A', summary: 'Claimed', ts: staleTs })
    coord.postActivity({ agentId: 'agent-1', type: 'claimed', beadId: 'sb-b', beadTitle: 'Bead B', summary: 'Claimed', ts: staleTs })

    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    expect(reopenSpy).toHaveBeenCalledWith('sb-a', expect.any(String))
    expect(reopenSpy).toHaveBeenCalledWith('sb-b', expect.any(String))
    expect(reopenSpy).toHaveBeenCalledTimes(2)
  })

  it('heartbeat then clear makes agent eligible for timeout', async () => {
    const stuckBead = makeBead()

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [stuckBead]
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

    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    // Heartbeat was cleared, so agent is considered dead
    expect(reopenSpy).toHaveBeenCalledWith('sb-stuck', expect.any(String))
  })

  it('skips beads with no claimedBy field', async () => {
    const unclaimedBead = makeBead({ claimedBy: undefined })

    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (status: string) => {
      if (status === 'in_progress') return [unclaimedBead]
      return []
    })

    const reopenSpy = vi.spyOn(coord.bd, 'reopenAsync').mockImplementation(async () => {})

    await runSweep(coord, claudeTimeoutMinutes)

    // No claimedBy — should not attempt reopen
    expect(reopenSpy).not.toHaveBeenCalled()
  })
})
