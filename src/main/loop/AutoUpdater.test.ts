import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted, so we use vi.hoisted() for shared state
// ---------------------------------------------------------------------------

const { mockAutoUpdater } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }))

vi.mock('electron', () => ({
  app: { isPackaged: true },
}))

import { app } from 'electron'
import { AutoUpdater } from './AutoUpdater'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  }
}

/** Retrieve the handler registered for a given autoUpdater event. */
function getHandler(event: string): (...args: unknown[]) => void {
  const call = mockAutoUpdater.on.mock.calls.find((c) => c[0] === event)
  if (!call) throw new Error(`No handler registered for "${event}"`)
  return call[1] as (...args: unknown[]) => void
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockAutoUpdater.on.mockReset()
    mockAutoUpdater.removeAllListeners.mockReset()
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.downloadUpdate.mockReset()
    mockAutoUpdater.quitAndInstall.mockReset()
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.autoInstallOnAppQuit = true
    ;(app as { isPackaged: boolean }).isPackaged = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- Constructor -------------------------------------------------------

  it('disables autoDownload and autoInstallOnAppQuit on construction', () => {
    const win = makeWindow()
    new AutoUpdater(() => win as never)
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('registers electron-updater event handlers on construction', () => {
    const win = makeWindow()
    new AutoUpdater(() => win as never)

    const events = mockAutoUpdater.on.mock.calls.map((c) => c[0])
    expect(events).toContain('checking-for-update')
    expect(events).toContain('update-available')
    expect(events).toContain('update-not-available')
    expect(events).toContain('download-progress')
    expect(events).toContain('update-downloaded')
    expect(events).toContain('error')
  })

  // ---- start / destroy ---------------------------------------------------

  it('schedules check after 30 s delay and then every 4 h', async () => {
    const win = makeWindow()
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined)
    const updater = new AutoUpdater(() => win as never)
    updater.start()

    // Nothing yet
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()

    // Advance past startup delay (30 s)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    // Advance 4 hours — second check
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)

    updater.destroy()
  })

  it('start() is idempotent', async () => {
    const win = makeWindow()
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined)
    const updater = new AutoUpdater(() => win as never)
    updater.start()
    updater.start() // second call — no-op

    await vi.advanceTimersByTimeAsync(30_000)
    // Only one check, proving no duplicate timer
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.destroy()
  })

  it('destroy() clears all timers', async () => {
    const win = makeWindow()
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined)
    const updater = new AutoUpdater(() => win as never)
    updater.start()
    updater.destroy()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mockAutoUpdater.removeAllListeners).toHaveBeenCalled()
  })

  // ---- Dev guard ---------------------------------------------------------

  it('start() is a no-op when app is not packaged', () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    updater.start()

    // No timers set — state unchanged
    expect(updater.state).toBe('idle')
    updater.destroy()
  })

  it('checkForUpdates() is a no-op when app is not packaged', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    await updater.checkForUpdates()
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('downloadUpdate() is a no-op when app is not packaged', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    await updater.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('quitAndInstall() is a no-op when app is not packaged', () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    updater.quitAndInstall()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  // ---- State guards ------------------------------------------------------

  it('checkForUpdates() skips when already checking', async () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)

    // Simulate "checking" state via the event handler
    getHandler('checking-for-update')()
    expect(updater.state).toBe('checking')

    await updater.checkForUpdates()
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checkForUpdates() skips when already downloading', async () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)

    // Move to 'downloading' via progress event
    getHandler('download-progress')({ percent: 10, bytesPerSecond: 512, transferred: 100, total: 1000 })
    expect(updater.state).toBe('downloading')

    await updater.checkForUpdates()
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('downloadUpdate() only works when state is "available"', async () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)

    // State is 'idle' — should not download
    await updater.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()

    // Simulate update-available
    getHandler('update-available')({ version: '2.0.0', releaseDate: '2026-01-01' })
    expect(updater.state).toBe('available')

    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined)
    await updater.downloadUpdate()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('quitAndInstall() only works when state is "downloaded"', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)

    updater.quitAndInstall() // state is 'idle'
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // Move to 'downloaded'
    getHandler('update-downloaded')({ version: '2.0.0', releaseDate: '2026-01-01' })
    expect(updater.state).toBe('downloaded')

    updater.quitAndInstall()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  // ---- Event handling / IPC broadcast ------------------------------------

  it('broadcasts checking event to the window', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('checking-for-update')()

    expect(win.webContents.send).toHaveBeenCalledWith('update:event', { type: 'checking' })
    expect(updater.state).toBe('checking')
  })

  it('broadcasts update-available event with normalized info', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('update-available')({ version: '3.1.0', releaseDate: '2026-03-24', releaseNotes: 'Bug fixes' })

    expect(updater.state).toBe('available')
    expect(updater.latestInfo).toEqual({
      version: '3.1.0',
      releaseDate: '2026-03-24',
      releaseNotes: 'Bug fixes',
    })
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'available',
      info: { version: '3.1.0', releaseDate: '2026-03-24', releaseNotes: 'Bug fixes' },
    })
  })

  it('normalizes array releaseNotes into a joined string', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('update-available')({
      version: '3.2.0',
      releaseDate: '2026-04-01',
      releaseNotes: [{ note: 'Fix A' }, { note: 'Fix B' }],
    })

    expect(updater.latestInfo!.releaseNotes).toBe('Fix A\nFix B')
  })

  it('broadcasts update-not-available event', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('update-not-available')({ version: '1.0.0', releaseDate: '2025-12-01' })

    expect(updater.state).toBe('not-available')
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'not-available',
      info: { version: '1.0.0', releaseDate: '2025-12-01', releaseNotes: null },
    })
  })

  it('broadcasts download-progress events and transitions to downloading state', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('download-progress')({ percent: 42, bytesPerSecond: 1024, transferred: 420, total: 1000 })

    expect(updater.state).toBe('downloading')
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'progress',
      progress: { percent: 42, bytesPerSecond: 1024, transferred: 420, total: 1000 },
    })
  })

  it('broadcasts update-downloaded event', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('update-downloaded')({ version: '3.1.0', releaseDate: '2026-03-24', releaseNotes: null })

    expect(updater.state).toBe('downloaded')
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'downloaded',
      info: { version: '3.1.0', releaseDate: '2026-03-24', releaseNotes: null },
    })
  })

  it('broadcasts error event', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    getHandler('error')(new Error('Network timeout'))

    expect(updater.state).toBe('error')
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'error',
      error: 'Network timeout',
    })
  })

  // ---- Null / destroyed window -------------------------------------------

  it('does not throw when window getter returns null', () => {
    const updater = new AutoUpdater(() => null)
    expect(() => getHandler('checking-for-update')()).not.toThrow()
    expect(updater.state).toBe('checking')
  })

  it('does not send to a destroyed window', () => {
    const win = makeWindow(true) // isDestroyed() returns true
    new AutoUpdater(() => win as never)
    getHandler('checking-for-update')()

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  // ---- Error handling in checkForUpdates / downloadUpdate ----------------

  it('catches checkForUpdates errors without double-broadcasting', async () => {
    // electron-updater fires 'error' before rejecting the promise. The event
    // handler owns state + broadcast; the catch block must only log.
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      getHandler('error')(new Error('no internet')) // event fires first
      throw new Error('no internet')
    })

    await updater.checkForUpdates()

    expect(updater.state).toBe('error')
    // Exactly one broadcast — from the event handler, not duplicated by the catch
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('update:event', {
      type: 'error',
      error: 'no internet',
    })
  })

  it('catches downloadUpdate errors without double-broadcasting', async () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)

    // Move to 'available' first
    getHandler('update-available')({ version: '2.0.0', releaseDate: '2026-01-01' })
    mockAutoUpdater.downloadUpdate.mockImplementation(async () => {
      getHandler('error')(new Error('disk full')) // event fires first
      throw new Error('disk full')
    })

    await updater.downloadUpdate()

    expect(updater.state).toBe('error')
    // Two broadcasts total: one for update-available, one for the error
    const errorCall = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'error',
    )
    expect(errorCall).toBeDefined()
    expect(errorCall![1]).toEqual({ type: 'error', error: 'disk full' })
    // Confirm no duplicate error broadcast
    const errorCalls = win.webContents.send.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'error',
    )
    expect(errorCalls).toHaveLength(1)
  })

  // ---- update-event emission ---------------------------------------------

  it('emits update-event on the AutoUpdater instance', () => {
    const win = makeWindow()
    const updater = new AutoUpdater(() => win as never)
    const events: unknown[] = []
    updater.on('update-event', (e) => events.push(e))

    getHandler('checking-for-update')()
    getHandler('update-available')({ version: '4.0.0', releaseDate: '2026-06-01', releaseNotes: null })

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'checking' })
    expect((events[1] as { type: string }).type).toBe('available')
  })
})
