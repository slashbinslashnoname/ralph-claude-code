import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'child_process'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runHealthCheck, formatHealthErrors, formatHealthWarnings } from './HealthCheck'
import * as BdClientModule from './BdClient'
import * as FileGuardModule from './FileGuard'
import { getProjectPaths, ensureStoreDirs, _setStoreRoot } from './ProjectStore'

let tmpDir: string
let storeRoot: string

function makeProject(opts: { beads?: boolean; configFiles?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-test-'))
  if (opts.beads !== false) fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  if (opts.configFiles !== false) {
    const paths = getProjectPaths(dir)
    ensureStoreDirs(paths)
    fs.writeFileSync(path.join(paths.configDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(paths.configDir, 'AGENT.md'), '# Agent')
    fs.writeFileSync(path.join(paths.configDir, '.slashbotrc'), 'CLAUDE_CODE_CMD=claude')
  }
  return dir
}

describe('HealthCheck', () => {
  beforeEach(() => {
    tmpDir = ''
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slashbot-store-'))
    _setStoreRoot(storeRoot)
  })
  afterEach(() => {
    _setStoreRoot(null)
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(storeRoot, { recursive: true, force: true })
  })

  it('returns ok when all tools and files are present', () => {
    tmpDir = makeProject()
    // Use a claude cmd that exists on every system
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    // warnings is always an array
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('reports missing bd CLI', () => {
    tmpDir = makeProject({ beads: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const bdError = result.errors.find(e => e.check === 'bd')
    expect(bdError).toBeDefined()
    expect(bdError!.message).toContain('.beads')
    expect(bdError!.remediation).toContain('bd init')
  })

  it('reports missing claude command', () => {
    tmpDir = makeProject()
    const result = runHealthCheck(tmpDir, 'nonexistent-claude-binary-xyz')
    expect(result.ok).toBe(false)
    const claudeError = result.errors.find(e => e.check === 'claude')
    expect(claudeError).toBeDefined()
    expect(claudeError!.message).toContain('nonexistent-claude-binary-xyz')
    expect(claudeError!.remediation).toContain('npm install')
  })

  it('reports missing absolute-path claude command', () => {
    tmpDir = makeProject()
    const result = runHealthCheck(tmpDir, '/nonexistent/path/to/claude')
    expect(result.ok).toBe(false)
    const claudeError = result.errors.find(e => e.check === 'claude')
    expect(claudeError).toBeDefined()
  })

  it('reports missing config files', () => {
    tmpDir = makeProject({ configFiles: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const filesError = result.errors.find(e => e.check === 'slashbot-files')
    expect(filesError).toBeDefined()
    expect(filesError!.remediation).toContain('slashbot-enable')
  })

  it('collects multiple errors without short-circuiting', () => {
    tmpDir = makeProject({ beads: false, configFiles: false })
    const result = runHealthCheck(tmpDir, 'nonexistent-claude-binary-xyz')
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
    const checks = result.errors.map(e => e.check)
    expect(checks).toContain('bd')
    expect(checks).toContain('claude')
    expect(checks).toContain('slashbot-files')
  })

})

describe('formatHealthErrors', () => {
  it('formats errors with remediation', () => {
    const output = formatHealthErrors([
      { check: 'bd', message: '`bd` not found', remediation: 'Install beads-rust' },
      { check: 'claude', message: '`claude` not found', remediation: 'Install Claude Code' },
    ])
    expect(output).toContain('[bd]')
    expect(output).toContain('[claude]')
    expect(output).toContain('→ Install beads-rust')
    expect(output).toContain('→ Install Claude Code')
  })

  it('returns empty string for no errors', () => {
    expect(formatHealthErrors([])).toBe('')
  })
})

describe('formatHealthWarnings', () => {
  it('formats warnings with remediation', () => {
    const output = formatHealthWarnings([
      { check: 'test', message: 'Test warning', remediation: 'Fix it' },
    ])
    expect(output).toContain('[test]')
    expect(output).toContain('→ Fix it')
  })

  it('returns empty string for no warnings', () => {
    expect(formatHealthWarnings([])).toBe('')
  })
})

describe('Anti-regression: sm CLI removed', () => {
  it('no source file under src/ references removed sm symbols', () => {
    const projectRoot = path.resolve(import.meta.dirname, '..', '..', '..')
    const result = spawnSync(
      'grep',
      [
        '-r', '-l',
        '--include=*.ts', '--include=*.tsx',
        '--exclude=HealthCheck.test.ts',
        '-e', 'slash' + 'mem',
        '-e', 'run' + 'Sm',
        'src',
      ],
      { cwd: projectRoot, encoding: 'utf-8' },
    )
    const matches = (result.stdout ?? '').trim()
    expect(matches, `Found sm-related references in:\n${matches}`).toBe('')
  })
})
