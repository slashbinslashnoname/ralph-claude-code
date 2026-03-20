import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { validateIntegrity } from './FileGuard'

vi.mock('fs')

describe('FileGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok when all required files exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.report).toBe('All required Slashbot files present.')
  })

  it('reports missing files when none exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['.slashbot', '.slashbot/PROMPT.md', '.slashbot/AGENT.md', '.slashbotrc'])
  })

  it('report contains remediation instruction', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const result = validateIntegrity('/project')
    expect(result.report).toContain('slashbot-enable --force')
    expect(result.report).toContain('Missing Slashbot files:')
  })

  it('reports only the specific missing files', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p)
      return s.endsWith('.slashbot') || s.endsWith('.slashbotrc')
    })
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['.slashbot/PROMPT.md', '.slashbot/AGENT.md'])
  })

  it('checks files with correct paths relative to projectPath', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    validateIntegrity('/my/project')
    const calls = vi.mocked(fs.existsSync).mock.calls.map(c => c[0])
    expect(calls).toContain('/my/project/.slashbot')
    expect(calls).toContain('/my/project/.slashbot/PROMPT.md')
    expect(calls).toContain('/my/project/.slashbot/AGENT.md')
    expect(calls).toContain('/my/project/.slashbotrc')
  })
})
