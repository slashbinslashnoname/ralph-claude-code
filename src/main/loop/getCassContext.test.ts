import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as cp from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import { WorkerLoop } from './WorkerLoop'
import { RalphConfig } from '../types'
import { ProjectPaths } from './ProjectStore'

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fs>()
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof cp>()
  return {
    ...orig,
    spawn: vi.fn(),
    execSync: vi.fn(),
    execFile: vi.fn(),
  }
})

function makeConfig(): RalphConfig {
  return {
    projectPath: '/tmp/test-project',
    beadsPath: '/tmp/test-project/.beads',
    agents: 1,
    claudeModel: 'sonnet',
    claudeCodeCmd: 'claude',
    autoMerge: true,
    loopIntervalMs: 1000,
  } as RalphConfig
}

function makePaths(): ProjectPaths {
  return {
    id: 'test-project-abc12345',
    projectRoot: '/tmp/test-project',
    storeDir: '/tmp/.slashbot/projects/test',
    logsDir: '/tmp/.slashbot/projects/test/logs',
    circuitBreakerState: '/tmp/.slashbot/projects/test/.circuit_breaker_state',
    callCount: '/tmp/.slashbot/projects/test/.call_count',
    activity: '/tmp/.slashbot/projects/test/activity.jsonl',
    knowledge: '/tmp/.slashbot/projects/test/knowledge.jsonl',
    agents: '/tmp/.slashbot/projects/test/agents.json',
    fileLocks: '/tmp/.slashbot/projects/test/file_locks.json',
    mail: '/tmp/.slashbot/projects/test/mail.jsonl',
    configDir: '/tmp/.slashbot/projects/test/config',
  } as ProjectPaths
}

function makeCoordinator() {
  return {
    claim: vi.fn(),
    release: vi.fn(),
    postActivity: vi.fn(),
    getLocks: vi.fn().mockReturnValue([]),
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    heartbeat: vi.fn(),
    sweepStaleClaims: vi.fn(),
    getRegisteredAgents: vi.fn().mockReturnValue([]),
    ensureWorktree: vi.fn().mockResolvedValue('/tmp/wt'),
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
  } as any
}

describe('WorkerLoop _getCassContext (cm CLI integration)', () => {
  let worker: WorkerLoop
  const mockExecFile = cp.execFile as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    worker = new WorkerLoop(
      'agent-1',
      0,
      '/tmp/test-project',
      makeConfig(),
      makeCoordinator(),
      makePaths(),
    )
  })

  it('returns formatted markdown when cm returns valid JSON', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, JSON.stringify({
        relevant_bullets: [
          { id: 'r1', text: 'Use dependency injection', confidence: 85, maturity: 'stable' },
        ],
        anti_patterns: [
          { id: 'a1', text: 'Avoid global state', confidence: 90, maturity: 'proven' },
        ],
        history_snippets: ['Refactored auth module last sprint'],
      }), '')
    })

    // Access private method via bracket notation
    const result = await (worker as any)._getCassContext('test task')

    expect(mockExecFile).toHaveBeenCalledWith(
      'cm',
      ['context', 'test task', '--json', '--limit', '30'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    )
    expect(result).toContain('### Relevant knowledge (from CASS memory)')
    expect(result).toContain('Use dependency injection')
    expect(result).toContain('[confidence: 85%]')
    expect(result).toContain('### Anti-patterns to avoid')
    expect(result).toContain('Avoid global state')
    expect(result).toContain('### Historical context')
    expect(result).toContain('Refactored auth module last sprint')
  })

  it('returns empty string when cm CLI fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(new Error('cm not found'), '', 'cm not found')
    })

    const result = await (worker as any)._getCassContext('test task')
    expect(result).toBe('')
  })

  it('returns empty string when cm returns invalid JSON', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, 'not json', '')
    })

    const result = await (worker as any)._getCassContext('test task')
    expect(result).toBe('')
  })

  it('returns empty string when cm returns empty context', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, JSON.stringify({
        relevant_bullets: [],
        anti_patterns: [],
        history_snippets: [],
      }), '')
    })

    const result = await (worker as any)._getCassContext('test task')
    expect(result).toBe('')
  })

  it('handles camelCase response keys', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, JSON.stringify({
        relevantBullets: [
          { id: 'r1', text: 'Always validate inputs', confidence: 70, maturity: 'emerging' },
        ],
        antiPatterns: [],
        historySnippets: [],
      }), '')
    })

    const result = await (worker as any)._getCassContext('test task')
    expect(result).toContain('Always validate inputs')
    expect(result).toContain('[confidence: 70%]')
  })

  it('limits rules to 15 and anti-patterns to 5', async () => {
    const manyRules = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`, text: `Rule ${i}`, confidence: 50, maturity: 'stable',
    }))
    const manyAntiPatterns = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, text: `AntiPattern ${i}`, confidence: 50, maturity: 'stable',
    }))

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, JSON.stringify({
        relevant_bullets: manyRules,
        anti_patterns: manyAntiPatterns,
        history_snippets: [],
      }), '')
    })

    const result = await (worker as any)._getCassContext('test task')
    // Should have exactly 15 rules (0-14)
    expect(result).toContain('Rule 14')
    expect(result).not.toContain('Rule 15')
    // Should have exactly 5 anti-patterns (0-4)
    expect(result).toContain('AntiPattern 4')
    expect(result).not.toContain('AntiPattern 5')
  })
})
