import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Ensure real modules are used even if other test files mock them

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'
import { AgentInfo, Bead } from '../types'
import { ProjectPaths } from './ProjectStore'

let tmpDir: string
let tmpPaths: ProjectPaths
let coord: AgentCoordinator

function makeTmpGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test')
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' })

  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  return dir
}

/** Build a ProjectPaths pointing storeDir inside the tmp project (co-located for test simplicity). */
function makeTmpPaths(projectDir: string): ProjectPaths {
  const storeDir = path.join(projectDir, '.slashbot')
  fs.mkdirSync(path.join(storeDir, 'logs'), { recursive: true })
  return {
    id: 'test-id',
    projectRoot: projectDir,
    storeDir,
    logsDir: path.join(storeDir, 'logs'),
    circuitBreakerState: path.join(storeDir, '.circuit_breaker_state'),
    callCount: path.join(storeDir, '.call_count'),
    activity: path.join(storeDir, 'activity.jsonl'),
    knowledge: path.join(storeDir, 'knowledge.jsonl'),
    agents: path.join(storeDir, 'agents.json'),
    fileLocks: path.join(storeDir, 'file_locks.json'),
    configDir: path.join(storeDir, 'config'),
    slashbotrc: path.join(storeDir, 'config', '.slashbotrc'),
    mail: path.join(storeDir, 'mail.jsonl'),
    worktreesDir: path.join(projectDir, '.worktrees'),
    beadsRoot: path.join(projectDir, '.beads'),
    agentMd: path.join(storeDir, 'config', 'AGENT.md'),
  }
}

describe('AgentCoordinator — atomic writes', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writeLocks is atomic — no .tmp file left behind', () => {
    coord.writeLocks([{ file: 'a.ts', agentId: 'agent-0', beadId: 'b1', reservedAt: new Date().toISOString() }])
    const lockFile = tmpPaths.fileLocks
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
    const agentsFile = tmpPaths.agents
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    expect(result.commitSha).toBeDefined()
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
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

  it('auto-resolves conflict with --theirs when no claudeCmd', async () => {
    const wt = coord.createWorktree('agent-0', 'b2')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'main version')
    execSync('git add . && git commit -m "main change"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt!.worktreePath, 'conflict.txt'), 'agent version')
    execSync('git add . && git commit -m "agent change"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b2', wt!.branch, wt!.worktreePath, { maxRetries: 1 })
    expect(result.merged).toBe(true)
    // Agent version wins via --theirs fallback
    const content = fs.readFileSync(path.join(tmpDir, 'conflict.txt'), 'utf8')
    expect(content).toBe('agent version')
  })

  it('auto-resolves conflict even with maxRetries=0', async () => {
    const wt = coord.createWorktree('agent-0', 'b3')
    expect(wt).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'main')
    execSync('git add . && git commit -m "main"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    fs.writeFileSync(path.join(wt!.worktreePath, 'x.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', { cwd: wt!.worktreePath, stdio: 'pipe', env: gitEnv })

    const result = await coord.mergeWorktree('agent-0', 'b3', wt!.branch, wt!.worktreePath, { maxRetries: 0 })
    expect(result.merged).toBe(true)
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
    expect(result.commitSha).toBeUndefined()
  })

  it('no-op merge (no new commits) returns no commitSha', async () => {
    const wt = coord.createWorktree('agent-0', 'noop1')
    expect(wt).toBeTruthy()
    // Don't make any commits in the worktree
    const result = await coord.mergeWorktree('agent-0', 'noop1', wt!.branch, wt!.worktreePath)
    expect(result.merged).toBe(true)
    expect(result.commitSha).toBeUndefined()
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

  it('concurrent merge with conflict — both succeed via --theirs fallback', async () => {
    const wt1 = coord.createWorktree('agent-0', 'e1')
    const wt2 = coord.createWorktree('agent-1', 'e2')
    expect(wt1).toBeTruthy()
    expect(wt2).toBeTruthy()

    // Both agents modify the same file
    fs.writeFileSync(path.join(wt1!.worktreePath, 'shared.txt'), 'version-a')
    execSync('git add . && git commit -m "version a"', { cwd: wt1!.worktreePath, stdio: 'pipe', env: gitEnv })

    fs.writeFileSync(path.join(wt2!.worktreePath, 'shared.txt'), 'version-b')
    execSync('git add . && git commit -m "version b"', { cwd: wt2!.worktreePath, stdio: 'pipe', env: gitEnv })

    // Merge sequentially — first succeeds normally, second auto-resolves with --theirs
    const r1 = await coord.mergeWorktree('agent-0', 'e1', wt1!.branch, wt1!.worktreePath, { maxRetries: 0 })
    expect(r1.merged).toBe(true)

    const r2 = await coord.mergeWorktree('agent-1', 'e2', wt2!.branch, wt2!.worktreePath, { maxRetries: 0 })
    expect(r2.merged).toBe(true)
    // Second agent's version wins
    const content = fs.readFileSync(path.join(tmpDir, 'shared.txt'), 'utf8')
    expect(content).toBe('version-b')
  })
})

describe('AgentCoordinator — orphaned worktree cleanup', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    const activityFile = tmpPaths.activity
    const validEvent = JSON.stringify({ ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', type: 'started', summary: 'ok' })
    fs.writeFileSync(activityFile, validEvent + '\n' + 'NOT_JSON{{{corrupt\n' + validEvent + '\n')
    // Recreate coordinator so it seeds its cache from the file (including corrupt lines)
    const freshCoord = new AgentCoordinator(tmpPaths)
    const events = freshCoord.readActivity()
    expect(events.length).toBe(2)
    expect(events[0].summary).toBe('ok')
    expect(events[1].summary).toBe('ok')
  })

  it('postActivity does not throw when directory does not exist', () => {
    const badPaths = { ...tmpPaths, storeDir: path.join(tmpDir, 'nonexistent', '.slashbot') }
    const badCoord = new AgentCoordinator(badPaths)
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
    // listAll is called inside claimBestBead to count open children per epic
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])
    // claimBestBead uses async bd methods — wire them to delegate to the sync mocks.
    // claimBestBead calls listByStatus('open') for candidates, so when tests mock
    // ready() with beads, return those for 'open' status too.
    vi.spyOn(coord.bd, 'readyAsync').mockImplementation(async () => coord.bd.ready())
    vi.spyOn(coord.bd, 'listByStatusAsync').mockImplementation(async (s: string) => {
      if (s === 'open') {
        const readyBeads = coord.bd.ready()
        if (readyBeads.length > 0) return readyBeads
      }
      return coord.bd.listByStatus(s)
    })
    vi.spyOn(coord.bd, 'listAllAsync').mockImplementation(async () => coord.bd.listAll())
    vi.spyOn(coord.bd, 'assignToAsync').mockImplementation(async (id: string, a: string) => coord.bd.assignTo(id, a))
    vi.spyOn(coord.bd, 'showAsync').mockImplementation(async (id: string) => coord.bd.show(id))
    vi.spyOn(coord.bd, 'getStateAsync').mockImplementation(async (id: string, k: string) => coord.bd.getState(id, k))
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

  it('claimBestBead prefers earlier createdAt when priority ties (FIFO)', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 1, createdAt: '2026-03-22T12:00:00Z' }),
      makeBead({ id: 'b2', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
      makeBead({ id: 'b3', priority: 1, createdAt: '2026-03-22T11:00:00Z' }),
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

  it('claimBestBead sorts undefined createdAt after defined createdAt', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 1 }), // no createdAt
      makeBead({ id: 'b2', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
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

  it('claimBestBead uses numeric ID as final tiebreaker', async () => {
    const beads = [
      makeBead({ id: '10', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
      makeBead({ id: '2', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: '2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('2')
  })

  it('claimBestBead uses localeCompare for non-numeric IDs', async () => {
    const beads = [
      makeBead({ id: 'xyz', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
      makeBead({ id: 'abc', priority: 1, createdAt: '2026-03-22T10:00:00Z' }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'abc', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('abc')
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

  it('claimBestBead picks higher priority over earlier createdAt (priority overrides FIFO)', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 2, createdAt: '2026-03-22T08:00:00Z' }), // older but lower priority
      makeBead({ id: 'b2', priority: 0, createdAt: '2026-03-22T12:00:00Z' }), // newer but higher priority
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

  it('claimBestBead picks fewer retries over higher priority (retry overrides FIFO and priority)', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 0, createdAt: '2026-03-22T08:00:00Z' }), // best priority, oldest, but retried
      makeBead({ id: 'b2', priority: 2, createdAt: '2026-03-22T12:00:00Z' }), // worse priority, newer, no retries
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockImplementation((id: string) => {
      if (id === 'b1') return '2'
      return ''
    })
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockReturnValue(makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('b2')
  })

  it('claimBestBead processes Plan 1 beads (ids 1-3) before Plan 2 beads (ids 4-6) via FIFO + ID ordering', async () => {
    // Simulate two plans: Plan 1 created earlier with ids 1-3, Plan 2 created later with ids 4-6
    // All same priority, no retries — ordering should be by createdAt then numeric ID
    const plan1Time = '2026-03-22T10:00:00Z'
    const plan2Time = '2026-03-22T11:00:00Z'
    const beads = [
      makeBead({ id: '4', priority: 2, createdAt: plan2Time }),
      makeBead({ id: '2', priority: 2, createdAt: plan1Time }),
      makeBead({ id: '6', priority: 2, createdAt: plan2Time }),
      makeBead({ id: '1', priority: 2, createdAt: plan1Time }),
      makeBead({ id: '5', priority: 2, createdAt: plan2Time }),
      makeBead({ id: '3', priority: 2, createdAt: plan1Time }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')

    // Track the order assignTo is called
    const assignOrder: string[] = []
    vi.spyOn(coord.bd, 'assignTo').mockImplementation((id: string) => {
      assignOrder.push(id)
      return true
    })
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) =>
      makeBead({ id, status: 'claimed', claimedBy: 'agent-0' })
    )

    // First claim should be id '1' (Plan 1, earliest time, lowest numeric ID)
    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('1')

    // Verify the sort order by checking candidates are tried in the right sequence
    // The sort produces: 1, 2, 3 (Plan 1 by time+id), then 4, 5, 6 (Plan 2 by time+id)
    expect(assignOrder[0]).toBe('1')
  })

  it('claimBestBead exhausts Plan 1 beads before Plan 2 beads in multi-plan scenario', async () => {
    const plan1Time = '2026-03-22T10:00:00Z'
    const plan2Time = '2026-03-22T11:00:00Z'
    // Register the claiming agents as live so their beads are respected
    coord.registerAgent({ id: 'agent-1', index: 1, phase: 'executing', currentBeadId: '1', currentBeadTitle: '', loopCount: 1, lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null })
    coord.registerAgent({ id: 'agent-2', index: 2, phase: 'executing', currentBeadId: '2', currentBeadTitle: '', loopCount: 1, lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null })
    // Plan 1 beads are all claimed/locked except id '3', Plan 2 has id '4' available
    const beads = [
      makeBead({ id: '1', priority: 2, createdAt: plan1Time, claimedBy: 'agent-1' }),
      makeBead({ id: '2', priority: 2, createdAt: plan1Time, claimedBy: 'agent-2' }),
      makeBead({ id: '3', priority: 2, createdAt: plan1Time }),
      makeBead({ id: '4', priority: 2, createdAt: plan2Time }),
      makeBead({ id: '5', priority: 2, createdAt: plan2Time }),
      makeBead({ id: '6', priority: 2, createdAt: plan2Time }),
    ]
    vi.spyOn(coord.bd, 'ready').mockReturnValue(beads)
    vi.spyOn(coord.bd, 'listByStatus').mockReturnValue([])
    vi.spyOn(coord.bd, 'getState').mockReturnValue('')
    vi.spyOn(coord.bd, 'assignTo').mockReturnValue(true)
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) =>
      makeBead({ id, status: 'claimed', claimedBy: 'agent-0' })
    )

    // Should pick '3' (last unclaimed Plan 1 bead) before any Plan 2 bead
    const result = await coord.claimBestBead('agent-0')
    expect(result).toBeTruthy()
    expect(result!.id).toBe('3')
  })
})

describe('AgentCoordinator — completeBead and failBead', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completeBead calls bd.close, releases files, and logs activity', async () => {
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
    expect(coord.readLocks().length).toBe(0)
    const events = coord.readActivity()
    const completed = events.find(e => e.type === 'completed')
    expect(completed).toBeDefined()
    expect(completed!.summary).toContain('b1')
  })

  it('commitAndPush returns the commit SHA after a successful commit', async () => {
    // Create a file change so there's something to commit
    fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'hello')
    const sha = await coord.commitAndPush('agent-0', 'b1', false)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('commitAndPush returns null when there is nothing to commit', async () => {
    const sha = await coord.commitAndPush('agent-0', 'b1', false)
    expect(sha).toBeNull()
  })

  it('completeBead includes commitSha in activity event when changes exist', async () => {
    vi.spyOn(coord.bd, 'close').mockImplementation(() => {})
    // Create a file change so commitAndPush produces a SHA
    fs.writeFileSync(path.join(tmpDir, 'changed.txt'), 'data')

    await coord.completeBead('agent-0', 'b1', ['changed.txt'], false)

    const events = coord.readActivity()
    const completed = events.find(e => e.type === 'completed')
    expect(completed).toBeDefined()
    expect(completed!.commitSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('commitAndPush returns null when nothing is staged', async () => {
    // Commit everything first so the working tree is clean
    execSync('git add -A && git commit -m "clean" --allow-empty', { cwd: tmpDir, stdio: 'pipe' })
    const sha = await coord.commitAndPush('agent-0', 'b1', false)
    expect(sha).toBeNull()
  })

  it('concurrent commitAndPush calls are serialized by semaphore', async () => {
    // Create a file so the first call has something to commit
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'a')

    const [r1, r2] = await Promise.all([
      coord.commitAndPush('agent-0', 'b1', false),
      coord.commitAndPush('agent-1', 'b2', false),
    ])

    // Because of serialization, only the first caller commits; the second finds nothing staged
    const results = [r1, r2]
    expect(results.filter(r => r !== null).length).toBe(1)
    expect(results.filter(r => r === null).length).toBe(1)
  })

  it('does not close bead when commitAndPush fails, but does release file locks', async () => {
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})
    const releaseSpy = vi.spyOn(coord, 'releaseFiles')
    vi.spyOn(coord, 'commitAndPush').mockRejectedValue(new Error('git commit failed'))

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    await expect(coord.completeBead('agent-0', 'b1', ['a.ts'], false)).rejects.toThrow('git commit failed')

    expect(closeSpy).not.toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalledWith('agent-0', 'b1')
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
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
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

describe('AgentCoordinator — activity cache', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('seeds cache from existing JSONL on construction', () => {
    const activityFile = tmpPaths.activity
    const entries = [
      { ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', type: 'started', summary: 'one' },
      { ts: '2026-01-01T00:01:00Z', agentId: 'agent-0', type: 'stopped', summary: 'two' },
    ]
    fs.writeFileSync(activityFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    coord = new AgentCoordinator(tmpPaths)
    const events = coord.readActivity(10)
    expect(events.length).toBe(2)
    expect(events[0].summary).toBe('one')
    expect(events[1].summary).toBe('two')
  })

  it('caps cache at 1000 entries, keeping newest', () => {
    coord = new AgentCoordinator(tmpPaths)
    for (let i = 0; i < 1050; i++) {
      coord.postActivity({ agentId: 'agent-0', type: 'executing', summary: `step-${i}` })
    }
    const events = coord.readActivity(2000)
    expect(events.length).toBe(1000)
    expect(events[0].summary).toBe('step-50')
    expect(events[999].summary).toBe('step-1049')
  })

  it('cache still works when disk write fails', () => {
    coord = new AgentCoordinator(tmpPaths)
    // Point activity file to a non-existent directory so disk writes fail
    ;(coord as any).activityFile = path.join(tmpDir, 'no', 'such', 'dir', 'activity.jsonl')

    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'cached-only' })
    const events = coord.readActivity()
    expect(events.length).toBe(1)
    expect(events[0].summary).toBe('cached-only')
  })

  it('readActivity returns from cache without re-reading disk', () => {
    coord = new AgentCoordinator(tmpPaths)
    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'hello' })

    // Delete the file on disk — readActivity should still return the cached entry
    const activityFile = tmpPaths.activity
    if (fs.existsSync(activityFile)) fs.unlinkSync(activityFile)

    const events = coord.readActivity()
    expect(events.length).toBe(1)
    expect(events[0].summary).toBe('hello')
  })
})

describe('AgentCoordinator — knowledge log', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readKnowledge returns empty array when no entries exist', () => {
    expect(coord.readKnowledge()).toEqual([])
  })

  it('postKnowledge adds entry with timestamp and reads it back', () => {
    const before = new Date().toISOString()
    coord.postKnowledge({
      agentId: 'agent-0', beadId: 'b1', category: 'pattern',
      summary: 'Use factory pattern', detail: 'Factories are used everywhere', confidence: 'high'
    })
    const entries = coord.readKnowledge()
    expect(entries.length).toBe(1)
    expect(entries[0].ts >= before).toBe(true)
    expect(entries[0].agentId).toBe('agent-0')
    expect(entries[0].category).toBe('pattern')
    expect(entries[0].summary).toBe('Use factory pattern')
    expect(entries[0].confidence).toBe('high')
  })

  it('readKnowledge respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      coord.postKnowledge({
        agentId: 'agent-0', beadId: 'b1', category: 'gotcha',
        summary: `gotcha ${i}`, detail: '', confidence: 'medium'
      })
    }
    const entries = coord.readKnowledge(3)
    expect(entries.length).toBe(3)
    expect(entries[0].summary).toBe('gotcha 7')
    expect(entries[2].summary).toBe('gotcha 9')
  })

  it('caps cache at 200 entries, keeping newest', () => {
    for (let i = 0; i < 220; i++) {
      coord.postKnowledge({
        agentId: 'agent-0', beadId: 'b1', category: 'convention',
        summary: `conv-${i}`, detail: '', confidence: 'low'
      })
    }
    const entries = coord.readKnowledge(500)
    expect(entries.length).toBe(200)
    expect(entries[0].summary).toBe('conv-20')
    expect(entries[199].summary).toBe('conv-219')
  })

  it('seeds cache from existing JSONL on construction', () => {
    const knowledgeFile = tmpPaths.knowledge
    const entries = [
      { ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', beadId: 'b1', category: 'risk', summary: 'one', detail: '', confidence: 'high' },
      { ts: '2026-01-01T00:01:00Z', agentId: 'agent-0', beadId: 'b2', category: 'dependency', summary: 'two', detail: '', confidence: 'medium' },
    ]
    fs.writeFileSync(knowledgeFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

    const freshCoord = new AgentCoordinator(tmpPaths)
    const result = freshCoord.readKnowledge(10)
    expect(result.length).toBe(2)
    expect(result[0].summary).toBe('one')
    expect(result[1].summary).toBe('two')
  })

  it('skips corrupt lines when loading from disk', () => {
    const knowledgeFile = tmpPaths.knowledge
    const valid = JSON.stringify({ ts: '2026-01-01T00:00:00Z', agentId: 'agent-0', beadId: 'b1', category: 'pattern', summary: 'ok', detail: '', confidence: 'high' })
    fs.writeFileSync(knowledgeFile, valid + '\n' + 'CORRUPT{{{line\n' + valid + '\n')

    const freshCoord = new AgentCoordinator(tmpPaths)
    const result = freshCoord.readKnowledge()
    expect(result.length).toBe(2)
  })

  it('postKnowledge does not throw when disk write fails', () => {
    ;(coord as any).knowledgeFile = path.join(tmpDir, 'no', 'such', 'dir', 'knowledge.jsonl')
    expect(() => {
      coord.postKnowledge({
        agentId: 'agent-0', beadId: 'b1', category: 'environment',
        summary: 'cached-only', detail: '', confidence: 'low'
      })
    }).not.toThrow()
    // Still available in cache
    const entries = coord.readKnowledge()
    expect(entries.length).toBe(1)
    expect(entries[0].summary).toBe('cached-only')
  })

  it('persists to disk as JSONL', () => {
    coord.postKnowledge({
      agentId: 'agent-0', beadId: 'b1', category: 'pattern',
      summary: 'test persist', detail: 'detail here', confidence: 'high'
    })
    const knowledgeFile = tmpPaths.knowledge
    expect(fs.existsSync(knowledgeFile)).toBe(true)
    const lines = fs.readFileSync(knowledgeFile, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.summary).toBe('test persist')
    expect(parsed.detail).toBe('detail here')
  })

  it('rapid sequential postKnowledge calls do not lose data', () => {
    const count = 50
    for (let i = 0; i < count; i++) {
      coord.postKnowledge({
        agentId: `agent-${i % 3}`, beadId: `b${i}`, category: 'pattern',
        summary: `rapid-${i}`, detail: '', confidence: 'high'
      })
    }
    // All entries present in cache
    const entries = coord.readKnowledge(count)
    expect(entries.length).toBe(count)
    // Ordered correctly
    for (let i = 0; i < count; i++) {
      expect(entries[i].summary).toBe(`rapid-${i}`)
    }
    // All entries present on disk
    const knowledgeFile = tmpPaths.knowledge
    const lines = fs.readFileSync(knowledgeFile, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(count)
    // Each line is distinct and parseable
    const summaries = lines.map(l => JSON.parse(l).summary)
    expect(new Set(summaries).size).toBe(count)
  })
})

describe('AgentCoordinator — rollbackBead', () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }

  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reverts commits and reopens bead', () => {
    // Create a commit that simulates agent work
    fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "agent work"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    // Post activity events simulating a merge+complete cycle
    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })
    coord.postActivity({ agentId: 'agent-0', type: 'completed', beadId: 'b1', commitSha: sha, summary: 'Completed' })

    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    expect(result.revertedShas.length).toBe(1)
    expect(result.revertedShas[0]).toBe(sha)

    // Verify the file was reverted (no longer present or contents changed)
    const log = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(log).toContain('Revert')

    expect(reopenSpy).toHaveBeenCalledWith('b1', expect.stringContaining('Rolled back'))

    // Verify rollback activity event was posted
    const events = coord.readActivity()
    const rollbackEvent = events.find(e => e.type === 'rollback' && e.summary?.includes('reverted'))
    expect(rollbackEvent).toBeDefined()
  })

  it('deduplicates SHAs from merged and completed events', () => {
    fs.writeFileSync(path.join(tmpDir, 'dup.ts'), 'dup')
    execSync('git add . && git commit -m "dup work"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    // Same SHA on both merged and completed
    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })
    coord.postActivity({ agentId: 'agent-0', type: 'completed', beadId: 'b1', commitSha: sha, summary: 'Completed' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    // Should only revert once despite two events with same SHA
    expect(result.revertedShas.length).toBe(1)
  })

  it('returns error when no SHAs found', () => {
    // No activity events for this bead
    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(false)
    expect(result.error).toContain('No commit SHAs found')
  })

  it('filters events — only considers events after last failed event', () => {
    // First attempt: commit and fail
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'old work')
    execSync('git add old.ts && git commit -m "old work"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const oldSha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: oldSha, summary: 'Merged attempt 1' })
    coord.postActivity({ agentId: 'agent-0', type: 'completed', beadId: 'b1', commitSha: oldSha, summary: 'Completed attempt 1' })
    coord.postActivity({ agentId: 'agent-0', type: 'failed', beadId: 'b1', summary: 'Failed attempt 1' })

    // Second attempt: new commit
    fs.writeFileSync(path.join(tmpDir, 'new.ts'), 'new work')
    execSync('git add new.ts && git commit -m "new work"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: newSha, summary: 'Merged attempt 2' })
    coord.postActivity({ agentId: 'agent-0', type: 'completed', beadId: 'b1', commitSha: newSha, summary: 'Completed attempt 2' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    // Should only revert the new SHA, not the old one
    expect(result.revertedShas).toEqual([newSha])
    expect(result.revertedShas).not.toContain(oldSha)
  })

  it('aborts on conflict and returns partial result', () => {
    // Create a commit
    fs.writeFileSync(path.join(tmpDir, 'conflict.ts'), 'original')
    execSync('git add . && git commit -m "original"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    // Modify the same file again so reverting the first commit will conflict
    fs.writeFileSync(path.join(tmpDir, 'conflict.ts'), 'modified heavily\nwith extra lines\nand more content')
    execSync('git add . && git commit -m "modify"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(false)
    expect(result.error).toContain('Conflict reverting')
  })

  it('releases file locks after rollback', () => {
    fs.writeFileSync(path.join(tmpDir, 'locked.ts'), 'locked content')
    execSync('git add . && git commit -m "locked"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.reserveFiles('agent-0', 'b1', ['locked.ts'])
    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    coord.rollbackBead('agent-0', 'b1')
    expect(coord.readLocks().length).toBe(0)
  })

  it('reverts multiple SHAs in reverse chronological order', () => {
    // Create two commits
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), 'content1')
    execSync('git add . && git commit -m "first"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha1 = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    fs.writeFileSync(path.join(tmpDir, 'file2.ts'), 'content2')
    execSync('git add . && git commit -m "second"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha2 = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha1, summary: 'Merged 1' })
    coord.postActivity({ agentId: 'agent-0', type: 'completed', beadId: 'b1', commitSha: sha2, summary: 'Completed' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    expect(result.revertedShas.length).toBe(2)
    // Reversed: sha2 (latest) should be reverted first, then sha1
    expect(result.revertedShas[0]).toBe(sha2)
    expect(result.revertedShas[1]).toBe(sha1)

    // Both files should be removed after revert
    expect(fs.existsSync(path.join(tmpDir, 'file1.ts'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'file2.ts'))).toBe(false)
  })

  it('handles bd.reopen failure gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'graceful.ts'), 'content')
    execSync('git add . && git commit -m "graceful"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => { throw new Error('bd reopen failed') })

    // Should not throw even if bd.reopen fails
    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    expect(result.revertedShas.length).toBe(1)
  })

  it('filters events after last rollback event too', () => {
    fs.writeFileSync(path.join(tmpDir, 'v1.ts'), 'v1')
    execSync('git add v1.ts && git commit -m "v1"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha1 = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha1, summary: 'Merged v1' })
    coord.postActivity({ agentId: 'agent-0', type: 'rollback', beadId: 'b1', summary: 'Rolled back v1' })

    // New attempt after rollback
    fs.writeFileSync(path.join(tmpDir, 'v2.ts'), 'v2')
    execSync('git add v2.ts && git commit -m "v2"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha2 = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha2, summary: 'Merged v2' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(true)
    expect(result.revertedShas).toEqual([sha2])
    expect(result.revertedShas).not.toContain(sha1)
  })

  it('releases file locks even when rollback fails due to conflict', () => {
    fs.writeFileSync(path.join(tmpDir, 'conflict.ts'), 'original')
    execSync('git add . && git commit -m "original"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })
    const sha = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()

    // Modify same file so revert will conflict
    fs.writeFileSync(path.join(tmpDir, 'conflict.ts'), 'modified heavily\nwith extra lines\nand more content')
    execSync('git add . && git commit -m "modify"', { cwd: tmpDir, stdio: 'pipe', env: gitEnv })

    coord.reserveFiles('agent-0', 'b1', ['conflict.ts'])
    coord.postActivity({ agentId: 'agent-0', type: 'merged', beadId: 'b1', commitSha: sha, summary: 'Merged' })

    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    const result = coord.rollbackBead('agent-0', 'b1')
    expect(result.reverted).toBe(false)
    expect(result.error).toContain('Conflict')
    // Locks should still be released on failure
    expect(coord.readLocks().length).toBe(0)
  })
})

describe('AgentCoordinator — idempotent bead operations', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completeBead skips bd.close and commitAndPush when bead is already done', async () => {
    const showSpy = vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'done', deps: [], files: [], priority: 2, tags: []
    })
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(showSpy).toHaveBeenCalledWith('b1')
    expect(closeSpy).not.toHaveBeenCalled()
    // File locks should still be released
    expect(coord.readLocks().length).toBe(0)
    // Activity event should still be posted
    const events = coord.readActivity()
    const completed = events.find(e => e.type === 'completed')
    expect(completed).toBeDefined()
    expect(completed!.summary).toContain('already done')
  })

  it('completeBead proceeds normally when bead is not yet done', async () => {
    vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'claimed', deps: [], files: [], priority: 2, tags: []
    })
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
  })

  it('completeBead proceeds when bd.show throws (bead not found)', async () => {
    vi.spyOn(coord.bd, 'show').mockImplementation(() => { throw new Error('not found') })
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(closeSpy).toHaveBeenCalled()
  })

  it('reopenBead skips bd.reopen when bead is already open', () => {
    const showSpy = vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'ready', deps: [], files: [], priority: 2, tags: []
    })
    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.reopenBead('agent-0', 'b1')

    expect(showSpy).toHaveBeenCalledWith('b1')
    expect(reopenSpy).not.toHaveBeenCalled()
    // File locks should still be released
    expect(coord.readLocks().length).toBe(0)
  })

  it('reopenBead proceeds normally when bead is not open', () => {
    vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'done', deps: [], files: [], priority: 2, tags: []
    })
    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    coord.reopenBead('agent-0', 'b1')

    expect(reopenSpy).toHaveBeenCalledWith('b1', expect.any(String))
  })

  it('reopenBead proceeds when bd.show throws (bead not found)', () => {
    vi.spyOn(coord.bd, 'show').mockImplementation(() => { throw new Error('not found') })
    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    coord.reopenBead('agent-0', 'b1')

    expect(reopenSpy).toHaveBeenCalled()
  })

  it('failBead skips bd.addLabel and bd.close when bead is already failed', () => {
    const showSpy = vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'failed', deps: [], files: [], priority: 2, tags: ['failed']
    })
    const addLabelSpy = vi.spyOn(coord.bd, 'addLabel').mockImplementation(() => {})
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.failBead('agent-0', 'b1', 'timeout')

    expect(showSpy).toHaveBeenCalledWith('b1')
    expect(addLabelSpy).not.toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
    // File locks should still be released
    expect(coord.readLocks().length).toBe(0)
    // Activity event should still be posted
    const events = coord.readActivity()
    const failed = events.find(e => e.type === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.summary).toContain('already failed')
  })

  it('failBead proceeds normally when bead is not yet failed', () => {
    vi.spyOn(coord.bd, 'show').mockReturnValue({
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'claimed', deps: [], files: [], priority: 2, tags: []
    })
    const addLabelSpy = vi.spyOn(coord.bd, 'addLabel').mockImplementation(() => {})
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.failBead('agent-0', 'b1', 'timeout')

    expect(addLabelSpy).toHaveBeenCalledWith('b1', 'failed')
    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
  })

  it('failBead proceeds when bd.show throws (bead not found)', () => {
    vi.spyOn(coord.bd, 'show').mockImplementation(() => { throw new Error('not found') })
    const addLabelSpy = vi.spyOn(coord.bd, 'addLabel').mockImplementation(() => {})
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    coord.failBead('agent-0', 'b1', 'timeout')

    expect(addLabelSpy).toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalled()
  })
})

describe('AgentCoordinator — activity indexes', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readActivityForBead returns events filtered by beadId', () => {
    coord.postActivity({ agentId: 'a0', type: 'claimed', beadId: 'b1', summary: 'claimed b1' })
    coord.postActivity({ agentId: 'a0', type: 'executing', beadId: 'b2', summary: 'exec b2' })
    coord.postActivity({ agentId: 'a1', type: 'completed', beadId: 'b1', summary: 'done b1' })

    const b1Events = coord.readActivityForBead('b1')
    expect(b1Events.length).toBe(2)
    expect(b1Events.every(e => e.beadId === 'b1')).toBe(true)

    const b2Events = coord.readActivityForBead('b2')
    expect(b2Events.length).toBe(1)
    expect(b2Events[0].beadId).toBe('b2')
  })

  it('readActivityForAgent returns events filtered by agentId', () => {
    coord.postActivity({ agentId: 'a0', type: 'claimed', beadId: 'b1' })
    coord.postActivity({ agentId: 'a1', type: 'claimed', beadId: 'b2' })
    coord.postActivity({ agentId: 'a0', type: 'completed', beadId: 'b1' })

    const a0Events = coord.readActivityForAgent('a0')
    expect(a0Events.length).toBe(2)
    expect(a0Events.every(e => e.agentId === 'a0')).toBe(true)

    const a1Events = coord.readActivityForAgent('a1')
    expect(a1Events.length).toBe(1)
  })

  it('readActivityForBead returns empty array for unknown bead', () => {
    expect(coord.readActivityForBead('nonexistent')).toEqual([])
  })

  it('readActivityForAgent returns empty array for unknown agent', () => {
    expect(coord.readActivityForAgent('nonexistent')).toEqual([])
  })

  it('readActivityForBead respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      coord.postActivity({ agentId: 'a0', type: 'executing', beadId: 'b1', summary: `step ${i}` })
    }

    const limited = coord.readActivityForBead('b1', 3)
    expect(limited.length).toBe(3)
    // Should return the last 3 events
    expect(limited[0].summary).toBe('step 7')
    expect(limited[2].summary).toBe('step 9')
  })

  it('readActivityForAgent respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      coord.postActivity({ agentId: 'a0', type: 'executing', beadId: `b${i}` })
    }

    const limited = coord.readActivityForAgent('a0', 5)
    expect(limited.length).toBe(5)
  })

  it('per-key index is capped at 200 entries via postActivity', () => {
    for (let i = 0; i < 210; i++) {
      coord.postActivity({ agentId: 'a0', type: 'executing', beadId: 'b1', summary: `e${i}` })
    }

    const events = coord.readActivityForBead('b1', 300)
    expect(events.length).toBe(200)
    // Oldest events should have been evicted — first remaining is e10
    expect(events[0].summary).toBe('e10')
    expect(events[199].summary).toBe('e209')
  })

  it('per-agent index is capped at 200 entries via postActivity', () => {
    for (let i = 0; i < 210; i++) {
      coord.postActivity({ agentId: 'a0', type: 'executing', beadId: `b${i}` })
    }

    const events = coord.readActivityForAgent('a0', 300)
    expect(events.length).toBe(200)
  })

  it('indexes are populated from disk on construction', () => {
    // Post some events via the first coordinator
    coord.postActivity({ agentId: 'a0', type: 'claimed', beadId: 'b1' })
    coord.postActivity({ agentId: 'a1', type: 'executing', beadId: 'b2' })
    coord.postActivity({ agentId: 'a0', type: 'completed', beadId: 'b1' })

    // Create a new coordinator that reads from the same disk file
    const coord2 = new AgentCoordinator(tmpPaths)

    const b1Events = coord2.readActivityForBead('b1')
    expect(b1Events.length).toBe(2)

    const a1Events = coord2.readActivityForAgent('a1')
    expect(a1Events.length).toBe(1)
  })

  it('events without beadId are not indexed by bead but are indexed by agent', () => {
    coord.postActivity({ agentId: 'a0', type: 'started', summary: 'agent started' })

    expect(coord.readActivityForAgent('a0').length).toBe(1)
    // No bead key was created
    expect(coord.readActivityForBead('undefined')).toEqual([])
  })

  it('rollbackBead uses indexed lookup (same behavior as before)', () => {
    // Mock bd methods to avoid CLI calls
    vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})

    // Simulate a merged event with a commit SHA
    coord.postActivity({ agentId: 'a0', type: 'merged', beadId: 'b1', commitSha: 'abc123' })

    // rollbackBead should find the SHA from the index
    const result = coord.rollbackBead('a0', 'b1')
    // It will fail to revert because abc123 is not a real SHA, but it should attempt it
    expect(result.revertedShas).toBeDefined()
    // The error should mention the SHA, proving the index lookup found it
    if (!result.reverted) {
      expect(result.error).toContain('abc123')
    }
  })
})

// ── Activity log rotation ─────────────────────────────────────────────────

describe('AgentCoordinator — activity log rotation', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const activityFile = () => tmpPaths.activity
  const rotatedFile = () => activityFile() + '.1'
  const event = (i: number) => ({ agentId: 'a0', type: 'started' as const, beadId: `b${i}` })

  it('does not rotate before 50 writes', () => {
    // Write a large file to make it exceed 1 MB
    fs.writeFileSync(activityFile(), 'x'.repeat(2_000_000))
    // Post 49 events — should not trigger rotation check
    for (let i = 0; i < 49; i++) {
      coord.postActivity(event(i))
    }
    // File should still exist (not rotated), no .1 backup
    expect(fs.existsSync(activityFile())).toBe(true)
    expect(fs.existsSync(rotatedFile())).toBe(false)
  })

  it('rotates at 50 writes when file > 1 MB', () => {
    // Seed the file with > 1 MB of data
    fs.writeFileSync(activityFile(), 'x'.repeat(2_000_000))
    // 50 writes should trigger rotation
    for (let i = 0; i < 50; i++) {
      coord.postActivity(event(i))
    }
    expect(fs.existsSync(rotatedFile())).toBe(true)
    // The original file is gone (renamed), but new writes will recreate it
  })

  it('does not rotate at 50 writes when file <= 1 MB', () => {
    // Post 50 small events — file will be well under 1 MB
    for (let i = 0; i < 50; i++) {
      coord.postActivity(event(i))
    }
    expect(fs.existsSync(rotatedFile())).toBe(false)
    expect(fs.existsSync(activityFile())).toBe(true)
  })

  it('resets write counter after check so rotation can trigger again', () => {
    // First cycle: 50 writes, file under 1 MB — no rotation
    for (let i = 0; i < 50; i++) {
      coord.postActivity(event(i))
    }
    expect(fs.existsSync(rotatedFile())).toBe(false)

    // Now inflate the file to > 1 MB
    fs.writeFileSync(activityFile(), 'x'.repeat(2_000_000))

    // Second cycle: 50 more writes — should trigger rotation
    for (let i = 50; i < 100; i++) {
      coord.postActivity(event(i))
    }
    expect(fs.existsSync(rotatedFile())).toBe(true)
  })

  it('in-memory cache is unaffected by rotation', () => {
    fs.writeFileSync(activityFile(), 'x'.repeat(2_000_000))
    for (let i = 0; i < 50; i++) {
      coord.postActivity(event(i))
    }
    // Rotation happened
    expect(fs.existsSync(rotatedFile())).toBe(true)
    // But in-memory cache still has all events
    const activity = coord.readActivity(100)
    expect(activity.length).toBe(50)
  })
})

describe('AgentCoordinator — _maybeCloseEpic (auto-close parent epic)', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeBead(overrides: Partial<Bead>): Bead {
    return {
      id: 'b1', title: 'Test', description: '', type: 'task',
      status: 'done', deps: [], files: [], priority: 2, tags: [],
      ...overrides
    }
  }

  it('closes parent epic when all siblings are done', async () => {
    let b1CallCount = 0
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      if (id === 'b1') {
        b1CallCount++
        // First call = idempotency check, return claimed so close proceeds
        if (b1CallCount === 1) return makeBead({ id: 'b1', epicId: 'epic-1', status: 'claimed' })
        // Second call = _maybeCloseEpic lookup
        return makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' })
      }
      if (id === 'epic-1') return makeBead({ id: 'epic-1', type: 'epic', status: 'claimed' })
      return null
    })
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([
      makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' }),
      makeBead({ id: 'b2', epicId: 'epic-1', status: 'done' }),
      makeBead({ id: 'b3', epicId: 'epic-1', status: 'done' }),
      makeBead({ id: 'epic-1', type: 'epic', status: 'claimed' }),
    ])
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    // close called for bead AND epic
    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
    expect(closeSpy).toHaveBeenCalledWith('epic-1', expect.stringContaining('auto-closed'))
    const events = coord.readActivity()
    const epicClose = events.find(e => e.beadId === 'epic-1' && e.type === 'completed')
    expect(epicClose).toBeDefined()
    expect(epicClose!.summary).toContain('Auto-closed epic')
  })

  it('does not close epic when some siblings are still open', async () => {
    let b1CallCount = 0
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      if (id === 'b1') {
        b1CallCount++
        if (b1CallCount === 1) return makeBead({ id: 'b1', epicId: 'epic-1', status: 'claimed' })
        return makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' })
      }
      if (id === 'epic-1') return makeBead({ id: 'epic-1', type: 'epic', status: 'claimed' })
      return null
    })
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([
      makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' }),
      makeBead({ id: 'b2', epicId: 'epic-1', status: 'claimed' }),
    ])
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    // close called for bead only, NOT for epic
    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
    expect(closeSpy).not.toHaveBeenCalledWith('epic-1', expect.any(String))
  })

  it('skips if bead has no parent epic', async () => {
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      if (id === 'b1') return makeBead({ id: 'b1', status: 'claimed' })
      return null
    })
    const listAllSpy = vi.spyOn(coord.bd, 'listAll')
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    // close called for bead only; listAll never called (early return)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(listAllSpy).not.toHaveBeenCalled()
  })

  it('skips if epic is already done', async () => {
    let b1CallCount = 0
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      if (id === 'b1') {
        b1CallCount++
        if (b1CallCount === 1) return makeBead({ id: 'b1', epicId: 'epic-1', status: 'claimed' })
        return makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' })
      }
      if (id === 'epic-1') return makeBead({ id: 'epic-1', type: 'epic', status: 'done' })
      return null
    })
    const listAllSpy = vi.spyOn(coord.bd, 'listAll')
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    // listAll never called because epic is already done
    expect(listAllSpy).not.toHaveBeenCalled()
    // close called for bead only
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('is non-fatal if bd.show throws during epic check', async () => {
    let callCount = 0
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      callCount++
      // First call (idempotency check) returns claimed bead
      if (callCount === 1) return makeBead({ id: 'b1', status: 'claimed' })
      // Second call (_maybeCloseEpic) throws
      throw new Error('bd crashed')
    })
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    // Should not throw
    await coord.completeBead('agent-0', 'b1', ['a.ts'])
    expect(closeSpy).toHaveBeenCalledWith('b1', expect.any(String))
  })

  it('handles failed siblings — does not close epic', async () => {
    let b1CallCount = 0
    vi.spyOn(coord.bd, 'show').mockImplementation((id: string) => {
      if (id === 'b1') {
        b1CallCount++
        if (b1CallCount === 1) return makeBead({ id: 'b1', epicId: 'epic-1', status: 'claimed' })
        return makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' })
      }
      if (id === 'epic-1') return makeBead({ id: 'epic-1', type: 'epic', status: 'claimed' })
      return null
    })
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([
      makeBead({ id: 'b1', epicId: 'epic-1', status: 'done' }),
      makeBead({ id: 'b2', epicId: 'epic-1', status: 'failed' }),
    ])
    const closeSpy = vi.spyOn(coord.bd, 'close').mockImplementation(() => {})

    await coord.completeBead('agent-0', 'b1', ['a.ts'])

    expect(closeSpy).not.toHaveBeenCalledWith('epic-1', expect.any(String))
  })
})

describe('AgentCoordinator — _checkClaimTimeouts', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(tmpPaths)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeBead(overrides: Partial<Bead>): Bead {
    return {
      id: 'b1', title: 'Test bead', description: '', type: 'task',
      status: 'claimed', deps: [], files: [], priority: 2, tags: [],
      ...overrides
    }
  }

  it('reopens timed-out beads with no live heartbeat', async () => {
    const claudeTimeoutMinutes = 5
    const thresholdMs = 2 * claudeTimeoutMinutes * 60_000 // 10 min
    const oldTs = new Date(Date.now() - thresholdMs - 60_000).toISOString() // 11 min ago

    // Post an old activity event for agent-1
    ;(coord as any)._activityCache.push({ ts: oldTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })
    ;(coord as any)._indexActivity({ ts: oldTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })

    // Mock bd.listByStatus('in_progress') to return a stuck bead
    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [makeBead({ id: 'b1', claimedBy: 'agent-1' })]
      return []
    })

    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})
    // Mock ready/listAll/etc for the rest of claimBestBead
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-0', claudeTimeoutMinutes)

    expect(reopenSpy).toHaveBeenCalledWith('b1', expect.any(String))
    const events = coord.readActivity()
    const timeoutEvent = events.find(e => e.type === 'claim_timeout' && e.beadId === 'b1')
    expect(timeoutEvent).toBeDefined()
    expect(timeoutEvent!.summary).toContain('timed out')
  })

  it('skips beads whose agent has a recent heartbeat', async () => {
    const claudeTimeoutMinutes = 5
    const thresholdMs = 2 * claudeTimeoutMinutes * 60_000
    const oldTs = new Date(Date.now() - thresholdMs - 60_000).toISOString()

    ;(coord as any)._activityCache.push({ ts: oldTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })
    ;(coord as any)._indexActivity({ ts: oldTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })

    // Agent-1 has a recent heartbeat
    coord.heartbeat('agent-1')

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [makeBead({ id: 'b1', claimedBy: 'agent-1' })]
      return []
    })

    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-0', claudeTimeoutMinutes)

    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('skips beads whose last activity is within threshold', async () => {
    const claudeTimeoutMinutes = 5
    const recentTs = new Date(Date.now() - 60_000).toISOString() // 1 min ago

    ;(coord as any)._activityCache.push({ ts: recentTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })
    ;(coord as any)._indexActivity({ ts: recentTs, agentId: 'agent-1', type: 'executing', beadId: 'b1' })

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [makeBead({ id: 'b1', claimedBy: 'agent-1' })]
      return []
    })

    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-0', claudeTimeoutMinutes)

    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('skips beads with no claimedBy', async () => {
    const claudeTimeoutMinutes = 5

    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      if (status === 'in_progress') return [makeBead({ id: 'b1', claimedBy: undefined })]
      return []
    })

    const reopenSpy = vi.spyOn(coord.bd, 'reopen').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    await coord.claimBestBead('agent-0', claudeTimeoutMinutes)

    expect(reopenSpy).not.toHaveBeenCalled()
  })

  it('is non-fatal if _checkClaimTimeouts throws', async () => {
    let callCount = 0
    vi.spyOn(coord.bd, 'listByStatus').mockImplementation((status: string) => {
      callCount++
      // First call is from _checkClaimTimeouts — throw
      if (callCount === 1) throw new Error('bd crashed')
      // Subsequent calls from claimBestBead itself
      return []
    })
    vi.spyOn(coord.bd, 'ready').mockReturnValue([])
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])

    // Should not throw — error is caught
    const result = await coord.claimBestBead('agent-0', 5)
    expect(result).toBeNull()
  })
})

describe('AgentCoordinator — mail', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    tmpPaths = makeTmpPaths(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeMailMessage(overrides: Partial<import('../types').MailMessage> = {}): import('../types').MailMessage {
    return {
      ts: new Date().toISOString(),
      from: 'agent-0',
      to: 'agent-1',
      subject: 'test',
      body: 'hello',
      threadId: 'general',
      read: false,
      ...overrides,
    }
  }

  it('readMail returns empty when mail.jsonl does not exist', () => {
    coord = new AgentCoordinator(tmpPaths)
    expect(coord.readMail()).toEqual([])
  })

  it('readMail loads existing mail.jsonl on construction', () => {
    const msg1 = makeMailMessage({ subject: 'first' })
    const msg2 = makeMailMessage({ subject: 'second', from: 'agent-1', to: 'agent-0' })
    fs.writeFileSync(tmpPaths.mail, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n')

    coord = new AgentCoordinator(tmpPaths)
    const all = coord.readMail()
    expect(all).toHaveLength(2)
    expect(all[0].subject).toBe('first')
    expect(all[1].subject).toBe('second')
  })

  it('readMail respects limit parameter', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMailMessage({ subject: `msg-${i}` })
    )
    fs.writeFileSync(tmpPaths.mail, messages.map(m => JSON.stringify(m)).join('\n') + '\n')

    coord = new AgentCoordinator(tmpPaths)
    const limited = coord.readMail(3)
    expect(limited).toHaveLength(3)
    expect(limited[0].subject).toBe('msg-7')
    expect(limited[2].subject).toBe('msg-9')
  })

  it('readMailForAgent filters by agent (to and from)', () => {
    const msg1 = makeMailMessage({ from: 'agent-0', to: 'agent-1', subject: 'to-1' })
    const msg2 = makeMailMessage({ from: 'agent-1', to: 'agent-0', subject: 'from-1' })
    const msg3 = makeMailMessage({ from: 'agent-2', to: 'agent-2', subject: 'self' })
    fs.writeFileSync(tmpPaths.mail, [msg1, msg2, msg3].map(m => JSON.stringify(m)).join('\n') + '\n')

    coord = new AgentCoordinator(tmpPaths)

    const forAgent1 = coord.readMailForAgent('agent-1')
    expect(forAgent1).toHaveLength(2) // msg1 (to agent-1) + msg2 (from agent-1)

    const forAgent2 = coord.readMailForAgent('agent-2')
    expect(forAgent2).toHaveLength(1) // msg3 (self-message indexed once)

    const forAgent3 = coord.readMailForAgent('agent-3')
    expect(forAgent3).toEqual([])
  })

  it('skips corrupt JSON lines in mail.jsonl', () => {
    const msg = makeMailMessage({ subject: 'valid' })
    fs.writeFileSync(tmpPaths.mail, 'not-json\n' + JSON.stringify(msg) + '\n{broken\n')

    coord = new AgentCoordinator(tmpPaths)
    const all = coord.readMail()
    expect(all).toHaveLength(1)
    expect(all[0].subject).toBe('valid')
  })

  it('watchMail emits only new messages appended after watch starts', async () => {
    const msg1 = makeMailMessage({ subject: 'pre-existing' })
    fs.writeFileSync(tmpPaths.mail, JSON.stringify(msg1) + '\n')

    coord = new AgentCoordinator(tmpPaths)

    const received: import('../types').MailMessage[][] = []
    coord.watchMail((msgs) => received.push(msgs))

    // Wait for chokidar to initialize
    await new Promise(r => setTimeout(r, 600))

    // Append a new message
    const msg2 = makeMailMessage({ subject: 'new-message' })
    fs.appendFileSync(tmpPaths.mail, JSON.stringify(msg2) + '\n')

    // Wait for chokidar to detect the change
    await new Promise(r => setTimeout(r, 1000))

    coord.unwatchMail()

    expect(received.length).toBeGreaterThanOrEqual(1)
    const allNew = received.flat()
    expect(allNew.some(m => m.subject === 'new-message')).toBe(true)
    expect(allNew.some(m => m.subject === 'pre-existing')).toBe(false)

    // Cache should include both old and new
    const all = coord.readMail()
    expect(all).toHaveLength(2)
  }, 10_000)

  it('watchMail handles file creation after watch starts', async () => {
    // Don't create the file before constructing
    coord = new AgentCoordinator(tmpPaths)

    const received: import('../types').MailMessage[][] = []
    coord.watchMail((msgs) => received.push(msgs))

    await new Promise(r => setTimeout(r, 600))

    // Create the file with a message
    const msg = makeMailMessage({ subject: 'first-ever' })
    fs.writeFileSync(tmpPaths.mail, JSON.stringify(msg) + '\n')

    await new Promise(r => setTimeout(r, 1000))

    coord.unwatchMail()

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received.flat().some(m => m.subject === 'first-ever')).toBe(true)
  }, 10_000)

  it('watchMail is idempotent — second call is a no-op', () => {
    coord = new AgentCoordinator(tmpPaths)
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    coord.watchMail(cb1)
    coord.watchMail(cb2) // should be ignored
    coord.unwatchMail()
    // No assertion needed — just verifying no error is thrown
  })

  it('unwatchMail is safe when not watching', () => {
    coord = new AgentCoordinator(tmpPaths)
    coord.unwatchMail() // should not throw
  })
})
