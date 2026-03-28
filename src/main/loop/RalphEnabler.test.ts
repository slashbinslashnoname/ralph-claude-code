import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
import * as cp from 'child_process'
import * as path from 'path'
import { detectProjectContext, checkEnabled, enableRalph } from './RalphEnabler'
import { ProjectPaths } from './ProjectStore'

describe('RalphEnabler', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
    vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined)
    vi.spyOn(cp, 'execFileSync').mockReturnValue('' as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('detectProjectContext', () => {
    it('detects nodejs project from package.json', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      ;(fs.readFileSync as any).mockReturnValue('{"name":"my-app"}')
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
      expect(ctx.name).toBe('my-app')
      expect(ctx.installCmd).toBe('npm install')
      expect(ctx.testCmd).toBe('npm test')
      expect(ctx.buildCmd).toBe('npm run build')
    })

    it('uses directory basename when package.json has no name', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      ;(fs.readFileSync as any).mockReturnValue('{}')
      const ctx = detectProjectContext('/home/user/my-project')
      expect(ctx.name).toBe('my-project')
    })

    it('handles package.json read errors gracefully', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      ;(fs.readFileSync as any).mockImplementation(() => { throw new Error('read error') })
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
      expect(ctx.name).toBe('project')
    })

    it('detects python project from pyproject.toml', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('pyproject.toml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('python')
      expect(ctx.testCmd).toBe('pytest')
    })

    it('detects rust project from Cargo.toml', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('Cargo.toml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('rust')
      expect(ctx.installCmd).toBe('cargo build')
      expect(ctx.testCmd).toBe('cargo test')
    })

    it('detects go project from go.mod', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('go.mod')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('go')
      expect(ctx.testCmd).toBe('go test ./...')
    })

    it('detects java project from pom.xml', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('pom.xml')
      )
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('java')
      expect(ctx.testCmd).toBe('mvn test')
    })

    it('returns unknown for unrecognized projects', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('unknown')
      expect(ctx.installCmd).toBe('')
      expect(ctx.testCmd).toBe('')
      expect(ctx.buildCmd).toBe('')
    })

    it('checks hasGit and hasBeads', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.git') || s.endsWith('.beads')
      })
      const ctx = detectProjectContext('/project')
      expect(ctx.hasGit).toBe(true)
      expect(ctx.hasBeads).toBe(true)
    })

    it('detects first matching project type (priority order)', () => {
      // package.json and Cargo.toml both exist — nodejs should win (first in list)
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('package.json') || s.endsWith('Cargo.toml')
      })
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('nodejs')
    })
  })

  describe('checkEnabled', () => {
    it('returns enabled:true when all files exist', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(true)
      expect(status.missing).toEqual([])
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
    })

    it('returns enabled:false with missing files', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(false)
      expect(status.missing.length).toBe(4)
      expect(status.hasRalphrc).toBe(false)
      expect(status.hasRalphDir).toBe(false)
    })

    it('correctly reports partial state', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
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
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(true)
      expect(result.filesCreated).toEqual([])
    })

    it('creates files when not enabled', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated).toContain('.slashbotrc')
      expect(result.filesCreated).toContain('.slashbot/PROMPT.md')
      expect(result.filesCreated).toContain('.slashbot/AGENT.md')
    })

    it('creates directories with recursive:true', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project')
      expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot', { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith('/project/.slashbot/logs', { recursive: true })
    })

    it('force overwrites existing files', () => {
      // All files exist but force is true
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const result = enableRalph('/project', { force: true, maxCallsPerHour: 50, useBeads: true, initialTasks: [] })
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated.length).toBeGreaterThan(0)
    })

    it('generates ralphrc with correct maxCallsPerHour', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 200, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const slashbotrcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(slashbotrcCall).toBeDefined()
      expect(String(slashbotrcCall![1])).toContain('MAX_CALLS_PER_HOUR=200')
    })

    it('generates ralphrc with beads task source when useBeads is true', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: true, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const slashbotrcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(slashbotrcCall![1])).toContain('TASK_SOURCES="beads"')
    })

    it('generates ralphrc with local task source when useBeads is false', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const slashbotrcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(slashbotrcCall![1])).toContain('TASK_SOURCES="local"')
    })

    it('includes npm tools for nodejs projects', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const slashbotrcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(slashbotrcCall![1])).toContain('Bash(npm *)')
    })

    it('appends gitignore entries when # Slashbot not present', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.gitignore')
      })
      ;(fs.readFileSync as any).mockReturnValue('node_modules/\n')
      enableRalph('/project')
      const calls = (fs.writeFileSync as any).mock.calls
      const gitignoreCall = calls.find((c: any) => String(c[0]).endsWith('.gitignore'))
      expect(gitignoreCall).toBeDefined()
      expect(String(gitignoreCall![1])).toContain('# Slashbot')
      expect(String(gitignoreCall![1])).toContain('.slashbot/logs/')
    })

    it('does not duplicate gitignore entries when # Slashbot already present', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        const s = String(p)
        return s.endsWith('.gitignore')
      })
      ;(fs.readFileSync as any).mockReturnValue('# Slashbot\n.slashbot/logs/\n')
      enableRalph('/project')
      const calls = (fs.writeFileSync as any).mock.calls
      const gitignoreCall = calls.find((c: any) => String(c[0]).endsWith('.gitignore'))
      // Should not write gitignore since # Slashbot already present
      expect(gitignoreCall).toBeUndefined()
    })

    it('returns error when fs operations fail', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      ;(fs.mkdirSync as any).mockImplementation(() => { throw new Error('Permission denied') })
      const result = enableRalph('/project')
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Permission denied')
    })

    it('generates ralphrc with commented-out model routing entries', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const slashbotrcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      const content = String(slashbotrcCall![1])
      expect(content).toContain('# Model routing — choose which Claude model to use for each phase')
      expect(content).toContain('# CLAUDE_MODEL_THINK=sonnet')
      expect(content).toContain('# CLAUDE_MODEL_EXECUTE=opus')
      expect(content).toContain('# CLAUDE_MODEL_REVIEW=sonnet')
    })

    it('returns project context in result', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const result = enableRalph('/project')
      expect(result.context).toBeDefined()
      expect(result.context.type).toBe('unknown')
    })

    it('generates PROMPT.md with project name', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('package.json')
      )
      ;(fs.readFileSync as any).mockReturnValue('{"name":"cool-app"}')
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const promptCall = calls.find((c: any) => String(c[0]).endsWith('PROMPT.md'))
      expect(promptCall).toBeDefined()
      expect(String(promptCall![1])).toContain('cool-app')
    })

    it('generates AGENT.md with test command', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('Cargo.toml')
      )
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] })
      const calls = (fs.writeFileSync as any).mock.calls
      const agentCall = calls.find((c: any) => String(c[0]).endsWith('AGENT.md'))
      expect(agentCall).toBeDefined()
      expect(String(agentCall![1])).toContain('cargo test')
    })
  })

  describe('detectProjectContext with beadsRoot', () => {
    it('checks beadsRoot when provided instead of project .beads', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        return String(p) === '/central/beads'
      })
      const ctx = detectProjectContext('/project', '/central/beads')
      expect(ctx.hasBeads).toBe(true)
    })

    it('returns hasBeads false when beadsRoot does not exist', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const ctx = detectProjectContext('/project', '/central/beads')
      expect(ctx.hasBeads).toBe(false)
    })

    it('falls back to project .beads when beadsRoot not provided', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        return String(p).endsWith('.beads')
      })
      const ctx = detectProjectContext('/project')
      expect(ctx.hasBeads).toBe(true)
    })
  })

  describe('checkEnabled with ProjectPaths', () => {
    const fakePaths: ProjectPaths = {
      id: 'abc123',
      storeDir: '/home/.slashbot/projects/abc123',
      logsDir: '/home/.slashbot/projects/abc123/logs',
      circuitBreakerState: '/home/.slashbot/projects/abc123/.circuit_breaker_state',
      callCount: '/home/.slashbot/projects/abc123/.call_count',
      activity: '/home/.slashbot/projects/abc123/activity.jsonl',
      knowledge: '/home/.slashbot/projects/abc123/knowledge.jsonl',
      agents: '/home/.slashbot/projects/abc123/agents.json',
      fileLocks: '/home/.slashbot/projects/abc123/file_locks.json',
      configDir: '/home/.slashbot/projects/abc123/config',
      slashbotrc: '/home/.slashbot/projects/abc123/config/.slashbotrc',
    }

    it('returns enabled:true when all config files exist in configDir', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      const status = checkEnabled('/project', fakePaths)
      expect(status.enabled).toBe(true)
      expect(status.missing).toEqual([])
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
    })

    it('returns enabled:false when config files missing from configDir', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const status = checkEnabled('/project', fakePaths)
      expect(status.enabled).toBe(false)
      expect(status.missing).toContain('.slashbotrc')
      expect(status.missing).toContain('PROMPT.md')
      expect(status.missing).toContain('AGENT.md')
    })

    it('checks paths in configDir not project root', () => {
      const checked: string[] = []
      ;(fs.existsSync as any).mockImplementation((p: unknown) => {
        checked.push(String(p))
        return true
      })
      checkEnabled('/project', fakePaths)
      expect(checked).toContain(path.join(fakePaths.configDir, '.slashbotrc'))
      expect(checked).toContain(path.join(fakePaths.configDir, 'PROMPT.md'))
      expect(checked).toContain(path.join(fakePaths.configDir, 'AGENT.md'))
    })
  })

  describe('enableRalph with ProjectPaths', () => {
    const fakePaths: ProjectPaths = {
      id: 'abc123',
      storeDir: '/home/.slashbot/projects/abc123',
      logsDir: '/home/.slashbot/projects/abc123/logs',
      circuitBreakerState: '/home/.slashbot/projects/abc123/.circuit_breaker_state',
      callCount: '/home/.slashbot/projects/abc123/.call_count',
      activity: '/home/.slashbot/projects/abc123/activity.jsonl',
      knowledge: '/home/.slashbot/projects/abc123/knowledge.jsonl',
      agents: '/home/.slashbot/projects/abc123/agents.json',
      fileLocks: '/home/.slashbot/projects/abc123/file_locks.json',
      configDir: '/home/.slashbot/projects/abc123/config',
      slashbotrc: '/home/.slashbot/projects/abc123/config/.slashbotrc',
    }
    const defaultOpts = { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] as string[] }

    it('writes config files to configDir when paths provided', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const result = enableRalph('/project', defaultOpts, fakePaths)
      expect(result.ok).toBe(true)
      expect(result.filesCreated).toContain('.slashbotrc')
      expect(result.filesCreated).toContain('PROMPT.md')
      expect(result.filesCreated).toContain('AGENT.md')
    })

    it('writes .slashbotrc to configDir not project root', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const calls = (fs.writeFileSync as any).mock.calls
      const rcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(rcCall).toBeDefined()
      expect(String(rcCall![0])).toBe(path.join(fakePaths.configDir, '.slashbotrc'))
    })

    it('writes PROMPT.md and AGENT.md to configDir', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const calls = (fs.writeFileSync as any).mock.calls
      const promptCall = calls.find((c: any) => String(c[0]).endsWith('PROMPT.md'))
      const agentCall = calls.find((c: any) => String(c[0]).endsWith('AGENT.md'))
      expect(String(promptCall![0])).toBe(path.join(fakePaths.configDir, 'PROMPT.md'))
      expect(String(agentCall![0])).toBe(path.join(fakePaths.configDir, 'AGENT.md'))
    })

    it('does not write .slashbotid to project root', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const calls = (fs.writeFileSync as any).mock.calls
      const idCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotid'))
      expect(idCall).toBeUndefined()
    })

    it('calls ensureStoreDirs when paths provided', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      expect(fs.mkdirSync).toHaveBeenCalledWith(fakePaths.storeDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(fakePaths.logsDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(fakePaths.configDir, { recursive: true })
    })

    it('does not create .slashbot dir when paths provided', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const mkdirCalls = (fs.mkdirSync as any).mock.calls.map((c: any) => String(c[0]))
      expect(mkdirCalls).not.toContain('/project/.slashbot')
    })

    it('does not add gitignore entries in centralized mode', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const calls = (fs.writeFileSync as any).mock.calls
      const gitignoreCall = calls.find((c: any) => String(c[0]).endsWith('.gitignore'))
      // No gitignore write since centralized mode returns empty string and '# Slashbot' isn't in existing content
      // but existing is '' (from mock), and generateGitignoreAdditions returns '' so nothing is appended
      // Actually, the code checks !existing.includes('# Slashbot') which is true, then writes existing + ''
      // Let's verify: the gitignore write may still happen but with no slashbot entries
      if (gitignoreCall) {
        const content = String(gitignoreCall![1])
        expect(content).not.toContain('.slashbotid')
        expect(content).not.toContain('.slashbot/logs/')
      }
    })

    it('PROMPT.md in centralized mode does not reference .slashbotid or .slashbot/', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      enableRalph('/project', defaultOpts, fakePaths)
      const calls = (fs.writeFileSync as any).mock.calls
      const promptCall = calls.find((c: any) => String(c[0]).endsWith('PROMPT.md'))
      const content = String(promptCall![1])
      expect(content).not.toContain('.slashbotid')
      expect(content).not.toContain('.slashbot/')
    })

    it('force overwrites config files in configDir', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const result = enableRalph('/project', { ...defaultOpts, force: true }, fakePaths)
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated.length).toBeGreaterThan(0)
    })
  })
})
