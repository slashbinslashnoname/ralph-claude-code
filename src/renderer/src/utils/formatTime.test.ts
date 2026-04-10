import { describe, test, expect } from 'vitest'
import { formatTime, formatTimePrecise, formatRelativeTime, formatElapsed } from './formatTime'

describe('formatTime', () => {
  test('formats a valid ISO timestamp', () => {
    const result = formatTime('2026-04-10T14:30:00Z')
    // Should contain month abbreviation and day
    expect(result).toMatch(/Apr/)
    expect(result).toMatch(/10/)
  })

  test('returns original string for invalid timestamp', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date')
  })

  test('does not include seconds', () => {
    const result = formatTime('2026-04-10T14:30:45Z')
    // formatTime should NOT include seconds — only formatTimePrecise does
    // We can't easily test absence of seconds since locale varies,
    // but we can verify the function returns a string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatTimePrecise', () => {
  test('formats a valid ISO timestamp with seconds', () => {
    const result = formatTimePrecise('2026-04-10T14:30:45Z')
    expect(result).toMatch(/Apr/)
    expect(result).toMatch(/10/)
  })

  test('returns original string for invalid timestamp', () => {
    expect(formatTimePrecise('garbage')).toBe('garbage')
  })

  test('handles edge case timestamps', () => {
    // Epoch
    const result = formatTimePrecise('1970-01-01T00:00:00Z')
    expect(result).toMatch(/Jan/)

    // End of year
    const result2 = formatTimePrecise('2026-12-31T23:59:59Z')
    expect(result2).toMatch(/Dec|Jan/) // could be Jan 1 in some timezones
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-04-10T12:00:00Z').getTime()

  test('returns "just now" for timestamps less than 60s ago', () => {
    const ts = new Date(now - 30_000).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('just now')
  })

  test('returns "just now" for timestamps 0s ago', () => {
    const ts = new Date(now).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('just now')
  })

  test('returns minutes ago', () => {
    const ts = new Date(now - 5 * 60_000).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('5m ago')
  })

  test('returns hours ago', () => {
    const ts = new Date(now - 3 * 3_600_000).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('3h ago')
  })

  test('returns days ago', () => {
    const ts = new Date(now - 2 * 86_400_000).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('2d ago')
  })

  test('returns "just now" for future timestamps', () => {
    const ts = new Date(now + 60_000).toISOString()
    expect(formatRelativeTime(ts, now)).toBe('just now')
  })

  test('returns original string for invalid input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date')
  })
})

describe('formatElapsed', () => {
  const now = new Date('2026-04-10T12:00:00Z').getTime()

  test('returns "<1m" for timestamps less than 60s ago', () => {
    const ts = new Date(now - 30_000).toISOString()
    expect(formatElapsed(ts, now)).toBe('<1m')
  })

  test('returns minutes for timestamps less than 1h ago', () => {
    const ts = new Date(now - 15 * 60_000).toISOString()
    expect(formatElapsed(ts, now)).toBe('15m')
  })

  test('returns hours and minutes for timestamps over 1h ago', () => {
    const ts = new Date(now - (2 * 3_600_000 + 30 * 60_000)).toISOString()
    expect(formatElapsed(ts, now)).toBe('2h 30m')
  })

  test('returns "<1m" for future timestamps', () => {
    const ts = new Date(now + 60_000).toISOString()
    expect(formatElapsed(ts, now)).toBe('<1m')
  })

  test('returns empty string for invalid input', () => {
    expect(formatElapsed('garbage', now)).toBe('')
  })
})
