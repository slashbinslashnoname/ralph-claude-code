import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted above imports, so we build the mock with vi.hoisted()
// which cannot reference module-level imports like EventEmitter.
// We implement a minimal event emitter inline.
const { mockAutoUpdater } = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  const listeners = new Map<string, Listener[]>()

  const mock = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(fn)
      return mock
    },
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    removeAllListeners() {
      listeners.clear()
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length
    },
  }
  return { mockAutoUpdater: mock }
})

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}))

import { AutoUpdater } from './AutoUpdater'

describe('AutoUpdater', () => {
  let updater: AutoUpdater

  beforeEach(() => {
    vi.clearAllMocks()
    mockAutoUpdater.removeAllListeners()
    mockAutoUpdater.autoDownload = true
    mockAutoUpdater.autoInstallOnAppQuit = true
    updater = new AutoUpdater()
  })

  it('starts in idle state', () => {
    expect(updater.getState()).toEqual({ state: 'idle' })
  })

  it('disables autoDownload and autoInstallOnAppQuit', () => {
    expect(mockAutoUpdater.autoDownload).toBe(false)
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('check() calls autoUpdater.checkForUpdates()', async () => {
    await updater.check()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled()
  })

  it('download() calls autoUpdater.downloadUpdate()', async () => {
    await updater.download()
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled()
  })

  it('quitAndInstall() calls autoUpdater.quitAndInstall()', () => {
    updater.quitAndInstall()
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled()
  })

  describe('event forwarding', () => {
    it('emits checking and sets state', () => {
      const cb = vi.fn()
      updater.on('checking', cb)

      mockAutoUpdater.emit('checking-for-update')
      expect(cb).toHaveBeenCalled()
      expect(updater.state).toBe('checking')
    })

    it('emits available with info and sets state', () => {
      const cb = vi.fn()
      updater.on('available', cb)
      const info = { version: '2.0.0', releaseDate: '2026-01-01', releaseNotes: null }

      mockAutoUpdater.emit('update-available', info)
      expect(cb).toHaveBeenCalledWith(info)
      expect(updater.state).toBe('available')
    })

    it('emits not-available with info and sets state', () => {
      const cb = vi.fn()
      updater.on('not-available', cb)
      const info = { version: '1.0.0', releaseDate: '2026-01-01', releaseNotes: null }

      mockAutoUpdater.emit('update-not-available', info)
      expect(cb).toHaveBeenCalledWith(info)
      expect(updater.state).toBe('not-available')
    })

    it('emits progress and sets state to downloading', () => {
      const cb = vi.fn()
      updater.on('progress', cb)
      const progress = { percent: 50, bytesPerSecond: 1024, transferred: 512, total: 1024 }

      mockAutoUpdater.emit('download-progress', progress)
      expect(cb).toHaveBeenCalledWith(progress)
      expect(updater.state).toBe('downloading')
    })

    it('emits downloaded with info and sets state', () => {
      const cb = vi.fn()
      updater.on('downloaded', cb)
      const info = { version: '2.0.0', releaseDate: '2026-01-01', releaseNotes: 'fixes' }

      mockAutoUpdater.emit('update-downloaded', info)
      expect(cb).toHaveBeenCalledWith(info)
      expect(updater.state).toBe('downloaded')
    })

    it('emits error string and sets state', () => {
      const cb = vi.fn()
      updater.on('error', cb)

      mockAutoUpdater.emit('error', new Error('network failure'))
      expect(cb).toHaveBeenCalledWith('network failure')
      expect(updater.state).toBe('error')
    })
  })
})
