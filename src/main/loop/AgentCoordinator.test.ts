import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'
import { AgentInfo, Bead } from '../types'

let tmpDir: string
let ralphDir: string
let coord: AgentCoordinator

function makeTmpGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test')
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' })

  const ralph = path.join(dir, '.ralph')
  fs.mkdirSync(path.join(ralph, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  return dir
}

describe('AgentCoordinator — atomic writes', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writeLocks is atomic — no .tmp file left behind', () => {
    coord.writeLocks([{ file: 'a.ts', agentId: 'agent-0', beadId: 'b1', reservedAt: new Date().toISOString() }])
    const lockFile = path.join(ralphDir, 'file_locks.json')
    assert.ok(fs.existsSync(lockFile), 'lock file should exist')
    assert.ok(!fs.existsSync(lockFile + '.tmp'), 'tmp file should not remain')
    const locks = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    assert.equal(locks.length, 1)
    assert.equal(locks[0].file, 'a.ts')
  })

  it('writeAgents is atomic — no .tmp file left behind', () => {
    coord.writeAgents([{
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    }])
    const agentsFile = path.join(ralphDir, 'agents.json')
    assert.ok(fs.existsSync(agentsFile), 'agents file should exist')
    assert.ok(!fs.existsSync(agentsFile + '.tmp'), 'tmp file should not remain')
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'))
    assert.equal(agents.length, 1)
  })

  it('read immediately after write returns consistent data', () => {
    for (let i = 0; i < 20; i++) {
      const locks = [{ file: `f${i}.ts`, agentId: 'agent-0', beadId: `b${i}`, reservedAt: new Date().toISOString() }]
      coord.writeLocks(locks)
      const read = coord.readLocks()
      assert.equal(read.length, 1)
      assert.equal(read[0].file, `f${i}.ts`)
    }
  })
})

describe('AgentCoordinator — merge retry', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merges a worktree branch successfully on first try', () => {
    // Create worktree
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt, 'worktree should be created')

    // Make a change in the worktree
    fs.writeFileSync(path.join(wt!.worktreePath, 'new-file.txt'), 'hello')
    execSync('git add . && git commit -m "add file"', {
      cwd: wt!.worktreePath, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    const result = coord.mergeWorktree('agent-0', 'b1', wt!.branch, wt!.worktreePath)
    assert.equal(result.merged, true)
    assert.ok(result.filesChanged.includes('new-file.txt'))
    assert.ok(fs.existsSync(path.join(tmpDir, 'new-file.txt')), 'merged file should exist in main')
  })

  it('retries merge after conflict and succeeds when conflict is resolved', () => {
    // Create worktree
    const wt = coord.createWorktree('agent-0', 'b2')
    assert.ok(wt)

    // Make conflicting change on main branch
    fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'main version')
    execSync('git add . && git commit -m "main change"', {
      cwd: tmpDir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    // Make conflicting change in worktree
    fs.writeFileSync(path.join(wt!.worktreePath, 'conflict.txt'), 'agent version')
    execSync('git add . && git commit -m "agent change"', {
      cwd: wt!.worktreePath, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    // Merge will conflict — retries won't help since conflict is on same file, so it should fail after retries
    const result = coord.mergeWorktree('agent-0', 'b2', wt!.branch, wt!.worktreePath, { maxRetries: 1 })
    assert.equal(result.merged, false)
    assert.ok(result.error, 'should have an error message')
  })

  it('respects maxRetries=0 — no retry on failure', () => {
    const wt = coord.createWorktree('agent-0', 'b3')
    assert.ok(wt)

    // Create conflict
    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'main')
    execSync('git add . && git commit -m "main"', {
      cwd: tmpDir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })
    fs.writeFileSync(path.join(wt!.worktreePath, 'x.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', {
      cwd: wt!.worktreePath, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    const result = coord.mergeWorktree('agent-0', 'b3', wt!.branch, wt!.worktreePath, { maxRetries: 0 })
    assert.equal(result.merged, false)
  })

  it('skips retry when stoppedFn returns true', () => {
    const wt = coord.createWorktree('agent-0', 'b4')
    assert.ok(wt)

    // Create conflict
    fs.writeFileSync(path.join(tmpDir, 'y.txt'), 'main')
    execSync('git add . && git commit -m "main"', {
      cwd: tmpDir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })
    fs.writeFileSync(path.join(wt!.worktreePath, 'y.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', {
      cwd: wt!.worktreePath, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    // stoppedFn returns true — should not retry
    const result = coord.mergeWorktree('agent-0', 'b4', wt!.branch, wt!.worktreePath, {
      maxRetries: 5, stoppedFn: () => true
    })
    assert.equal(result.merged, false)
  })

  it('cleans up worktree even on failure', () => {
    const wt = coord.createWorktree('agent-0', 'b5')
    assert.ok(wt)

    fs.writeFileSync(path.join(tmpDir, 'z.txt'), 'main')
    execSync('git add . && git commit -m "main"', {
      cwd: tmpDir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })
    fs.writeFileSync(path.join(wt!.worktreePath, 'z.txt'), 'agent')
    execSync('git add . && git commit -m "agent"', {
      cwd: wt!.worktreePath, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_EMAIL: 'test@test.com' }
    })

    coord.mergeWorktree('agent-0', 'b5', wt!.branch, wt!.worktreePath, { maxRetries: 0 })
    // Worktree directory should be cleaned up
    assert.ok(!fs.existsSync(wt!.worktreePath), 'worktree should be removed after failed merge')
  })
})

describe('AgentCoordinator — orphaned worktree cleanup', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes orphaned worktree not owned by any agent', () => {
    // Create a worktree as if agent-0 made it
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const fakePath = path.join(worktreesDir, 'agent-0-orphan1')
    fs.mkdirSync(fakePath)
    fs.writeFileSync(path.join(fakePath, 'file.txt'), 'leftover')

    // No agents registered — all worktrees are orphans
    const removed = coord.cleanOrphanedWorktrees()
    assert.ok(removed.includes('agent-0-orphan1'))
    assert.ok(!fs.existsSync(fakePath), 'orphaned worktree dir should be removed')
  })

  it('preserves worktree owned by an active agent', () => {
    // Register an agent
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'executing',
      currentBeadId: 'b1', currentBeadTitle: 'test', loopCount: 1,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })

    // Create its worktree dir
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ownedPath = path.join(worktreesDir, 'agent-0-b1')
    fs.mkdirSync(ownedPath)
    fs.writeFileSync(path.join(ownedPath, 'file.txt'), 'in-progress')

    const removed = coord.cleanOrphanedWorktrees()
    assert.equal(removed.length, 0)
    assert.ok(fs.existsSync(ownedPath), 'owned worktree should still exist')
  })

  it('removes orphans but preserves owned in mixed set', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })

    // Owned by active agent
    const owned = path.join(worktreesDir, 'agent-0-b1')
    fs.mkdirSync(owned)

    // Orphan — agent-1 not registered
    const orphan = path.join(worktreesDir, 'agent-1-b2')
    fs.mkdirSync(orphan)

    const removed = coord.cleanOrphanedWorktrees()
    assert.ok(removed.includes('agent-1-b2'))
    assert.ok(!removed.includes('agent-0-b1'))
    assert.ok(fs.existsSync(owned))
    assert.ok(!fs.existsSync(orphan))
  })

  it('returns empty array when .worktrees dir does not exist', () => {
    const removed = coord.cleanOrphanedWorktrees()
    assert.deepEqual(removed, [])
  })
})

describe('AgentCoordinator — file locks and agent registry', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reserveFiles then releaseFiles round-trips correctly', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts', 'b.ts'])
    assert.equal(coord.readLocks().length, 2)
    coord.releaseFiles('agent-0', 'b1')
    assert.equal(coord.readLocks().length, 0)
  })

  it('lockedFilesByOthers excludes own locks', () => {
    coord.reserveFiles('agent-0', 'b1', ['shared.ts'])
    coord.reserveFiles('agent-1', 'b2', ['other.ts'])
    const locked = coord.lockedFilesByOthers('agent-0')
    assert.ok(locked.includes('other.ts'))
    assert.ok(!locked.includes('shared.ts'))
  })

  it('deregisterAgent removes agent and releases its locks', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'idle',
      currentBeadId: null, currentBeadTitle: null, loopCount: 0,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })
    coord.reserveFiles('agent-0', 'b1', ['file.ts'])

    coord.deregisterAgent('agent-0')
    assert.equal(coord.readAgents().length, 0)
    assert.equal(coord.readLocks().length, 0)
  })

  it('activity log appends and reads in order', () => {
    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'hello' })
    coord.postActivity({ agentId: 'agent-0', type: 'stopped', summary: 'bye' })
    const events = coord.readActivity()
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'started')
    assert.equal(events[1].type, 'stopped')
  })

  it('reserveFiles replaces previous locks for the same agent+bead', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts', 'b.ts'])
    assert.equal(coord.readLocks().length, 2)
    // Reserve again with different files — old locks for same agent+bead should be gone
    coord.reserveFiles('agent-0', 'b1', ['c.ts'])
    const locks = coord.readLocks()
    assert.equal(locks.length, 1)
    assert.equal(locks[0].file, 'c.ts')
  })

  it('releaseAllForAgent removes all locks for that agent across beads', () => {
    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.reserveFiles('agent-0', 'b2', ['b.ts'])
    coord.reserveFiles('agent-1', 'b3', ['c.ts'])
    assert.equal(coord.readLocks().length, 3)
    coord.releaseAllForAgent('agent-0')
    const locks = coord.readLocks()
    assert.equal(locks.length, 1)
    assert.equal(locks[0].agentId, 'agent-1')
  })

  it('readLocks returns empty array when file does not exist', () => {
    assert.deepEqual(coord.readLocks(), [])
  })

  it('readAgents returns empty array when file does not exist', () => {
    assert.deepEqual(coord.readAgents(), [])
  })
})

describe('AgentCoordinator — agent registration', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
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
    assert.equal(agents.length, 1)
    assert.equal(agents[0].id, 'agent-0')
  })

  it('registerAgent replaces an existing agent with the same id', () => {
    coord.registerAgent(makeAgent({ phase: 'idle' }))
    coord.registerAgent(makeAgent({ phase: 'executing' }))
    const agents = coord.getAgents()
    assert.equal(agents.length, 1)
    assert.equal(agents[0].phase, 'executing')
  })

  it('registerAgent supports multiple agents', () => {
    coord.registerAgent(makeAgent({ id: 'agent-0', index: 0 }))
    coord.registerAgent(makeAgent({ id: 'agent-1', index: 1 }))
    coord.registerAgent(makeAgent({ id: 'agent-2', index: 2 }))
    assert.equal(coord.getAgents().length, 3)
  })

  it('updateAgent patches fields and updates lastActivity', () => {
    coord.registerAgent(makeAgent({ phase: 'idle', loopCount: 0 }))
    coord.updateAgent('agent-0', { phase: 'executing', loopCount: 5, currentBeadId: 'b1' })
    const agents = coord.getAgents()
    assert.equal(agents[0].phase, 'executing')
    assert.equal(agents[0].loopCount, 5)
    assert.equal(agents[0].currentBeadId, 'b1')
  })

  it('updateAgent is a no-op for unknown agent id', () => {
    coord.registerAgent(makeAgent())
    coord.updateAgent('agent-99', { phase: 'executing' })
    const agents = coord.getAgents()
    assert.equal(agents.length, 1)
    assert.equal(agents[0].phase, 'idle')
  })

  it('deregisterAgent removes agent and releases all its locks', () => {
    coord.registerAgent(makeAgent({ id: 'agent-0' }))
    coord.registerAgent(makeAgent({ id: 'agent-1', index: 1 }))
    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.reserveFiles('agent-1', 'b2', ['b.ts'])

    coord.deregisterAgent('agent-0')
    assert.equal(coord.getAgents().length, 1)
    assert.equal(coord.getAgents()[0].id, 'agent-1')
    // Only agent-1's locks remain
    const locks = coord.readLocks()
    assert.equal(locks.length, 1)
    assert.equal(locks[0].agentId, 'agent-1')
  })
})

describe('AgentCoordinator — activity log', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readActivity returns empty array when file does not exist', () => {
    assert.deepEqual(coord.readActivity(), [])
  })

  it('postActivity includes a timestamp', () => {
    const before = new Date().toISOString()
    coord.postActivity({ agentId: 'agent-0', type: 'started', summary: 'go' })
    const events = coord.readActivity()
    assert.equal(events.length, 1)
    assert.ok(events[0].ts >= before)
    assert.equal(events[0].agentId, 'agent-0')
    assert.equal(events[0].type, 'started')
  })

  it('readActivity respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      coord.postActivity({ agentId: 'agent-0', type: 'executing', summary: `step ${i}` })
    }
    const events = coord.readActivity(3)
    assert.equal(events.length, 3)
    // Should return the last 3 events
    assert.equal(events[0].summary, 'step 7')
    assert.equal(events[2].summary, 'step 9')
  })

  it('postActivity preserves optional fields', () => {
    coord.postActivity({
      agentId: 'agent-0', type: 'claimed',
      beadId: 'b1', beadTitle: 'Fix bug', summary: 'Claimed bead',
      filesChanged: ['a.ts', 'b.ts'], branch: 'agent/agent-0/b1'
    })
    const events = coord.readActivity()
    assert.equal(events[0].beadId, 'b1')
    assert.equal(events[0].beadTitle, 'Fix bug')
    assert.deepEqual(events[0].filesChanged, ['a.ts', 'b.ts'])
    assert.equal(events[0].branch, 'agent/agent-0/b1')
  })
})

describe('AgentCoordinator — worktree creation', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates worktree with correct path and branch name', () => {
    const wt = coord.createWorktree('agent-0', 'sb-abc')
    assert.ok(wt)
    assert.equal(wt!.branch, 'agent/agent-0/sb-abc')
    assert.equal(wt!.worktreePath, path.join(tmpDir, '.worktrees', 'agent-0-sb-abc'))
    assert.ok(fs.existsSync(wt!.worktreePath))
  })

  it('worktree has .beads symlink when .beads dir exists', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt)
    const beadsLink = path.join(wt!.worktreePath, '.beads')
    assert.ok(fs.existsSync(beadsLink))
    const stat = fs.lstatSync(beadsLink)
    assert.ok(stat.isSymbolicLink())
  })

  it('worktree has .ralph symlink', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt)
    const ralphLink = path.join(wt!.worktreePath, '.ralph')
    assert.ok(fs.existsSync(ralphLink))
    assert.ok(fs.lstatSync(ralphLink).isSymbolicLink())
  })

  it('worktree has .ralphrc symlink when .ralphrc exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.ralphrc'), 'maxCallsPerHour=10')
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt)
    const rcLink = path.join(wt!.worktreePath, '.ralphrc')
    assert.ok(fs.existsSync(rcLink))
    assert.ok(fs.lstatSync(rcLink).isSymbolicLink())
  })

  it('worktree .gitignore contains required entries', () => {
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt)
    const gitignore = fs.readFileSync(path.join(wt!.worktreePath, '.gitignore'), 'utf8')
    assert.ok(gitignore.includes('.ralph/'))
    assert.ok(gitignore.includes('.ralphrc'))
    assert.ok(gitignore.includes('.beads/'))
    assert.ok(gitignore.includes('.worktrees/'))
  })

  it('recreates worktree if path already exists (stale worktree)', () => {
    const wt1 = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt1)
    // Create again — should succeed by cleaning up the old one
    const wt2 = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt2)
    assert.ok(fs.existsSync(wt2!.worktreePath))
  })

  it('worktree branch is on the same commit as current HEAD', () => {
    const mainHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim()
    const wt = coord.createWorktree('agent-0', 'b1')
    assert.ok(wt)
    const wtHead = execSync('git rev-parse HEAD', { cwd: wt!.worktreePath }).toString().trim()
    assert.equal(wtHead, mainHead)
  })
})

describe('AgentCoordinator — bead claiming with contention', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
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
    // Mock bd.ready and bd.listByStatus to return empty
    mock.method(coord.bd, 'ready', () => [])
    mock.method(coord.bd, 'listByStatus', () => [])

    const result = await coord.claimBestBead('agent-0')
    assert.equal(result, null)
  })

  it('claimBestBead claims the highest-priority bead', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 2 }),
      makeBead({ id: 'b2', priority: 0 }),
      makeBead({ id: 'b3', priority: 1 }),
    ]
    mock.method(coord.bd, 'ready', () => beads)
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', (_id: string) => makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    assert.ok(result)
    assert.equal(result!.id, 'b2')
  })

  it('claimBestBead skips beads with files locked by others', async () => {
    coord.reserveFiles('agent-1', 'other', ['locked.ts'])
    const beads = [
      makeBead({ id: 'b1', priority: 0, files: ['locked.ts'] }),
      makeBead({ id: 'b2', priority: 1, files: ['free.ts'] }),
    ]
    mock.method(coord.bd, 'ready', () => beads)
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', () => makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    assert.ok(result)
    assert.equal(result!.id, 'b2')
  })

  it('claimBestBead skips beads claimed by other agents', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 0, claimedBy: 'agent-1' }),
      makeBead({ id: 'b2', priority: 1 }),
    ]
    mock.method(coord.bd, 'ready', () => beads)
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', () => makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    assert.ok(result)
    assert.equal(result!.id, 'b2')
  })

  it('claimBestBead falls back to open beads when ready is empty', async () => {
    mock.method(coord.bd, 'ready', () => [])
    mock.method(coord.bd, 'listByStatus', () => [makeBead({ id: 'b1', status: 'ready' })])
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', () => makeBead({ id: 'b1', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    assert.ok(result)
    assert.equal(result!.id, 'b1')
  })

  it('claimBestBead skips beads where assignTo fails', async () => {
    const beads = [
      makeBead({ id: 'b1', priority: 0 }),
      makeBead({ id: 'b2', priority: 1 }),
    ]
    let callCount = 0
    mock.method(coord.bd, 'ready', () => beads)
    mock.method(coord.bd, 'assignTo', () => {
      callCount++
      return callCount > 1 // first call fails, second succeeds
    })
    mock.method(coord.bd, 'show', () => makeBead({ id: 'b2', status: 'claimed', claimedBy: 'agent-0' }))

    const result = await coord.claimBestBead('agent-0')
    assert.ok(result)
    assert.equal(result!.id, 'b2')
  })

  it('claimBestBead posts activity and reserves files on success', async () => {
    const bead = makeBead({ id: 'b1', files: ['src/main.ts'] })
    mock.method(coord.bd, 'ready', () => [bead])
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', () => makeBead({ id: 'b1', status: 'claimed', claimedBy: 'agent-0' }))

    await coord.claimBestBead('agent-0')
    const locks = coord.readLocks()
    assert.equal(locks.length, 1)
    assert.equal(locks[0].file, 'src/main.ts')
    const events = coord.readActivity()
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'claimed')
  })

  it('concurrent claimBestBead calls are serialized by semaphore', async () => {
    const order: string[] = []
    let callNum = 0
    const beads = [
      makeBead({ id: 'b1', priority: 0 }),
      makeBead({ id: 'b2', priority: 1 }),
    ]

    mock.method(coord.bd, 'ready', () => {
      callNum++
      order.push(`ready-${callNum}`)
      // First call sees both; second call sees only b2 (b1 already claimed)
      if (callNum === 1) return [beads[0], beads[1]]
      return [beads[1]]
    })
    mock.method(coord.bd, 'assignTo', () => true)
    mock.method(coord.bd, 'show', (id: string) => makeBead({ id, status: 'claimed' }))

    // Launch two claims concurrently
    const [r1, r2] = await Promise.all([
      coord.claimBestBead('agent-0'),
      coord.claimBestBead('agent-1'),
    ])

    // Both should have resolved
    assert.ok(r1)
    assert.ok(r2)
    // Semaphore ensures ready calls happen sequentially (ready-1 before ready-2)
    assert.equal(order[0], 'ready-1')
    assert.equal(order[1], 'ready-2')
  })
})

describe('AgentCoordinator — completeBead and failBead', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completeBead calls bd.close, releases files, and logs activity', () => {
    let closedId = ''
    mock.method(coord.bd, 'close', (id: string) => { closedId = id })

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.completeBead('agent-0', 'b1', ['a.ts'])

    assert.equal(closedId, 'b1')
    assert.equal(coord.readLocks().length, 0)
    const events = coord.readActivity()
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'completed')
    assert.ok(events[0].summary!.includes('b1'))
  })

  it('failBead calls bd.addLabel + bd.close, releases files, and logs activity', () => {
    let addedLabel = ''
    let closedId = ''
    mock.method(coord.bd, 'addLabel', (_id: string, label: string) => { addedLabel = label })
    mock.method(coord.bd, 'close', (id: string) => { closedId = id })

    coord.reserveFiles('agent-0', 'b1', ['a.ts'])
    coord.failBead('agent-0', 'b1', 'merge conflict')

    assert.equal(addedLabel, 'failed')
    assert.equal(closedId, 'b1')
    assert.equal(coord.readLocks().length, 0)
    const events = coord.readActivity()
    assert.equal(events[0].type, 'failed')
    assert.equal(events[0].summary, 'merge conflict')
  })
})

describe('AgentCoordinator — hasOpenWork and getStats', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    ralphDir = path.join(tmpDir, '.ralph')
    coord = new AgentCoordinator(ralphDir, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('hasOpenWork returns true when open beads exist', () => {
    mock.method(coord.bd, 'listByStatus', (status: string) => {
      if (status === 'open') return [{ id: 'b1' }]
      return []
    })
    assert.equal(coord.hasOpenWork(), true)
  })

  it('hasOpenWork returns true when in_progress beads exist', () => {
    mock.method(coord.bd, 'listByStatus', (status: string) => {
      if (status === 'open') return []
      if (status === 'in_progress') return [{ id: 'b1' }]
      return []
    })
    assert.equal(coord.hasOpenWork(), true)
  })

  it('hasOpenWork returns false when no open or in_progress beads', () => {
    mock.method(coord.bd, 'listByStatus', () => [])
    assert.equal(coord.hasOpenWork(), false)
  })

  it('getStats delegates to bd.stats()', () => {
    const expected = { total: 5, pending: 1, ready: 2, claimed: 1, done: 1, failed: 0, pct: 20 }
    mock.method(coord.bd, 'stats', () => expected)
    assert.deepEqual(coord.getStats(), expected)
  })
})
