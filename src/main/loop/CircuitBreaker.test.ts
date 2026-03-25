import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }))
import * as fs from 'fs'
import * as path from 'path'
import { CircuitBreaker } from './CircuitBreaker'
import { RalphConfig } from '../types'

const SLASHBOT_DIR = '/tmp/test-slashbot'
const STATE_PATH = path.join(SLASHBOT_DIR, '.circuit_breaker_state')
const TMP_PATH = STATE_PATH + '.tmp.' + process.pid

function makeConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 10,
    claudeOutputFormat: 'text',
    claudeCodeCmd: 'claude',
    allowedTools: '*',
    sleepDuration: 1,
    continueSession: false,
    cbNoProgressThreshold: 3,
    cbSameErrorThreshold: 3,
    cbErrorWindowSize: 20,
    cbErrorWindowThreshold: 5,
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 30,
    autoPush: false,
    maxRetries: 3,
    autoSplitThreshold: 3,
    buildMonitorCmd: '',
    buildMonitorInterval: 0,
    claudeModelThink: 'sonnet',
    claudeModelExecute: 'opus',
    claudeModelReview: 'sonnet',
    ...overrides
  }
}

const NOW = new Date('2026-01-15T12:00:00Z').getTime()

describe('CircuitBreaker', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined)
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('snapshot returns correct shape', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      const snap = cb.snapshot()
      expect(snap).toMatchObject({
        state: 'CLOSED',
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        error_window_count: 0,
        consecutive_permission_denials: 0,
        last_progress_loop: 0,
        total_opens: 0,
        reason: 'Initialized',
        current_loop: 0
      })
      expect(snap.last_change).toBeDefined()
      expect(snap.opened_at).toBeUndefined()
    })
  })

  describe('tick', () => {
    it('updates current_loop in snapshot', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.tick(5)
      expect(cb.snapshot().current_loop).toBe(5)
    })
  })

  describe('load', () => {
    it('does nothing when state file does not exist', () => {
      ;(fs.existsSync as any).mockReturnValue(false)
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.load()
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('restores persisted state from file', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(
        JSON.stringify({
          state: 'HALF_OPEN',
          consecutive_no_progress: 2,
          consecutive_same_error: 1,
          consecutive_permission_denials: 1,
          last_progress_loop: 5,
          total_opens: 1,
          reason: 'test reason',
          current_loop: 10
        })
      )

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.load()
      const snap = cb.snapshot()
      expect(snap.state).toBe('HALF_OPEN')
      expect(snap.consecutive_no_progress).toBe(2)
      expect(snap.consecutive_same_error).toBe(1)
      expect(snap.total_opens).toBe(1)
      expect(snap.reason).toBe('test reason')
      expect(snap.current_loop).toBe(10)
      expect(fs.readFileSync).toHaveBeenCalledWith(STATE_PATH, 'utf8')
    })

    it('handles corrupt JSON gracefully', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue('not valid json!!!')

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.load()
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('handles missing fields in persisted state with defaults', () => {
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(JSON.stringify({}))

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.load()
      const snap = cb.snapshot()
      expect(snap.state).toBe('CLOSED')
      expect(snap.consecutive_no_progress).toBe(0)
      expect(snap.reason).toBe('')
    })

    it('restores error_window from persisted array (new format)', () => {
      const errorWindow = [
        { ts: NOW - 2000, error: 'err A' },
        { ts: NOW - 1000, error: 'err B' }
      ]
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(
        JSON.stringify({
          state: 'CLOSED',
          consecutive_no_progress: 0,
          error_window: errorWindow,
          consecutive_permission_denials: 0,
          last_progress_loop: 0,
          total_opens: 0,
          reason: 'test',
          current_loop: 0
        })
      )

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.load()
      expect(cb.snapshot().error_window_count).toBe(2)
      expect(cb.snapshot().consecutive_same_error).toBe(2)
    })

    it('transitions OPEN to HALF_OPEN when cooldown has elapsed', () => {
      const openedAt = new Date('2026-01-15T11:00:00Z').toISOString() // 60 min ago
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(
        JSON.stringify({
          state: 'OPEN',
          opened_at: openedAt,
          total_opens: 1,
          reason: 'was open'
        })
      )

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig({ cbCooldownMinutes: 30 }))
      cb.load()
      expect(cb.snapshot().state).toBe('HALF_OPEN')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().reason).toContain('Cooldown elapsed')
    })

    it('keeps OPEN state when cooldown has NOT elapsed', () => {
      const openedAt = new Date('2026-01-15T11:50:00Z').toISOString() // 10 min ago
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(
        JSON.stringify({
          state: 'OPEN',
          opened_at: openedAt,
          total_opens: 1,
          reason: 'was open'
        })
      )

      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig({ cbCooldownMinutes: 30 }))
      cb.load()
      expect(cb.snapshot().state).toBe('OPEN')
      expect(cb.isOpen()).toBe(true)
    })
  })

  describe('save', () => {
    it('persists current state atomically via write + rename', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.tick(7)
      cb.save()

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        TMP_PATH,
        expect.any(String)
      )
      expect(fs.renameSync).toHaveBeenCalledWith(TMP_PATH, STATE_PATH)
      const written = JSON.parse(
        (fs.writeFileSync as any).mock.calls[0][1] as string
      )
      expect(written.state).toBe('CLOSED')
      expect(written.current_loop).toBe(7)
      expect(written.last_change).toBeDefined()
    })

    it('includes opened_at when circuit has been opened', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)
      cb.recordPermissionDenial() // triggers open
      cb.save()

      const written = JSON.parse(
        (fs.writeFileSync as any).mock.calls[0][1] as string
      )
      expect(written.opened_at).toBeDefined()
    })
  })

  describe('reset', () => {
    it('clears all counters and sets state to CLOSED', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)
      cb.recordPermissionDenial() // open the circuit
      expect(cb.isOpen()).toBe(true)

      cb.reset()
      const snap = cb.snapshot()
      expect(snap.state).toBe('CLOSED')
      expect(snap.consecutive_no_progress).toBe(0)
      expect(snap.consecutive_same_error).toBe(0)
      expect(snap.consecutive_permission_denials).toBe(0)
      expect(snap.reason).toBe('Manual reset')
      expect(snap.opened_at).toBeUndefined()
    })

    it('calls save after reset', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.reset()
      expect(fs.renameSync).toHaveBeenCalledWith(TMP_PATH, STATE_PATH)
    })
  })

  describe('recordProgress', () => {
    it('resets all consecutive counters', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      cb.recordProgress(5)

      const snap = cb.snapshot()
      expect(snap.consecutive_no_progress).toBe(0)
      expect(snap.consecutive_same_error).toBe(0)
      expect(snap.consecutive_permission_denials).toBe(0)
      expect(snap.last_progress_loop).toBe(5)
    })

    it('transitions HALF_OPEN back to CLOSED on progress', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordProgress(3)
      expect(cb.snapshot().state).toBe('CLOSED')
      expect(cb.snapshot().reason).toBe('Progress detected, circuit recovered')
    })

    it('does not change state when already CLOSED', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordProgress(1)
      expect(cb.snapshot().state).toBe('CLOSED')
    })
  })

  describe('recordNoProgress', () => {
    it('ignores calls when askingQuestions is true', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordNoProgress(true)
      cb.recordNoProgress(true)
      cb.recordNoProgress(true)
      expect(cb.snapshot().consecutive_no_progress).toBe(0)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('increments consecutiveNoProgress counter', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordNoProgress(false)
      expect(cb.snapshot().consecutive_no_progress).toBe(1)
      cb.recordNoProgress(false)
      expect(cb.snapshot().consecutive_no_progress).toBe(2)
    })

    it('transitions CLOSED to HALF_OPEN at threshold', () => {
      const config = makeConfig({ cbNoProgressThreshold: 3 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordNoProgress(false) // 1
      cb.recordNoProgress(false) // 2
      expect(cb.snapshot().state).toBe('CLOSED')

      cb.recordNoProgress(false) // 3 — hits threshold
      expect(cb.snapshot().state).toBe('HALF_OPEN')
      expect(cb.snapshot().reason).toContain('3 loops with no progress')
    })

    it('stays CLOSED below threshold (n-1)', () => {
      const config = makeConfig({ cbNoProgressThreshold: 3 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordNoProgress(false) // 1
      cb.recordNoProgress(false) // 2
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('transitions HALF_OPEN to OPEN on further no-progress', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordNoProgress(false) // 1
      cb.recordNoProgress(false) // 2 — HALF_OPEN
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordNoProgress(false) // 3 — still >= threshold, now OPEN
      expect(cb.snapshot().state).toBe('OPEN')
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().total_opens).toBe(1)
      expect(cb.snapshot().opened_at).toBeDefined()
    })
  })

  describe('recordError (sliding window)', () => {
    it('accumulates errors in the window', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordError('error A')
      expect(cb.snapshot().error_window_count).toBe(1)
      expect(cb.snapshot().consecutive_same_error).toBe(1)
      cb.recordError('error B')
      expect(cb.snapshot().error_window_count).toBe(2)
      cb.recordError('error C')
      expect(cb.snapshot().error_window_count).toBe(3)
    })

    it('alternating errors still accumulate in window', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 4 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)
      cb.recordError('error A')
      cb.recordError('error B')
      cb.recordError('error A')
      expect(cb.snapshot().error_window_count).toBe(3)
      expect(cb.isOpen()).toBe(false)
      cb.recordError('error B') // 4th error — hits threshold
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().reason).toContain('errors in sliding window')
    })

    it('drains window on recordProgress', () => {
      const cb = new CircuitBreaker(SLASHBOT_DIR, makeConfig())
      cb.recordError('error A')
      cb.recordError('error B')
      cb.recordError('error C')
      expect(cb.snapshot().error_window_count).toBe(3)

      cb.recordProgress(1)
      expect(cb.snapshot().error_window_count).toBe(0)
      expect(cb.snapshot().consecutive_same_error).toBe(0)
    })

    it('prunes window to cbErrorWindowSize', () => {
      const config = makeConfig({ cbErrorWindowSize: 3, cbErrorWindowThreshold: 100 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      for (let i = 0; i < 5; i++) {
        cb.recordError(`error ${i}`)
      }
      // Window capped at 3 (the most recent entries)
      expect(cb.snapshot().error_window_count).toBe(3)
    })

    it('opens circuit when window reaches cbErrorWindowThreshold', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 3, cbErrorWindowSize: 10 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('err 1')
      cb.recordError('err 2')
      expect(cb.isOpen()).toBe(false)

      cb.recordError('err 3') // 3rd — hits threshold
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().total_opens).toBe(1)
      expect(cb.snapshot().reason).toContain('3 errors in sliding window')
    })

    it('does not trip when errors are drained between bursts', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 3, cbErrorWindowSize: 10 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('err 1')
      cb.recordError('err 2')
      cb.recordProgress(1) // drain
      cb.recordError('err 3')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(1)
    })
  })

  describe('recordError with error categorization', () => {
    it('permanent error trips circuit immediately, bypassing window', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 10, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('invalid api key detected', 'permanent')
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().reason).toContain('Permanent error')
      expect(cb.snapshot().reason).toContain('invalid api key')
      expect(cb.snapshot().total_opens).toBe(1)
      // Permanent errors should NOT be added to the window
      expect(cb.snapshot().error_window_count).toBe(0)
    })

    it('permanent error auto-classified from error text trips immediately', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 10, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('authentication failed for user xyz')
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().reason).toContain('Permanent error')
    })

    it('transient error accumulates in window normally', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 5, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('ECONNRESET on socket', 'transient')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(1)

      cb.recordError('ETIMEDOUT waiting for response', 'transient')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(2)
    })

    it('unknown error accumulates in window normally', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 5, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('something weird happened', 'unknown')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(1)
    })

    it('auto-classifies transient errors to window', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 5, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordError('ECONNRESET')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(1)
    })

    it('explicit category overrides auto-classification', () => {
      const config = makeConfig({ cbErrorWindowThreshold: 10, cbErrorWindowSize: 20 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      // "invalid api key" would auto-classify as permanent, but we override to transient
      cb.recordError('invalid api key', 'transient')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().error_window_count).toBe(1)
    })
  })

  describe('recordPermissionDenial', () => {
    it('increments counter on each call', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 10 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordPermissionDenial()
      expect(cb.snapshot().consecutive_permission_denials).toBe(1)
      cb.recordPermissionDenial()
      expect(cb.snapshot().consecutive_permission_denials).toBe(2)
    })

    it('opens circuit at permission denial threshold', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 2 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordPermissionDenial() // 1
      expect(cb.isOpen()).toBe(false)

      cb.recordPermissionDenial() // 2 — opens
      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().reason).toContain('permission denials')
      expect(cb.snapshot().total_opens).toBe(1)
    })
  })

  describe('state transitions: full lifecycle', () => {
    it('CLOSED → HALF_OPEN → CLOSED (recovery)', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      expect(cb.snapshot().state).toBe('CLOSED')

      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordProgress(3)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('CLOSED → HALF_OPEN → OPEN (escalation)', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('OPEN')
    })

    it('OPEN → HALF_OPEN via cooldown on load', () => {
      const config = makeConfig({ cbCooldownMinutes: 10 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      const openedAt = new Date('2026-01-15T11:45:00Z').toISOString()
      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(
        JSON.stringify({ state: 'OPEN', opened_at: openedAt, total_opens: 1 })
      )

      cb.load()
      expect(cb.snapshot().state).toBe('HALF_OPEN')
    })

    it('tracks totalOpens across multiple open events', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(SLASHBOT_DIR, config)

      cb.recordPermissionDenial() // opens
      expect(cb.snapshot().total_opens).toBe(1)

      cb.reset()
      cb.recordPermissionDenial() // opens again
      expect(cb.snapshot().total_opens).toBe(2)
    })
  })

  describe('persistence round-trip', () => {
    it('save then load preserves state', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb1 = new CircuitBreaker(SLASHBOT_DIR, config)
      cb1.tick(5)
      cb1.recordNoProgress(false)
      cb1.recordNoProgress(false) // HALF_OPEN
      cb1.save()

      // writeFileSync writes to tmp path; content is arg [1]
      const savedJson = (fs.writeFileSync as any).mock.calls[0][1] as string

      ;(fs.existsSync as any).mockReturnValue(true)
      ;(fs.readFileSync as any).mockReturnValue(savedJson)

      const cb2 = new CircuitBreaker(SLASHBOT_DIR, config)
      cb2.load()

      expect(cb2.snapshot().state).toBe('HALF_OPEN')
      expect(cb2.snapshot().consecutive_no_progress).toBe(2)
      expect(cb2.snapshot().current_loop).toBe(5)
    })
  })
})
