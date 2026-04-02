import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'
import { SwarmOrchestrator } from './SwarmOrchestrator'
import { ProjectPaths, getProjectPaths, ensureStoreDirs } from './ProjectStore'

// ── AgentCoordinator heartbeat tests ──────────────────────────────────────

describe('AgentCoordinator — heartbeat', () => {
  let tmpDir: string
  let coord: AgentCoordinator

  function makeTmpPaths(projectDir: string): ProjectPaths {
    const storeDir = path.join(projectDir, '.slashbot')
    fs.mkdirSync(path.join(storeDir, 'logs'), { recursive: true })
    fs.mkdirSync(path.join(storeDir, 'config'), { recursive: true })
    return {
      id: 'test-id', projectRoot: projectDir, storeDir,
      logsDir: path.join(storeDir, 'logs'),
      circuitBreakerState: path.join(storeDir, '.circuit_breaker_state'),
      callCount: path.join(storeDir, '.call_count'),
      activity: path.join(storeDir, 'activity.jsonl'),
      knowledge: path.join(storeDir, 'knowledge.jsonl'),
      agents: path.join(storeDir, 'agents.json'),
      fileLocks: path.join(storeDir, 'file_locks.json'),
      configDir: path.join(storeDir, 'config'),
      slashbotrc: path.join(storeDir, 'config', '.slashbotrc'),
      worktreesDir: path.join(projectDir, '.worktrees'),
      beadsRoot: path.join(projectDir, '.beads'),
      beadsCwd: projectDir,
      mail: path.join(storeDir, 'mail.jsonl'),
      agentMd: path.join(storeDir, 'config', 'AGENT.md'),
      promptMd: path.join(storeDir, 'config', 'PROMPT.md'),
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-coord-'))
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' })
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' })
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test')
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' })
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true })
    coord = new AgentCoordinator(makeTmpPaths(tmpDir))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('heartbeat() records a timestamp retrievable by getLastHeartbeat()', () => {
    const before = Date.now()
    coord.heartbeat('agent-0')
    const ts = coord.getLastHeartbeat('agent-0')
    expect(ts).toBeDefined()
    expect(ts!).toBeGreaterThanOrEqual(before)
    expect(ts!).toBeLessThanOrEqual(Date.now())
  })

  it('getLastHeartbeat() returns undefined for unknown agents', () => {
    expect(coord.getLastHeartbeat('agent-unknown')).toBeUndefined()
  })

  it('heartbeat() updates existing timestamp', () => {
    coord.heartbeat('agent-0')
    const first = coord.getLastHeartbeat('agent-0')!
    // Advance time slightly
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    coord.heartbeat('agent-0')
    const second = coord.getLastHeartbeat('agent-0')!
    expect(second).toBeGreaterThan(first)
    vi.useRealTimers()
  })

  it('clearHeartbeat() removes an agent heartbeat', () => {
    coord.heartbeat('agent-0')
    expect(coord.getLastHeartbeat('agent-0')).toBeDefined()
    coord.clearHeartbeat('agent-0')
    expect(coord.getLastHeartbeat('agent-0')).toBeUndefined()
  })
})

// ── SwarmOrchestrator dead-agent detection tests ──────────────────────────

function makeTmpProject(): ProjectPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-swarm-'))
  const paths = getProjectPaths(dir)
  ensureStoreDirs(paths)
  fs.writeFileSync(paths.slashbotrc, [
    'CLAUDE_CODE_CMD=false',
    'CLAUDE_TIMEOUT_MINUTES=1',
    'CLAUDE_OUTPUT_FORMAT=text',
    'ALLOWED_TOOLS=',
  ].join('\n'))
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'PROMPT.md'), '# Prompt')
  fs.writeFileSync(path.join(paths.configDir, 'AGENT.md'), '# Agent')
  return paths
}

describe('SwarmOrchestrator — dead-agent detection', () => {
  let tmpDir: string
  let tmpPaths: ProjectPaths
  let orch: SwarmOrchestrator

  beforeEach(() => {
    tmpPaths = makeTmpProject()
    tmpDir = tmpPaths.projectRoot
    orch = new SwarmOrchestrator(tmpPaths)
  })

  afterEach(() => {
    try { orch.stopAll() } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getHeartbeat() returns undefined for unknown agent', () => {
    expect(orch.getHeartbeat('agent-99')).toBeUndefined()
  })

  it('getStaleAgents() returns agents with old heartbeats', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('agent-0', Date.now() - 20 * 60_000) // 20min old
    map.set('agent-1', Date.now()) // fresh

    const stale = orch.getStaleAgents(10 * 60_000) // 10min threshold
    expect(stale).toEqual(['agent-0'])
  })

  it('getStaleAgents() returns empty when all heartbeats are fresh', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('agent-0', Date.now())
    map.set('agent-1', Date.now())

    expect(orch.getStaleAgents(10 * 60_000)).toEqual([])
  })

  it('_detectDeadAgents() reopens beads for dead agents', () => {
    // Setup: register a fake agent with a stale heartbeat
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('agent-0', Date.now() - 5 * 60_000) // 5min old

    // claudeTimeoutMinutes is 1, so threshold = 2 * 1 * 60000 = 120000 ms = 2min
    // 5min > 2min → agent is dead

    // Register the agent with a current bead
    orch.coordinator.registerAgent({
      id: 'agent-0', index: 0, phase: 'executing',
      currentBeadId: 'test-bead', currentBeadTitle: 'Test bead',
      loopCount: 1, lastActivity: new Date().toISOString(),
      worktreeBranch: null, thinkingSummary: null
    })

    // Mock the worker in the workers map
    const mockWorker = { stop: vi.fn(), on: vi.fn(), emit: vi.fn() }
    const workers = (orch as any).workers as Map<string, any>
    workers.set('agent-0', mockWorker)

    // Mock reopenBead since we don't have real beads
    const reopenSpy = vi.spyOn(orch.coordinator, 'reopenBead').mockImplementation(() => {})

    // Capture activity posts
    const activitySpy = vi.spyOn(orch.coordinator, 'postActivity')

    // Run detection
    ;(orch as any)._detectDeadAgents()

    // Verify bead was reopened
    expect(reopenSpy).toHaveBeenCalledWith('agent-0', 'test-bead')

    // Verify dead_agent activity was posted
    expect(activitySpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'system',
      type: 'dead_agent',
      beadId: 'test-bead',
    }))

    // Verify worker was stopped and removed
    expect(mockWorker.stop).toHaveBeenCalled()
    expect(workers.has('agent-0')).toBe(false)
    expect(map.has('agent-0')).toBe(false)
  })

  it('_detectDeadAgents() skips agents with fresh heartbeats', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('agent-0', Date.now()) // fresh

    const mockWorker = { stop: vi.fn(), on: vi.fn(), emit: vi.fn() }
    const workers = (orch as any).workers as Map<string, any>
    workers.set('agent-0', mockWorker)

    const reopenSpy = vi.spyOn(orch.coordinator, 'reopenBead').mockImplementation(() => {})

    ;(orch as any)._detectDeadAgents()

    expect(reopenSpy).not.toHaveBeenCalled()
    expect(mockWorker.stop).not.toHaveBeenCalled()
    expect(workers.has('agent-0')).toBe(true)
  })

  it('_detectDeadAgents() skips agents not in the workers map', () => {
    const map = (orch as any)._heartbeatMap as Map<string, number>
    map.set('agent-ghost', Date.now() - 10 * 60_000) // stale but no worker

    const reopenSpy = vi.spyOn(orch.coordinator, 'reopenBead').mockImplementation(() => {})

    ;(orch as any)._detectDeadAgents()

    // Should not attempt to reopen since agent has no worker
    expect(reopenSpy).not.toHaveBeenCalled()
  })
})
