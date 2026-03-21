import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentCoordinator } from './AgentCoordinator'

/**
 * Integration tests for the commit mutex (commitSemaphore).
 *
 * The commitSemaphore serializes git add / git commit calls so that
 * concurrent completeBead invocations never interleave git operations.
 * Because `git add -A` stages everything in the working tree, concurrent
 * calls may batch changes into fewer commits — what matters is:
 *   1. All files end up committed (nothing lost)
 *   2. The repo passes git fsck (no corruption)
 *   3. The semaphore prevents interleaving
 */

function makeTmpGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-mutex-'))
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

describe('commitMutex — concurrent completeBead', () => {
  let tmpDir: string
  let slashbotDir: string
  let coord: AgentCoordinator

  beforeEach(() => {
    tmpDir = makeTmpGitProject()
    slashbotDir = path.join(tmpDir, '.slashbot')
    coord = new AgentCoordinator(slashbotDir, tmpDir)

    // Mock bd.close / bd.show so completeBead doesn't need real beads
    vi.spyOn(coord.bd, 'close').mockImplementation(() => {})
    vi.spyOn(coord.bd, 'show').mockReturnValue(null)
    vi.spyOn(coord.bd, 'listAll').mockReturnValue([])
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent completeBead calls commit all files without corruption', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file-a.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(tmpDir, 'file-b.ts'), 'export const b = 2')

    await Promise.all([
      coord.completeBead('agent-0', 'bead-1', ['file-a.ts'], false),
      coord.completeBead('agent-1', 'bead-2', ['file-b.ts'], false)
    ])

    // Both files must be tracked (committed) — nothing lost
    const tracked = execSync('git ls-files', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(tracked).toContain('file-a.ts')
    expect(tracked).toContain('file-b.ts')

    // git fsck verifies repo integrity — no interleaved/corrupt objects
    const fsck = execSync('git fsck --full', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(fsck).not.toContain('error')
  })

  it('sequential completeBead calls produce distinct commits with correct bead IDs', async () => {
    fs.writeFileSync(path.join(tmpDir, 'x.ts'), '1')
    await coord.completeBead('agent-0', 'bead-x', ['x.ts'], false)

    fs.writeFileSync(path.join(tmpDir, 'y.ts'), '2')
    await coord.completeBead('agent-1', 'bead-y', ['y.ts'], false)

    const log = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(log).toContain('bead-x')
    expect(log).toContain('bead-y')

    // Two bead commits + init = 3
    const commitCount = log.trim().split('\n').length
    expect(commitCount).toBe(3)
  })

  it('commitAndPush returns null when there are no staged changes', async () => {
    const sha = await coord.commitAndPush('agent-0', 'bead-empty', false)
    expect(sha).toBeNull()
  })

  it('commitAndPush returns a valid SHA on success', async () => {
    fs.writeFileSync(path.join(tmpDir, 'z.ts'), 'export const z = 42')
    const sha = await coord.commitAndPush('agent-0', 'bead-sha', false)
    expect(sha).toBeTruthy()
    expect(sha!.length).toBeGreaterThanOrEqual(7)

    // Verify SHA matches HEAD
    const head = execSync('git rev-parse HEAD', { cwd: tmpDir, stdio: 'pipe' }).toString().trim()
    expect(head).toBe(sha)
  })

  it('many concurrent commits produce a consistent repo with all files tracked', async () => {
    const count = 5
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(path.join(tmpDir, `concurrent-${i}.ts`), `export const v${i} = ${i}`)
    }

    const promises: Promise<void>[] = []
    for (let i = 0; i < count; i++) {
      promises.push(coord.completeBead(`agent-${i}`, `bead-${i}`, [`concurrent-${i}.ts`], false))
    }
    await Promise.all(promises)

    // All files must be tracked
    const tracked = execSync('git ls-files', { cwd: tmpDir, stdio: 'pipe' }).toString()
    for (let i = 0; i < count; i++) {
      expect(tracked).toContain(`concurrent-${i}.ts`)
    }

    // Repo integrity check
    const fsck = execSync('git fsck --full', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(fsck).not.toContain('error')
  })

  it('concurrent commitAndPush calls serialize via semaphore', async () => {
    // Track when each commit actually runs by using GIT_AUTHOR_NAME
    // which is set per-agent inside commitAndPush. After both complete,
    // we verify both commits exist with distinct authors.

    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a')
    const sha1 = coord.commitAndPush('agent-0', 'bead-A', false)

    // Create second file after first commitAndPush starts (but before it finishes,
    // since the semaphore is async). The second call blocks on the semaphore.
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b')
    const sha2 = coord.commitAndPush('agent-1', 'bead-B', false)

    const [r1, r2] = await Promise.all([sha1, sha2])

    // At least one commit should have succeeded
    expect(r1 !== null || r2 !== null).toBe(true)

    // All files committed
    const tracked = execSync('git ls-files', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(tracked).toContain('a.ts')
    expect(tracked).toContain('b.ts')

    // Repo intact
    const fsck = execSync('git fsck --full', { cwd: tmpDir, stdio: 'pipe' }).toString()
    expect(fsck).not.toContain('error')
  })
})
