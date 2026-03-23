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

describe('preload mail namespace', () => {
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

  it('exposes mail namespace with all four methods', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, unknown>
    expect(mail).toBeDefined()
    expect(typeof mail.list).toBe('function')
    expect(typeof mail.subscribe).toBe('function')
    expect(typeof mail.unsubscribe).toBe('function')
    expect(typeof mail.onMessage).toBe('function')
  })

  it('mail.list invokes correct IPC channel with default limit', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, (...args: unknown[]) => unknown>
    await mail.list('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('mail:list', '/my/project', 50)
  })

  it('mail.list invokes correct IPC channel with custom limit', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, (...args: unknown[]) => unknown>
    await mail.list('/my/project', 100)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('mail:list', '/my/project', 100)
  })

  it('mail.subscribe invokes correct IPC channel', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, (...args: unknown[]) => unknown>
    await mail.subscribe('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('mail:subscribe', '/my/project')
  })

  it('mail.unsubscribe invokes correct IPC channel', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, (...args: unknown[]) => unknown>
    await mail.unsubscribe('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('mail:unsubscribe', '/my/project')
  })

  it('mail.onMessage registers listener and returns unsubscribe', async () => {
    const api = await loadApi()
    const mail = api.mail as Record<string, (...args: unknown[]) => unknown>
    const cb = vi.fn()
    const unsub = mail.onMessage(cb) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('mail:message', expect.any(Function))
    // calling unsubscribe removes the listener
    expect(typeof unsub).toBe('function')
    unsub()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'mail:message',
      expect.any(Function),
    )
  })
})
