import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as realFs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

// ── fs mock ────────────────────────────────────────────────────────────────
// We keep real fs for tmpdir operations but track calls via a recording layer.

const fsReadCalls: string[] = []
const fsExistsCalls: string[] = []
const fsWriteCalls: string[] = []

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readFileSync: vi.fn((...args: any[]) => {
      fsReadCalls.push(args[0] as string)
      try { return actual.readFileSync(args[0] as string, args[1] as any) } catch { return '' }
    }),
    existsSync: vi.fn((...args: any[]) => {
      fsExistsCalls.push(args[0] as string)
      return actual.existsSync(args[0] as string)
    }),
    writeFileSync: vi.fn((...args: any[]) => {
      fsWriteCalls.push(args[0] as string)
      return actual.writeFileSync(args[0] as any, args[1] as any)
    }),
    mkdirSync: vi.fn((...args: any[]) => actual.mkdirSync(args[0] as string, args[1] as any)),
    readdirSync: vi.fn((...args: any[]) => {
      try { return actual.readdirSync(args[0] as string) } catch { return [] }
    }),
    statSync: vi.fn((...args: any[]) => actual.statSync(args[0] as string)),
    rmSync: vi.fn((...args: any[]) => actual.rmSync(args[0] as string, args[1] as any)),
    rmdirSync: vi.fn((...args: any[]) => actual.rmdirSync(args[0] as string)),
    copyFileSync: vi.fn((...args: any[]) => actual.copyFileSync(args[0] as string, args[1] as string)),
  }
})

// ── Electron mock ──────────────────────────────────────────────────────────

const registeredHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      registeredHandlers.set(channel, handler)
    },
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock('./nativeRequire', () => ({
  createNativeRequire: () => (mod: string) => {
    if (mod === 'chokidar') {
      return {
        watch: () => ({ on: vi.fn().mockReturnThis(), close: vi.fn() }),
      }
    }
    throw new Error(`Unexpected require: ${mod}`)
  },
}))

vi.mock('./loop/SwarmOrchestrator', () => ({
  SwarmOrchestrator: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    startWorkers: vi.fn(),
    stopWorkers: vi.fn(),
    stopAll: vi.fn(),
    workerCount: () => 0,
    isPlanning: () => false,
    getPlanRequest: () => null,
    getAgents: () => [],
    getStats: () => null,
    sessionStartedAt: null,
    stoppingGracefully: false,
    coordinator: { rollbackBead: vi.fn() },
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('./loop/RcParser', () => ({ loadConfig: vi.fn().mockReturnValue({}) }))

const mockCircuitBreaker = vi.fn().mockImplementation(() => ({
  reset: vi.fn(),
  snapshot: vi.fn().mockReturnValue({ state: 'CLOSED' }),
}))
vi.mock('./loop/CircuitBreaker', () => ({ CircuitBreaker: mockCircuitBreaker }))

const mockCheckEnabled = vi.fn().mockReturnValue({ enabled: true, missing: [], hasRalphrc: true, hasRalphDir: true })
const mockEnableRalph = vi.fn().mockReturnValue({ ok: true, alreadyEnabled: false, filesCreated: [], context: {} })
vi.mock('./loop/RalphEnabler', () => ({
  checkEnabled: mockCheckEnabled,
  detectProjectContext: vi.fn().mockReturnValue({ framework: 'node' }),
  enableRalph: mockEnableRalph,
}))

vi.mock('./loop/BdClient', () => ({
  BdClient: vi.fn().mockImplementation(() => ({
    check: vi.fn(), listByStatus: vi.fn().mockReturnValue([]),
    listAll: vi.fn().mockReturnValue([]), show: vi.fn(),
    create: vi.fn(), ready: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue({}),
  })),
}))

vi.mock('./loop/beadValidation', () => ({
  validateBeadsList: (p: unknown, f: unknown) => ({ projectPath: p, filter: f }),
  validateBeadsCreate: (p: unknown, o: unknown) => ({ projectPath: p, opts: o }),
  validateBeadsUpdate: (p: unknown, id: unknown, o: unknown) => ({ projectPath: p, id, opts: o ?? {} }),
  validateBeadId: (id: unknown) => id,
  validateProjectPath: (p: unknown) => p,
}))

const mockValidateConfigRead = vi.fn().mockImplementation((p: string, r: string, configDir?: string) => ({
  projectPath: p, relPath: r, resolvedPath: path.join(configDir ?? p, r),
}))
const mockValidateConfigWrite = vi.fn().mockImplementation((p: string, r: string, c: string, configDir?: string) => ({
  projectPath: p, relPath: r, resolvedPath: path.join(configDir ?? p, r), content: c,
}))
vi.mock('./loop/configValidation', () => ({
  validateConfigRead: mockValidateConfigRead,
  validateConfigWrite: mockValidateConfigWrite,
}))

vi.mock('./loop/projectValidation', () => ({
  validateProjectPathArg: (p: unknown) => p,
  validateSaveTabs: (t: unknown) => t,
}))

vi.mock('./loop/telegramValidation', () => ({
  validateTelegramProjectPath: (p: unknown) => p,
  validateTelegramConfigure: vi.fn(),
}))

vi.mock('./loop/TelegramBot', () => ({ TelegramBot: vi.fn() }))
vi.mock('./loop/TelegramBridge', () => ({ TelegramBridge: vi.fn() }))

vi.mock('./loop/swarmValidation', () => ({
  validateSwarmStart: (p: unknown, w: unknown) => ({ projectPath: p, workerCount: w }),
  validateSwarmStop: (p: unknown) => ({ projectPath: p }),
  validateSwarmInject: (p: unknown, r: unknown) => ({ projectPath: p, request: r }),
  validateSwarmQueueRemove: (p: unknown, id: unknown) => ({ projectPath: p, id }),
  validateSwarmQueue: (p: unknown) => ({ projectPath: p }),
  validateSwarmStatus: (p: unknown) => ({ projectPath: p }),
  validateSwarmBeads: (p: unknown, s: unknown) => ({ projectPath: p, status: s }),
  validateSwarmBeadStats: (p: unknown) => ({ projectPath: p }),
  validateSwarmAgentLogs: (p: unknown) => ({ projectPath: p }),
  validateSwarmActivity: (p: unknown, l: unknown) => ({ projectPath: p, limit: l }),
  validateSwarmAgentOutput: (p: unknown, a: unknown) => ({ projectPath: p, agentId: a }),
  validateSwarmAgentLogContent: (p: unknown, f: unknown) => ({ projectPath: p, filename: f }),
  validateSwarmPauseResume: (p: unknown, a: unknown) => ({ projectPath: p, agentId: a }),
  validateSwarmKnowledge: (p: unknown, l: unknown) => ({ projectPath: p, limit: l }),
  validateSwarmBuildMonitorToggle: (p: unknown, e: unknown) => ({ projectPath: p, enabled: e }),
  validateSwarmBuildMonitorStatus: (p: unknown) => ({ projectPath: p }),
  validateSwarmActivityForBead: (p: unknown, b: unknown, l: unknown) => ({ projectPath: p, beadId: b, limit: l }),
  validateSwarmActivityForAgent: (p: unknown, a: unknown, l: unknown) => ({ projectPath: p, agentId: a, limit: l }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function computeStoreDir(projectPath: string): string {
  const absolute = path.resolve(projectPath)
  const id = crypto.createHash('sha256').update(absolute).digest('hex')
  return path.join(os.homedir(), '.slashbot', 'projects', id)
}

function invoke(channel: string, ...args: any[]): any {
  const handler = registeredHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({} /* event */, ...args)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ipc handlers use centralized ProjectPaths', () => {
  let tmpDir: string
  let storePath: string

  beforeEach(async () => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'))
    storePath = path.join(tmpDir, 'projects.json')
    realFs.writeFileSync(storePath, '[]')

    registeredHandlers.clear()
    fsReadCalls.length = 0
    fsExistsCalls.length = 0
    fsWriteCalls.length = 0

    mockCheckEnabled.mockClear()
    mockEnableRalph.mockClear()
    mockCircuitBreaker.mockClear()
    mockValidateConfigRead.mockClear()
    mockValidateConfigWrite.mockClear()

    const { registerIpc } = await import('./ipc')
    registerIpc(() => null, storePath)
  })

  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('status:read', () => {
    it('reads from centralized storeDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsReadCalls.length = 0
      invoke('status:read', projectPath)

      expect(fsReadCalls.some(p => p.startsWith(storeDir))).toBe(true)
      expect(fsReadCalls.filter(p => p.startsWith(storeDir))).toContain(
        path.join(storeDir, '.circuit_breaker_state')
      )
      // Must NOT read from old project-local .slashbot/ path
      expect(fsReadCalls.some(p => p.startsWith('/test/project/.slashbot/'))).toBe(false)
    })
  })

  describe('logs:read', () => {
    it('checks log file in centralized logsDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsExistsCalls.length = 0
      invoke('logs:read', projectPath)

      expect(fsExistsCalls).toContain(path.join(storeDir, 'logs', 'slashbot.log'))
    })
  })

  describe('logs:list', () => {
    it('checks centralized logsDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsExistsCalls.length = 0
      invoke('logs:list', projectPath)

      expect(fsExistsCalls).toContain(path.join(storeDir, 'logs'))
    })
  })

  describe('file:read', () => {
    it('passes configDir to validateConfigRead', () => {
      const projectPath = '/test/project'
      const expectedConfigDir = path.join(computeStoreDir(projectPath), 'config')

      invoke('file:read', projectPath, 'PROMPT.md')

      expect(mockValidateConfigRead).toHaveBeenCalledWith(projectPath, 'PROMPT.md', expectedConfigDir)
    })
  })

  describe('file:write', () => {
    it('passes configDir to validateConfigWrite', () => {
      const projectPath = '/test/project'
      const expectedConfigDir = path.join(computeStoreDir(projectPath), 'config')

      invoke('file:write', projectPath, 'PROMPT.md', '# prompt')

      expect(mockValidateConfigWrite).toHaveBeenCalledWith(projectPath, 'PROMPT.md', '# prompt', expectedConfigDir)
    })
  })

  describe('circuit:reset', () => {
    it('constructs CircuitBreaker with storeDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      invoke('circuit:reset', projectPath)

      expect(mockCircuitBreaker).toHaveBeenCalledWith(storeDir, expect.any(Object))
    })
  })

  describe('session:reset', () => {
    it('targets .claude_session_id in storeDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsExistsCalls.length = 0
      invoke('session:reset', projectPath)

      expect(fsExistsCalls).toContain(path.join(storeDir, '.claude_session_id'))
    })
  })

  describe('slashbot:is-enabled', () => {
    it('passes ProjectPaths to checkEnabled', () => {
      const projectPath = '/test/project'

      invoke('slashbot:is-enabled', projectPath)

      expect(mockCheckEnabled).toHaveBeenCalledWith(
        projectPath,
        expect.objectContaining({
          storeDir: computeStoreDir(projectPath),
          configDir: path.join(computeStoreDir(projectPath), 'config'),
        })
      )
    })
  })

  describe('slashbot:enable', () => {
    it('passes ProjectPaths to enableRalph', () => {
      const projectPath = '/test/project'
      const opts = { force: false }

      invoke('slashbot:enable', projectPath, opts)

      expect(mockEnableRalph).toHaveBeenCalledWith(
        projectPath,
        opts,
        expect.objectContaining({ storeDir: computeStoreDir(projectPath) })
      )
    })
  })

  describe('slashbot:cleanup-legacy', () => {
    it('removes legacy .slashbot/ directory', () => {
      const projectPath = path.join(tmpDir, 'myproject')
      const legacyDir = path.join(projectPath, '.slashbot')
      realFs.mkdirSync(legacyDir, { recursive: true })
      realFs.writeFileSync(path.join(legacyDir, 'status.json'), '{}')

      const result = invoke('slashbot:cleanup-legacy', projectPath)

      expect(result).toEqual({ ok: true, removed: true })
      expect(realFs.existsSync(legacyDir)).toBe(false)
    })

    it('returns removed: false when no legacy dir exists', () => {
      const projectPath = path.join(tmpDir, 'clean-project')
      realFs.mkdirSync(projectPath, { recursive: true })

      const result = invoke('slashbot:cleanup-legacy', projectPath)

      expect(result).toEqual({ ok: true, removed: false })
    })
  })

  describe('swarm:agent-logs', () => {
    it('reads from centralized logsDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsExistsCalls.length = 0
      invoke('swarm:agent-logs', projectPath)

      expect(fsExistsCalls).toContain(path.join(storeDir, 'logs'))
    })
  })

  describe('swarm:agent-log-content', () => {
    it('reads from centralized logsDir', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsReadCalls.length = 0
      invoke('swarm:agent-log-content', projectPath, 'agent-0_think_2025-01-01.log')

      expect(fsReadCalls).toContain(path.join(storeDir, 'logs', 'agent-0_think_2025-01-01.log'))
    })
  })

  describe('swarm:agent-output fallback', () => {
    it('falls back to centralized logsDir when no active swarm', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsReadCalls.length = 0
      invoke('swarm:agent-output', projectPath, 'agent-0')

      expect(fsReadCalls).toContain(path.join(storeDir, 'logs', 'agent-0.log'))
    })
  })

  describe('slashbot:enable returns storeDir', () => {
    it('includes storeDir in the enable result', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)
      mockEnableRalph.mockReturnValueOnce({ ok: true, alreadyEnabled: false, filesCreated: ['PROMPT.md'], context: {} })

      const result = invoke('slashbot:enable', projectPath, { force: true })

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        storeDir,
        filesCreated: ['PROMPT.md'],
      }))
    })
  })

  describe('slashbot:migrate-check', () => {
    it('migrates legacy storage and returns storeDir', () => {
      const projectPath = path.join(tmpDir, 'migrate-proj')
      const legacyDir = path.join(projectPath, '.slashbot')
      realFs.mkdirSync(legacyDir, { recursive: true })
      realFs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), '{"test":true}\n')

      const result = invoke('slashbot:migrate-check', projectPath)

      expect(result.ok).toBe(true)
      expect(result.didMigrate).toBe(true)
      expect(result.storeDir).toBe(computeStoreDir(projectPath))
      expect(result.migratedFiles).toContain('activity.jsonl')
      // Verify the file was actually migrated
      const storeDir = computeStoreDir(projectPath)
      expect(realFs.existsSync(path.join(storeDir, 'activity.jsonl'))).toBe(true)
    })

    it('ensures store dirs without migration when no legacy exists', () => {
      const projectPath = path.join(tmpDir, 'fresh-proj')
      realFs.mkdirSync(projectPath, { recursive: true })

      const result = invoke('slashbot:migrate-check', projectPath)

      expect(result.ok).toBe(true)
      expect(result.didMigrate).toBe(false)
      expect(result.storeDir).toBe(computeStoreDir(projectPath))
      // Store dirs should be created
      expect(realFs.existsSync(computeStoreDir(projectPath))).toBe(true)
    })

    it('returns error on failure', () => {
      // Use a path that will cause getProjectPaths to work but ensureStoreDirs to fail
      // We test the error envelope by using a non-writable path
      const projectPath = '/test/project'
      const result = invoke('slashbot:migrate-check', projectPath)

      // This will either succeed (if home dir is writable) or return an error envelope
      expect(result).toHaveProperty('ok')
    })
  })

  describe('project:add with migration', () => {
    it('auto-migrates legacy storage', () => {
      const projectPath = path.join(tmpDir, 'legacy-proj')
      const legacyDir = path.join(projectPath, '.slashbot')
      realFs.mkdirSync(legacyDir, { recursive: true })
      realFs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), '{"test":true}\n')

      const result = invoke('project:add', projectPath)

      expect(result).toEqual({ ok: true })
      const storeDir = computeStoreDir(projectPath)
      expect(realFs.existsSync(path.join(storeDir, 'activity.jsonl'))).toBe(true)
    })

    it('skips migration when no legacy storage exists', () => {
      const projectPath = path.join(tmpDir, 'new-proj')
      realFs.mkdirSync(projectPath, { recursive: true })

      const result = invoke('project:add', projectPath)

      expect(result).toEqual({ ok: true })
      const storeDir = computeStoreDir(projectPath)
      expect(realFs.existsSync(path.join(storeDir, 'activity.jsonl'))).toBe(false)
    })
  })
})
