import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RateLimit } from '../../src/main/loop/RateLimit'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RateLimit', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ralph-rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts with zero count', () => {
    const rl = new RateLimit(dir, 100)
    const s = rl.status()
    expect(s.used).toBe(0)
    expect(s.max).toBe(100)
  })

  it('canCall returns true when under limit', () => {
    const rl = new RateLimit(dir, 100)
    expect(rl.canCall()).toBe(true)
  })

  it('records calls and tracks count', () => {
    const rl = new RateLimit(dir, 100)
    rl.record()
    rl.record()
    rl.record()
    expect(rl.status().used).toBe(3)
  })

  it('canCall returns false when at limit', () => {
    const rl = new RateLimit(dir, 2)
    rl.record()
    rl.record()
    expect(rl.canCall()).toBe(false)
  })

  it('persists state to file', () => {
    const rl = new RateLimit(dir, 100)
    rl.record()
    rl.record()

    const file = join(dir, '.call_count')
    expect(existsSync(file)).toBe(true)

    const data = JSON.parse(readFileSync(file, 'utf8'))
    expect(data.count).toBe(2)
    expect(data.hourStart).toBeDefined()
  })

  it('loads existing state', () => {
    const rl1 = new RateLimit(dir, 100)
    rl1.record()
    rl1.record()
    rl1.record()

    const rl2 = new RateLimit(dir, 100)
    expect(rl2.status().used).toBe(3)
  })

  it('resets after one hour', () => {
    // Write a state file with hourStart in the past
    const pastHour = new Date(Date.now() - 3_700_000).toISOString()
    writeFileSync(join(dir, '.call_count'), JSON.stringify({
      count: 50,
      hourStart: pastHour
    }))

    const rl = new RateLimit(dir, 100)
    // Constructor calls _load then _maybeReset — count should reset
    expect(rl.status().used).toBe(0)
    expect(rl.canCall()).toBe(true)
  })

  it('msUntilReset returns positive value', () => {
    const rl = new RateLimit(dir, 100)
    const ms = rl.msUntilReset()
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(3_600_000)
  })

  it('resetIn returns formatted string', () => {
    const rl = new RateLimit(dir, 100)
    const str = rl.resetIn()
    expect(str).toMatch(/^\d+:\d{2}:\d{2}$/)
  })

  it('handles corrupt state file', () => {
    writeFileSync(join(dir, '.call_count'), 'not json')
    const rl = new RateLimit(dir, 100)
    expect(rl.status().used).toBe(0)
  })

  it('waitForReset resets count', async () => {
    // Write state with hourStart just barely past the hour
    const pastHour = new Date(Date.now() - 3_599_990).toISOString()
    writeFileSync(join(dir, '.call_count'), JSON.stringify({
      count: 50,
      hourStart: pastHour
    }))

    const rl = new RateLimit(dir, 100)
    await rl.waitForReset()
    expect(rl.status().used).toBe(0)
  }, 15_000)

  it('status returns correct structure', () => {
    const rl = new RateLimit(dir, 50)
    rl.record()
    const s = rl.status()
    expect(s).toEqual({
      used: 1,
      max: 50,
      resetIn: expect.stringMatching(/^\d+:\d{2}:\d{2}$/)
    })
  })
})
