import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'


import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkerLoop } from './WorkerLoop'
import { DEFAULT_CONFIG, validateConfig, parseRcFile } from './RcParser'
import { ProjectPaths } from './ProjectStore'


// Minimal mock coordinator with bd state tracking
function makeMockCoordinator() {
  const stateStore = new Map<string, string>()
  return {
    bd: {
      getState(id: string, dimension: string): string {
        return stateStore.get(`${id}:${dimension}`) ?? ''
      },
      setState(id: string, dimension: string, value: string): void {
        stateStore.set(`${id}:${dimension}`, value)
      }
    },
    registerAgent: vi.fn(),
    updateAgent: vi.fn(),
    postActivity: vi.fn(),
    deregisterAgent: vi.fn(),
    releaseAllForAgent: vi.fn(),
    claimBestBead: vi.fn().mockResolvedValue(null),
    hasOpenWork: vi.fn().mockReturnValue(false),
    createWorktree: vi.fn().mockReturnValue(null),
    mergeWorktree: vi.fn().mockResolvedValue({ merged: true, filesChanged: [] }),
    reserveFiles: vi.fn(),
    releaseFiles: vi.fn(),
    reopenBead: vi.fn(),
    failBead: vi.fn(),
    completeBead: vi.fn(),
    heartbeat: vi.fn(),
    clearHeartbeat: vi.fn(),
    _stateStore: stateStore
  }
}

describe('Bead retry helpers', () => {
  let worker: WorkerLoop
  let coordinator: ReturnType<typeof makeMockCoordinator>

  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bead-retry-test-'))
    coordinator = makeMockCoordinator()
    const logsDir = path.join(tmpDir, 'logs')
    const paths: ProjectPaths = {
      id: 'test-id',
      projectRoot: '/tmp/test-project',
      storeDir: tmpDir,
      logsDir,
      circuitBreakerState: path.join(tmpDir, '.circuit_breaker_state'),
      callCount: path.join(tmpDir, '.call_count'),
      activity: path.join(tmpDir, 'activity.jsonl'),
      knowledge: path.join(tmpDir, 'knowledge.jsonl'),
      agents: path.join(tmpDir, 'agents.json'),
      fileLocks: path.join(tmpDir, 'file_locks.json'),
      configDir: path.join(tmpDir, 'config'),
      slashbotrc: path.join(tmpDir, 'config', '.slashbotrc'),
      worktreesDir: '/tmp/test-project/.worktrees',
      beadsRoot: '/tmp/test-project/.beads',
      agentMd: path.join(tmpDir, 'config', 'AGENT.md'),
    }
    worker = new (WorkerLoop as any)(
      'agent-0', 0, '/tmp/test-project',
      { ...DEFAULT_CONFIG, maxRetries: 2 },
      coordinator as any,
      paths
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('_getBeadAttempt', () => {
    it('returns 0 for a new bead with no state', () => {
      expect(worker._getBeadAttempt('sb-new')).toBe(0)
    })

    it('returns the stored attempt count', () => {
      coordinator._stateStore.set('sb-abc:retry_attempt', '2')
      expect(worker._getBeadAttempt('sb-abc')).toBe(2)
    })

    it('returns 0 for non-numeric state', () => {
      coordinator._stateStore.set('sb-bad:retry_attempt', 'garbage')
      expect(worker._getBeadAttempt('sb-bad')).toBe(0)
    })
  })

  describe('_incrementBeadAttempt', () => {
    it('increments from 0 to 1', () => {
      worker._incrementBeadAttempt('sb-first')
      expect(coordinator._stateStore.get('sb-first:retry_attempt')).toBe('1')
    })

    it('increments from 1 to 2', () => {
      coordinator._stateStore.set('sb-inc:retry_attempt', '1')
      worker._incrementBeadAttempt('sb-inc')
      expect(coordinator._stateStore.get('sb-inc:retry_attempt')).toBe('2')
    })
  })

  describe('_backoffMs', () => {
    it('returns 3s for attempt 0', () => {
      expect(worker._backoffMs(0)).toBe(3000)
    })

    it('returns 6s for attempt 1', () => {
      expect(worker._backoffMs(1)).toBe(6000)
    })

    it('returns 12s for attempt 2', () => {
      expect(worker._backoffMs(2)).toBe(12000)
    })

    it('returns 24s for attempt 3', () => {
      expect(worker._backoffMs(3)).toBe(24000)
    })

    it('caps at 60s', () => {
      expect(worker._backoffMs(10)).toBe(60000)
      expect(worker._backoffMs(100)).toBe(60000)
    })
  })
})

describe('RcParser maxRetries config', () => {
  it('has default maxRetries of 2', () => {
    expect(DEFAULT_CONFIG.maxRetries).toBe(2)
  })
})

describe('RcParser maxRetries validation', () => {
  it('accepts maxRetries within range', () => {
    const { config, warnings } = validateConfig({ maxRetries: 5 })
    expect(config.maxRetries).toBe(5)
    expect(warnings).toEqual([])
  })

  it('accepts maxRetries of 0 (no retries)', () => {
    const { config, warnings } = validateConfig({ maxRetries: 0 })
    expect(config.maxRetries).toBe(0)
    expect(warnings).toEqual([])
  })

  it('rejects maxRetries above 10', () => {
    const { config, warnings } = validateConfig({ maxRetries: 15 })
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('out of range')
  })

  it('rejects negative maxRetries', () => {
    const { config, warnings } = validateConfig({ maxRetries: -1 })
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('out of range')
  })
})

describe('RcParser maxRetries parsing', () => {
  it('parses MAX_RETRIES from .slashbotrc', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-test-'))
    try {
      fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), 'MAX_RETRIES=3\n', 'utf8')
      const result = parseRcFile(tmpDir)
      expect(result.maxRetries).toBe(3)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
