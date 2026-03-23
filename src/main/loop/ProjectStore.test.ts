import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()) }))
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  getProjectPaths,
  ensureStoreDirs,
  detectLegacyStorage,
  migrateLegacyStorage,
} from './ProjectStore'

const FAKE_HOME = '/fake/home'
const PROJECT_PATH = '/my/project'
const PROJECT_ID = crypto.createHash('sha256').update(PROJECT_PATH).digest('hex')
const STORE_DIR = path.join(FAKE_HOME, '.slashbot', 'projects', PROJECT_ID)

describe('ProjectStore', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(FAKE_HOME)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'copyFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getProjectPaths', () => {
    it('returns full SHA256 hex digest as id', () => {
      const paths = getProjectPaths(PROJECT_PATH)
      expect(paths.id).toBe(PROJECT_ID)
      expect(paths.id).toHaveLength(64)
    })

    it('computes storeDir under ~/.slashbot/projects/<id>', () => {
      const paths = getProjectPaths(PROJECT_PATH)
      expect(paths.storeDir).toBe(STORE_DIR)
    })

    it('returns correct sub-paths', () => {
      const paths = getProjectPaths(PROJECT_PATH)
      expect(paths.projectRoot).toBe(PROJECT_PATH)
      expect(paths.logsDir).toBe(path.join(STORE_DIR, 'logs'))
      expect(paths.circuitBreakerState).toBe(path.join(STORE_DIR, '.circuit_breaker_state'))
      expect(paths.callCount).toBe(path.join(STORE_DIR, '.call_count'))
      expect(paths.activity).toBe(path.join(STORE_DIR, 'activity.jsonl'))
      expect(paths.knowledge).toBe(path.join(STORE_DIR, 'knowledge.jsonl'))
      expect(paths.agents).toBe(path.join(STORE_DIR, 'agents.json'))
      expect(paths.fileLocks).toBe(path.join(STORE_DIR, 'file_locks.json'))
      expect(paths.configDir).toBe(path.join(STORE_DIR, 'config'))
      expect(paths.worktreesDir).toBe(path.join(PROJECT_PATH, '.worktrees'))
      expect(paths.beadsRoot).toBe(path.join(PROJECT_PATH, '.beads'))
    })

    it('resolves relative paths to absolute before hashing', () => {
      const absPath = path.resolve('relative/project')
      const expected = crypto.createHash('sha256').update(absPath).digest('hex')
      const paths = getProjectPaths('relative/project')
      expect(paths.id).toBe(expected)
    })

    it('different project paths produce different IDs', () => {
      const a = getProjectPaths('/project/a')
      const b = getProjectPaths('/project/b')
      expect(a.id).not.toBe(b.id)
    })
  })

  describe('ensureStoreDirs', () => {
    it('creates storeDir, logsDir, and configDir recursively', () => {
      const paths = getProjectPaths(PROJECT_PATH)
      ensureStoreDirs(paths)

      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.storeDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.logsDir, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(paths.configDir, { recursive: true })
    })
  })

  describe('detectLegacyStorage', () => {
    it('returns false when .slashbot dir does not exist', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      expect(detectLegacyStorage(PROJECT_PATH)).toBe(false)
    })

    it('returns true when a legacy file exists', () => {
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(PROJECT_PATH, '.slashbot')) return true
        if (p === path.join(PROJECT_PATH, '.slashbot', 'activity.jsonl')) return true
        return false
      })
      expect(detectLegacyStorage(PROJECT_PATH)).toBe(true)
    })

    it('returns true when logs/ directory has entries', () => {
      const logsDir = path.join(PROJECT_PATH, '.slashbot', 'logs')
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(PROJECT_PATH, '.slashbot')) return true
        if (p === logsDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === logsDir) return { isDirectory: () => true }
        return { isDirectory: () => false }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === logsDir) return ['agent-0.log']
        return []
      })

      expect(detectLegacyStorage(PROJECT_PATH)).toBe(true)
    })

    it('returns false when .slashbot exists but has no legacy data files', () => {
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(PROJECT_PATH, '.slashbot')) return true
        return false
      })
      expect(detectLegacyStorage(PROJECT_PATH)).toBe(false)
    })

    it('returns false when logs/ directory exists but is empty', () => {
      const logsDir = path.join(PROJECT_PATH, '.slashbot', 'logs')
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(PROJECT_PATH, '.slashbot')) return true
        if (p === logsDir) return true
        return false
      })
      ;(fs.statSync as any).mockReturnValue({ isDirectory: () => true })
      ;(fs.readdirSync as any).mockReturnValue([])

      expect(detectLegacyStorage(PROJECT_PATH)).toBe(false)
    })
  })

  describe('migrateLegacyStorage', () => {
    it('copies existing legacy files to centralized store', () => {
      const legacyDir = path.join(PROJECT_PATH, '.slashbot')
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(legacyDir, 'activity.jsonl')) return true
        if (p === path.join(legacyDir, 'agents.json')) return true
        return false
      })

      const result = migrateLegacyStorage(PROJECT_PATH)

      expect(result.migrated).toContain('activity.jsonl')
      expect(result.migrated).toContain('agents.json')
      // Atomic copy: copyFileSync writes to .tmp.PID, then renameSync moves to final
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        path.join(legacyDir, 'activity.jsonl'),
        expect.stringContaining('activity.jsonl.tmp.')
      )
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('activity.jsonl.tmp.'),
        path.join(STORE_DIR, 'activity.jsonl')
      )
    })

    it('skips files that already exist in destination', () => {
      const legacyDir = path.join(PROJECT_PATH, '.slashbot')
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(legacyDir, 'activity.jsonl')) return true
        if (p === path.join(STORE_DIR, 'activity.jsonl')) return true
        return false
      })

      const result = migrateLegacyStorage(PROJECT_PATH)

      expect(result.skipped).toContain('activity.jsonl')
      expect(result.migrated).not.toContain('activity.jsonl')
    })

    it('calls ensureStoreDirs before migrating', () => {
      ;(fs.existsSync as any).mockReturnValue(false)

      migrateLegacyStorage(PROJECT_PATH)

      expect(fs.mkdirSync).toHaveBeenCalledWith(STORE_DIR, { recursive: true })
      expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(STORE_DIR, 'logs'), { recursive: true })
    })

    it('migrates logs/ directory recursively', () => {
      const legacyDir = path.join(PROJECT_PATH, '.slashbot')
      const srcLogs = path.join(legacyDir, 'logs')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === srcLogs) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === srcLogs) return { isDirectory: () => true }
        if (p === path.join(srcLogs, 'agent-0.log')) return { isDirectory: () => false }
        return { isDirectory: () => false }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === srcLogs) return ['agent-0.log']
        return []
      })

      const result = migrateLegacyStorage(PROJECT_PATH)

      expect(result.migrated).toContain('logs/')
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        path.join(srcLogs, 'agent-0.log'),
        expect.stringContaining('agent-0.log.tmp.')
      )
    })

    it('returns .slashbotid as only migrated item when no legacy files exist', () => {
      ;(fs.existsSync as any).mockReturnValue(false)

      const result = migrateLegacyStorage(PROJECT_PATH)

      expect(result.migrated).toEqual(['.slashbotid'])
      expect(result.skipped).toEqual([])
    })
  })
})
