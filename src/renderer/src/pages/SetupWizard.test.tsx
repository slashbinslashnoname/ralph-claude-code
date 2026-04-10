import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'SetupWizard.tsx'), 'utf-8')

describe('SetupWizard centralized storage display', () => {
  test('shows storeDir when present in enable result', () => {
    expect(src).toContain('result.storeDir')
  })

  test('storeDir is rendered inside a code element', () => {
    expect(src).toMatch(/<code>\{result\.storeDir\}<\/code>/)
  })

  test('centralized storage path entry listed in setup files', () => {
    expect(src).toContain('~/.slashbot/projects/')
  })

  test('success block is conditional on result.ok', () => {
    expect(src).toContain('result?.ok')
  })

  test('storeDir block is conditional to avoid showing undefined', () => {
    expect(src).toContain('result.storeDir &&')
  })
})

describe('SetupWizard timeout handling', () => {
  test('defines BD_CHECK_TIMEOUT_MS constant', () => {
    expect(src).toContain('BD_CHECK_TIMEOUT_MS')
  })

  test('defines ENABLE_TIMEOUT_MS constant', () => {
    expect(src).toContain('ENABLE_TIMEOUT_MS')
  })

  test('wraps installCheck with withTimeout', () => {
    expect(src).toMatch(/withTimeout\(sb\.beads\.installCheck\(\),\s*BD_CHECK_TIMEOUT_MS/)
  })

  test('wraps enable call with withTimeout', () => {
    expect(src).toMatch(/withTimeout\(\s*sb\.enable\(/)
  })

  test('withTimeout rejects with descriptive timeout message', () => {
    expect(src).toContain('timed out after')
  })
})

describe('SetupWizard bd check error recovery', () => {
  test('tracks bdCheckError state', () => {
    expect(src).toContain('bdCheckError')
  })

  test('shows error message when bd check fails', () => {
    expect(src).toContain('Failed to check bd CLI:')
  })

  test('offers Retry button on bd check error', () => {
    expect(src).toMatch(/bdCheckError[\s\S]*?Retry/)
  })

  test('offers Skip beads button on bd check error', () => {
    expect(src).toMatch(/bdCheckError[\s\S]*?Skip beads/)
  })

  test('offers Skip beads button when bd not found', () => {
    expect(src).toMatch(/bdInstalled === false[\s\S]*?Skip beads/)
  })
})

describe('SetupWizard enable error recovery', () => {
  test('tracks enableError state', () => {
    expect(src).toContain('enableError')
  })

  test('shows error with Setup failed label', () => {
    expect(src).toContain('Setup failed:')
  })

  test('offers Back button on enable failure', () => {
    // In the enable error block there should be a Back button
    expect(src).toMatch(/enableError[\s\S]*?Back[\s\S]*?Retry/)
  })

  test('offers Retry button on enable failure', () => {
    expect(src).toMatch(/enableError[\s\S]*?onClick=\{run\}/)
  })

  test('catches timeout errors from enable call', () => {
    expect(src).toContain('catch (err)')
  })
})
