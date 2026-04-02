import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()) }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()) }))
import * as fs from 'fs'
import * as os from 'os'
import * as cp from 'child_process'
import * as path from 'path'
import { detectProjectContext, checkEnabled, enableRalph } from './RalphEnabler'
import { ProjectPaths } from './ProjectStore'

function makePaths(overrides?: Partial<ProjectPaths>): ProjectPaths {
  return {
    id: 'project-abc12345',
    projectRoot: '/project',
    storeDir: '/home/.slashbot/projects/project-abc12345',
    logsDir: '/home/.slashbot/projects/project-abc12345/logs',
    circuitBreakerState: '/home/.slashbot/projects/project-abc12345/.circuit_breaker_state',
    callCount: '/home/.slashbot/projects/project-abc12345/.call_count',
    activity: '/home/.slashbot/projects/project-abc12345/activity.jsonl',
    knowledge: '/home/.slashbot/projects/project-abc12345/knowledge.jsonl',
    agents: '/home/.slashbot/projects/project-abc12345/agents.json',
    fileLocks: '/home/.slashbot/projects/project-abc12345/file_locks.json',
    configDir: '/home/.slashbot/projects/project-abc12345/config',
    slashbotrc: '/home/.slashbot/projects/project-abc12345/config/.slashbotrc',
    mail: '/home/.slashbot/projects/project-abc12345/mail.jsonl',
    worktreesDir: '/project/.worktrees',
    beadsRoot: '/project/.beads',
    beadsCwd: '/project',
    agentMd: '/home/.slashbot/projects/project-abc12345/config/AGENT.md',
    promptMd: '/home/.slashbot/projects/project-abc12345/config/PROMPT.md',
    ...overrides
  }
}

describe('RalphEnabler', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any)
    vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw new Error('ENOENT') })
    vi.spyOn(fs, 'symlinkSync').mockReturnValue(undefined)
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

    it('returns unknown for unrecognized projects', () => {
      const ctx = detectProjectContext('/project')
      expect(ctx.type).toBe('unknown')
      expect(ctx.installCmd).toBe('')
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

    it('checks beadsRoot when provided instead of project .beads', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p) === '/central/beads'
      )
      const ctx = detectProjectContext('/project', '/central/beads')
      expect(ctx.hasBeads).toBe(true)
    })
  })

  describe('checkEnabled', () => {
    it('returns enabled:true when all config files exist', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      const paths = makePaths()
      const status = checkEnabled('/project', paths)
      expect(status.enabled).toBe(true)
      expect(status.missing).toEqual([])
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
    })

    it('returns enabled:false when config files missing', () => {
      const paths = makePaths()
      const status = checkEnabled('/project', paths)
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
      const paths = makePaths()
      checkEnabled('/project', paths)
      expect(checked).toContain(path.join(paths.configDir, '.slashbotrc'))
      expect(checked).toContain(path.join(paths.configDir, 'PROMPT.md'))
      expect(checked).toContain(path.join(paths.configDir, 'AGENT.md'))
      expect(checked).not.toContain('/project/.slashbot')
      expect(checked).not.toContain('/project/.slashbotrc')
    })

    it('derives paths when not provided', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      const status = checkEnabled('/project')
      expect(status.enabled).toBe(true)
    })
  })

  describe('enableRalph', () => {
    it('returns alreadyEnabled when project is already enabled', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const paths = makePaths()
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(true)
      expect(result.filesCreated).toEqual([])
    })

    it('writes config files to configDir', () => {
      const paths = makePaths()
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated).toContain('.slashbotrc')
      expect(result.filesCreated).toContain('PROMPT.md')
      expect(result.filesCreated).toContain('AGENT.md')
    })

    it('writes .slashbotrc to configDir not project root', () => {
      const paths = makePaths()
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const rcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(rcCall).toBeDefined()
      expect(String(rcCall![0])).toBe(path.join(paths.configDir, '.slashbotrc'))
    })

    it('does not create .slashbot dir in project root', () => {
      const paths = makePaths()
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const mkdirCalls = (fs.mkdirSync as any).mock.calls.map((c: any) => String(c[0]))
      expect(mkdirCalls).not.toContain('/project/.slashbot')
    })

    it('calls ensureStoreDirs', () => {
      const paths = makePaths()
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.storeDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.logsDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.configDir, { recursive: true })
    })

    it('generates ralphrc with correct maxCallsPerHour', () => {
      const paths = makePaths()
      enableRalph('/project', { force: false, maxCallsPerHour: 200, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const rcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(rcCall![1])).toContain('MAX_CALLS_PER_HOUR=200')
    })

    it('generates ralphrc with beads task source when useBeads is true', () => {
      const paths = makePaths()
      enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: true, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const rcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(rcCall![1])).toContain('TASK_SOURCES="beads"')
    })

    it('force overwrites existing files', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('{"name":"test"}')
      const paths = makePaths()
      const result = enableRalph('/project', { force: true, maxCallsPerHour: 50, useBeads: true, initialTasks: [] }, paths)
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated.length).toBeGreaterThan(0)
    })

    it('returns error when fs operations fail', () => {
      ;(fs.mkdirSync as any).mockImplementation(() => { throw new Error('Permission denied') })
      const paths = makePaths()
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Permission denied')
    })

    it('returns project context in result', () => {
      const paths = makePaths()
      const result = enableRalph('/project', { force: false, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      expect(result.context).toBeDefined()
      expect(result.context.type).toBe('unknown')
    })

    it('generates PROMPT.md without legacy protected files section', () => {
      const paths = makePaths()
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const promptCall = calls.find((c: any) => String(c[0]).endsWith('PROMPT.md'))
      const content = String(promptCall![1])
      expect(content).not.toContain('.slashbot/')
      expect(content).not.toContain('Protected files')
    })

    it('generates PROMPT.md with slashmem section', () => {
      const paths = makePaths()
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const promptCall = calls.find((c: any) => String(c[0]).endsWith('PROMPT.md'))
      const content = String(promptCall![1])
      expect(content).toContain('## Memory — slashmem')
      expect(content).toContain('sm context')
      expect(content).toContain('sm ingest')
      expect(content).toContain('sm rules add')
      expect(content).toContain('sm distill')
      expect(content).toContain('sm status')
      expect(content).toContain('sm projects')
      expect(content).toContain('--project <name>')
    })

    it('generates ralphrc with sm allowed tool', () => {
      const paths = makePaths()
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const rcCall = calls.find((c: any) => String(c[0]).endsWith('.slashbotrc'))
      expect(String(rcCall![1])).toContain('Bash(sm *)')
    })

    it('generates AGENT.md with test command', () => {
      ;(fs.existsSync as any).mockImplementation((p: unknown) =>
        String(p).endsWith('Cargo.toml')
      )
      const paths = makePaths()
      enableRalph('/project', { force: true, maxCallsPerHour: 100, useBeads: false, initialTasks: [] }, paths)
      const calls = (fs.writeFileSync as any).mock.calls
      const agentCall = calls.find((c: any) => String(c[0]).endsWith('AGENT.md'))
      expect(agentCall).toBeDefined()
      expect(String(agentCall![1])).toContain('cargo test')
    })
  })
})
