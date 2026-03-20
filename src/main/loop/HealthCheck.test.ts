import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runHealthCheck, formatHealthErrors } from './HealthCheck'

let tmpDir: string

function makeProject(opts: { beads?: boolean; ralph?: boolean; ralphrc?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-test-'))
  if (opts.beads !== false) fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  if (opts.ralph !== false) {
    fs.mkdirSync(path.join(dir, '.ralph'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.ralph', 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(dir, '.ralph', 'AGENT.md'), '# Agent')
  }
  if (opts.ralphrc !== false) {
    fs.writeFileSync(path.join(dir, '.ralphrc'), 'CLAUDE_CODE_CMD=claude')
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

  it('reports missing ralph files', () => {
    tmpDir = makeProject({ ralph: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const filesError = result.errors.find(e => e.check === 'ralph-files')
    expect(filesError).toBeDefined()
    expect(filesError!.message).toContain('.ralph')
    expect(filesError!.remediation).toContain('ralph-enable')
  })

  it('reports missing .ralphrc', () => {
    tmpDir = makeProject({ ralphrc: false })
    const result = runHealthCheck(tmpDir, 'node')
    expect(result.ok).toBe(false)
    const filesError = result.errors.find(e => e.check === 'ralph-files')
    expect(filesError).toBeDefined()
    expect(filesError!.message).toContain('.ralphrc')
  })

  it('collects multiple errors without short-circuiting', () => {
    tmpDir = makeProject({ beads: false, ralph: false, ralphrc: false })
    const result = runHealthCheck(tmpDir, 'nonexistent-claude-binary-xyz')
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
    const checks = result.errors.map(e => e.check)
    expect(checks).toContain('bd')
    expect(checks).toContain('claude')
    expect(checks).toContain('ralph-files')
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
