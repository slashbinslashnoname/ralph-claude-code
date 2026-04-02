import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'
import { makeTmpGitProject, makeTmpPaths } from './testHelpers'
import { ProjectPaths } from './ProjectStore'

/**
 * Integration tests for git worktree creation via AgentCoordinator.createWorktree().
 *
 * Verifies worktrees are created at paths.worktreesDir with correct symlinks
 * to centralized locations (.beads, .slashbot, .slashbotrc) and proper .gitignore.
 *
 * Branch naming: worker/<beadId> (bead-centric, no agent identity in branch)
 * Dir naming: worker-<beadId> (under .worktrees/)
 */

describe('AgentCoordinator.createWorktree', () => {
  let tmpDir: string
  let paths: ProjectPaths
  let coord: AgentCoordinator

  beforeEach(() => {
    tmpDir = makeTmpGitProject('worktree-test-')
    paths = makeTmpPaths(tmpDir)

    // Create .slashbotrc at project root so the symlink test can verify it
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), 'timeout = 10')

    coord = new AgentCoordinator(paths)
  })

  afterEach(() => {
    // Clean up worktrees before removing tmpDir
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a worktree at paths.worktreesDir/worker-<beadId>', () => {
    const result = coord.createWorktree('worker-0', 'sb-123')

    expect(result).not.toBeNull()
    const expected = path.join(paths.worktreesDir, 'worker-sb-123')
    expect(result!.worktreePath).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('returns bead-centric branch name worker/<beadId>', () => {
    const result = coord.createWorktree('worker-0', 'sb-123')

    expect(result).not.toBeNull()
    expect(result!.branch).toBe('worker/sb-123')

    // Verify the branch actually exists
    const branches = execSync('git branch --list', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(branches).toContain('worker/sb-123')
  })

  it('symlinks .beads to paths.beadsRoot', () => {
    const result = coord.createWorktree('worker-0', 'sb-link')

    expect(result).not.toBeNull()
    const beadsLink = path.join(result!.worktreePath, '.beads')
    expect(fs.existsSync(beadsLink)).toBe(true)

    const stat = fs.lstatSync(beadsLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(beadsLink)).toBe(paths.beadsRoot)
  })

  it('symlinks .slashbot to paths.storeDir', () => {
    const result = coord.createWorktree('worker-0', 'sb-store')

    expect(result).not.toBeNull()
    const slashbotLink = path.join(result!.worktreePath, '.slashbot')
    expect(fs.existsSync(slashbotLink)).toBe(true)

    const stat = fs.lstatSync(slashbotLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(slashbotLink)).toBe(paths.storeDir)
  })

  it('symlinks .slashbotrc to project root .slashbotrc', () => {
    const result = coord.createWorktree('worker-0', 'sb-rc')

    expect(result).not.toBeNull()
    const rcLink = path.join(result!.worktreePath, '.slashbotrc')
    expect(fs.existsSync(rcLink)).toBe(true)

    const stat = fs.lstatSync(rcLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(rcLink)).toBe(path.join(tmpDir, '.slashbotrc'))
  })

  it('writes .gitignore with required entries', () => {
    const result = coord.createWorktree('worker-0', 'sb-gi')

    expect(result).not.toBeNull()
    const gitignorePath = path.join(result!.worktreePath, '.gitignore')
    expect(fs.existsSync(gitignorePath)).toBe(true)

    const content = fs.readFileSync(gitignorePath, 'utf8')
    expect(content).toContain('.slashbot/')
    expect(content).toContain('.slashbotrc')
    expect(content).toContain('.beads/')
    expect(content).toContain('.worktrees/')
  })

  it('worktree directory contains project files from main branch', () => {
    const result = coord.createWorktree('worker-0', 'sb-files')

    expect(result).not.toBeNull()
    // README.md was committed in the init commit
    expect(fs.existsSync(path.join(result!.worktreePath, 'README.md'))).toBe(true)
  })

  it('cleans up stale worktree and recreates it', () => {
    // Create a worktree first
    const result1 = coord.createWorktree('worker-0', 'sb-stale')
    expect(result1).not.toBeNull()

    // Create again with same ids — should clean up and recreate
    const result2 = coord.createWorktree('worker-0', 'sb-stale')
    expect(result2).not.toBeNull()
    expect(fs.existsSync(result2!.worktreePath)).toBe(true)
  })

  it('different agents working on different beads get separate worktrees', () => {
    const r1 = coord.createWorktree('worker-0', 'sb-alpha')
    const r2 = coord.createWorktree('worker-1', 'sb-beta')

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r1!.worktreePath).not.toBe(r2!.worktreePath)
    expect(r1!.branch).not.toBe(r2!.branch)
    expect(fs.existsSync(r1!.worktreePath)).toBe(true)
    expect(fs.existsSync(r2!.worktreePath)).toBe(true)
  })

  it('agentId is ignored in branch/path naming (bead-centric)', () => {
    // Two different agents creating a worktree for the same bead
    // should produce the same path — the second call cleans up the first
    const r1 = coord.createWorktree('worker-0', 'sb-same')
    expect(r1).not.toBeNull()
    expect(r1!.branch).toBe('worker/sb-same')
    expect(r1!.worktreePath).toContain('worker-sb-same')

    const r2 = coord.createWorktree('worker-1', 'sb-same')
    expect(r2).not.toBeNull()
    expect(r2!.branch).toBe('worker/sb-same')
    // Same path — agent identity doesn't affect naming
    expect(r2!.worktreePath).toBe(r1!.worktreePath)
  })
})

describe('AgentCoordinator.cleanOrphanedWorktrees — new and legacy patterns', () => {
  let tmpDir: string
  let paths: ProjectPaths
  let coord: AgentCoordinator

  beforeEach(() => {
    tmpDir = makeTmpGitProject('worktree-cleanup-')
    paths = makeTmpPaths(tmpDir)
    coord = new AgentCoordinator(paths)
  })

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: tmpDir, stdio: 'pipe' }) } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('cleans up new-pattern orphaned worktree (worker-<beadId>)', () => {
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const fakePath = path.join(worktreesDir, 'worker-sb-orphan')
    fs.mkdirSync(fakePath)
    fs.writeFileSync(path.join(fakePath, 'file.txt'), 'leftover')

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toContain('worker-sb-orphan')
    expect(fs.existsSync(fakePath)).toBe(false)
  })

  it('cleans up legacy-pattern orphaned worktree (agent-N-<beadId>)', () => {
    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const fakePath = path.join(worktreesDir, 'agent-0-sb-legacy')
    fs.mkdirSync(fakePath)
    fs.writeFileSync(path.join(fakePath, 'file.txt'), 'leftover')

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toContain('agent-0-sb-legacy')
    expect(fs.existsSync(fakePath)).toBe(false)
  })

  it('preserves new-pattern worktree owned by active agent', () => {
    // Register an agent with an active worktree branch
    coord.registerAgent({
      id: 'worker-0', index: 0, phase: 'executing',
      currentBeadId: 'sb-active', currentBeadTitle: 'test', currentBeadDescription: null, currentBeadType: null, loopCount: 1,
      lastActivity: new Date().toISOString(), worktreeBranch: 'worker/sb-active', thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ownedPath = path.join(worktreesDir, 'worker-sb-active')
    fs.mkdirSync(ownedPath)
    fs.writeFileSync(path.join(ownedPath, 'file.txt'), 'in-progress')

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed.length).toBe(0)
    expect(fs.existsSync(ownedPath)).toBe(true)
  })

  it('preserves legacy-pattern worktree owned by active agent', () => {
    coord.registerAgent({
      id: 'agent-0', index: 0, phase: 'executing',
      currentBeadId: 'b1', currentBeadTitle: 'test', currentBeadDescription: null, currentBeadType: null, loopCount: 1,
      lastActivity: new Date().toISOString(), worktreeBranch: null, thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ownedPath = path.join(worktreesDir, 'agent-0-b1')
    fs.mkdirSync(ownedPath)

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed.length).toBe(0)
    expect(fs.existsSync(ownedPath)).toBe(true)
  })

  it('cleans mixed new and legacy orphans while preserving owned', () => {
    coord.registerAgent({
      id: 'worker-0', index: 0, phase: 'executing',
      currentBeadId: 'sb-owned', currentBeadTitle: 'test', currentBeadDescription: null, currentBeadType: null, loopCount: 1,
      lastActivity: new Date().toISOString(), worktreeBranch: 'worker/sb-owned', thinkingSummary: null
    })

    const worktreesDir = path.join(tmpDir, '.worktrees')
    fs.mkdirSync(worktreesDir, { recursive: true })

    // Owned (new pattern)
    const owned = path.join(worktreesDir, 'worker-sb-owned')
    fs.mkdirSync(owned)

    // Orphan (new pattern)
    const orphanNew = path.join(worktreesDir, 'worker-sb-orphan')
    fs.mkdirSync(orphanNew)

    // Orphan (legacy pattern)
    const orphanLegacy = path.join(worktreesDir, 'agent-1-sb-old')
    fs.mkdirSync(orphanLegacy)

    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toContain('worker-sb-orphan')
    expect(removed).toContain('agent-1-sb-old')
    expect(removed).not.toContain('worker-sb-owned')
    expect(fs.existsSync(owned)).toBe(true)
    expect(fs.existsSync(orphanNew)).toBe(false)
    expect(fs.existsSync(orphanLegacy)).toBe(false)
  })

  it('returns empty array when .worktrees dir does not exist', () => {
    const removed = coord.cleanOrphanedWorktrees()
    expect(removed).toEqual([])
  })
})
