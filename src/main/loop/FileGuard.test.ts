import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()) }))
import * as fs from 'fs'
import * as os from 'os'
import { validateIntegrity } from './FileGuard'
import type { ProjectPaths } from './ProjectStore'

function makePaths(overrides?: Partial<ProjectPaths>): ProjectPaths {
  return {
    id: 'abc123',
    projectRoot: '/project',
    storeDir: '/home/.slashbot/projects/abc123',
    logsDir: '/home/.slashbot/projects/abc123/logs',
    circuitBreakerState: '/home/.slashbot/projects/abc123/.circuit_breaker_state',
    callCount: '/home/.slashbot/projects/abc123/.call_count',
    activity: '/home/.slashbot/projects/abc123/activity.jsonl',
    knowledge: '/home/.slashbot/projects/abc123/knowledge.jsonl',
    agents: '/home/.slashbot/projects/abc123/agents.json',
    fileLocks: '/home/.slashbot/projects/abc123/file_locks.json',
    configDir: '/home/.slashbot/projects/abc123/config',
    slashbotrc: '/home/.slashbot/projects/abc123/config/.slashbotrc',
    worktreesDir: '/project/.worktrees',
    beadsRoot: '/project/.beads',
    beadsCwd: '/project',
    agentMd: '/home/.slashbot/projects/abc123/config/AGENT.md',
    ...overrides
  }
}

describe('FileGuard', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok when all required files exist', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    const result = validateIntegrity('/project', makePaths())
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.report).toBe('All required Slashbot files present.')
  })

  it('reports missing files when none exist', () => {
    ;(fs.existsSync as any).mockReturnValue(false)
    const result = validateIntegrity('/project', makePaths())
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['storeDir', 'PROMPT.md', 'AGENT.md', '.slashbotrc'])
  })

  it('report contains remediation instruction', () => {
    ;(fs.existsSync as any).mockReturnValue(false)
    const result = validateIntegrity('/project', makePaths())
    expect(result.report).toContain('slashbot-enable --force')
    expect(result.report).toContain('Missing Slashbot files:')
  })

  it('reports only the specific missing files', () => {
    ;(fs.existsSync as any).mockImplementation((p: unknown) => {
      const s = String(p)
      return s.endsWith('abc123') || s.endsWith('.slashbotrc')
    })
    const result = validateIntegrity('/project', makePaths())
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['PROMPT.md', 'AGENT.md'])
  })

  it('checks storeDir, configDir files, and agentMd', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    const paths = makePaths()
    validateIntegrity('/project', paths)
    const calls = (fs.existsSync as any).mock.calls.map((c: any) => c[0])
    expect(calls).toContain('/home/.slashbot/projects/abc123')
    expect(calls).toContain('/home/.slashbot/projects/abc123/config/PROMPT.md')
    expect(calls).toContain('/home/.slashbot/projects/abc123/config/AGENT.md')
    expect(calls).toContain('/home/.slashbot/projects/abc123/config/.slashbotrc')
  })

  it('does not check project-root paths', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    validateIntegrity('/project', makePaths())
    const calls = (fs.existsSync as any).mock.calls.map((c: any) => c[0])
    expect(calls).not.toContain('/project/.slashbot')
    expect(calls).not.toContain('/project/.slashbotrc')
  })

  it('derives paths automatically when not provided', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(true)
  })
})
