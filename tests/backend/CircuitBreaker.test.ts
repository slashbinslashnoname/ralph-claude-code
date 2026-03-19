import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker } from '../../src/main/loop/CircuitBreaker'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('CircuitBreaker', () => {
  let dir: string
  const defaultConfig = {
    cbNoProgressThreshold: 3,
    cbSameErrorThreshold: 5,
    cbPermissionDenialThreshold: 2,
    cbCooldownMinutes: 30
  }

  beforeEach(() => {
    dir = join(tmpdir(), `ralph-cb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    const snap = cb.snapshot()
    expect(snap.state).toBe('CLOSED')
    expect(snap.consecutive_no_progress).toBe(0)
    expect(snap.consecutive_same_error).toBe(0)
  })

  it('isOpen returns false when CLOSED', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    expect(cb.isOpen()).toBe(false)
  })

  it('transitions to HALF_OPEN after no-progress threshold', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false) // threshold = 3
    expect(cb.snapshot().state).toBe('HALF_OPEN')
  })

  it('transitions from HALF_OPEN to OPEN on continued no-progress', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    // Get to HALF_OPEN
    for (let i = 0; i < 3; i++) cb.recordNoProgress(false)
    expect(cb.snapshot().state).toBe('HALF_OPEN')
    // One more triggers OPEN
    cb.recordNoProgress(false)
    expect(cb.snapshot().state).toBe('OPEN')
    expect(cb.isOpen()).toBe(true)
  })

  it('does not count no-progress when asking questions', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.recordNoProgress(true)
    cb.recordNoProgress(true)
    cb.recordNoProgress(true)
    expect(cb.snapshot().state).toBe('CLOSED')
    expect(cb.snapshot().consecutive_no_progress).toBe(0)
  })

  it('recovers from HALF_OPEN to CLOSED on progress', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    for (let i = 0; i < 3; i++) cb.recordNoProgress(false)
    expect(cb.snapshot().state).toBe('HALF_OPEN')
    cb.recordProgress(4)
    expect(cb.snapshot().state).toBe('CLOSED')
    expect(cb.snapshot().reason).toBe('Progress detected, circuit recovered')
  })

  it('records progress and resets counters', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    cb.recordProgress(3)
    const snap = cb.snapshot()
    expect(snap.consecutive_no_progress).toBe(0)
    expect(snap.consecutive_same_error).toBe(0)
    expect(snap.last_progress_loop).toBe(3)
  })

  it('opens on same error threshold', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    // Need at least 2 unique errors, then consecutive
    cb.recordError('Error A')
    cb.recordError('Error B')
    // Now consecutiveSameError increments each time
    for (let i = 0; i < 4; i++) {
      cb.recordError('Error C')
    }
    expect(cb.snapshot().state).toBe('OPEN')
  })

  it('opens on permission denial threshold', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.recordPermissionDenial()
    expect(cb.snapshot().state).toBe('CLOSED')
    cb.recordPermissionDenial() // threshold = 2
    expect(cb.isOpen()).toBe(true)
    expect(cb.snapshot().total_opens).toBe(1)
  })

  it('saves and loads state', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.tick(5)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    cb.save()

    const stateFile = join(dir, '.circuit_breaker_state')
    expect(existsSync(stateFile)).toBe(true)

    const cb2 = new CircuitBreaker(dir, defaultConfig)
    cb2.load()
    const snap = cb2.snapshot()
    expect(snap.consecutive_no_progress).toBe(2)
    expect(snap.current_loop).toBe(5)
  })

  it('resets state', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    cb.recordNoProgress(false)
    expect(cb.isOpen()).toBe(true)

    cb.reset()
    expect(cb.isOpen()).toBe(false)
    expect(cb.snapshot().state).toBe('CLOSED')
    expect(cb.snapshot().reason).toBe('Manual reset')
  })

  it('cooldown: OPEN transitions to HALF_OPEN after cooldown on load', () => {
    const cb = new CircuitBreaker(dir, { ...defaultConfig, cbCooldownMinutes: 0 })
    // Force to OPEN
    for (let i = 0; i < 3; i++) cb.recordNoProgress(false)
    cb.recordNoProgress(false) // HALF_OPEN -> OPEN
    cb.save()

    // Load with 0 minute cooldown — should immediately transition
    const cb2 = new CircuitBreaker(dir, { ...defaultConfig, cbCooldownMinutes: 0 })
    cb2.load()
    expect(cb2.snapshot().state).toBe('HALF_OPEN')
  })

  it('tracks totalOpens', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    // First open
    for (let i = 0; i < 3; i++) cb.recordNoProgress(false)
    cb.recordNoProgress(false) // OPEN
    expect(cb.snapshot().total_opens).toBe(1)

    cb.reset()
    // Second open via permission denial
    cb.recordPermissionDenial()
    cb.recordPermissionDenial()
    expect(cb.snapshot().total_opens).toBe(2)
  })

  it('tick updates current loop', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.tick(42)
    expect(cb.snapshot().current_loop).toBe(42)
  })

  it('handles corrupt state file gracefully', () => {
    const { writeFileSync } = require('fs')
    writeFileSync(join(dir, '.circuit_breaker_state'), 'not json')
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.load() // should not throw
    expect(cb.snapshot().state).toBe('CLOSED')
  })

  it('handles missing state file gracefully', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    cb.load() // should not throw
    expect(cb.snapshot().state).toBe('CLOSED')
  })

  it('error deduplication limits lastErrors to 10', () => {
    const cb = new CircuitBreaker(dir, defaultConfig)
    for (let i = 0; i < 15; i++) {
      cb.recordError(`Error ${i}`)
    }
    // Should not crash, circuit should be OPEN from same error threshold
    expect(cb.isOpen()).toBe(true)
  })
})
