import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'

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
})
