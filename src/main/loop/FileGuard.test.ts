import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
import * as fs from 'fs'
import { validateIntegrity } from './FileGuard'

describe('FileGuard', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok when all required files exist', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.report).toBe('All required Slashbot files present.')
  })

  it('reports missing files when none exist', () => {
    ;(fs.existsSync as any).mockReturnValue(false)
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['.slashbot', '.slashbot/PROMPT.md', '.slashbot/AGENT.md', '.slashbotrc'])
  })

  it('report contains remediation instruction', () => {
    ;(fs.existsSync as any).mockReturnValue(false)
    const result = validateIntegrity('/project')
    expect(result.report).toContain('slashbot-enable --force')
    expect(result.report).toContain('Missing Slashbot files:')
  })

  it('reports only the specific missing files', () => {
    ;(fs.existsSync as any).mockImplementation((p: unknown) => {
      const s = String(p)
      return s.endsWith('.slashbot') || s.endsWith('.slashbotrc')
    })
    const result = validateIntegrity('/project')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['.slashbot/PROMPT.md', '.slashbot/AGENT.md'])
  })

  it('checks files with correct paths relative to projectPath', () => {
    ;(fs.existsSync as any).mockReturnValue(true)
    validateIntegrity('/my/project')
    const calls = (fs.existsSync as any).mock.calls.map((c: any) => c[0])
    expect(calls).toContain('/my/project/.slashbot')
    expect(calls).toContain('/my/project/.slashbot/PROMPT.md')
    expect(calls).toContain('/my/project/.slashbot/AGENT.md')
    expect(calls).toContain('/my/project/.slashbotrc')
  })
})
