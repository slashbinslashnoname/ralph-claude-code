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
} from './ProjectStore'

const FAKE_HOME = '/fake/home'
const PROJECT_PATH = '/my/project'
const PROJECT_HASH8 = crypto.createHash('sha256').update(PROJECT_PATH).digest('hex').slice(0, 8)
const PROJECT_ID = `project-${PROJECT_HASH8}`
const STORE_DIR = path.join(FAKE_HOME, '.slashbot', 'projects', PROJECT_ID)

describe('ProjectStore', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(FAKE_HOME)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getProjectPaths', () => {
    it('returns human-readable id with basename and 8-char hash prefix', () => {
      const paths = getProjectPaths(PROJECT_PATH)
      expect(paths.id).toBe(PROJECT_ID)
      expect(paths.id).toMatch(/^project-[0-9a-f]{8}$/)
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
      expect(paths.mail).toBe(path.join(STORE_DIR, 'mail.jsonl'))
      expect(paths.configDir).toBe(path.join(STORE_DIR, 'config'))
      expect(paths.worktreesDir).toBe(path.join(PROJECT_PATH, '.worktrees'))
      // beadsRoot falls back to storeDir/.beads when projectRoot/.beads doesn't exist
      expect(paths.beadsRoot).toBe(path.join(STORE_DIR, '.beads'))
      expect(paths.beadsCwd).toBe(STORE_DIR)
    })

    it('prefers projectRoot/.beads when it exists', () => {
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === path.join(PROJECT_PATH, '.beads')) return true
        return false
      })
      const paths = getProjectPaths(PROJECT_PATH)
      expect(paths.beadsRoot).toBe(path.join(PROJECT_PATH, '.beads'))
      expect(paths.beadsCwd).toBe(PROJECT_PATH)
    })

    it('resolves relative paths to absolute before hashing', () => {
      const absPath = path.resolve('relative/project')
      const expectedHash8 = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 8)
      const paths = getProjectPaths('relative/project')
      expect(paths.id).toBe(`project-${expectedHash8}`)
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
})
