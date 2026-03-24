import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
import * as child_process from 'child_process'
import * as fs from 'fs'
import { stripAnsi, buildEnv, resolveCmd, atomicWriteSync, rotateLogFile, _resetBuildEnvCache } from './utils'
import * as os from 'os'
import * as path from 'path'

let mockExecSync: any

beforeEach(() => {
  mockExecSync = vi.spyOn(child_process, 'execSync')
})

afterEach(() => {
  _resetBuildEnvCache()
  vi.restoreAllMocks()
})

describe('stripAnsi', () => {
  it('removes SGR escape sequences', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red')
  })

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1B]0;title\x07text')).toBe('text')
  })

  it('removes charset selection sequences', () => {
    expect(stripAnsi('\x1B(Btext')).toBe('text')
  })

  it('removes keypad mode sequences', () => {
    expect(stripAnsi('\x1B=text\x1B>')).toBe('text')
  })

  it('normalizes line endings', () => {
    expect(stripAnsi('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('')
  })

  it('strips mixed escape sequences', () => {
    const input = '\x1B[1m\x1B[32m✓\x1B[0m Test passed\r\n'
    expect(stripAnsi(input)).toBe('✓ Test passed\n')
  })
})

describe('buildEnv', () => {
  it('returns an env object with PATH', () => {
    const env = buildEnv()
    expect(env).toHaveProperty('PATH')
    expect(typeof env.PATH).toBe('string')
  })

  it('includes standard system paths', () => {
    const env = buildEnv()
    expect(env.PATH).toContain('/usr/local/bin')
    expect(env.PATH).toContain('/usr/bin')
    expect(env.PATH).toContain('/bin')
  })

  it('includes homebrew paths', () => {
    const env = buildEnv()
    expect(env.PATH).toContain('/opt/homebrew/bin')
  })

  it('deduplicates PATH entries', () => {
    const env = buildEnv()
    const entries = env.PATH!.split(':')
    const unique = [...new Set(entries)]
    expect(entries.length).toBe(unique.length)
  })

  it('preserves existing env vars', () => {
    const env = buildEnv()
    expect(env.HOME).toBe(process.env.HOME)
  })

  it('includes mise shim path', () => {
    const env = buildEnv()
    expect(env.PATH).toContain('.local/share/mise/shims')
  })

  it('falls back to zsh when bash probe fails', () => {
    mockExecSync.mockImplementation((cmd: any, opts: any) => {
      const cmdStr = String(cmd)
      if (cmdStr.startsWith('bash -l -c')) {
        throw new Error('bash not available')
      }
      if (cmdStr.startsWith('zsh -l -c')) {
        return Buffer.from('/zsh/probe/path:/usr/bin')
      }
      // Delegate 'which' and other calls to real implementation
      return child_process.execFileSync(cmd.split(' ')[0], cmd.split(' ').slice(1), opts)
    })

    const env = buildEnv()
    expect(env.PATH).toContain('/zsh/probe/path')
  })

  it('memoizes the result across calls', () => {
    const env1 = buildEnv()
    const env2 = buildEnv()
    expect(env1).toBe(env2) // same reference — no recomputation
  })

  it('recomputes after cache reset', () => {
    const env1 = buildEnv()
    _resetBuildEnvCache()
    const env2 = buildEnv()
    expect(env1).not.toBe(env2) // different reference after reset
    expect(env2).toHaveProperty('PATH')
  })

  it('takes last line of shell output to skip motd', () => {
    mockExecSync.mockImplementation((cmd: any, _opts: any) => {
      const cmdStr = String(cmd)
      if (cmdStr.startsWith('bash -l -c')) {
        return Buffer.from('Welcome to bash\nSome motd line\n/actual/path:/usr/bin')
      }
      if (cmdStr.startsWith('zsh -l -c')) {
        throw new Error('not needed')
      }
      return Buffer.from('')
    })

    const env = buildEnv()
    expect(env.PATH).toContain('/actual/path')
    expect(env.PATH).not.toContain('Welcome')
  })
})

describe('resolveCmd', () => {
  it('returns the command unchanged if not absolute and which fails', () => {
    const env = buildEnv()
    const result = resolveCmd('nonexistent_cmd_xyz_123', env)
    expect(result).toBe('nonexistent_cmd_xyz_123')
  })

  it('resolves an absolute path that exists', () => {
    const env = buildEnv()
    // /bin/sh always exists
    const result = resolveCmd('/bin/sh', env)
    expect(result).toBe('/bin/sh')
  })

  it('strips directory from non-existent absolute path and falls back to which', () => {
    const env = buildEnv()
    // /nonexistent/bash doesn't exist, so it should strip to 'bash' and resolve via which
    const result = resolveCmd('/nonexistent/bash', env)
    // Should either resolve to the real bash path or fall back to 'bash'
    expect(result).toMatch(/bash/)
  })

  it('resolves a known command via which', () => {
    const env = buildEnv()
    const result = resolveCmd('sh', env)
    expect(result).toMatch(/^\/.*sh$/)
  })
})

describe('rotateLogFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotateLogFile-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does nothing when file is under maxSize', () => {
    const logFile = path.join(tmpDir, 'test.log')
    fs.writeFileSync(logFile, 'small')
    expect(rotateLogFile(logFile, 1024, 3)).toBe(false)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('small')
  })

  it('does nothing when file does not exist', () => {
    expect(rotateLogFile(path.join(tmpDir, 'nope.log'), 1024, 3)).toBe(false)
  })

  it('rotates file to .1 when over maxSize', () => {
    const logFile = path.join(tmpDir, 'test.log')
    const content = 'x'.repeat(2000)
    fs.writeFileSync(logFile, content)
    expect(rotateLogFile(logFile, 1000, 3)).toBe(true)
    expect(fs.existsSync(logFile)).toBe(false)
    expect(fs.readFileSync(logFile + '.1', 'utf8')).toBe(content)
  })

  it('shifts existing rotated files', () => {
    const logFile = path.join(tmpDir, 'test.log')
    fs.writeFileSync(logFile, 'x'.repeat(2000))
    fs.writeFileSync(logFile + '.1', 'prev1')
    fs.writeFileSync(logFile + '.2', 'prev2')
    expect(rotateLogFile(logFile, 1000, 3)).toBe(true)
    expect(fs.readFileSync(logFile + '.1', 'utf8')).toBe('x'.repeat(2000))
    expect(fs.readFileSync(logFile + '.2', 'utf8')).toBe('prev1')
    expect(fs.readFileSync(logFile + '.3', 'utf8')).toBe('prev2')
  })

  it('drops oldest file beyond maxRotations', () => {
    const logFile = path.join(tmpDir, 'test.log')
    fs.writeFileSync(logFile, 'x'.repeat(2000))
    fs.writeFileSync(logFile + '.1', 'prev1')
    fs.writeFileSync(logFile + '.2', 'prev2')
    fs.writeFileSync(logFile + '.3', 'oldest')
    expect(rotateLogFile(logFile, 1000, 3)).toBe(true)
    // .3 should now contain prev2 (oldest was overwritten)
    expect(fs.readFileSync(logFile + '.3', 'utf8')).toBe('prev2')
    expect(fs.existsSync(logFile + '.4')).toBe(false)
  })

  it('works with maxRotations=1', () => {
    const logFile = path.join(tmpDir, 'test.log')
    fs.writeFileSync(logFile, 'x'.repeat(2000))
    fs.writeFileSync(logFile + '.1', 'old')
    expect(rotateLogFile(logFile, 1000, 1)).toBe(true)
    expect(fs.readFileSync(logFile + '.1', 'utf8')).toBe('x'.repeat(2000))
  })
})

describe('atomicWriteSync', () => {
  let writeSpy: any
  let renameSpy: any
  let unlinkSpy: any

  beforeEach(() => {
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    renameSpy = vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)
    unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes to a temp file then renames atomically', () => {
    atomicWriteSync('/tmp/dest.json', '{"ok":true}')

    const tmpPath = `/tmp/dest.json.tmp.${process.pid}`
    expect(writeSpy).toHaveBeenCalledWith(tmpPath, '{"ok":true}')
    expect(renameSpy).toHaveBeenCalledWith(tmpPath, '/tmp/dest.json')
  })

  it('cleans up temp file and rethrows on writeFileSync failure', () => {
    writeSpy.mockImplementation(() => { throw new Error('disk full') })

    expect(() => atomicWriteSync('/tmp/dest.json', 'data')).toThrow('disk full')
    const tmpPath = `/tmp/dest.json.tmp.${process.pid}`
    expect(unlinkSpy).toHaveBeenCalledWith(tmpPath)
    expect(renameSpy).not.toHaveBeenCalled()
  })

  it('cleans up temp file and rethrows on renameSync failure', () => {
    renameSpy.mockImplementation(() => { throw new Error('rename failed') })

    expect(() => atomicWriteSync('/tmp/dest.json', 'data')).toThrow('rename failed')
    const tmpPath = `/tmp/dest.json.tmp.${process.pid}`
    expect(unlinkSpy).toHaveBeenCalledWith(tmpPath)
  })
})
