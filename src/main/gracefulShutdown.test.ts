import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'

/**
 * Tests for gracefulShutdown() and cleanOrphanedWorktrees().
 *
 * We can't easily import gracefulShutdown directly since ipc.ts has Electron
 * dependencies. Instead we test the worktree cleanup logic and the
 * SwarmOrchestrator.shutdown() integration which is the core of the handler.
 */
import { SwarmOrchestrator } from './loop/SwarmOrchestrator'

let tmpDir: string

function makeTmpGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test')
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' })

  const ralphDir = path.join(dir, '.slashbot')
  fs.mkdirSync(path.join(ralphDir, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.slashbotrc'), JSON.stringify({
    claudeCodeCmd: 'false',
    claudeTimeoutMinutes: 1,
    claudeOutputFormat: 'text',
    allowedTools: '',
    maxAgents: 2,
    continueSession: false,
  }))
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  return dir
}

describe('Graceful shutdown integration', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('shutdown() on multiple orchestrators completes without error', async () => {
    const orch1 = new SwarmOrchestrator(tmpDir)
    const orch2 = new SwarmOrchestrator(tmpDir)

    let complete1 = false
    let complete2 = false
    orch1.on('shutdown-complete', () => { complete1 = true })
    orch2.on('shutdown-complete', () => { complete2 = true })

    await Promise.allSettled([orch1.shutdown(), orch2.shutdown()])

    expect(complete1).toBe(true)
    expect(complete2).toBe(true)
  })

  it('shutdown cleans up fake workers and emits event', async () => {
    const orch = new SwarmOrchestrator(tmpDir)
    // Inject fake worker entries
    ;(orch as any).workers.set('agent-0', { stop: () => {} })
    ;(orch as any).workers.set('agent-1', { stop: () => {} })
    ;(orch as any).workerLoopPromises.set('agent-0', Promise.resolve())
    ;(orch as any).workerLoopPromises.set('agent-1', Promise.resolve())

    let emitted = false
    orch.on('shutdown-complete', () => { emitted = true })

    await orch.shutdown()

    expect(orch.workerCount()).toBe(0)
    expect(emitted).toBe(true)
    expect(orch.isShuttingDown()).toBe(false)
  })

  it('shutdown with timeout forces completion on hanging workers', async () => {
    const orch = new SwarmOrchestrator(tmpDir)
    ;(orch as any).workers.set('agent-0', { stop: () => {} })
    ;(orch as any).workerLoopPromises.set('agent-0', new Promise<void>(() => {})) // never resolves

    const start = Date.now()
    await orch.shutdown(300)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(elapsed).toBeLessThan(1500)
    expect(orch.workerCount()).toBe(0)
  })

  it('double-quit is safe (re-entrant shutdown)', async () => {
    const orch = new SwarmOrchestrator(tmpDir)
    ;(orch as any).workers.set('agent-0', { stop: () => {} })
    ;(orch as any).workerLoopPromises.set('agent-0', new Promise<void>(() => {}))

    // Start shutdown, then call again while first is in progress
    const p1 = orch.shutdown(200)
    const p2 = orch.shutdown(200) // should return immediately (no-op)

    await Promise.all([p1, p2])
    expect(orch.isShuttingDown()).toBe(false)
  })

  it('no active swarms — shutdown completes immediately', async () => {
    const orch = new SwarmOrchestrator(tmpDir)
    const start = Date.now()
    await orch.shutdown()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })
})

/**
 * Worktree cleanup tests — exercises the same git operations that
 * cleanOrphanedWorktrees() (in ipc.ts) performs. That function can't be
 * imported directly due to Electron dependencies, so we verify the
 * underlying git worktree + branch cleanup lifecycle here.
 */
describe('Worktree cleanup lifecycle', () => {
  beforeEach(() => {
    tmpDir = makeTmpGitProject()
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('git worktree remove + branch -D cleans up agent worktree fully', () => {
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const worktreePath = path.join(worktreesDir, 'agent-0-sb-test')
    const branch = 'agent/agent-0/sb-test'

    execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
      cwd: tmpDir, stdio: 'pipe'
    })
    expect(fs.existsSync(worktreePath)).toBe(true)

    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: tmpDir, stdio: 'pipe'
    })
    expect(fs.existsSync(worktreePath)).toBe(false)

    try {
      execSync(`git branch -D "${branch}"`, { cwd: tmpDir, stdio: 'pipe' })
    } catch { /* may already be gone */ }

    const branches = execSync('git branch', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(branches).not.toContain(branch)
  })

  it('falls back to rmSync when git worktree remove fails (non-git directory)', () => {
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const fakePath = path.join(worktreesDir, 'agent-0-sb-orphan')
    fs.mkdirSync(fakePath)
    fs.writeFileSync(path.join(fakePath, 'dummy.txt'), 'leftover')

    // git worktree remove will fail — fallback to manual cleanup
    try {
      execSync(`git worktree remove --force "${fakePath}"`, { cwd: tmpDir, stdio: 'pipe' })
    } catch {
      fs.rmSync(fakePath, { recursive: true, force: true })
    }

    expect(fs.existsSync(fakePath)).toBe(false)
  })
})
