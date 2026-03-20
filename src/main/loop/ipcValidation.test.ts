import { describe, it, expect } from 'vitest'
import { validatePath, validateString, validateNumber, validateEnum } from './ipcValidation'

// ── validatePath ────────────────────────────────────────────────────────────

describe('validatePath', () => {
  it('accepts a simple path', () => {
    expect(validatePath('/home/user/file.txt')).toBe('/home/user/file.txt')
  })

  it('accepts a relative path by default', () => {
    expect(validatePath('src/index.ts')).toBe('src/index.ts')
  })

  it('rejects non-string', () => {
    expect(() => validatePath(123)).toThrow(/must be a non-empty string/)
    expect(() => validatePath(null)).toThrow(/must be a non-empty string/)
    expect(() => validatePath(undefined)).toThrow(/must be a non-empty string/)
  })

  it('rejects empty string', () => {
    expect(() => validatePath('')).toThrow(/must be a non-empty string/)
  })

  it('rejects null bytes', () => {
    expect(() => validatePath('/home/user\0/file')).toThrow(/null bytes/)
  })

  it('rejects paths exceeding max length', () => {
    expect(() => validatePath('x'.repeat(4097))).toThrow(/4096 characters/)
  })

  it('accepts paths at the default max length', () => {
    const p = '/'.padEnd(4096, 'a')
    expect(validatePath(p)).toBe(p)
  })

  it('respects custom maxLength', () => {
    expect(() => validatePath('abcdef', { maxLength: 5 })).toThrow(/5 characters/)
    expect(validatePath('abcde', { maxLength: 5 })).toBe('abcde')
  })

  it('enforces absolute when requested', () => {
    expect(() => validatePath('relative/path', { absolute: true })).toThrow(/absolute path/)
    expect(validatePath('/absolute/path', { absolute: true })).toBe('/absolute/path')
  })

  it('uses custom field name in errors', () => {
    expect(() => validatePath('', { field: 'projectDir' })).toThrow(/projectDir/)
  })

  // ── containment ──────────────────────────────────────────────────────────

  it('resolves path within container', () => {
    const result = validatePath('.ralphrc', { containIn: '/home/project' })
    expect(result).toBe('/home/project/.ralphrc')
  })

  it('resolves nested path within container', () => {
    const result = validatePath('sub/dir/file.txt', { containIn: '/home/project' })
    expect(result).toBe('/home/project/sub/dir/file.txt')
  })

  it('rejects traversal outside container', () => {
    expect(
      () => validatePath('../../../etc/passwd', { containIn: '/home/project' })
    ).toThrow(/path traversal detected/)
  })

  it('rejects embedded traversal outside container', () => {
    expect(
      () => validatePath('sub/../../../../../../etc/passwd', { containIn: '/home/project' })
    ).toThrow(/path traversal detected/)
  })
})

// ── validateString ──────────────────────────────────────────────────────────

describe('validateString', () => {
  it('accepts a valid string', () => {
    expect(validateString('hello')).toBe('hello')
  })

  it('rejects non-string types', () => {
    expect(() => validateString(42)).toThrow(/must be a string/)
    expect(() => validateString(true)).toThrow(/must be a string/)
    expect(() => validateString([])).toThrow(/must be a string/)
  })

  it('rejects null/undefined when required', () => {
    expect(() => validateString(null)).toThrow(/is required/)
    expect(() => validateString(undefined)).toThrow(/is required/)
  })

  it('returns undefined for null/undefined when optional', () => {
    expect(validateString(null, { optional: true })).toBe(undefined)
    expect(validateString(undefined, { optional: true })).toBe(undefined)
  })

  it('rejects empty string by default (minLength=1)', () => {
    expect(() => validateString('')).toThrow(/at least 1/)
  })

  it('accepts empty string when minLength=0', () => {
    expect(validateString('', { minLength: 0 })).toBe('')
  })

  it('rejects strings exceeding maxLength', () => {
    expect(() => validateString('abcdef', { maxLength: 5 })).toThrow(/5 characters/)
  })

  it('accepts strings at the maxLength boundary', () => {
    expect(validateString('abcde', { maxLength: 5 })).toBe('abcde')
  })

  it('trims whitespace when trim=true', () => {
    expect(validateString('  hello  ', { trim: true })).toBe('hello')
  })

  it('rejects trimmed-to-empty string when minLength=1', () => {
    expect(() => validateString('   ', { trim: true })).toThrow(/at least 1/)
  })

  it('validates pattern', () => {
    const alphaNum = /^[a-zA-Z0-9]+$/
    expect(validateString('abc123', { pattern: alphaNum })).toBe('abc123')
    expect(() => validateString('abc 123', { pattern: alphaNum })).toThrow(/invalid characters/)
  })

  it('uses custom field name', () => {
    expect(() => validateString(null, { field: 'username' })).toThrow(/username/)
  })
})

// ── validateNumber ──────────────────────────────────────────────────────────

describe('validateNumber', () => {
  it('accepts a valid integer', () => {
    expect(validateNumber(5)).toBe(5)
  })

  it('accepts zero', () => {
    expect(validateNumber(0)).toBe(0)
  })

  it('accepts negative integers', () => {
    expect(validateNumber(-3)).toBe(-3)
  })

  it('coerces string to number', () => {
    expect(validateNumber('42')).toBe(42)
  })

  it('rejects non-numeric string', () => {
    expect(() => validateNumber('abc')).toThrow(/must be a number/)
  })

  it('rejects NaN', () => {
    expect(() => validateNumber(NaN)).toThrow(/must be a number/)
  })

  it('rejects null/undefined when required', () => {
    expect(() => validateNumber(null)).toThrow(/is required/)
    expect(() => validateNumber(undefined)).toThrow(/is required/)
  })

  it('returns undefined when optional', () => {
    expect(validateNumber(null, { optional: true })).toBe(undefined)
    expect(validateNumber(undefined, { optional: true })).toBe(undefined)
  })

  it('returns defaultValue for undefined/null input', () => {
    expect(validateNumber(null, { defaultValue: 10 })).toBe(10)
    expect(validateNumber(undefined, { defaultValue: 0 })).toBe(0)
  })

  it('still validates when a value is provided even with defaultValue', () => {
    expect(() => validateNumber('abc', { defaultValue: 10 })).toThrow(/must be a number/)
  })

  it('rejects floats when integer=true (default)', () => {
    expect(() => validateNumber(3.14)).toThrow(/must be an integer/)
  })

  it('accepts floats when integer=false', () => {
    expect(validateNumber(3.14, { integer: false })).toBe(3.14)
  })

  it('enforces min', () => {
    expect(validateNumber(5, { min: 5 })).toBe(5)
    expect(() => validateNumber(4, { min: 5 })).toThrow(/at least 5/)
  })

  it('enforces max', () => {
    expect(validateNumber(10, { max: 10 })).toBe(10)
    expect(() => validateNumber(11, { max: 10 })).toThrow(/at most 10/)
  })

  it('enforces min and max together', () => {
    expect(validateNumber(5, { min: 1, max: 10 })).toBe(5)
    expect(() => validateNumber(0, { min: 1, max: 10 })).toThrow(/at least 1/)
    expect(() => validateNumber(11, { min: 1, max: 10 })).toThrow(/at most 10/)
  })

  it('uses custom field name', () => {
    expect(() => validateNumber('abc', { field: 'priority' })).toThrow(/priority/)
  })
})

// ── validateEnum ────────────────────────────────────────────────────────────

describe('validateEnum', () => {
  const STATUSES = ['open', 'closed', 'pending'] as const

  it('accepts a valid enum value', () => {
    expect(validateEnum('open', STATUSES)).toBe('open')
    expect(validateEnum('closed', STATUSES)).toBe('closed')
  })

  it('rejects an invalid enum value', () => {
    expect(() => validateEnum('unknown', STATUSES)).toThrow(/must be one of: open, closed, pending/)
  })

  it('rejects non-string', () => {
    expect(() => validateEnum(42, STATUSES)).toThrow(/must be a string/)
    expect(() => validateEnum(true, STATUSES)).toThrow(/must be a string/)
  })

  it('rejects null/undefined when required', () => {
    expect(() => validateEnum(null, STATUSES)).toThrow(/is required/)
    expect(() => validateEnum(undefined, STATUSES)).toThrow(/is required/)
  })

  it('returns undefined when optional', () => {
    expect(validateEnum(null, STATUSES, { optional: true })).toBe(undefined)
    expect(validateEnum(undefined, STATUSES, { optional: true })).toBe(undefined)
  })

  it('returns defaultValue for undefined/null', () => {
    expect(validateEnum(null, STATUSES, { defaultValue: 'open' })).toBe('open')
  })

  it('normalizes with trim + lowercase when normalize=true', () => {
    expect(validateEnum(' Open ', STATUSES, { normalize: true })).toBe('open')
    expect(validateEnum('CLOSED', STATUSES, { normalize: true })).toBe('closed')
  })

  it('does not normalize by default', () => {
    expect(() => validateEnum('Open', STATUSES)).toThrow(/must be one of/)
  })

  it('uses custom field name', () => {
    expect(() => validateEnum('bad', STATUSES, { field: 'status' })).toThrow(/status/)
  })
})
