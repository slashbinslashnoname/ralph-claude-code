import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'


import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runHealthCheck, formatHealthErrors, formatHealthWarnings } from './HealthCheck'
import * as BdClientModule from './BdClient'
import * as FileGuardModule from './FileGuard'

let tmpDir: string

function makeProject(opts: { beads?: boolean; slashbot?: boolean; slashbotrc?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-test-'))
  if (opts.beads !== false) fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  if (opts.slashbot !== false) {
    fs.mkdirSync(path.join(dir, '.slashbot'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.slashbot', 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(dir, '.slashbot', 'AGENT.md'), '# Agent')
  }
  if (opts.slashbotrc !== false) {
    fs.writeFileSync(path.join(dir, '.slashbotrc'), 'CLAUDE_CODE_CMD=claude')
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
    // warnings is always an array (may contain cm warnings depending on environment)
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

  it('reports missing slashbot files', () => {
    tmpDir = makeProject({ slashbot: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const filesError = result.errors.find(e => e.check === 'slashbot-files')
    expect(filesError).toBeDefined()
    expect(filesError!.message).toContain('.slashbot')
    expect(filesError!.remediation).toContain('slashbot-enable')
  })

  it('reports missing .slashbotrc', () => {
    tmpDir = makeProject({ slashbotrc: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const filesError = result.errors.find(e => e.check === 'slashbot-files')
    expect(filesError).toBeDefined()
    expect(filesError!.message).toContain('.slashbotrc')
  })

  it('collects multiple errors without short-circuiting', () => {
    tmpDir = makeProject({ beads: false, slashbot: false, slashbotrc: false })
    const result = runHealthCheck(tmpDir, 'nonexistent-claude-binary-xyz')
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
    const checks = result.errors.map(e => e.check)
    expect(checks).toContain('bd')
    expect(checks).toContain('claude')
    expect(checks).toContain('slashbot-files')
  })
})

describe('HealthCheck — cm warnings', () => {
  beforeEach(() => { tmpDir = '' })
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function mockPassingChecks(): void {
    // Mock bd and file checks so they pass, isolating cm behavior
    vi.spyOn(BdClientModule.BdClient.prototype, 'check').mockReturnValue({ available: true })
    vi.spyOn(FileGuardModule, 'validateIntegrity').mockReturnValue({ ok: true, missing: [] })
  }

  it('warnings array is present and does not affect ok status', () => {
    tmpDir = makeProject()
    mockPassingChecks()
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('cm warning does not cause health check failure', () => {
    tmpDir = makeProject()
    mockPassingChecks()
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(true)
    // If cm is not installed, there should be a cm warning
    const cmWarning = result.warnings.find(w => w.check === 'cm')
    if (cmWarning) {
      expect(cmWarning.message).toContain('cm')
      expect(cmWarning.remediation).toBeTruthy()
    }
  })

  it('cm-playbook warning has correct structure when present', () => {
    tmpDir = makeProject()
    mockPassingChecks()
    const result = runHealthCheck(tmpDir, 'node')
    const playbookWarning = result.warnings.find(w => w.check === 'cm-playbook')
    if (playbookWarning) {
      expect(playbookWarning.message).toContain('playbook')
      expect(playbookWarning.remediation).toContain('cm reflect')
    }
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
      { check: 'cm', message: '`cm` not found', remediation: 'Install cm' },
      { check: 'cm-playbook', message: 'Playbook empty', remediation: 'Run cm reflect' },
    ])
    expect(output).toContain('[cm]')
    expect(output).toContain('[cm-playbook]')
    expect(output).toContain('→ Install cm')
    expect(output).toContain('→ Run cm reflect')
  })

  it('returns empty string for no warnings', () => {
    expect(formatHealthWarnings([])).toBe('')
  })
})
