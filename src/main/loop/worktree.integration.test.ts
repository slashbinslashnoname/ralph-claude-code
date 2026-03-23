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

  it('creates a worktree at paths.worktreesDir/<agentId>-<beadId>', () => {
    const result = coord.createWorktree('agent-0', 'sb-123')

    expect(result).not.toBeNull()
    const expected = path.join(paths.worktreesDir, 'agent-0-sb-123')
    expect(result!.worktreePath).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('returns the correct branch name', () => {
    const result = coord.createWorktree('agent-0', 'sb-123')

    expect(result).not.toBeNull()
    expect(result!.branch).toBe('agent/agent-0/sb-123')

    // Verify the branch actually exists
    const branches = execSync('git branch --list', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(branches).toContain('agent/agent-0/sb-123')
  })

  it('symlinks .beads to paths.beadsRoot', () => {
    const result = coord.createWorktree('agent-0', 'sb-link')

    expect(result).not.toBeNull()
    const beadsLink = path.join(result!.worktreePath, '.beads')
    expect(fs.existsSync(beadsLink)).toBe(true)

    const stat = fs.lstatSync(beadsLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(beadsLink)).toBe(paths.beadsRoot)
  })

  it('symlinks .slashbot to paths.storeDir', () => {
    const result = coord.createWorktree('agent-0', 'sb-store')

    expect(result).not.toBeNull()
    const slashbotLink = path.join(result!.worktreePath, '.slashbot')
    expect(fs.existsSync(slashbotLink)).toBe(true)

    const stat = fs.lstatSync(slashbotLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(slashbotLink)).toBe(paths.storeDir)
  })

  it('symlinks .slashbotrc to project root .slashbotrc', () => {
    const result = coord.createWorktree('agent-0', 'sb-rc')

    expect(result).not.toBeNull()
    const rcLink = path.join(result!.worktreePath, '.slashbotrc')
    expect(fs.existsSync(rcLink)).toBe(true)

    const stat = fs.lstatSync(rcLink)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(rcLink)).toBe(path.join(tmpDir, '.slashbotrc'))
  })

  it('writes .gitignore with required entries', () => {
    const result = coord.createWorktree('agent-0', 'sb-gi')

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
    const result = coord.createWorktree('agent-0', 'sb-files')

    expect(result).not.toBeNull()
    // README.md was committed in the init commit
    expect(fs.existsSync(path.join(result!.worktreePath, 'README.md'))).toBe(true)
  })

  it('cleans up stale worktree and recreates it', () => {
    // Create a worktree first
    const result1 = coord.createWorktree('agent-0', 'sb-stale')
    expect(result1).not.toBeNull()

    // Create again with same ids — should clean up and recreate
    const result2 = coord.createWorktree('agent-0', 'sb-stale')
    expect(result2).not.toBeNull()
    expect(fs.existsSync(result2!.worktreePath)).toBe(true)
  })

  it('multiple agents can create worktrees concurrently', () => {
    const r1 = coord.createWorktree('agent-0', 'sb-multi')
    const r2 = coord.createWorktree('agent-1', 'sb-multi')

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r1!.worktreePath).not.toBe(r2!.worktreePath)
    expect(r1!.branch).not.toBe(r2!.branch)
    expect(fs.existsSync(r1!.worktreePath)).toBe(true)
    expect(fs.existsSync(r2!.worktreePath)).toBe(true)
  })
})
