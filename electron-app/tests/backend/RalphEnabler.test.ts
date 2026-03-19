import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  detectProjectContext,
  checkEnabled,
  enableRalph,
  DEFAULT_ENABLE_OPTIONS
} from '../../src/main/loop/RalphEnabler'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RalphEnabler', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ralph-en-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('detectProjectContext', () => {
    it('detects nodejs project', () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }))
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('nodejs')
      expect(ctx.name).toBe('my-app')
      expect(ctx.installCmd).toBe('npm install')
      expect(ctx.testCmd).toBe('npm test')
    })

    it('detects python project (pyproject.toml)', () => {
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "mylib"')
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('python')
      expect(ctx.testCmd).toBe('pytest')
    })

    it('detects rust project', () => {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myrs"')
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('rust')
      expect(ctx.testCmd).toBe('cargo test')
    })

    it('detects go project', () => {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/mygo')
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('go')
      expect(ctx.testCmd).toBe('go test ./...')
    })

    it('detects java project (pom.xml)', () => {
      writeFileSync(join(dir, 'pom.xml'), '<project></project>')
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('java')
      expect(ctx.testCmd).toBe('mvn test')
    })

    it('returns unknown for empty directory', () => {
      const ctx = detectProjectContext(dir)
      expect(ctx.type).toBe('unknown')
      expect(ctx.installCmd).toBe('')
    })

    it('detects git presence', () => {
      mkdirSync(join(dir, '.git'))
      const ctx = detectProjectContext(dir)
      expect(ctx.hasGit).toBe(true)
    })

    it('detects beads presence', () => {
      mkdirSync(join(dir, '.beads'))
      const ctx = detectProjectContext(dir)
      expect(ctx.hasBeads).toBe(true)
    })

    it('uses basename when package.json has no name', () => {
      writeFileSync(join(dir, 'package.json'), '{}')
      const ctx = detectProjectContext(dir)
      expect(ctx.name).toBe(dir.split('/').pop())
    })
  })

  describe('checkEnabled', () => {
    it('returns not enabled for empty directory', () => {
      const status = checkEnabled(dir)
      expect(status.enabled).toBe(false)
      expect(status.missing.length).toBeGreaterThan(0)
      expect(status.hasRalphrc).toBe(false)
      expect(status.hasRalphDir).toBe(false)
    })

    it('returns enabled when all files present', () => {
      mkdirSync(join(dir, '.ralph'), { recursive: true })
      writeFileSync(join(dir, '.ralphrc'), '# config')
      writeFileSync(join(dir, '.ralph', 'PROMPT.md'), '# prompt')
      writeFileSync(join(dir, '.ralph', 'fix_plan.md'), '# tasks')
      writeFileSync(join(dir, '.ralph', 'AGENT.md'), '# agent')
      const status = checkEnabled(dir)
      expect(status.enabled).toBe(true)
      expect(status.missing).toEqual([])
    })

    it('detects partial setup', () => {
      mkdirSync(join(dir, '.ralph'), { recursive: true })
      writeFileSync(join(dir, '.ralphrc'), '# config')
      const status = checkEnabled(dir)
      expect(status.enabled).toBe(false)
      expect(status.hasRalphrc).toBe(true)
      expect(status.hasRalphDir).toBe(true)
      expect(status.missing).toContain('.ralph/PROMPT.md')
    })
  })

  describe('enableRalph', () => {
    it('creates all required files', () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-app' }))
      const result = enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      expect(result.ok).toBe(true)
      expect(result.alreadyEnabled).toBe(false)
      expect(result.filesCreated).toContain('.ralphrc')
      expect(result.filesCreated).toContain('.ralph/PROMPT.md')
      expect(result.filesCreated).toContain('.ralph/fix_plan.md')
      expect(result.filesCreated).toContain('.ralph/AGENT.md')
      expect(result.context.type).toBe('nodejs')
    })

    it('creates .ralph directory', () => {
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      expect(existsSync(join(dir, '.ralph'))).toBe(true)
      expect(existsSync(join(dir, '.ralph', 'logs'))).toBe(true)
    })

    it('generates valid .ralphrc', () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-app' }))
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      const rc = readFileSync(join(dir, '.ralphrc'), 'utf8')
      expect(rc).toContain('MAX_CALLS_PER_HOUR=100')
      expect(rc).toContain('CLAUDE_OUTPUT_FORMAT=json')
      expect(rc).toContain('Bash(npm *)')
    })

    it('generates PROMPT.md with project info', () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-app' }))
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      const prompt = readFileSync(join(dir, '.ralph', 'PROMPT.md'), 'utf8')
      expect(prompt).toContain('test-app')
      expect(prompt).toContain('nodejs')
      expect(prompt).toContain('npm test')
    })

    it('generates fix_plan.md with initial tasks', () => {
      enableRalph(dir, { ...DEFAULT_ENABLE_OPTIONS, initialTasks: ['Build login page', 'Add tests'] })
      const plan = readFileSync(join(dir, '.ralph', 'fix_plan.md'), 'utf8')
      expect(plan).toContain('- [ ] Build login page')
      expect(plan).toContain('- [ ] Add tests')
    })

    it('generates fix_plan.md with defaults when no tasks', () => {
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      const plan = readFileSync(join(dir, '.ralph', 'fix_plan.md'), 'utf8')
      expect(plan).toContain('Review the codebase')
    })

    it('returns alreadyEnabled when Ralph is set up', () => {
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      const result2 = enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      expect(result2.alreadyEnabled).toBe(true)
      expect(result2.ok).toBe(true)
    })

    it('force overwrites existing files', () => {
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      writeFileSync(join(dir, '.ralph', 'PROMPT.md'), 'custom content')

      const result = enableRalph(dir, { ...DEFAULT_ENABLE_OPTIONS, force: true })
      expect(result.alreadyEnabled).toBe(false)
      const prompt = readFileSync(join(dir, '.ralph', 'PROMPT.md'), 'utf8')
      expect(prompt).not.toBe('custom content')
    })

    it('updates .gitignore with Ralph section', () => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
      enableRalph(dir, DEFAULT_ENABLE_OPTIONS)
      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('# Ralph')
      expect(gitignore).toContain('.ralph/logs/')
    })

    it('does not duplicate Ralph section in .gitignore', () => {
      writeFileSync(join(dir, '.gitignore'), '# Ralph\n.ralph/logs/\n')
      enableRalph(dir, { ...DEFAULT_ENABLE_OPTIONS, force: true })
      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
      const count = (gitignore.match(/# Ralph/g) || []).length
      expect(count).toBe(1)
    })

    it('uses custom maxCallsPerHour', () => {
      enableRalph(dir, { ...DEFAULT_ENABLE_OPTIONS, maxCallsPerHour: 50 })
      const rc = readFileSync(join(dir, '.ralphrc'), 'utf8')
      expect(rc).toContain('MAX_CALLS_PER_HOUR=50')
    })

    it('configures beads task source', () => {
      enableRalph(dir, { ...DEFAULT_ENABLE_OPTIONS, useBeads: true })
      const rc = readFileSync(join(dir, '.ralphrc'), 'utf8')
      expect(rc).toContain('TASK_SOURCES="beads"')
    })
  })
})
