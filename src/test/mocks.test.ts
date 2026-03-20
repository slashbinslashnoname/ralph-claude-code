import { describe, it, expect } from 'vitest'
import {
  createMockChildProcess,
  createMockSpawn,
  createMockFs,
  createMockBrowserWindow,
  createMockElectronApp,
  createMockIpcMain,
  createMockDialog,
} from './mocks'

describe('createMockChildProcess', () => {
  it('creates a process with the given pid', () => {
    const proc = createMockChildProcess(42)
    expect(proc.pid).toBe(42)
    expect(proc.exitCode).toBeNull()
  })

  it('simulateStdout emits data on stdout', () => {
    const proc = createMockChildProcess()
    const chunks: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.simulateStdout('hello')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].toString()).toBe('hello')
  })

  it('simulateStderr emits data on stderr', () => {
    const proc = createMockChildProcess()
    const chunks: Buffer[] = []
    proc.stderr.on('data', (d: Buffer) => chunks.push(d))
    proc.simulateStderr('oops')
    expect(chunks[0].toString()).toBe('oops')
  })

  it('simulateExit emits close and exit events', () => {
    const proc = createMockChildProcess()
    let closedWith: number | null = null
    let exitedWith: number | null = null
    proc.on('close', (code: number) => { closedWith = code })
    proc.on('exit', (code: number) => { exitedWith = code })
    proc.simulateExit(1)
    expect(closedWith).toBe(1)
    expect(exitedWith).toBe(1)
    expect(proc.exitCode).toBe(1)
  })
})

describe('createMockSpawn', () => {
  it('returns a callable spawn that tracks the last process', () => {
    const spawn = createMockSpawn()
    expect(spawn.lastProcess).toBeNull()
    const proc = spawn('node', ['--version'])
    expect(proc).toBeDefined()
    expect(spawn.lastProcess).not.toBeNull()
    expect(spawn).toHaveBeenCalledWith('node', ['--version'])
  })
})

describe('createMockFs', () => {
  it('existsSync returns true for initial files', () => {
    const fs = createMockFs({ '/a.txt': 'content' })
    expect(fs.existsSync('/a.txt')).toBe(true)
    expect(fs.existsSync('/missing')).toBe(false)
  })

  it('readFileSync returns file content or throws ENOENT', () => {
    const fs = createMockFs({ '/a.txt': 'hello' })
    expect(fs.readFileSync('/a.txt')).toBe('hello')
    expect(() => fs.readFileSync('/missing')).toThrow('ENOENT')
  })

  it('writeFileSync adds files to the store', () => {
    const fs = createMockFs()
    fs.writeFileSync('/new.txt', 'data')
    expect(fs.existsSync('/new.txt')).toBe(true)
    expect(fs.readFileSync('/new.txt')).toBe('data')
  })

  it('rmSync removes files', () => {
    const fs = createMockFs({ '/a.txt': 'x' })
    fs.rmSync('/a.txt')
    expect(fs.existsSync('/a.txt')).toBe(false)
  })

  it('renameSync moves content between keys', () => {
    const fs = createMockFs({ '/old': 'content' })
    fs.renameSync('/old', '/new')
    expect(fs.existsSync('/old')).toBe(false)
    expect(fs.readFileSync('/new')).toBe('content')
  })
})

describe('createMockBrowserWindow', () => {
  it('has callable webContents.send and lifecycle methods', () => {
    const win = createMockBrowserWindow()
    win.webContents.send('channel', 'data')
    expect(win.webContents.send).toHaveBeenCalledWith('channel', 'data')
    expect(win.isDestroyed()).toBe(false)
  })
})

describe('createMockElectronApp', () => {
  it('provides standard app methods', () => {
    const app = createMockElectronApp()
    expect(app.isReady()).toBe(true)
    expect(app.getPath('userData')).toBe('/mock/userData')
    expect(app.getName()).toBe('slashbot-test')
  })
})

describe('createMockIpcMain', () => {
  it('registers handlers and allows invocation via _invoke', async () => {
    const ipc = createMockIpcMain()
    ipc.handle('test-channel', (_event: unknown, x: number) => x * 2)
    const result = await ipc._invoke('test-channel', 5)
    expect(result).toBe(10)
  })

  it('throws when invoking an unregistered channel', async () => {
    const ipc = createMockIpcMain()
    await expect(ipc._invoke('missing')).rejects.toThrow('No handler for channel')
  })

  it('removeHandler removes the handler', async () => {
    const ipc = createMockIpcMain()
    ipc.handle('ch', () => 'ok')
    ipc.removeHandler('ch')
    await expect(ipc._invoke('ch')).rejects.toThrow()
  })
})

describe('createMockDialog', () => {
  it('returns expected defaults', async () => {
    const dialog = createMockDialog()
    const open = await dialog.showOpenDialog({})
    expect(open.canceled).toBe(false)
    expect(open.filePaths).toEqual(['/mock/selected'])

    const save = await dialog.showSaveDialog({})
    expect(save.canceled).toBe(false)

    const msg = await dialog.showMessageBox({})
    expect(msg.response).toBe(0)
  })
})
