import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateIntegrity } from '../../src/main/loop/FileGuard'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('FileGuard', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ralph-fg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function createRalphFiles(): void {
    mkdirSync(join(dir, '.ralph'), { recursive: true })
    writeFileSync(join(dir, '.ralph', 'PROMPT.md'), '# Prompt')
    writeFileSync(join(dir, '.ralph', 'fix_plan.md'), '# Tasks')
    writeFileSync(join(dir, '.ralph', 'AGENT.md'), '# Agent')
    writeFileSync(join(dir, '.ralphrc'), '# Config')
  }

  it('returns ok when all required files present', () => {
    createRalphFiles()
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.report).toBe('All required Ralph files present.')
  })

  it('detects missing .ralph directory', () => {
    writeFileSync(join(dir, '.ralphrc'), '# Config')
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('.ralph')
  })

  it('detects missing .ralphrc', () => {
    mkdirSync(join(dir, '.ralph'), { recursive: true })
    writeFileSync(join(dir, '.ralph', 'PROMPT.md'), '# Prompt')
    writeFileSync(join(dir, '.ralph', 'fix_plan.md'), '# Tasks')
    writeFileSync(join(dir, '.ralph', 'AGENT.md'), '# Agent')
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('.ralphrc')
  })

  it('detects missing PROMPT.md', () => {
    mkdirSync(join(dir, '.ralph'), { recursive: true })
    writeFileSync(join(dir, '.ralph', 'fix_plan.md'), '# Tasks')
    writeFileSync(join(dir, '.ralph', 'AGENT.md'), '# Agent')
    writeFileSync(join(dir, '.ralphrc'), '# Config')
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('.ralph/PROMPT.md')
  })

  it('detects multiple missing files', () => {
    // Only create the .ralph directory
    mkdirSync(join(dir, '.ralph'), { recursive: true })
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(false)
    expect(result.missing.length).toBeGreaterThanOrEqual(3)
  })

  it('report includes missing file names', () => {
    const result = validateIntegrity(dir)
    expect(result.report).toContain('Missing Ralph files:')
    expect(result.report).toContain('.ralph')
    expect(result.report).toContain('ralph-enable --force')
  })

  it('report includes recovery instructions', () => {
    const result = validateIntegrity(dir)
    expect(result.report).toContain('Run to restore:  ralph-enable --force')
  })

  it('passes with all files even when extras exist', () => {
    createRalphFiles()
    // Add extra optional files
    writeFileSync(join(dir, '.ralph', 'status.json'), '{}')
    mkdirSync(join(dir, '.ralph', 'logs'), { recursive: true })
    const result = validateIntegrity(dir)
    expect(result.ok).toBe(true)
  })
})
