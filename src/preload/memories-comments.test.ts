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

describe('preload memories namespace', () => {
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

  it('exposes memories namespace with list, add, and forget methods', async () => {
    const api = await loadApi()
    const memories = api.memories as Record<string, unknown>
    expect(memories).toBeDefined()
    expect(typeof memories.list).toBe('function')
    expect(typeof memories.add).toBe('function')
    expect(typeof memories.forget).toBe('function')
  })

  it('memories.list invokes memories:list with projectPath', async () => {
    const api = await loadApi()
    const memories = api.memories as Record<string, (...args: unknown[]) => unknown>
    await memories.list('/my/project')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('memories:list', '/my/project')
  })

  it('memories.add invokes memories:add with text and optional key', async () => {
    const api = await loadApi()
    const memories = api.memories as Record<string, (...args: unknown[]) => unknown>
    await memories.add('/my/project', 'remember this', 'my-key')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'memories:add',
      '/my/project',
      'remember this',
      'my-key',
    )
  })

  it('memories.add works without key', async () => {
    const api = await loadApi()
    const memories = api.memories as Record<string, (...args: unknown[]) => unknown>
    await memories.add('/my/project', 'remember this')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'memories:add',
      '/my/project',
      'remember this',
      undefined,
    )
  })

  it('memories.forget invokes memories:forget with key', async () => {
    const api = await loadApi()
    const memories = api.memories as Record<string, (...args: unknown[]) => unknown>
    await memories.forget('/my/project', 'my-key')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'memories:forget',
      '/my/project',
      'my-key',
    )
  })
})

describe('preload beads.comments and beads.addComment', () => {
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

  it('exposes comments and addComment on beads namespace', async () => {
    const api = await loadApi()
    const beads = api.beads as Record<string, unknown>
    expect(typeof beads.comments).toBe('function')
    expect(typeof beads.addComment).toBe('function')
  })

  it('beads.comments invokes comments:list with projectPath and id', async () => {
    const api = await loadApi()
    const beads = api.beads as Record<string, (...args: unknown[]) => unknown>
    await beads.comments('/my/project', 'abc-123')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'comments:list',
      '/my/project',
      'abc-123',
    )
  })

  it('beads.addComment invokes comments:add with projectPath, id, and text', async () => {
    const api = await loadApi()
    const beads = api.beads as Record<string, (...args: unknown[]) => unknown>
    await beads.addComment('/my/project', 'abc-123', 'Great work!')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'comments:add',
      '/my/project',
      'abc-123',
      'Great work!',
    )
  })
})
