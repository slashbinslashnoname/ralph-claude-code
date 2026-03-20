/**
 * Shared mock utilities for Vitest tests.
 *
 * Provides factory functions for mocking child_process.spawn, fs operations,
 * and Electron APIs so tests can run without real subprocesses or Electron.
 */
import { vi, type Mock } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

// ── child_process.spawn mock ───────────────────────────────────────────────

export interface MockChildProcess extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: Mock; end: Mock }
  kill: Mock
  exitCode: number | null
  /** Simulate the process exiting with the given code */
  simulateExit: (code: number) => void
  /** Simulate stdout data */
  simulateStdout: (data: string) => void
  /** Simulate stderr data */
  simulateStderr: (data: string) => void
}

/**
 * Creates a mock ChildProcess that behaves like a real spawned process.
 * Use `simulateExit`, `simulateStdout`, `simulateStderr` to drive test scenarios.
 */
export function createMockChildProcess(pid = 1234): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess
  proc.pid = pid
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.kill = vi.fn()
  proc.exitCode = null

  proc.simulateExit = (code: number) => {
    proc.exitCode = code
    proc.emit('close', code)
    proc.emit('exit', code)
  }

  proc.simulateStdout = (data: string) => {
    proc.stdout.emit('data', Buffer.from(data))
  }

  proc.simulateStderr = (data: string) => {
    proc.stderr.emit('data', Buffer.from(data))
  }

  return proc
}

/**
 * Returns a mock `spawn` function that returns a MockChildProcess.
 * Access the last spawned process via `.lastProcess`.
 */
export function createMockSpawn() {
  let lastProcess: MockChildProcess | null = null
  const mockSpawn = vi.fn((_cmd: string, _args?: string[]) => {
    lastProcess = createMockChildProcess()
    return lastProcess as unknown as ChildProcess
  })
  return Object.assign(mockSpawn, {
    get lastProcess() { return lastProcess },
  })
}

// ── fs mock helpers ────────────────────────────────────────────────────────

/**
 * Creates a mock in-memory filesystem for testing.
 * Keys are file paths, values are file contents.
 */
export function createMockFs(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles))

  return {
    existsSync: vi.fn((p: string) => files.has(p)),
    readFileSync: vi.fn((p: string, _encoding?: string) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' })
      return files.get(p)!
    }),
    writeFileSync: vi.fn((p: string, data: string) => { files.set(p, data) }),
    mkdirSync: vi.fn(),
    rmSync: vi.fn((p: string) => { files.delete(p) }),
    readdirSync: vi.fn(() => []),
    renameSync: vi.fn((from: string, to: string) => {
      const content = files.get(from)
      if (content !== undefined) {
        files.set(to, content)
        files.delete(from)
      }
    }),
    /** Direct access to the backing store for assertions */
    _files: files,
  }
}

// ── Electron API mocks ─────────────────────────────────────────────────────

export interface MockBrowserWindow {
  webContents: {
    send: Mock
    on: Mock
    removeAllListeners: Mock
  }
  on: Mock
  close: Mock
  destroy: Mock
  isDestroyed: Mock
  focus: Mock
  show: Mock
  hide: Mock
  setTitle: Mock
}

/** Creates a mock Electron BrowserWindow instance */
export function createMockBrowserWindow(): MockBrowserWindow {
  return {
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    on: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setTitle: vi.fn(),
  }
}

/** Creates a mock Electron `app` object */
export function createMockElectronApp() {
  return {
    quit: vi.fn(),
    exit: vi.fn(),
    isReady: vi.fn(() => true),
    getPath: vi.fn((name: string) => `/mock/${name}`),
    getName: vi.fn(() => 'slashbot-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  }
}

/** Creates a mock Electron `ipcMain` object */
export function createMockIpcMain() {
  const handlers = new Map<string, Function>()
  return {
    handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler) }),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
    removeAllListeners: vi.fn(),
    /** Invoke a registered handler (for testing IPC round-trips) */
    _invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for channel: ${channel}`)
      return handler({}, ...args)
    },
    _handlers: handlers,
  }
}

/** Creates a mock Electron `dialog` object */
export function createMockDialog() {
  return {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['/mock/selected'] })),
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: '/mock/saved' })),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    showErrorBox: vi.fn(),
  }
}
