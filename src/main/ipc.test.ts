import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as realFs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { BdClient } from './loop/BdClient'

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
    getSwarmPhase: () => 'idle',
    coordinator: { rollbackBead: vi.fn() },
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}))

const mockLoadConfig = vi.fn().mockReturnValue({})
const mockValidateConfig = vi.fn().mockReturnValue({ config: {}, warnings: [] })
const mockSerializeConfig = vi.fn().mockReturnValue('MAX_CALLS_PER_HOUR=100\n')
vi.mock('./loop/RcParser', () => ({
  loadConfig: mockLoadConfig,
  validateConfig: mockValidateConfig,
  serializeConfig: mockSerializeConfig,
}))

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

const mockAutoUpdaterInstance = {
  on: vi.fn(),
  check: vi.fn().mockResolvedValue(undefined),
  download: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn(),
  getState: vi.fn().mockReturnValue({ state: 'idle' }),
}
vi.mock('./loop/AutoUpdater', () => ({
  AutoUpdater: vi.fn().mockImplementation(() => mockAutoUpdaterInstance),
}))

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
  const hash8 = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  const id = `${path.basename(absolute)}-${hash8}`
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
    mockLoadConfig.mockClear().mockReturnValue({})
    mockValidateConfig.mockClear().mockReturnValue({ config: {}, warnings: [] })
    mockSerializeConfig.mockClear().mockReturnValue('MAX_CALLS_PER_HOUR=100\n')
    mockAutoUpdaterInstance.check.mockClear()
    mockAutoUpdaterInstance.download.mockClear()
    mockAutoUpdaterInstance.quitAndInstall.mockClear()
    mockAutoUpdaterInstance.getState.mockClear()

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
    it('constructs CircuitBreaker with storeDir and agentId when agentId provided', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      mockCircuitBreaker.mockClear()
      invoke('circuit:reset', projectPath, { agentId: 'worker-0' })

      expect(mockCircuitBreaker).toHaveBeenCalledWith(storeDir, expect.any(Object), 'worker-0')
    })

    it('returns ok:true without calling CircuitBreaker when no per-worker files exist', () => {
      const projectPath = '/test/project'

      mockCircuitBreaker.mockClear()
      const result = invoke('circuit:reset', projectPath)

      expect(result).toEqual({ ok: true })
      expect(mockCircuitBreaker).not.toHaveBeenCalled()
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
      invoke('swarm:agent-log-content', projectPath, 'worker-0_think_2025-01-01.log')

      expect(fsReadCalls).toContain(path.join(storeDir, 'logs', 'worker-0_think_2025-01-01.log'))
    })
  })

  describe('swarm:agent-output fallback', () => {
    it('falls back to centralized logsDir when no active swarm', () => {
      const projectPath = '/test/project'
      const storeDir = computeStoreDir(projectPath)

      fsReadCalls.length = 0
      invoke('swarm:agent-output', projectPath, 'worker-0')

      expect(fsReadCalls).toContain(path.join(storeDir, 'logs', 'worker-0.log'))
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


  describe('update:check', () => {
    it('calls AutoUpdater.check()', async () => {
      await invoke('update:check')
      expect(mockAutoUpdaterInstance.check).toHaveBeenCalled()
    })
  })

  describe('update:download', () => {
    it('calls AutoUpdater.download()', async () => {
      await invoke('update:download')
      expect(mockAutoUpdaterInstance.download).toHaveBeenCalled()
    })
  })

  describe('update:install', () => {
    it('calls quitAndInstall after graceful shutdown', async () => {
      await invoke('update:install')
      expect(mockAutoUpdaterInstance.quitAndInstall).toHaveBeenCalled()
    })
  })

  describe('update:state', () => {
    it('returns current updater state', () => {
      const result = invoke('update:state')
      expect(result).toEqual({ state: 'idle' })
      expect(mockAutoUpdaterInstance.getState).toHaveBeenCalled()
    })
  })

  describe('registerIpc return value', () => {
    it('returns an IpcHandle with getAutoUpdater()', async () => {
      const { registerIpc } = await import('./ipc')
      registeredHandlers.clear()
      const handle = registerIpc(() => null, storePath)
      expect(handle).toBeDefined()
      expect(typeof handle.getAutoUpdater).toBe('function')
      const updater = handle.getAutoUpdater()
      expect(updater).toBe(mockAutoUpdaterInstance)
    })
  })

  describe('auto-update event wiring', () => {
    it('registers event listeners on AutoUpdater for broadcast', () => {
      // Trigger lazy init
      invoke('update:state')
      const eventNames = mockAutoUpdaterInstance.on.mock.calls.map((c: any[]) => c[0])
      expect(eventNames).toContain('checking')
      expect(eventNames).toContain('available')
      expect(eventNames).toContain('not-available')
      expect(eventNames).toContain('progress')
      expect(eventNames).toContain('downloaded')
      expect(eventNames).toContain('error')
    })
  })

  describe('config:read', () => {
    it('returns {ok, config} from loadConfig', () => {
      const fakeConfig = { maxCallsPerHour: 200, sleepDuration: 5 }
      mockLoadConfig.mockReturnValueOnce(fakeConfig)

      const result = invoke('config:read', '/test/project')

      expect(result).toEqual({ ok: true, config: fakeConfig })
      expect(mockLoadConfig).toHaveBeenCalledWith('/test/project')
    })

    it('returns {ok: false, error} when loadConfig throws', () => {
      mockLoadConfig.mockImplementationOnce(() => { throw new Error('bad rc') })

      const result = invoke('config:read', '/test/project')

      expect(result).toEqual({ ok: false, error: 'bad rc' })
    })
  })

  describe('config:write', () => {
    it('merges partial config and writes serialized output', () => {
      const projectPath = path.join(tmpDir, 'write-proj')
      realFs.mkdirSync(projectPath, { recursive: true })
      const current = { maxCallsPerHour: 100, sleepDuration: 3, telegram: { botToken: 'tok', chatId: 'cid', enabled: true, notifyOn: 'all' as const } }
      const validated = { ...current, maxCallsPerHour: 200 }
      mockLoadConfig.mockReturnValueOnce(current)
      mockValidateConfig.mockReturnValueOnce({ config: validated, warnings: [] })
      mockSerializeConfig.mockReturnValueOnce('MAX_CALLS_PER_HOUR=200\n')

      const result = invoke('config:write', projectPath, { maxCallsPerHour: 200 })

      expect(result).toEqual({ ok: true })
      expect(mockLoadConfig).toHaveBeenCalledWith(projectPath)
      expect(mockValidateConfig).toHaveBeenCalledWith(expect.objectContaining({ maxCallsPerHour: 200 }))
      expect(mockSerializeConfig).toHaveBeenCalledWith(validated)
      expect(fsWriteCalls).toContain(path.join(projectPath, '.slashbotrc'))
    })

    it('preserves telegram keys when not in partial', () => {
      const projectPath = path.join(tmpDir, 'tg-preserve')
      realFs.mkdirSync(projectPath, { recursive: true })
      const current = { maxCallsPerHour: 100, telegram: { botToken: 'secret', chatId: '-100', enabled: true, notifyOn: 'all' as const } }
      mockLoadConfig.mockReturnValueOnce(current)
      mockValidateConfig.mockReturnValueOnce({ config: { ...current, sleepDuration: 10 }, warnings: [] })

      invoke('config:write', projectPath, { sleepDuration: 10 })

      const mergedArg = mockValidateConfig.mock.calls[0][0]
      expect(mergedArg.telegram).toEqual(current.telegram)
    })

    it('merges telegram sub-keys when partial includes telegram', () => {
      const projectPath = path.join(tmpDir, 'tg-merge')
      realFs.mkdirSync(projectPath, { recursive: true })
      const current = { telegram: { botToken: 'tok', chatId: '-100', enabled: true, notifyOn: 'all' as const } }
      mockLoadConfig.mockReturnValueOnce(current)
      mockValidateConfig.mockReturnValueOnce({ config: current, warnings: [] })

      invoke('config:write', projectPath, { telegram: { chatId: '-999' } as any })

      const mergedArg = mockValidateConfig.mock.calls[0][0]
      expect(mergedArg.telegram.botToken).toBe('tok')
      expect(mergedArg.telegram.chatId).toBe('-999')
      expect(mergedArg.telegram.enabled).toBe(true)
    })

    it('returns error when validation produces warnings', () => {
      mockLoadConfig.mockReturnValueOnce({})
      mockValidateConfig.mockReturnValueOnce({ config: {}, warnings: ['value out of range'] })

      const result = invoke('config:write', '/test/project', { maxCallsPerHour: -5 })

      expect(result).toEqual({ ok: false, error: 'value out of range' })
    })

    it('returns error when loadConfig throws', () => {
      mockLoadConfig.mockImplementationOnce(() => { throw new Error('no rc') })

      const result = invoke('config:write', '/test/project', { maxCallsPerHour: 100 })

      expect(result).toEqual({ ok: false, error: 'no rc' })
    })
  })

  // ── Memories IPC handlers ───────────────────────────────────────────────

  describe('memories:list', () => {
    it('returns memories from BdClient', async () => {
      const memoriesAsync = vi.fn().mockResolvedValue([{ key: 'k1', text: 'v1' }])
      vi.mocked(BdClient).mockImplementationOnce(() => ({ memoriesAsync }) as any)
      const result = await invoke('memories:list', '/test/project')
      expect(result).toEqual({ ok: true, memories: [{ key: 'k1', text: 'v1' }] })
      expect(memoriesAsync).toHaveBeenCalled()
    })

    it('returns error with empty array on failure', async () => {
      vi.mocked(BdClient).mockImplementationOnce(() => ({
        memoriesAsync: vi.fn().mockRejectedValue(new Error('bd failed')),
      }) as any)
      const result = await invoke('memories:list', '/test/project')
      expect(result).toEqual({ ok: false, error: 'bd failed', memories: [] })
    })
  })

  describe('memories:add', () => {
    it('calls rememberAsync with text and optional key', async () => {
      const rememberAsync = vi.fn().mockResolvedValue({ action: 'added', key: 'k1', value: 'v1' })
      vi.mocked(BdClient).mockImplementationOnce(() => ({ rememberAsync }) as any)
      const result = await invoke('memories:add', '/test/project', 'my note', 'mykey')
      expect(result).toEqual({ ok: true, result: { action: 'added', key: 'k1', value: 'v1' } })
      expect(rememberAsync).toHaveBeenCalledWith('my note', 'mykey')
    })

    it('calls rememberAsync without key when not provided', async () => {
      const rememberAsync = vi.fn().mockResolvedValue({ action: 'added', key: 'auto', value: 'my note' })
      vi.mocked(BdClient).mockImplementationOnce(() => ({ rememberAsync }) as any)
      const result = await invoke('memories:add', '/test/project', 'my note')
      expect(result.ok).toBe(true)
      expect(rememberAsync).toHaveBeenCalledWith('my note', undefined)
    })

    it('rejects empty text', async () => {
      const result = await invoke('memories:add', '/test/project', '')
      expect(result).toEqual({ ok: false, error: 'text must be a non-empty string' })
    })

    it('rejects empty key string', async () => {
      const result = await invoke('memories:add', '/test/project', 'note', '')
      expect(result).toEqual({ ok: false, error: 'key must be a non-empty string when provided' })
    })
  })

  describe('memories:forget', () => {
    it('calls forgetAsync with key', async () => {
      const forgetAsync = vi.fn().mockResolvedValue({ deleted: 'k1', key: 'k1' })
      vi.mocked(BdClient).mockImplementationOnce(() => ({ forgetAsync }) as any)
      const result = await invoke('memories:forget', '/test/project', 'k1')
      expect(result).toEqual({ ok: true, result: { deleted: 'k1', key: 'k1' } })
      expect(forgetAsync).toHaveBeenCalledWith('k1')
    })

    it('rejects empty key', async () => {
      const result = await invoke('memories:forget', '/test/project', '')
      expect(result).toEqual({ ok: false, error: 'key must be a non-empty string' })
    })
  })

  // ── Comments IPC handlers ──────────────────────────────────────────────

  describe('comments:list', () => {
    it('returns comments for a bead', async () => {
      const commentsAsync = vi.fn().mockResolvedValue([{ id: 'c1', issueId: 'b1', author: 'me', text: 'hello', createdAt: '2026-01-01' }])
      vi.mocked(BdClient).mockImplementationOnce(() => ({ commentsAsync }) as any)
      const result = await invoke('comments:list', '/test/project', 'bead-1')
      expect(result.ok).toBe(true)
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0].id).toBe('c1')
      expect(commentsAsync).toHaveBeenCalledWith('bead-1')
    })

    it('returns error with empty array on failure', async () => {
      vi.mocked(BdClient).mockImplementationOnce(() => ({
        commentsAsync: vi.fn().mockRejectedValue(new Error('not found')),
      }) as any)
      const result = await invoke('comments:list', '/test/project', 'bead-1')
      expect(result).toEqual({ ok: false, error: 'not found', comments: [] })
    })
  })

  describe('comments:add', () => {
    it('adds a comment to a bead', async () => {
      const addCommentAsync = vi.fn().mockResolvedValue({ id: 'c2', issueId: 'b1', author: 'me', text: 'new', createdAt: '2026-01-01' })
      vi.mocked(BdClient).mockImplementationOnce(() => ({ addCommentAsync }) as any)
      const result = await invoke('comments:add', '/test/project', 'bead-1', 'hello world')
      expect(result.ok).toBe(true)
      expect(result.comment.id).toBe('c2')
      expect(addCommentAsync).toHaveBeenCalledWith('bead-1', 'hello world')
    })

    it('rejects empty text', async () => {
      const result = await invoke('comments:add', '/test/project', 'bead-1', '')
      expect(result).toEqual({ ok: false, error: 'text must be a non-empty string' })
    })
  })
})
