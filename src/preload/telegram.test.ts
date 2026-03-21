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

describe('preload telegram namespace', () => {
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

  it('exposes telegram namespace with all four methods', async () => {
    const api = await loadApi()
    const telegram = api.telegram as Record<string, unknown>
    expect(telegram).toBeDefined()
    expect(typeof telegram.status).toBe('function')
    expect(typeof telegram.configure).toBe('function')
    expect(typeof telegram.test).toBe('function')
    expect(typeof telegram.disconnect).toBe('function')
  })

  it('telegram.status invokes correct IPC channel', async () => {
    const api = await loadApi()
    const telegram = api.telegram as Record<string, (...args: unknown[]) => unknown>
    await telegram.status('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('telegram:status', '/my/project')
  })

  it('telegram.configure invokes correct IPC channel with config', async () => {
    const api = await loadApi()
    const telegram = api.telegram as Record<string, (...args: unknown[]) => unknown>
    const config = { botToken: 'tok', chatId: '123' }
    await telegram.configure('/my/project', config)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'telegram:configure',
      '/my/project',
      config,
    )
  })

  it('telegram.test invokes correct IPC channel', async () => {
    const api = await loadApi()
    const telegram = api.telegram as Record<string, (...args: unknown[]) => unknown>
    await telegram.test('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('telegram:test', '/my/project')
  })

  it('telegram.disconnect invokes correct IPC channel', async () => {
    const api = await loadApi()
    const telegram = api.telegram as Record<string, (...args: unknown[]) => unknown>
    await telegram.disconnect('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('telegram:disconnect', '/my/project')
  })
})
