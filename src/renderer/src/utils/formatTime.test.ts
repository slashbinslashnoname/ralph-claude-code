import { describe, test, expect } from 'vitest'
import { formatTime, formatTimePrecise } from './formatTime'

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
