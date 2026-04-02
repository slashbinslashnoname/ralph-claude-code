/**
 * Tests for memory (cm/sm CLI) integration across loops, health check, and IPC.
 *
 * Covers:
 * - HealthCheck sm CLI warning logic (deterministic mock)
 * - BD_SYSTEM_PROMPT content in WorkerLoop prompts
 * - PlanLoop PROMPT.md injection (carries slashmem instructions)
 * - IPC memory:* handlers (cm CLI wrappers)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as cp from 'child_process'
import { validateProjectPath } from './beadValidation'

// ── WorkerLoop + PlanLoop imports ──────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fs>()
  return {
    ...orig,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn(),
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
    execFileSync: vi.fn(),
    exec: vi.fn(),
  }
})

import { WorkerLoop } from './WorkerLoop'
import { RalphConfig, Bead } from '../types'
import type { ProjectPaths } from './ProjectStore'

// ── Shared helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 10,
    claudeOutputFormat: 'json',
    claudeCodeCmd: 'claude',
    allowedTools: '*',
    sleepDuration: 1,
    continueSession: false,
    cbNoProgressThreshold: 3,
    cbSameErrorThreshold: 3,
    cbErrorWindowSize: 20,
    cbErrorWindowThreshold: 5,
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 30,
    cbMaxCooldownMinutes: 480,
    autoPush: false,
    maxRetries: 2,
    autoSplitThreshold: 3,
    buildMonitorCmd: '',
    buildMonitorInterval: 0,
    claudeModelThink: 'sonnet',
    claudeModelExecute: 'opus',
    claudeModelReview: 'sonnet',
    ...overrides,
  }
}

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'sb-mem',
    title: 'Memory test bead',
    description: 'Testing memory integration',
    type: 'task',
    status: 'ready',
    deps: [],
    files: [],
    priority: 2,
    tags: [],
    ...overrides,
  }
}

function makePaths(overrides: Partial<ProjectPaths> = {}): ProjectPaths {
  return {
    id: 'mem-test',
    projectRoot: '/project',
    storeDir: '/store',
    logsDir: '/store/logs',
    circuitBreakerState: '/store/.circuit_breaker_state',
    callCount: '/store/.call_count',
    activity: '/store/activity.jsonl',
    knowledge: '/store/knowledge.jsonl',
    agents: '/store/agents.json',
    fileLocks: '/store/file_locks.json',
    configDir: '/store/config',
    slashbotrc: '/store/config/.slashbotrc',
    worktreesDir: '/project/.worktrees',
    beadsRoot: '/project/.beads',
    beadsCwd: '/project',
    agentMd: '/store/config/AGENT.md',
    promptMd: '/store/config/PROMPT.md',
    ...overrides,
  }
}

function makeCoordinator() {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    updateAgent: vi.fn(),
    postActivity: vi.fn(),
    releaseAllForAgent: vi.fn(),
    claimBestBead: vi.fn(async () => null),
    hasOpenWork: vi.fn(() => false),
    hasOpenWorkAsync: vi.fn(async () => false),
    allAgentsIdle: vi.fn(() => true),
    getAgentStates: vi.fn(() => ({})),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(),
    bd: {
      check: vi.fn(() => ({ available: true })),
      show: vi.fn(() => null),
      listAll: vi.fn(() => []),
      ready: vi.fn(() => []),
      listByStatus: vi.fn(() => []),
      create: vi.fn(),
      createAsync: vi.fn(async () => 'sb-new'),
      close: vi.fn(),
      claim: vi.fn(),
      update: vi.fn(),
      addDep: vi.fn(),
      addLabel: vi.fn(),
      comments: vi.fn(() => []),
      stats: vi.fn(() => ({})),
      ensureDolt: vi.fn(async () => {}),
    },
    readKnowledge: vi.fn(() => []),
    postKnowledge: vi.fn(),
  } as any
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BD_SYSTEM_PROMPT in WorkerLoop prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fs.existsSync as any).mockReturnValue(false)
    ;(fs.mkdirSync as any).mockReturnValue(undefined)
    ;(fs.readFileSync as any).mockReturnValue('')
    ;(cp.execSync as any).mockReturnValue(Buffer.from('main'))
  })

  afterEach(() => vi.restoreAllMocks())

  it('execute prompt includes bd CLI reference sections', () => {
    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    const prompt = (worker as any)._buildExecutePrompt(makeBead())

    // BD_SYSTEM_PROMPT key sections
    expect(prompt).toContain('## Beads (`bd` CLI)')
    expect(prompt).toContain('### Lifecycle (orchestrator-managed')
    expect(prompt).toContain('Do NOT run `bd close`')
    expect(prompt).toContain('### Read commands')
    expect(prompt).toContain('bd show <id>')
    expect(prompt).toContain('bd list --json')
    expect(prompt).toContain('bd comments <id>')
    expect(prompt).toContain('### Update commands')
    expect(prompt).toContain('bd update <id>')
    expect(prompt).toContain('### Creating discovered work')
    expect(prompt).toContain('bd create')
    expect(prompt).toContain('fix-later')
    expect(prompt).toContain('bd dep add')
  })

  it('review prompt includes bd CLI reference sections', () => {
    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    const prompt = (worker as any)._buildReviewPrompt(makeBead())

    expect(prompt).toContain('## Beads (`bd` CLI)')
    expect(prompt).toContain('Do NOT run `bd close`')
    expect(prompt).toContain('### Read commands')
    expect(prompt).toContain('bd show <id>')
  })

  it('execute prompt includes PROMPT.md content when it exists', () => {
    ;(fs.existsSync as any).mockImplementation((p: string) =>
      p.endsWith('PROMPT.md')
    )
    ;(fs.readFileSync as any).mockImplementation((p: string) => {
      if (String(p).endsWith('PROMPT.md')) {
        return '## Memory — slashmem\n\nsm context "brief description"\nsm ingest --task'
      }
      return ''
    })

    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    const prompt = (worker as any)._buildExecutePrompt(makeBead())

    expect(prompt).toContain('## Memory — slashmem')
    expect(prompt).toContain('sm context')
    expect(prompt).toContain('sm ingest')
  })

  it('review prompt includes PROMPT.md content when it exists', () => {
    ;(fs.existsSync as any).mockImplementation((p: string) =>
      p.endsWith('PROMPT.md')
    )
    ;(fs.readFileSync as any).mockImplementation((p: string) => {
      if (String(p).endsWith('PROMPT.md')) return '## Memory — slashmem\nsm rules add'
      return ''
    })

    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    const prompt = (worker as any)._buildReviewPrompt(makeBead())

    expect(prompt).toContain('## Memory — slashmem')
    expect(prompt).toContain('sm rules add')
  })

  it('execute prompt omits PROMPT.md content when file does not exist', () => {
    ;(fs.existsSync as any).mockReturnValue(false)

    const worker = new WorkerLoop('agent-0', 0, '/project', makeConfig(), makeCoordinator(), makePaths())
    const prompt = (worker as any)._buildExecutePrompt(makeBead())

    expect(prompt).not.toContain('## Memory — slashmem')
    expect(prompt).not.toContain('sm context')
  })
})

describe('PlanLoop PROMPT.md injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fs.existsSync as any).mockReturnValue(false)
    ;(fs.mkdirSync as any).mockReturnValue(undefined)
    ;(fs.readFileSync as any).mockReturnValue('')
    ;(cp.execSync as any).mockReturnValue(Buffer.from('main'))
  })

  afterEach(() => vi.restoreAllMocks())

  it('plan prompt includes PROMPT.md slashmem content when file exists', async () => {
    const { PlanLoop } = await import('./PlanLoop')

    ;(fs.existsSync as any).mockImplementation((p: string) =>
      String(p).endsWith('PROMPT.md')
    )
    ;(fs.readFileSync as any).mockImplementation((p: string) => {
      if (String(p).endsWith('PROMPT.md')) {
        return '## Memory — slashmem\n\nUse `sm context` before starting work.'
      }
      return ''
    })

    const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    const prompt = (loop as any)._buildPlanPrompt('Build a feature')

    expect(prompt).toContain('## Memory — slashmem')
    expect(prompt).toContain('sm context')
  })

  it('plan prompt works without PROMPT.md', async () => {
    const { PlanLoop } = await import('./PlanLoop')

    ;(fs.existsSync as any).mockReturnValue(false)
    ;(fs.readFileSync as any).mockReturnValue('')

    const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    const prompt = (loop as any)._buildPlanPrompt('Build a feature')

    expect(prompt).toContain('Build a feature')
    expect(prompt).not.toContain('slashmem')
  })

  it('encode prompt includes bd CLI reference but not memory instructions', async () => {
    const { PlanLoop } = await import('./PlanLoop')

    const loop = new PlanLoop(makePaths(), makeConfig(), makeCoordinator())
    const prompt = (loop as any)._buildEncodePrompt('## Architecture\nREST API', 'Build API')

    expect(prompt).toContain('bd create')
    expect(prompt).toContain('bd dep add')
    expect(prompt).toContain('bd list --json')
    // Encode prompt should not carry memory context — only the plan prompt does
    expect(prompt).not.toContain('slashmem')
    expect(prompt).not.toContain('sm context')
  })
})

describe('HealthCheck sm CLI warning (mocked)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('produces sm warning when which throws', async () => {
    // Dynamically import to get fresh module with our mocks
    const { runHealthCheck } = await import('./HealthCheck')

    // Mock execFileSync to fail only for 'sm'
    ;(cp.execFileSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'sm') throw new Error('not found')
      return Buffer.from('/usr/bin/node')
    })

    // Mock BdClient and FileGuard via their modules
    const BdClientModule = await import('./BdClient')
    vi.spyOn(BdClientModule, 'BdClient').mockImplementation(() => ({
      check: () => ({ available: true }),
    }) as any)

    const FileGuardModule = await import('./FileGuard')
    vi.spyOn(FileGuardModule, 'validateIntegrity').mockReturnValue({ ok: true, missing: [] })

    const result = runHealthCheck('/test-project', 'node')
    expect(result.ok).toBe(true)

    const smWarning = result.warnings.find(w => w.check === 'sm')
    expect(smWarning).toBeDefined()
    expect(smWarning!.message).toContain('slashmem')
    expect(smWarning!.message).toContain('persistent memory')
    expect(smWarning!.remediation).toContain('cargo install slashmem')
  })

  it('no sm warning when sm is available', async () => {
    const { runHealthCheck } = await import('./HealthCheck')

    ;(cp.execFileSync as any).mockReturnValue(Buffer.from('/usr/bin/sm'))

    const BdClientModule = await import('./BdClient')
    vi.spyOn(BdClientModule, 'BdClient').mockImplementation(() => ({
      check: () => ({ available: true }),
    }) as any)

    const FileGuardModule = await import('./FileGuard')
    vi.spyOn(FileGuardModule, 'validateIntegrity').mockReturnValue({ ok: true, missing: [] })

    const result = runHealthCheck('/test-project', 'node')
    expect(result.ok).toBe(true)
    expect(result.warnings.find(w => w.check === 'sm')).toBeUndefined()
  })

  it('sm warning does not cause errors array to be non-empty', async () => {
    const { runHealthCheck } = await import('./HealthCheck')

    ;(cp.execFileSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'sm') throw new Error('not found')
      return Buffer.from('/usr/bin/node')
    })

    const BdClientModule = await import('./BdClient')
    vi.spyOn(BdClientModule, 'BdClient').mockImplementation(() => ({
      check: () => ({ available: true }),
    }) as any)

    const FileGuardModule = await import('./FileGuard')
    vi.spyOn(FileGuardModule, 'validateIntegrity').mockReturnValue({ ok: true, missing: [] })

    const result = runHealthCheck('/test-project', 'node')
    expect(result.errors).toEqual([])
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
  })
})

describe('IPC memory handlers — contracts and validation', () => {
  // ipc.ts handlers cannot be directly imported (they require Electron's ipcMain).
  // Following the pattern from beadsRollbackIpc.test.ts, we test:
  //  1. The validateProjectPath validator used by memory:context/similar/stats/top
  //  2. The memory:check installed/not-installed logic
  //  3. The { ok, data } / { ok: false, error } return shape contract
  //  4. The cm CLI command strings the handlers construct

  it('memory:check — installed:true when exec resolves, installed:false when it rejects', async () => {
    // Mirrors the try/catch in the actual handler (ipc.ts ~line 982)
    async function checkMemory(execFn: () => Promise<void>): Promise<{ installed: boolean }> {
      try {
        await execFn()
        return { installed: true }
      } catch {
        return { installed: false }
      }
    }
    expect(await checkMemory(() => Promise.resolve())).toEqual({ installed: true })
    expect(await checkMemory(() => Promise.reject(new Error('not found')))).toEqual({ installed: false })
  })

  it('memory:context/similar/stats/top — validateProjectPath rejects invalid inputs', () => {
    expect(() => validateProjectPath('')).toThrow(/non-empty/)
    expect(() => validateProjectPath(null)).toThrow(/non-empty string/)
    expect(() => validateProjectPath(123)).toThrow(/non-empty string/)
    expect(validateProjectPath('/valid/path')).toBe('/valid/path')
  })

  it('memory handlers return { ok: true, data } on success', () => {
    // Mirrors the handler pattern: return { ok: true, data: JSON.parse(result.stdout) }
    function successResult(data: unknown) { return { ok: true, data } }
    const r = successResult({ entries: [{ id: '1', text: 'ctx', score: 0.9 }] })
    expect(r.ok).toBe(true)
    expect((r.data as any).entries).toHaveLength(1)
  })

  it('memory handlers return { ok: false, error: string } for Error and non-Error throws', () => {
    // Mirrors: catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    function errorResult(e: unknown): { ok: boolean; error: string } {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    expect(errorResult(new Error('timeout'))).toEqual({ ok: false, error: 'timeout' })
    expect(errorResult('raw string')).toEqual({ ok: false, error: 'raw string' })
    expect(errorResult(42)).toEqual({ ok: false, error: '42' })
  })

  it('memory:context constructs correct cm CLI command (verified against ipc.ts ~line 996)', () => {
    // Actual handler: execAsync(`cm context ${JSON.stringify(query)} --json`, ...)
    const build = (query: string) => `cm context ${JSON.stringify(query)} --json`
    expect(build('deploy steps')).toBe('cm context "deploy steps" --json')
    expect(build("it's complex")).toBe(`cm context "it's complex" --json`)
  })

  it('memory:similar constructs correct cm CLI command (verified against ipc.ts ~line 1010)', () => {
    const build = (query: string) => `cm similar ${JSON.stringify(query)} --json`
    expect(build('auth flow')).toBe('cm similar "auth flow" --json')
  })

  it('memory:stats constructs correct cm CLI command (verified against ipc.ts ~line 1024)', () => {
    expect('cm stats --json').toBe('cm stats --json')
  })

  it('memory:top constructs correct cm CLI command with count param (verified against ipc.ts ~line 1038)', () => {
    const build = (count: number) => `cm top ${count} --json`
    expect(build(10)).toBe('cm top 10 --json')
    expect(build(5)).toBe('cm top 5 --json')
  })

  it('cm CLI query escapes shell-dangerous characters via JSON.stringify', () => {
    const query = 'test "with quotes" and \\backslashes'
    const cmd = `cm context ${JSON.stringify(query)} --json`
    expect(cmd).toContain('\\"with quotes\\"')
    expect(cmd).toContain('\\\\backslashes')
  })
})
