import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validatePath, validateString, validateNumber, validateEnum } from './ipcValidation'

// ── validatePath ────────────────────────────────────────────────────────────

describe('validatePath', () => {
  it('accepts a simple path', () => {
    assert.equal(validatePath('/home/user/file.txt'), '/home/user/file.txt')
  })

  it('accepts a relative path by default', () => {
    assert.equal(validatePath('src/index.ts'), 'src/index.ts')
  })

  it('rejects non-string', () => {
    assert.throws(() => validatePath(123), /must be a non-empty string/)
    assert.throws(() => validatePath(null), /must be a non-empty string/)
    assert.throws(() => validatePath(undefined), /must be a non-empty string/)
  })

  it('rejects empty string', () => {
    assert.throws(() => validatePath(''), /must be a non-empty string/)
  })

  it('rejects null bytes', () => {
    assert.throws(() => validatePath('/home/user\0/file'), /null bytes/)
  })

  it('rejects paths exceeding max length', () => {
    assert.throws(() => validatePath('x'.repeat(4097)), /4096 characters/)
  })

  it('accepts paths at the default max length', () => {
    const p = '/'.padEnd(4096, 'a')
    assert.equal(validatePath(p), p)
  })

  it('respects custom maxLength', () => {
    assert.throws(() => validatePath('abcdef', { maxLength: 5 }), /5 characters/)
    assert.equal(validatePath('abcde', { maxLength: 5 }), 'abcde')
  })

  it('enforces absolute when requested', () => {
    assert.throws(() => validatePath('relative/path', { absolute: true }), /absolute path/)
    assert.equal(validatePath('/absolute/path', { absolute: true }), '/absolute/path')
  })

  it('uses custom field name in errors', () => {
    assert.throws(() => validatePath('', { field: 'projectDir' }), /projectDir/)
  })

  // ── containment ──────────────────────────────────────────────────────────

  it('resolves path within container', () => {
    const result = validatePath('.ralphrc', { containIn: '/home/project' })
    assert.equal(result, '/home/project/.ralphrc')
  })

  it('resolves nested path within container', () => {
    const result = validatePath('sub/dir/file.txt', { containIn: '/home/project' })
    assert.equal(result, '/home/project/sub/dir/file.txt')
  })

  it('rejects traversal outside container', () => {
    assert.throws(
      () => validatePath('../../../etc/passwd', { containIn: '/home/project' }),
      /path traversal detected/
    )
  })

  it('rejects embedded traversal outside container', () => {
    assert.throws(
      () => validatePath('sub/../../../../../../etc/passwd', { containIn: '/home/project' }),
      /path traversal detected/
    )
  })
})

// ── validateString ──────────────────────────────────────────────────────────

describe('validateString', () => {
  it('accepts a valid string', () => {
    assert.equal(validateString('hello'), 'hello')
  })

  it('rejects non-string types', () => {
    assert.throws(() => validateString(42), /must be a string/)
    assert.throws(() => validateString(true), /must be a string/)
    assert.throws(() => validateString([]), /must be a string/)
  })

  it('rejects null/undefined when required', () => {
    assert.throws(() => validateString(null), /is required/)
    assert.throws(() => validateString(undefined), /is required/)
  })

  it('returns undefined for null/undefined when optional', () => {
    assert.equal(validateString(null, { optional: true }), undefined)
    assert.equal(validateString(undefined, { optional: true }), undefined)
  })

  it('rejects empty string by default (minLength=1)', () => {
    assert.throws(() => validateString(''), /at least 1/)
  })

  it('accepts empty string when minLength=0', () => {
    assert.equal(validateString('', { minLength: 0 }), '')
  })

  it('rejects strings exceeding maxLength', () => {
    assert.throws(() => validateString('abcdef', { maxLength: 5 }), /5 characters/)
  })

  it('accepts strings at the maxLength boundary', () => {
    assert.equal(validateString('abcde', { maxLength: 5 }), 'abcde')
  })

  it('trims whitespace when trim=true', () => {
    assert.equal(validateString('  hello  ', { trim: true }), 'hello')
  })

  it('rejects trimmed-to-empty string when minLength=1', () => {
    assert.throws(() => validateString('   ', { trim: true }), /at least 1/)
  })

  it('validates pattern', () => {
    const alphaNum = /^[a-zA-Z0-9]+$/
    assert.equal(validateString('abc123', { pattern: alphaNum }), 'abc123')
    assert.throws(() => validateString('abc 123', { pattern: alphaNum }), /invalid characters/)
  })

  it('uses custom field name', () => {
    assert.throws(() => validateString(null, { field: 'username' }), /username/)
  })
})

// ── validateNumber ──────────────────────────────────────────────────────────

describe('validateNumber', () => {
  it('accepts a valid integer', () => {
    assert.equal(validateNumber(5), 5)
  })

  it('accepts zero', () => {
    assert.equal(validateNumber(0), 0)
  })

  it('accepts negative integers', () => {
    assert.equal(validateNumber(-3), -3)
  })

  it('coerces string to number', () => {
    assert.equal(validateNumber('42'), 42)
  })

  it('rejects non-numeric string', () => {
    assert.throws(() => validateNumber('abc'), /must be a number/)
  })

  it('rejects NaN', () => {
    assert.throws(() => validateNumber(NaN), /must be a number/)
  })

  it('rejects null/undefined when required', () => {
    assert.throws(() => validateNumber(null), /is required/)
    assert.throws(() => validateNumber(undefined), /is required/)
  })

  it('returns undefined when optional', () => {
    assert.equal(validateNumber(null, { optional: true }), undefined)
    assert.equal(validateNumber(undefined, { optional: true }), undefined)
  })

  it('returns defaultValue for undefined/null input', () => {
    assert.equal(validateNumber(null, { defaultValue: 10 }), 10)
    assert.equal(validateNumber(undefined, { defaultValue: 0 }), 0)
  })

  it('still validates when a value is provided even with defaultValue', () => {
    assert.throws(() => validateNumber('abc', { defaultValue: 10 }), /must be a number/)
  })

  it('rejects floats when integer=true (default)', () => {
    assert.throws(() => validateNumber(3.14), /must be an integer/)
  })

  it('accepts floats when integer=false', () => {
    assert.equal(validateNumber(3.14, { integer: false }), 3.14)
  })

  it('enforces min', () => {
    assert.equal(validateNumber(5, { min: 5 }), 5)
    assert.throws(() => validateNumber(4, { min: 5 }), /at least 5/)
  })

  it('enforces max', () => {
    assert.equal(validateNumber(10, { max: 10 }), 10)
    assert.throws(() => validateNumber(11, { max: 10 }), /at most 10/)
  })

  it('enforces min and max together', () => {
    assert.equal(validateNumber(5, { min: 1, max: 10 }), 5)
    assert.throws(() => validateNumber(0, { min: 1, max: 10 }), /at least 1/)
    assert.throws(() => validateNumber(11, { min: 1, max: 10 }), /at most 10/)
  })

  it('uses custom field name', () => {
    assert.throws(() => validateNumber('abc', { field: 'priority' }), /priority/)
  })
})

// ── validateEnum ────────────────────────────────────────────────────────────

describe('validateEnum', () => {
  const STATUSES = ['open', 'closed', 'pending'] as const

  it('accepts a valid enum value', () => {
    assert.equal(validateEnum('open', STATUSES), 'open')
    assert.equal(validateEnum('closed', STATUSES), 'closed')
  })

  it('rejects an invalid enum value', () => {
    assert.throws(() => validateEnum('unknown', STATUSES), /must be one of: open, closed, pending/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateEnum(42, STATUSES), /must be a string/)
    assert.throws(() => validateEnum(true, STATUSES), /must be a string/)
  })

  it('rejects null/undefined when required', () => {
    assert.throws(() => validateEnum(null, STATUSES), /is required/)
    assert.throws(() => validateEnum(undefined, STATUSES), /is required/)
  })

  it('returns undefined when optional', () => {
    assert.equal(validateEnum(null, STATUSES, { optional: true }), undefined)
    assert.equal(validateEnum(undefined, STATUSES, { optional: true }), undefined)
  })

  it('returns defaultValue for undefined/null', () => {
    assert.equal(validateEnum(null, STATUSES, { defaultValue: 'open' }), 'open')
  })

  it('normalizes with trim + lowercase when normalize=true', () => {
    assert.equal(validateEnum(' Open ', STATUSES, { normalize: true }), 'open')
    assert.equal(validateEnum('CLOSED', STATUSES, { normalize: true }), 'closed')
  })

  it('does not normalize by default', () => {
    assert.throws(() => validateEnum('Open', STATUSES), /must be one of/)
  })

  it('uses custom field name', () => {
    assert.throws(() => validateEnum('bad', STATUSES, { field: 'status' }), /status/)
  })
})
