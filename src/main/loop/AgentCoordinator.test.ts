import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Ensure real modules are used even if other test files mock them

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'
import { AgentInfo, Bead } from '../types'

let tmpDir: string
let slashbotDir: string
let coord: AgentCoordinator

function makeTmpGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test')
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' })

  const sb = path.join(dir, '.slashbot')
  fs.mkdirSync(path.join(sb, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  return dir
}

describe('AgentCoordinator — atomic writes', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writeLocks is atomic — no .tmp file left behind', () => {
    coord.writeLocks([{ file: 'a.ts', agentId: 'agent-0', beadId: 'b1', reservedAt: new Date().toISOString() }])
    const lockFile = path.join(slashbotDir, 'file_locks.json')
    expect(fs.existsSync(lockFile)).toBe(true)
    expect(fs.existsSync(lockFile + '.tmp')).toBe(false)
    const locks = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    expect(locks.length).toBe(1)
    expect(locks[0].file).toBe('a.ts')
  })

  it('writeAgents is atomic — no .tmp file left behind', () => {
    coord.writeAgents([{
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    }])
    const agentsFile = path.join(slashbotDir, 'agents.json')
    expect(fs.existsSync(agentsFile)).toBe(true)
    expect(fs.existsSync(agentsFile + '.tmp')).toBe(false)
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'))
    expect(agents.length).toBe(1)
  })

  it('read immediately after write returns consistent data', () => {
    for (let i = 0; i < 20; i++) {
      const locks = [{ file: `f${i}.ts`, agentId: 'agent-0', beadId: `b${i}`, reservedAt: new Date().toISOString() }]
      coord.writeLocks(locks)
      const read = coord.readLocks()
      expect(read.length).toBe(1)
      expect(read[0].file).toBe(`f${i}.ts`)
    }
  })
})

describe('AgentCoordinator — atomic merge', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }

  it('merges a worktree branch successfully on first try', async () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(wt!.worktreePath, 'new-file.txt'), 'hello')
    execSync('git add . && git commit -m "add file"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b1', wt!.branch, wt!.worktreePath)
    expect(result.merged).toBe(true)
    expect(result.filesChanged).toContain('new-file.txt')
    expect(fs.existsSync(path.join(tmpDir, 'new-file.txt'))).toBe(true)
  })

  it('merge uses update-ref — base branch ref is updated atomically', async () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()

    const baseBefore = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    fs.writeFileSync(path.join(wt!.worktreePath, 'atomic.txt'), 'atomic merge')
    execSync('git add . && git commit -m "atomic"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b1', wt!.branch, wt!.worktreePath)
    expect(result.merged).toBe(true)

    const baseAfter = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()
    expect(baseAfter).not.toBe(baseBefore)
    // The new base should contain the agent's commit
    const log = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(log).toContain('atomic')
  })

  it('retries merge after conflict and fails without claudeCmd', async () => {
    const wt = coord.createWorktree('agent-0', 'b2')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'main version')
    execSync('git add . && git commit -m "main change"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt!.worktreePath, 'conflict.txt'), 'agent version')
    execSync('git add . && git commit -m "agent change"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b2', wt!.branch, wt!.worktreePath, { maxRetries: 1 })
    expect(result.merged).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('respects maxRetries=0 — no retry on failure', async () => {
    const wt = coord.createWorktree('agent-0', 'b3')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'main')
    execSync('git add . && git commit -m "main"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    fs.writeFileSync(path.join(wt!.worktreePath, 'x.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b3', wt!.branch, wt!.worktreePath, { maxRetries: 0 })
    expect(result.merged).toBe(false)
  })

  it('skips retry when stoppedFn returns true', async () => {
    const wt = coord.createWorktree('agent-0', 'b4')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'y.txt'), 'main')
    execSync('git add . && git commit -m "main"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    fs.writeFileSync(path.join(wt!.worktreePath, 'y.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b4', wt!.branch, wt!.worktreePath, {
      maxRetries: 5, stoppedFn: () => true
    })
    expect(result.merged).toBe(false)
  })

  it('cleans up worktree even on failure', async () => {
    const wt = coord.createWorktree('agent-0', 'b5')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'z.txt'), 'main')
    execSync('git add . && git commit -m "main"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    fs.writeFileSync(path.join(wt!.worktreePath, 'z.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    await coord.mergeWorktree('agent-0', 'b5', wt!.branch, wt!.worktreePath, { maxRetries: 0 })
    expect(fs.existsSync(wt!.worktreePath)).toBe(false)
  })

  it('no-op merge — agent branch has no new commits', async () => {
    const wt = coord.createWorktree('agent-0', 'b6')
    expect(wt).toBeTruthy()

    // No commits on agent branch — should fast-return
    const result = await coord.mergeWorktree('agent-0', 'b6', wt!.branch, wt!.worktreePath)
    expect(result.merged).toBe(true)
    expect(result.filesChanged).toEqual([])
  })

  it('concurrent merge — two agents merging different files simultaneously', async () => {
    // Create two worktrees
    const wt1 = coord.createWorktree('agent-0', 'c1')
    const wt2 = coord.createWorktree('agent-1', 'c2')
    expect(wt1).toBeTruthy()
    expect(wt2).toBeTruthy()

    // Agent 0 adds file-a.txt
    fs.writeFileSync(path.join(wt1!.worktreePath, 'file-a.txt'), 'from agent-0')
    execSync('git add . && git commit -m "add file-a"', { cwd: wt1!.worktreePath, stdio: 'pipe', env: gitEnv })

    // Agent 1 adds file-b.txt
    fs.writeFileSync(path.join(wt2!.worktreePath, 'file-b.txt'), 'from agent-1')
    execSync('git add . && git commit -m "add file-b"', { cwd: wt2!.worktreePath, stdio: 'pipe', env: gitEnv })

    // Merge both simultaneously — one will succeed via CAS, the other retries
    const [r1, r2] = await Promise.all([
      coord.mergeWorktree('agent-0', 'c1', wt1!.branch, wt1!.worktreePath),
      coord.mergeWorktree('agent-1', 'c2', wt2!.branch, wt2!.worktreePath)
    ])

    expect(r1.merged).toBe(true)
    expect(r2.merged).toBe(true)

    // Both files should be present on the base branch
    expect(fs.existsSync(path.join(tmpDir, 'file-a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'file-b.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'file-a.txt'), 'utf8')).toBe('from agent-0')
    expect(fs.readFileSync(path.join(tmpDir, 'file-b.txt'), 'utf8')).toBe('from agent-1')
  })

  it('stale worktree — agent branched from old commit, base moved forward', async () => {
    const wt = coord.createWorktree('agent-0', 's1')
    expect(wt).toBeTruthy()

    // Advance main after worktree was created
    fs.writeFileSync(path.join(tmpDir, 'main-update.txt'), 'main moved ahead')
    execSync('git add . && git commit -m "main advance"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })

    // Agent makes changes on the stale branch
    fs.writeFileSync(path.join(wt!.worktreePath, 'agent-work.txt'), 'agent work')
    execSync('git add . && git commit -m "agent work"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 's1', wt!.branch, wt!.worktreePath)
    expect(result.merged).toBe(true)

    // Both the main advance and agent work should be present
    expect(fs.existsSync(path.join(tmpDir, 'main-update.txt'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'agent-work.txt'))).toBe(true)
  })

  it('unresolvable branch returns merged=true with empty filesChanged', async () => {
    // Fake a branch that doesn't exist
    const result = await coord.mergeWorktree('agent-0', 'nonexist', 'agent/agent-0/nonexist', '/tmp/fake-wt')
    expect(result.merged).toBe(true)
    expect(result.filesChanged).toEqual([])
  })

  it('concurrent merge — three agents merging non-overlapping files', async () => {
    const wt1 = coord.createWorktree('agent-0', 'd1')
    const wt2 = coord.createWorktree('agent-1', 'd2')
    const wt3 = coord.createWorktree('agent-2', 'd3')
    expect(wt1).toBeTruthy()
    expect(wt2).toBeTruthy()
    expect(wt3).toBeTruthy()

    fs.writeFileSync(path.join(wt1!.worktreePath, 'alpha.txt'), 'a')
    execSync('git add . && git commit -m "alpha"', { cwd: wt1!.worktreePath, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt2!.worktreePath, 'beta.txt'), 'b')
    execSync('git add . && git commit -m "beta"', { cwd: wt2!.worktreePath, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt3!.worktreePath, 'gamma.txt'), 'c')
    execSync('git add . && git commit -m "gamma"', { cwd: wt3!.worktreePath, stdio: 'pipe', env: gitEnv })

    const [r1, r2, r3] = await Promise.all([
      coord.mergeWorktree('agent-0', 'd1', wt1!.branch, wt1!.worktreePath),
      coord.mergeWorktree('agent-1', 'd2', wt2!.branch, wt2!.worktreePath),
      coord.mergeWorktree('agent-2', 'd3', wt3!.branch, wt3!.worktreePath)
    ])

    expect(r1.merged).toBe(true)
    expect(r2.merged).toBe(true)
    expect(r3.merged).toBe(true)

    expect(fs.existsSync(path.join(tmpDir, 'alpha.txt'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'beta.txt'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'gamma.txt'))).toBe(true)
  })

  it('concurrent merge with conflict — first succeeds, second fails', async () => {
    const wt1 = coord.createWorktree('agent-0', 'e1')
    const wt2 = coord.createWorktree('agent-1', 'e2')
    expect(wt1).toBeTruthy()
    expect(wt2).toBeTruthy()

    // Both agents modify the same file
    fs.writeFileSync(path.join(wt1!.worktreePath, 'shared.txt'), 'version-a')
    execSync('git add . && git commit -m "version a"', { cwd: wt1!.worktreePath, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt2!.worktreePath, 'shared.txt'), 'version-b')
    execSync('git add . && git commit -m "version b"', { cwd: wt2!.worktreePath, stdio: 'pipe', env: gitEnv })

    // Merge sequentially — first should succeed, second should conflict
    const r1 = await coord.mergeWorktree('agent-0', 'e1', wt1!.branch, wt1!.worktreePath, { maxRetries: 0 })
    expect(r1.merged).toBe(true)

    const r2 = await coord.mergeWorktree('agent-1', 'e2', wt2!.branch, wt2!.worktreePath, { maxRetries: 0 })
    expect(r2.merged).toBe(false)
    expect(r2.error).toBeTruthy()
  })
})

describe('AgentCoordinator — orphaned worktree cleanup', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes orphaned worktree not owned by any agent', () => {
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const fakePath = path.join(worktreesDir, 'agent-0-orphan1')
    fs.mkdirSync(fakePath)
    fs.writeFileSync(path.join(fakePath, 'file.txt'), 'leftover')

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toContain('agent-0-orphan1')
    expect(fs.existsSync(fakePath)).toBe(false)
  })

  it('preserves worktree owned by an active agent', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'executing',
      currentBeadId: 'b1', currentBeadTitle: 'test', loopCount: 1,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ownedPath = path.join(worktreesDir, 'agent-0-b1')
    fs.mkdirSync(ownedPath)
    fs.writeFileSync(path.join(ownedPath, 'file.txt'), 'in-progress')

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed.length).toBe(0)
    expect(fs.existsSync(ownedPath)).toBe(true)
  })

  it('removes orphans but preserves owned in mixed set', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })

    const owned = path.join(worktreesDir, 'agent-0-b1')
    fs.mkdirSync(owned)

    const orphan = path.join(worktreesDir, 'agent-1-b2')
    fs.mkdirSync(orphan)

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toContain('agent-1-b2')
    expect(removed).not.toContain('agent-0-b1')
    expect(fs.existsSync(owned)).toBe(true)
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('returns empty array when .worktrees dir does not exist', () => {
    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toEqual([])
  })
})

describe('AgentCoordinator — file locks and agent registry', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reserveFiles then releaseFiles round-trips correctly', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts', 'b.ts'])
    expect(coord.readLocks().length).toBe(2)
    coord.releaseFiles('agent-0', 'b1')
    expect(coord.readLocks().length).toBe(0)
  })

  it('lockedFilesByOthers excludes own locks', () => {
    coord.reserveFiles('agent-0', 'b1', ['shared.ts'])
    coord.reserveFiles('agent-1', 'b2', ['other.ts'])
    const locked = coord.lockedFilesByOthers('agent-0')
    expect(locked).toContain('other.ts')
    expect(locked).not.toContain('shared.ts')
  })

  it('deregisterAgent removes agent and releases its locks', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })
    coord.reserveFiles('agent-0', 'b1', ['file.ts'])

    coord.deregisterAgent('agent-0')
    expect(coord.readAgents().length).toBe(0)
    expect(coord.readLocks().length).toBe(0)
  })

  it('activity log appends and reads in order', () => {
    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'hello' })
    coord.postActivity({ agentId: 'agent-0', type: 'stopped', summary: 'bye' })
    const events = coord.readActivity()
    expect(events.length).toBe(2)
    expect(events[0].type).toBe('started')
    expect(events[1].type).toBe('stopped')
  })

  it('reserveFiles replaces previous locks for the same agent+bead', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts', 'b.ts'])
    expect(coord.readLocks().length).toBe(2)
    coord.reserveFiles('agent-0', 'b1', ['c.ts'])
    const locks = coord.readLocks()
    expect(locks.length).toBe(1)
    expect(locks[0].file).toBe('c.ts')
  })

  it('releaseAllForAgent removes all locks for that agent across beads', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.reserveFiles('agent-0', 'b2', ['b.ts'])
    coord.reserveFiles('agent-1', 'b3', ['c.ts'])
    expect(coord.readLocks().length).toBe(3)
    coord.releaseAllForAgent('agent-0')
    const locks = coord.readLocks()
    expect(locks.length).toBe(1)
    expect(locks[0].agentId).toBe('agent-1')
  })

  it('readLocks returns empty array when file does not exist', () => {
    expect(coord.readLocks()).toEqual([])
  })

  it('readAgents returns empty array when file does not exist', () => {
    expect(coord.readAgents()).toEqual([])
  })
})

describe('AgentCoordinator — agent registration', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const makeAgent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
    id: 'agent-0', index: 0, phase: 'idle',
    currentBeadId: null, currentBeadTitle: null, loopCount: 0,
    lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null,
    ...overrides
  })

  it('registerAgent adds a new agent', () => {
    coord.registerAgent(makeAgent())
    const agents = coord.getAgents()
    expect(agents.length).toBe(1)
    expect(agents[0].id).toBe('agent-0')
  })

  it('registerAgent replaces an existing agent with the same id', () => {
    coord.registerAgent(makeAgent({ phase: 'idle' }))
    coord.registerAgent(makeAgent({ phase: 'executing' }))
    const agents = coord.getAgents()
    expect(agents.length).toBe(1)
    expect(agents[0].phase).toBe('executing')
  })

  it('registerAgent supports multiple agents', () => {
    coord.registerAgent(makeAgent({ id: 'agent-0', index: 0 }))
    coord.registerAgent(makeAgent({ id: 'agent-1', index: 1 }))
    coord.registerAgent(makeAgent({ id: 'agent-2', index: 2 }))
    expect(coord.getAgents().length).toBe(3)
  })

  it('updateAgent patches fields and updates lastActivity', () => {
    coord.registerAgent(makeAgent({ phase: 'idle', loopCount: 0 }))
    coord.updateAgent('agent-0', { phase: 'executing', loopCount: 5, currentBeadId: 'b1' })
    const agents = coord.getAgents()
    expect(agents[0].phase).toBe('executing')
    expect(agents[0].loopCount).toBe(5)
    expect(agents[0].currentBeadId).toBe('b1')
  })

  it('updateAgent is a no-op for unknown agent id', () => {
    coord.registerAgent(makeAgent())
    coord.updateAgent('agent-99', { phase: 'executing' })
    const agents = coord.getAgents()
    expect(agents.length).toBe(1)
    expect(agents[0].phase).toBe('idle')
  })

  it('deregisterAgent removes agent and releases all its locks', () => {
    coord.registerAgent(makeAgent({ id: 'agent-0' }))
    coord.registerAgent(makeAgent({ id: 'agent-1', index: 1 }))
    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.reserveFiles('agent-1', 'b2', ['b.ts'])

    coord.deregisterAgent('agent-0')
    expect(coord.getAgents().length).toBe(1)
    expect(coord.getAgents()[0].id).toBe('agent-1')
    const locks = coord.readLocks()
    expect(locks.length).toBe(1)
    expect(locks[0].agentId).toBe('agent-1')
  })
})

describe('AgentCoordinator — activity log', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readActivity returns empty array when file does not exist', () => {
    expect(coord.readActivity()).toEqual([])
  })

  it('postActivity includes a timestamp', () => {
    const before = new Date().toISOString()
    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'go' })
    const events = coord.readActivity()
    expect(events.length).toBe(1)
    expect(events[0].ts >= before).toBe(true)
    expect(events[0].agentId).toBe('agent-0')
    expect(events[0].type).toBe('started')
  })

  it('readActivity respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      coord.postActivity({ agentId: 'agent-0', type: 'executing', summary: `step ${i}` })
    }
    const events = coord.readActivity(3)
    expect(events.length).toBe(3)
    expect(events[0].summary).toBe('step 7')
    expect(events[2].summary).toBe('step 9')
  })

  it('readActivity skips corrupt lines and returns valid entries', () => {
    const activityFile = path.join(slashbotDir, 'activity.jsonl')
    const validEvent = JSON.stringify({ ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', type: 'started', summary: 'ok' })
    fs.writeFileSync(activityFile, validEvent + '\n' + 'NOT_JSON{{{corrupt\n' + validEvent + '\n')
    const events = coord.readActivity()
    expect(events.length).toBe(2)
    expect(events[0].summary).toBe('ok')
    expect(events[1].summary).toBe('ok')
  })

  it('postActivity does not throw when directory does not exist', () => {
    const badCoord = new AgentCoordinator(path.join(tmpDir, 'nonexistent', '.slashbot'), tmpDir)
    ;(badCoord as any).activityFile = path.join(tmpDir, 'no', 'such', 'dir', 'activity.jsonl')
    expect(() => {
      badCoord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'test' })
    }).not.toThrow()
  })

  it('postActivity preserves optional fields', () => {
    coord.postActivity({
      agentId: 'agent-0', type: 'claimed',
      beadId: 'b1', beadTitle: 'Fix bug', summary: 'Claimed bead',
      filesChanged: ['a.ts', 'b.ts'], branch: 'agent/agent-0/b1'
    })
    const events = coord.readActivity()
    expect(events[0].beadId).toBe('b1')
    expect(events[0].beadTitle).toBe('Fix bug')
    expect(events[0].filesChanged).toEqual(['a.ts', 'b.ts'])
    expect(events[0].branch).toBe('agent/agent-0/b1')
  })
})

describe('AgentCoordinator — worktree creation', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates worktree with correct path and branch name', () => {
    const wt = coord.createWorktree('agent-0', 'sb-abc')
    expect(wt).toBeTruthy()
    expect(wt!.branch).toBe('agent/agent-0/sb-abc')
    expect(wt!.worktreePath).toBe(path.join(tmpDir, '.worktrees', 'agent-0-sb-abc'))
    expect(fs.existsSync(wt!.worktreePath)).toBe(true)
  })

  it('worktree has .beads symlink when .beads dir exists', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()
    const beadsLink = path.join(wt!.worktreePath, '.beads')
    expect(fs.existsSync(beadsLink)).toBe(true)
    expect(fs.lstatSync(beadsLink).isSymbolicLink()).toBe(true)
  })

  it('worktree has .slashbot symlink', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()
    const slashbotLink = path.join(wt!.worktreePath, '.slashbot')
    expect(fs.existsSync(slashbotLink)).toBe(true)
    expect(fs.lstatSync(slashbotLink).isSymbolicLink()).toBe(true)
  })

  it('worktree has .slashbotrc symlink when .slashbotrc exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), 'maxCallsPerHour=10')
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()
    const rcLink = path.join(wt!.worktreePath, '.slashbotrc')
    expect(fs.existsSync(rcLink)).toBe(true)
    expect(fs.lstatSync(rcLink).isSymbolicLink()).toBe(true)
  })

  it('worktree .gitignore contains required entries', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()
    const gitignore = fs.readFileSync(path.join(wt!.worktreePath, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.slashbot/')
    expect(gitignore).toContain('.slashbotrc')
    expect(gitignore).toContain('.beads/')
    expect(gitignore).toContain('.worktrees/')
  })

  it('recreates worktree if path already exists (stale worktree)', () => {
    const wt1 = coord.createWorktree('agent-0', 'b1')
    expect(wt1).toBeTruthy()
    const wt2 = coord.createWorktree('agent-0', 'b1')
    expect(wt2).toBeTruthy()
    expect(fs.existsSync(wt2!.worktreePath)).toBe(true)
  })

  it('worktree branch is on the same commit as current HEAD', () => {
    const mainHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim()
    const wt = coord.createWorktree('agent-0', 'b1')
    expect(wt).toBeTruthy()
    const wtHead = execSync('git rev-parse HEAD', { cwd: wt!.worktreePath }).toString().trim()
    expect(wtHead).toBe(mainHead)
  })
})

describe('AgentCoordinator — bead claiming with contention', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const makeBead = (overrides: Partial<Bead> = {}): Bead => ({
    id: 'b1', title: 'Test bead', description: '', type: 'task',
    status: 'ready', deps: [], files: [], priority: 2, tags: [],
    ...overrides
  })

  it('claimBestBead returns null when no beads are available', async () => {
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeNull()
  })

  it('claimBestBead claims the highest-priority bead', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 2 }),
      makeBead({ id: 'b2', priority: 0 }),
      makeBead({ id: 'b3', priority: 1 }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b2')
  })

  it('claimBestBead skips beads with files locked by others', async () => {
    coord.reserveFiles('agent-1', 'other', ['locked.ts'])
    const beads = [
      makeBead({ id: 'b1', priority: 0, files: ['locked.ts'] }),
      makeBead({ id: 'b2', priority: 1, files: ['free.ts'] }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b2')
  })

  it('claimBestBead skips beads claimed by other agents', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 0, claimedBy: 'agent-1' }),
      makeBead({ id: 'b2', priority: 1 }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b2')
  })

  it('claimBestBead falls back to open beads when ready is empty', async () => {
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([makeBead({ id: 'b1', status: 'ready' })])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b1', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b1')
  })

  it('claimBestBead skips beads where assignTo fails', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 0 }),
      makeBead({ id: 'b2', priority: 1 }),
    ]
    let callCount = 0
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockImplementation(() => {
      callCount++
      return callCount > 1
    })
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b2')
  })

  it('claimBestBead posts activity and reserves files on success', async () => {
    const bead = makeBead({ id: 'b1', files: ['src/main.ts'] })
    vi.spyOn(coord.bd, 'ready').mockReturnValue([bead])
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b1', status: 'claimed', claimedBy: 'agent-0' }))

    await coord.claimBestBead('agent-0')
    const locks = coord.readLocks()
    expect(locks.length).toBe(1)
    expect(locks[0].file).toBe('src/main.ts')
    const events = coord.readActivity()
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('claimed')
  })

  it('concurrent claimBestBead calls are serialized by semaphore', async () => {
    const order: string[] = []
    let callNum = 0
    const beads = [
      makeBead({ id: 'b1', priority: 0 }),
      makeBead({ id: 'b2', priority: 1 }),
    ]

    vi.spyOn(coord.bd, 'ready').mockImplementation(() => {
      callNum++
      order.push(`ready-${callNum}`)
      if (callNum === 1) return [beads[0], beads[1]]
      return [beads[1]]
    })
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockImplementation((_id: string) => makeBead({ id: _id, status: 'claimed' }))

    const [r1, r2] = await Promise.all([
      coord.claimBestBead('agent-0'),
      coord.claimBestBead('agent-1'),
    ])

    expect(r1).toBeTruthy()
    expect(r2).toBeTruthy()
    expect(order[0]).toBe('ready-1')
    expect(order[1]).toBe('ready-2')
  })
})

describe('AgentCoordinator — completeBead and failBead', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completeBead calls bd.close, releases files, and logs activity', () => {
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
    expect(coord.readLocks().length).toBe(0)
    const events = coord.readActivity()
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].type).toBe('completed')
    expect(events[0].summary).toContain('b1')
  })

  it('failBead calls bd.addLabel + bd.close, releases files, and logs activity', () => {
    const addLabelSpy = vi.spyOn(coord.bd, 'addLabel').mockImplementation(() => {})
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.failBead('agent-0', 'b1', 'merge conflict')

    expect(addLabelSpy).toHaveBeenCalledWith('b1', 'failed')
    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
    expect(coord.readLocks().length).toBe(0)
    const events = coord.readActivity()
    expect(events[0].type).toBe('failed')
    expect(events[0].summary).toBe('merge conflict')
  })
})

describe('AgentCoordinator — hasOpenWork and getStats', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('hasOpenWork returns true when open beads exist', () => {
    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'open') return [{ id: 'b1' }] as any
      return []
    })
    expect(coord.hasOpenWork()).toBe(true)
  })

  it('hasOpenWork returns true when in_progress beads exist', () => {
    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'open') return []
      if (status === 'in_progress') return [{ id: 'b1' }] as any
      return []
    })
    expect(coord.hasOpenWork()).toBe(true)
  })

  it('hasOpenWork returns false when no open or in_progress beads', () => {
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    expect(coord.hasOpenWork()).toBe(false)
  })

  it('getStats delegates to bd.stats()', () => {
    const expected = { total: 5, pending: 1, ready: 2, claimed: 1, done: 1, failed: 0, pct: 20 }
    vi.spyOn(coord.bd, 'stats').mockReturnValue(expected)
    expect(coord.getStats()).toEqual(expected)
  })
})
