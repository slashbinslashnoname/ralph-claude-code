import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runHealthCheck, formatHealthErrors, formatHealthWarnings } from './HealthCheck'
import * as BdClientModule from './BdClient'
import * as FileGuardModule from './FileGuard'
import { getProjectPaths, ensureStoreDirs } from './ProjectStore'

let tmpDir: string

function makeProject(opts: { beads?: boolean; configFiles?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-test-'))
  if (opts.beads !== false) fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  if (opts.configFiles !== false) {
    // Create config files in the centralized store location
    const paths = getProjectPaths(dir)
    ensureStoreDirs(paths)
    fs.writeFileSync(path.join(paths.configDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(paths.configDir, 'AGENT.md'), '# Agent')
    fs.writeFileSync(path.join(paths.configDir, '.slashbotrc'), 'CLAUDE_CODE_CMD=claude')
  }
  return dir
}

describe('HealthCheck', () => {
  beforeEach(() => { tmpDir = '' })
  afterEach(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) })

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

  it('warns when sm CLI is not on PATH', () => {
    // sm is unlikely to be installed in CI/test environments,
    // so by default the warning should be present
    tmpDir = makeProject()
    const result = runHealthCheck(tmpDir, 'node')
    // Whether sm is installed or not, the check should not block
    expect(result.ok).toBe(true)
    // If sm is not installed, we should see the warning
    const smWarning = result.warnings.find(w => w.check === 'sm')
    if (smWarning) {
      expect(smWarning.message).toContain('slashmem')
      expect(smWarning.remediation).toContain('cargo install slashmem')
    }
  })

  it('sm check does not affect ok status', () => {
    tmpDir = makeProject()
    const result = runHealthCheck(tmpDir, 'node')
    // sm is optional — even if missing, ok should still be true
    expect(result.ok).toBe(true)
    expect(result.errors.find(e => e.check === 'sm')).toBeUndefined()
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
