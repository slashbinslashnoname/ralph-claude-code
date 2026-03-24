import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockStart = vi.fn()
const mockAutoUpdater = { start: mockStart }
const mockRegisterIpc = vi.fn().mockReturnValue({
  getAutoUpdater: () => mockAutoUpdater,
})
const mockGracefulShutdown = vi.fn().mockResolvedValue(undefined)

vi.mock('./ipc', () => ({
  registerIpc: (...args: unknown[]) => mockRegisterIpc(...args),
  gracefulShutdown: (...args: unknown[]) => mockGracefulShutdown(...args),
}))

const mockGetPath = vi.fn().mockReturnValue('/tmp/test-userdata')
let whenReadyResolve: () => void
const whenReadyPromise = new Promise<void>((r) => { whenReadyResolve = r })

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    getPath: (...args: unknown[]) => mockGetPath(...args),
    whenReady: () => whenReadyPromise,
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: { toggleDevTools: vi.fn() },
  })),
  globalShortcut: {
    register: vi.fn(),
    unregisterAll: vi.fn(),
  },
}))

vi.mock('./getIconPath', () => ({
  getIconPath: () => '/fake/icon.png',
}))

// ── Tests ─────────────────────────────────────────────────────────────────

describe('index.ts startup auto-update wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls registerIpc and receives an IpcHandle', async () => {
    await import('./index')
    expect(mockRegisterIpc).toHaveBeenCalledTimes(1)
    expect(mockRegisterIpc).toHaveBeenCalledWith(expect.any(Function), expect.stringContaining('projects.json'))
  })

  it('calls autoUpdater.start() after app is ready', async () => {
    await import('./index')
    expect(mockStart).not.toHaveBeenCalled()

    // Resolve whenReady and flush microtasks
    whenReadyResolve()
    await whenReadyPromise
    // The .then() callback runs as a microtask
    await new Promise((r) => setTimeout(r, 0))

    expect(mockStart).toHaveBeenCalledTimes(1)
  })
})
