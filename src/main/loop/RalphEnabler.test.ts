import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { detectProjectContext, checkEnabled, enableRalph } from './RalphEnabler'

vi.mock('fs')

describe('RalphEnabler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any)
    vi.mocked(fs.readFileSync).mockReturnValue('')
  })

  describe('detectProjectContext', () => {
    it('detects nodejs project from package.json', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"my-app"}')
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
      expect(ctx.name).toBe('my-app')
      expect(ctx.installCmd).toBe('npm install')
      expect(ctx.testCmd).toBe('npm test')
      expect(ctx.buildCmd).toBe('npm run build')
    })

    it('uses directory basename when package.json has no name', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      const ctx = detectProjectContext('/home/user/my-project')
      expect(ctx.name).toBe('my-project')
    })

    it('handles package.json read errors gracefully', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('read error') })
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
      expect(ctx.name).toBe('project')
    })

    it('detects python project from pyproject.toml', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('pyproject.toml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('python')
      expect(ctx.testCmd).toBe('pytest')
    })

    it('detects rust project from Cargo.toml', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('Cargo.toml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('rust')
      expect(ctx.installCmd).toBe('cargo build')
      expect(ctx.testCmd).toBe('cargo test')
    })

    it('detects go project from go.mod', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('go.mod')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('go')
      expect(ctx.testCmd).toBe('go test ./...')
    })

    it('detects java project from pom.xml', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('pom.xml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('java')
      expect(ctx.testCmd).toBe('mvn test')
    })

    it('returns unknown for unrecognized projects', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('unknown')
      expect(ctx.installCmd).toBe('')
      expect(ctx.testCmd).toBe('')
      expect(ctx.buildCmd).toBe('')
    })

    it('checks hasGit and hasBeads', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.git') || s.endsWith('.beads')
      })
      const ctx = detectProjectContext('/project')
      expect(ctx.hasGit).toBe(true)
      expect(ctx.hasBeads).toBe(true)
    })

    it('detects first matching project type (priority order)', () => {
      // package.json and Cargo.toml both exist — nodejs should win (first in list)
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('package.json') || s.endsWith('Cargo.toml')
      })
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"test"}')
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
    })
  })

  describe('checkEnabled', () => {
    it('returns enabled:true when all files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(true)
      expect(status.missing).toEqual([])
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
    })

    it('returns enabled:false with missing files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(false)
      expect(status.missing.length).toBe(4)
      expect(status.hasRalphrc).toBe(false)
      expect(status.hasRalphDir).toBe(false)
    })

    it('correctly reports partial state', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.slashbotrc') || s.endsWith('.slashbot')
      })
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(false)
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
      expect(status.missing).toContain('.slashbot/PROMPT.md')
      expect(status.missing).toContain('.slashbot/AGENT.md')
    })
  })

  describe('enableRalph', () => {
    it('returns alreadyEnabled when project is already enabled', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"test"}')
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(true)
      expect(result.filesCreated).toEqual([])
    })

    it('creates files when not enabled', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated).toContain('.slashbotrc')
      expect(result.filesCreated).toContain('.slashbot/PROMPT.md')
      expect(result.filesCreated).toContain('.slashbot/AGENT.md')
    })

    it('creates directories with recursive:true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      enableRalph('/project')
      expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot', { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot/logs', { recursive: true })
    })

    it('force overwrites existing files', () => {
      // All files exist but force is true
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"test"}')
      const result = enableRalph('/project', { force: true, maxCallsPerHour: 50, useBeads: true, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated.length).toBeGreaterThan(0)
    })

    it('generates ralphrc with correct maxCallsPerHour', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 200, useBeads: false, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const ralphrcCall = calls.find(c => String(c[0]).endsWith('.slashbotrc'))
      expect(ralphrcCall).toBeDefined()
      expect(String(ralphrcCall![1])).toContain('MAX_CALLS_PER_HOUR=200')
    })

    it('generates ralphrc with beads task source when useBeads is true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: true, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const ralphrcCall = calls.find(c => String(c[0]).endsWith('.slashbotrc'))
      expect(String(ralphrcCall![1])).toContain('TASK_SOURCES="beads"')
    })

    it('generates ralphrc with local task source when useBeads is false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const ralphrcCall = calls.find(c => String(c[0]).endsWith('.slashbotrc'))
      expect(String(ralphrcCall![1])).toContain('TASK_SOURCES="local"')
    })

    it('includes npm tools for nodejs projects', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"test"}')
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const ralphrcCall = calls.find(c => String(c[0]).endsWith('.slashbotrc'))
      expect(String(ralphrcCall![1])).toContain('Bash(npm *)')
    })

    it('appends gitignore entries when # Ralph not present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.gitignore')
      })
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/\n')
      enableRalph('/project')
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const gitignoreCall = calls.find(c => String(c[0]).endsWith('.gitignore'))
      expect(gitignoreCall).toBeDefined()
      expect(String(gitignoreCall![1])).toContain('# Ralph')
      expect(String(gitignoreCall![1])).toContain('.slashbot/logs/')
    })

    it('does not duplicate gitignore entries when # Ralph already present', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.gitignore')
      })
      vi.mocked(fs.readFileSync).mockReturnValue('# Ralph\n.slashbot/logs/\n')
      enableRalph('/project')
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const gitignoreCall = calls.find(c => String(c[0]).endsWith('.gitignore'))
      // Should not write gitignore since # Ralph already present
      expect(gitignoreCall).toBeUndefined()
    })

    it('returns error when fs operations fail', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fs.mkdirSync).mockImplementation(() => { throw new Error('Permission denied') })
      const result = enableRalph('/project')
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Permission denied')
    })

    it('returns project context in result', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const result = enableRalph('/project')
      expect(result.context).toBeDefined()
      expect(result.context.type).toBe('unknown')
    })

    it('generates PROMPT.md with project name', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      vi.mocked(fs.readFileSync).mockReturnValue('{"name":"cool-app"}')
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const promptCall = calls.find(c => String(c[0]).endsWith('PROMPT.md'))
      expect(promptCall).toBeDefined()
      expect(String(promptCall![1])).toContain('cool-app')
    })

    it('generates AGENT.md with test command', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
        String(p).endsWith('Cargo.toml')
      )
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = vi.mocked(fs.writeFileSync).mock.calls
      const agentCall = calls.find(c => String(c[0]).endsWith('AGENT.md'))
      expect(agentCall).toBeDefined()
      expect(String(agentCall![1])).toContain('cargo test')
    })
  })
})
