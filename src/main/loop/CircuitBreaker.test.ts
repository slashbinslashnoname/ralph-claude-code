import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { CircuitBreaker } from './CircuitBreaker'
import { RalphConfig } from '../types'

vi.mock('fs')

const RALPH_DIR = '/tmp/test-ralph'
const STATE_PATH = path.join(RALPH_DIR, '.circuit_breaker_state')

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
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 30,
    autoPush: false,
    ...overrides
  }
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('snapshot returns correct shape', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      const snap = cb.snapshot()
      expect(snap).toMatchObject({
        state: 'CLOSED',
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
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
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.tick(5)
      expect(cb.snapshot().current_loop).toBe(5)
    })
  })

  describe('load', () => {
    it('does nothing when state file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.load()
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('restores persisted state from file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
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

      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
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
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json!!!')

      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.load()
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('handles missing fields in persisted state with defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.load()
      const snap = cb.snapshot()
      expect(snap.state).toBe('CLOSED')
      expect(snap.consecutive_no_progress).toBe(0)
      expect(snap.reason).toBe('')
    })

    it('transitions OPEN to HALF_OPEN when cooldown has elapsed', () => {
      const openedAt = new Date('2026-01-15T11:00:00Z').toISOString() // 60 min ago
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          state: 'OPEN',
          opened_at: openedAt,
          total_opens: 1,
          reason: 'was open'
        })
      )

      const cb = new CircuitBreaker(RALPH_DIR, makeConfig({ cbCooldownMinutes: 30 }))
      cb.load()
      expect(cb.snapshot().state).toBe('HALF_OPEN')
      expect(cb.isOpen()).toBe(false)
      expect(cb.snapshot().reason).toContain('Cooldown elapsed')
    })

    it('keeps OPEN state when cooldown has NOT elapsed', () => {
      const openedAt = new Date('2026-01-15T11:50:00Z').toISOString() // 10 min ago
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          state: 'OPEN',
          opened_at: openedAt,
          total_opens: 1,
          reason: 'was open'
        })
      )

      const cb = new CircuitBreaker(RALPH_DIR, makeConfig({ cbCooldownMinutes: 30 }))
      cb.load()
      expect(cb.snapshot().state).toBe('OPEN')
      expect(cb.isOpen()).toBe(true)
    })
  })

  describe('save', () => {
    it('persists current state to file', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.tick(7)
      cb.save()

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        STATE_PATH,
        expect.any(String)
      )
      const written = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      )
      expect(written.state).toBe('CLOSED')
      expect(written.current_loop).toBe(7)
      expect(written.last_change).toBeDefined()
    })

    it('includes opened_at when circuit has been opened', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(RALPH_DIR, config)
      cb.recordPermissionDenial() // triggers open
      cb.save()

      const written = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      )
      expect(written.opened_at).toBeDefined()
    })
  })

  describe('reset', () => {
    it('clears all counters and sets state to CLOSED', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(RALPH_DIR, config)
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
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.reset()
      expect(fs.writeFileSync).toHaveBeenCalled()
    })
  })

  describe('recordProgress', () => {
    it('resets all consecutive counters', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
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
      const cb = new CircuitBreaker(RALPH_DIR, config)

      // Hit threshold to get to HALF_OPEN
      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordProgress(3)
      expect(cb.snapshot().state).toBe('CLOSED')
      expect(cb.snapshot().reason).toBe('Progress detected, circuit recovered')
    })

    it('does not change state when already CLOSED', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.recordProgress(1)
      expect(cb.snapshot().state).toBe('CLOSED')
    })
  })

  describe('recordNoProgress', () => {
    it('ignores calls when askingQuestions is true', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.recordNoProgress(true)
      cb.recordNoProgress(true)
      cb.recordNoProgress(true)
      expect(cb.snapshot().consecutive_no_progress).toBe(0)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('increments consecutiveNoProgress counter', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.recordNoProgress(false)
      expect(cb.snapshot().consecutive_no_progress).toBe(1)
      cb.recordNoProgress(false)
      expect(cb.snapshot().consecutive_no_progress).toBe(2)
    })

    it('transitions CLOSED to HALF_OPEN at threshold', () => {
      const config = makeConfig({ cbNoProgressThreshold: 3 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      cb.recordNoProgress(false) // 1
      cb.recordNoProgress(false) // 2
      expect(cb.snapshot().state).toBe('CLOSED')

      cb.recordNoProgress(false) // 3 — hits threshold
      expect(cb.snapshot().state).toBe('HALF_OPEN')
      expect(cb.snapshot().reason).toContain('3 loops with no progress')
    })

    it('stays CLOSED below threshold (n-1)', () => {
      const config = makeConfig({ cbNoProgressThreshold: 3 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      cb.recordNoProgress(false) // 1
      cb.recordNoProgress(false) // 2
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('transitions HALF_OPEN to OPEN on further no-progress', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

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

  describe('recordError', () => {
    it('does not increment consecutiveSameError until 2 distinct errors seen', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())

      // First unique error — lastErrors has length 1, no increment
      cb.recordError('error A')
      expect(cb.snapshot().consecutive_same_error).toBe(0)

      // Second unique error — lastErrors has length 2, now increments
      cb.recordError('error B')
      expect(cb.snapshot().consecutive_same_error).toBe(1)
    })

    it('increments on repeated calls once 2 distinct errors exist', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.recordError('error A')
      cb.recordError('error B')
      expect(cb.snapshot().consecutive_same_error).toBe(1)

      // Duplicate — still length >= 2, so increments
      cb.recordError('error A')
      expect(cb.snapshot().consecutive_same_error).toBe(2)
    })

    it('deduplicates error strings in lastErrors', () => {
      const cb = new CircuitBreaker(RALPH_DIR, makeConfig())
      cb.recordError('error A')
      cb.recordError('error A') // duplicate, not added
      // lastErrors still has length 1, no increment
      expect(cb.snapshot().consecutive_same_error).toBe(0)
    })

    it('opens circuit when same-error threshold is reached', () => {
      const config = makeConfig({ cbSameErrorThreshold: 3 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      // Need 2 distinct errors to start counting
      cb.recordError('error A')
      cb.recordError('error B') // consecutive_same_error = 1
      cb.recordError('error C') // consecutive_same_error = 2
      cb.recordError('error D') // consecutive_same_error = 3 — opens

      expect(cb.isOpen()).toBe(true)
      expect(cb.snapshot().reason).toContain('same error')
    })

    it('caps lastErrors at 10 entries', () => {
      const config = makeConfig({ cbSameErrorThreshold: 100 }) // high to avoid opening
      const cb = new CircuitBreaker(RALPH_DIR, config)

      for (let i = 0; i < 15; i++) {
        cb.recordError(`error ${i}`)
      }
      // Should not throw and circuit should still work
      expect(cb.snapshot().consecutive_same_error).toBe(14) // 15 calls, first one doesn't count
    })
  })

  describe('recordPermissionDenial', () => {
    it('increments counter on each call', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 10 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      cb.recordPermissionDenial()
      expect(cb.snapshot().consecutive_permission_denials).toBe(1)
      cb.recordPermissionDenial()
      expect(cb.snapshot().consecutive_permission_denials).toBe(2)
    })

    it('opens circuit at permission denial threshold', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 2 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

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
      const cb = new CircuitBreaker(RALPH_DIR, config)

      expect(cb.snapshot().state).toBe('CLOSED')

      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordProgress(3)
      expect(cb.snapshot().state).toBe('CLOSED')
    })

    it('CLOSED → HALF_OPEN → OPEN (escalation)', () => {
      const config = makeConfig({ cbNoProgressThreshold: 2 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      cb.recordNoProgress(false)
      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('HALF_OPEN')

      cb.recordNoProgress(false)
      expect(cb.snapshot().state).toBe('OPEN')
    })

    it('OPEN → HALF_OPEN via cooldown on load', () => {
      const config = makeConfig({ cbCooldownMinutes: 10 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

      // Simulate persisted OPEN state opened 15 min ago
      const openedAt = new Date('2026-01-15T11:45:00Z').toISOString()
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ state: 'OPEN', opened_at: openedAt, total_opens: 1 })
      )

      cb.load()
      expect(cb.snapshot().state).toBe('HALF_OPEN')
    })

    it('tracks totalOpens across multiple open events', () => {
      const config = makeConfig({ cbPermissionDenialThreshold: 1 })
      const cb = new CircuitBreaker(RALPH_DIR, config)

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
      const cb1 = new CircuitBreaker(RALPH_DIR, config)
      cb1.tick(5)
      cb1.recordNoProgress(false)
      cb1.recordNoProgress(false) // HALF_OPEN
      cb1.save()

      const savedJson = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string

      // Simulate loading from the saved state
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(savedJson)

      const cb2 = new CircuitBreaker(RALPH_DIR, config)
      cb2.load()

      expect(cb2.snapshot().state).toBe('HALF_OPEN')
      expect(cb2.snapshot().consecutive_no_progress).toBe(2)
      expect(cb2.snapshot().current_loop).toBe(5)
    })
  })
})
