import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()) }))
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getProjectPaths,
  migrateLegacyStorage,
  cleanupLegacyStorage,
  detectLegacyStorage,
} from './ProjectStore'

let tmpDir: string
let projectRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'))
  projectRoot = path.join(tmpDir, 'project')
  fs.mkdirSync(projectRoot, { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('migrateLegacyStorage (integration)', () => {
  it('migrates state files atomically to centralized store', () => {
    const legacyDir = path.join(projectRoot, '.slashbot')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), '{"event":"test"}\n')
    fs.writeFileSync(path.join(legacyDir, 'agents.json'), '{}')

    const result = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(result.migrated).toContain('activity.jsonl')
    expect(result.migrated).toContain('agents.json')
    expect(fs.readFileSync(path.join(paths.storeDir, 'activity.jsonl'), 'utf-8')).toBe('{"event":"test"}\n')
    expect(fs.readFileSync(path.join(paths.storeDir, 'agents.json'), 'utf-8')).toBe('{}')
  })

  it('skips files that already exist in destination', () => {
    const legacyDir = path.join(projectRoot, '.slashbot')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), 'legacy')

    const paths = getProjectPaths(projectRoot)
    fs.mkdirSync(paths.storeDir, { recursive: true })
    fs.writeFileSync(path.join(paths.storeDir, 'activity.jsonl'), 'existing')

    const result = migrateLegacyStorage(projectRoot)

    expect(result.skipped).toContain('activity.jsonl')
    expect(fs.readFileSync(path.join(paths.storeDir, 'activity.jsonl'), 'utf-8')).toBe('existing')
  })

  it('migrates logs/ directory recursively', () => {
    const legacyLogs = path.join(projectRoot, '.slashbot', 'logs')
    fs.mkdirSync(legacyLogs, { recursive: true })
    fs.writeFileSync(path.join(legacyLogs, 'agent-0.log'), 'log content')

    const result = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(result.migrated).toContain('logs/')
    expect(fs.readFileSync(path.join(paths.logsDir, 'agent-0.log'), 'utf-8')).toBe('log content')
  })

  it('migrates .slashbotrc from project root to configDir', () => {
    fs.mkdirSync(path.join(projectRoot, '.slashbot'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, '.slashbotrc'), 'max_agents=2')

    const result = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(result.migrated).toContain('.slashbotrc')
    expect(fs.readFileSync(path.join(paths.configDir, '.slashbotrc'), 'utf-8')).toBe('max_agents=2')
  })

  it('migrates PROMPT.md and AGENT.md from .slashbot to configDir', () => {
    const legacyDir = path.join(projectRoot, '.slashbot')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'PROMPT.md'), '# Prompt')
    fs.writeFileSync(path.join(legacyDir, 'AGENT.md'), '# Agent')

    const result = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(result.migrated).toContain('PROMPT.md')
    expect(result.migrated).toContain('AGENT.md')
    expect(fs.readFileSync(path.join(paths.configDir, 'PROMPT.md'), 'utf-8')).toBe('# Prompt')
    expect(fs.readFileSync(path.join(paths.configDir, 'AGENT.md'), 'utf-8')).toBe('# Agent')
  })

  it('writes .slashbotid marker in project root', () => {
    fs.mkdirSync(path.join(projectRoot, '.slashbot'), { recursive: true })

    const result = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(result.migrated).toContain('.slashbotid')
    const idContent = fs.readFileSync(path.join(projectRoot, '.slashbotid'), 'utf-8')
    expect(idContent.trim()).toBe(paths.id)
  })

  it('does not overwrite existing .slashbotid', () => {
    fs.mkdirSync(path.join(projectRoot, '.slashbot'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, '.slashbotid'), 'existing-id\n')

    const result = migrateLegacyStorage(projectRoot)

    expect(result.migrated).not.toContain('.slashbotid')
    expect(fs.readFileSync(path.join(projectRoot, '.slashbotid'), 'utf-8')).toBe('existing-id\n')
  })

  it('returns .slashbotid as only migrated item when no legacy files exist', () => {
    const result = migrateLegacyStorage(projectRoot)

    expect(result.migrated).toEqual(['.slashbotid'])
    expect(result.skipped).toEqual([])
  })

  it('no tmp files are left behind after migration', () => {
    const legacyDir = path.join(projectRoot, '.slashbot')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), 'data')

    migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    const storeFiles = fs.readdirSync(paths.storeDir)
    const tmpFiles = storeFiles.filter(f => f.includes('.tmp.'))
    expect(tmpFiles).toEqual([])
  })
})

describe('cleanupLegacyStorage (integration)', () => {
  it('removes .slashbot/, .beads/, .worktrees/ directories', () => {
    fs.mkdirSync(path.join(projectRoot, '.slashbot', 'logs'), { recursive: true })
    fs.mkdirSync(path.join(projectRoot, '.beads'), { recursive: true })
    fs.mkdirSync(path.join(projectRoot, '.worktrees'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, '.slashbot', 'activity.jsonl'), 'data')

    const result = cleanupLegacyStorage(projectRoot)

    expect(result.removed).toContain('.slashbot/')
    expect(result.removed).toContain('.beads/')
    expect(result.removed).toContain('.worktrees/')
    expect(result.errors).toEqual([])
    expect(fs.existsSync(path.join(projectRoot, '.slashbot'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.beads'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.worktrees'))).toBe(false)
  })

  it('removes .slashbotrc from project root', () => {
    fs.writeFileSync(path.join(projectRoot, '.slashbotrc'), 'config')

    const result = cleanupLegacyStorage(projectRoot)

    expect(result.removed).toContain('.slashbotrc')
    expect(fs.existsSync(path.join(projectRoot, '.slashbotrc'))).toBe(false)
  })

  it('cleans legacy entries from .gitignore', () => {
    const gitignoreContent = [
      'node_modules/',
      '.slashbot/',
      '.slashbotrc',
      '.beads/',
      '.worktrees/',
      'dist/',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), gitignoreContent)

    const result = cleanupLegacyStorage(projectRoot)

    expect(result.removed).toContain('.gitignore (cleaned)')
    const cleaned = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
    expect(cleaned).toBe('node_modules/\ndist/\n')
  })

  it('leaves .gitignore unchanged if no legacy entries present', () => {
    const gitignoreContent = 'node_modules/\ndist/\n'
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), gitignoreContent)

    const result = cleanupLegacyStorage(projectRoot)

    expect(result.removed).not.toContain('.gitignore (cleaned)')
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')).toBe(gitignoreContent)
  })

  it('handles missing directories gracefully', () => {
    const result = cleanupLegacyStorage(projectRoot)

    expect(result.removed).toEqual([])
    expect(result.errors).toEqual([])
  })
})

describe('end-to-end: migrate then cleanup', () => {
  it('full migration cycle preserves data and cleans project root', () => {
    // Set up legacy layout
    const legacyDir = path.join(projectRoot, '.slashbot')
    fs.mkdirSync(path.join(legacyDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'activity.jsonl'), '{"e":"start"}\n')
    fs.writeFileSync(path.join(legacyDir, 'AGENT.md'), '# Agent config')
    fs.writeFileSync(path.join(legacyDir, 'logs', 'agent-0.log'), 'log data')
    fs.writeFileSync(path.join(projectRoot, '.slashbotrc'), 'max_agents=3')
    fs.mkdirSync(path.join(projectRoot, '.beads'), { recursive: true })
    fs.mkdirSync(path.join(projectRoot, '.worktrees'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.slashbot/\n.slashbotrc\n.beads/\n.worktrees/\nnode_modules/\n')

    // Verify detection
    expect(detectLegacyStorage(projectRoot)).toBe(true)

    // Migrate
    const migrateResult = migrateLegacyStorage(projectRoot)
    const paths = getProjectPaths(projectRoot)

    expect(migrateResult.migrated).toContain('activity.jsonl')
    expect(migrateResult.migrated).toContain('.slashbotrc')
    expect(migrateResult.migrated).toContain('AGENT.md')
    expect(migrateResult.migrated).toContain('logs/')
    expect(migrateResult.migrated).toContain('.slashbotid')

    // Verify data in centralized store
    expect(fs.readFileSync(path.join(paths.storeDir, 'activity.jsonl'), 'utf-8')).toBe('{"e":"start"}\n')
    expect(fs.readFileSync(path.join(paths.configDir, 'AGENT.md'), 'utf-8')).toBe('# Agent config')
    expect(fs.readFileSync(path.join(paths.configDir, '.slashbotrc'), 'utf-8')).toBe('max_agents=3')
    expect(fs.readFileSync(path.join(paths.logsDir, 'agent-0.log'), 'utf-8')).toBe('log data')

    // Cleanup
    const cleanupResult = cleanupLegacyStorage(projectRoot)
    expect(cleanupResult.removed).toContain('.slashbot/')
    expect(cleanupResult.removed).toContain('.beads/')
    expect(cleanupResult.removed).toContain('.worktrees/')
    expect(cleanupResult.removed).toContain('.slashbotrc')
    expect(cleanupResult.removed).toContain('.gitignore (cleaned)')
    expect(cleanupResult.errors).toEqual([])

    // Project root is clean
    expect(fs.existsSync(path.join(projectRoot, '.slashbot'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.slashbotrc'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.beads'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.worktrees'))).toBe(false)

    // .slashbotid remains
    expect(fs.existsSync(path.join(projectRoot, '.slashbotid'))).toBe(true)

    // .gitignore still has non-legacy entries
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')).toBe('node_modules/\n')

    // Centralized store still intact
    expect(fs.existsSync(path.join(paths.storeDir, 'activity.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(paths.configDir, 'AGENT.md'))).toBe(true)
  })
})
