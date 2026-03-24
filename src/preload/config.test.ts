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

describe('preload config namespace', () => {
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

  it('exposes config namespace with read and write methods', async () => {
    const api = await loadApi()
    const config = api.config as Record<string, unknown>
    expect(config).toBeDefined()
    expect(typeof config.read).toBe('function')
    expect(typeof config.write).toBe('function')
  })

  it('config.read invokes config:read with projectPath', async () => {
    const api = await loadApi()
    const config = api.config as Record<string, (...args: unknown[]) => unknown>
    await config.read('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('config:read', '/my/project')
  })

  it('config.write invokes config:write with projectPath and updates', async () => {
    const api = await loadApi()
    const config = api.config as Record<string, (...args: unknown[]) => unknown>
    const updates = { maxCallsPerHour: 100, autoPush: true }
    await config.write('/my/project', updates)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'config:write',
      '/my/project',
      updates,
    )
  })
})
