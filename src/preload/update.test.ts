import { describe, it, expect, vi, beforeEach } from 'vitest'

const electron = {
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}

vi.mock('electron', () => electron)

describe('preload update namespace', () => {
  async function loadApi(): Promise<Record<string, unknown>> {
    vi.resetModules()
    await import('./index')
    const call = electron.contextBridge.exposeInMainWorld.mock.calls[0]
    expect(call[0]).toBe('slashbot')
    return call[1] as Record<string, unknown>
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes update namespace with all invoke methods', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, unknown>
    expect(update).toBeDefined()
    expect(typeof update.check).toBe('function')
    expect(typeof update.download).toBe('function')
    expect(typeof update.install).toBe('function')
    expect(typeof update.getState).toBe('function')
  })

  it('exposes update namespace with all event listeners', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, unknown>
    expect(typeof update.onChecking).toBe('function')
    expect(typeof update.onAvailable).toBe('function')
    expect(typeof update.onNotAvailable).toBe('function')
    expect(typeof update.onProgress).toBe('function')
    expect(typeof update.onDownloaded).toBe('function')
    expect(typeof update.onError).toBe('function')
  })

  it('check invokes update:check', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    await update.check()
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('update:check')
  })

  it('download invokes update:download', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    await update.download()
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('update:download')
  })

  it('install invokes update:install', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    await update.install()
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('update:install')
  })

  it('getState invokes update:state', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    await update.getState()
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('update:state')
  })

  it('onChecking registers listener on update:checking', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onChecking(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('update:checking', expect.any(Function))
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:checking',
      expect.any(Function),
    )
  })

  it('onAvailable registers listener on update:available', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onAvailable(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('update:available', expect.any(Function))
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:available',
      expect.any(Function),
    )
  })

  it('onNotAvailable registers listener on update:not-available', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onNotAvailable(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
      'update:not-available',
      expect.any(Function),
    )
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:not-available',
      expect.any(Function),
    )
  })

  it('onProgress registers listener on update:progress', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onProgress(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('update:progress', expect.any(Function))
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:progress',
      expect.any(Function),
    )
  })

  it('onDownloaded registers listener on update:downloaded', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onDownloaded(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('update:downloaded', expect.any(Function))
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:downloaded',
      expect.any(Function),
    )
  })

  it('onError registers listener on update:error', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = update.onError(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('update:error', expect.any(Function))
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'update:error',
      expect.any(Function),
    )
  })

  it('event listener forwards args to callback (strips event)', async () => {
    const api = await loadApi()
    const update = api.update as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    update.onAvailable(cb)
    const handler = electron.ipcRenderer.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'update:available',
    )![1] as (...args: unknown[]) => void
    handler({}, { version: '1.2.3' })
    expect(cb).toHaveBeenCalledWith({ version: '1.2.3' })
  })
})
