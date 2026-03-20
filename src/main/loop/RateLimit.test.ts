import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { RateLimit } from './RateLimit'

vi.mock('fs')

const RALPH_DIR = '/tmp/test-ralph'
const CALL_COUNT_PATH = path.join(RALPH_DIR, '.call_count')

describe('RateLimit', () => {
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

  describe('constructor', () => {
    it('initializes with zero count when no persisted file exists', () => {
      const rl = new RateLimit(RALPH_DIR, 100)
      const s = rl.status()
      expect(s.used).toBe(0)
      expect(s.max).toBe(100)
    })

    it('loads persisted state from file', () => {
      const hourStart = new Date('2026-01-15T11:30:00Z').toISOString()
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ count: 42, hourStart })
      )

      const rl = new RateLimit(RALPH_DIR, 100)
      expect(rl.status().used).toBe(42)
      expect(fs.readFileSync).toHaveBeenCalledWith(CALL_COUNT_PATH, 'utf8')
    })

    it('handles corrupted persisted file gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json')

      const rl = new RateLimit(RALPH_DIR, 100)
      expect(rl.status().used).toBe(0)
    })

    it('resets count if persisted hourStart is older than 60 minutes', () => {
      const oldHourStart = new Date('2026-01-15T10:00:00Z').toISOString()
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ count: 50, hourStart: oldHourStart })
      )

      const rl = new RateLimit(RALPH_DIR, 100)
      expect(rl.status().used).toBe(0)
      // Should have saved the reset state
      expect(fs.writeFileSync).toHaveBeenCalled()
    })
  })

  describe('canCall', () => {
    it('returns true when count is below max', () => {
      const rl = new RateLimit(RALPH_DIR, 5)
      expect(rl.canCall()).toBe(true)
    })

    it('returns false when count reaches max', () => {
      const rl = new RateLimit(RALPH_DIR, 3)
      rl.record()
      rl.record()
      rl.record()
      expect(rl.canCall()).toBe(false)
    })

    it('returns true at max-1', () => {
      const rl = new RateLimit(RALPH_DIR, 2)
      rl.record()
      expect(rl.canCall()).toBe(true)
    })

    it('resets and returns true after 60 minutes even if at max', () => {
      const rl = new RateLimit(RALPH_DIR, 1)
      rl.record()
      expect(rl.canCall()).toBe(false)

      // Advance 60 minutes
      vi.advanceTimersByTime(3_600_000)
      expect(rl.canCall()).toBe(true)
    })
  })

  describe('record', () => {
    it('increments count and persists', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      expect(rl.status().used).toBe(1)
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CALL_COUNT_PATH,
        expect.stringContaining('"count":1')
      )
    })

    it('increments multiple times correctly', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      rl.record()
      rl.record()
      expect(rl.status().used).toBe(3)
    })

    it('persists on every call', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      rl.record()
      rl.record()
      // writeFileSync called 3 times for 3 records
      expect(fs.writeFileSync).toHaveBeenCalledTimes(3)
    })
  })

  describe('auto-reset after 60 minutes', () => {
    it('does not reset at 59 minutes 59 seconds', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      rl.record()

      vi.advanceTimersByTime(3_600_000 - 1000) // 59:59
      expect(rl.status().used).toBe(2)
    })

    it('resets at exactly 60 minutes', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      rl.record()

      vi.advanceTimersByTime(3_600_000)
      expect(rl.status().used).toBe(0)
    })

    it('resets after more than 60 minutes', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()

      vi.advanceTimersByTime(7_200_000) // 2 hours
      expect(rl.canCall()).toBe(true)
      expect(rl.status().used).toBe(0)
    })
  })

  describe('msUntilReset', () => {
    it('returns full hour when just created', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      expect(rl.msUntilReset()).toBe(3_600_000)
    })

    it('returns remaining time after some elapsed time', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      vi.advanceTimersByTime(1_200_000) // 20 minutes
      expect(rl.msUntilReset()).toBe(2_400_000) // 40 minutes
    })

    it('returns 0 when past the hour', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      vi.advanceTimersByTime(4_000_000) // > 1 hour
      expect(rl.msUntilReset()).toBe(0)
    })
  })

  describe('resetIn', () => {
    it('formats as h:mm:ss', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      expect(rl.resetIn()).toBe('1:00:00')
    })

    it('formats partial time correctly', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      vi.advanceTimersByTime(1_234_000) // ~20 min 34 sec elapsed
      // Remaining: 3_600_000 - 1_234_000 = 2_366_000 ms
      // = 0h 39m 26s
      expect(rl.resetIn()).toBe('0:39:26')
    })

    it('returns 0:00:00 when past the hour', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      vi.advanceTimersByTime(4_000_000)
      expect(rl.resetIn()).toBe('0:00:00')
    })
  })

  describe('status', () => {
    it('returns correct shape', () => {
      const rl = new RateLimit(RALPH_DIR, 50)
      rl.record()
      const s = rl.status()
      expect(s).toEqual({
        used: 1,
        max: 50,
        resetIn: expect.stringMatching(/^\d:\d{2}:\d{2}$/)
      })
    })

    it('triggers reset when called after 60 minutes', () => {
      const rl = new RateLimit(RALPH_DIR, 10)
      rl.record()
      rl.record()
      vi.advanceTimersByTime(3_600_000)
      const s = rl.status()
      expect(s.used).toBe(0)
    })
  })

  describe('waitForReset', () => {
    it('resets count after waiting', async () => {
      const rl = new RateLimit(RALPH_DIR, 5)
      rl.record()
      rl.record()
      rl.record()
      expect(rl.status().used).toBe(3)

      const promise = rl.waitForReset()
      await vi.advanceTimersByTimeAsync(3_600_000)
      await promise

      expect(rl.status().used).toBe(0)
      // Should have saved after reset
      expect(fs.writeFileSync).toHaveBeenCalled()
    })

    it('waits only the remaining time', async () => {
      const rl = new RateLimit(RALPH_DIR, 5)
      vi.advanceTimersByTime(1_800_000) // 30 min elapsed

      const promise = rl.waitForReset()
      // Should only need 30 more minutes
      await vi.advanceTimersByTimeAsync(1_800_000)
      await promise

      expect(rl.status().used).toBe(0)
    })
  })

  describe('concurrent increments', () => {
    it('handles rapid sequential record calls accurately', () => {
      const rl = new RateLimit(RALPH_DIR, 100)
      for (let i = 0; i < 50; i++) {
        rl.record()
      }
      expect(rl.status().used).toBe(50)
      expect(fs.writeFileSync).toHaveBeenCalledTimes(50)
    })

    it('maintains correct count across boundary conditions', () => {
      const rl = new RateLimit(RALPH_DIR, 3)
      rl.record()
      rl.record()
      rl.record()
      expect(rl.canCall()).toBe(false)
      // Record past max (no guard in record itself)
      rl.record()
      expect(rl.status().used).toBe(4)
    })
  })
})
