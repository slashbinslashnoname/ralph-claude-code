import { describe, it, expect } from 'vitest'
import { validateProjectPathArg, validateSaveTabs } from './projectValidation'

// ── validateProjectPathArg ──────────────────────────────────────────────────

describe('validateProjectPathArg', () => {
  it('accepts valid absolute paths', () => {
    expect(validateProjectPathArg('/Users/foo/project')).toBe('/Users/foo/project')
    expect(validateProjectPathArg('/tmp')).toBe('/tmp')
  })

  it('rejects non-string', () => {
    expect(() => validateProjectPathArg(123)).toThrow(/non-empty string/)
    expect(() => validateProjectPathArg(null)).toThrow(/non-empty string/)
    expect(() => validateProjectPathArg(undefined)).toThrow(/non-empty string/)
    expect(() => validateProjectPathArg({})).toThrow(/non-empty string/)
  })

  it('rejects empty string', () => {
    expect(() => validateProjectPathArg('')).toThrow(/non-empty string/)
  })

  it('rejects relative paths', () => {
    expect(() => validateProjectPathArg('relative/path')).toThrow(/absolute path/)
    expect(() => validateProjectPathArg('./foo')).toThrow(/absolute path/)
    expect(() => validateProjectPathArg('../foo')).toThrow(/absolute path/)
  })

  it('rejects null bytes', () => {
    expect(() => validateProjectPathArg('/foo\0bar')).toThrow(/null bytes/)
  })

  it('rejects oversized paths', () => {
    expect(() => validateProjectPathArg('/' + 'a'.repeat(1024))).toThrow(/1024 characters/)
  })

  it('accepts path at max length', () => {
    const p = '/' + 'a'.repeat(1023)
    expect(validateProjectPathArg(p)).toBe(p)
  })
})

// ── validateSaveTabs ────────────────────────────────────────────────────────

describe('validateSaveTabs', () => {
  it('accepts valid tabs', () => {
    const result = validateSaveTabs({ paths: ['/foo', '/bar'], active: 1 })
    expect(result).toEqual({ paths: ['/foo', '/bar'], active: 1 })
  })

  it('accepts empty paths with active 0', () => {
    const result = validateSaveTabs({ paths: [], active: 0 })
    expect(result).toEqual({ paths: [], active: 0 })
  })

  it('rejects non-object', () => {
    expect(() => validateSaveTabs(null)).toThrow(/must be an object/)
    expect(() => validateSaveTabs('string')).toThrow(/must be an object/)
    expect(() => validateSaveTabs(42)).toThrow(/must be an object/)
  })

  it('rejects missing paths', () => {
    expect(() => validateSaveTabs({ active: 0 })).toThrow(/must be an array/)
  })

  it('rejects non-array paths', () => {
    expect(() => validateSaveTabs({ paths: 'not-array', active: 0 })).toThrow(/must be an array/)
  })

  it('rejects too many paths', () => {
    const paths = Array.from({ length: 51 }, (_, i) => `/p${i}`)
    expect(() => validateSaveTabs({ paths, active: 0 })).toThrow(/50 or fewer/)
  })

  it('rejects non-string path entries', () => {
    expect(() => validateSaveTabs({ paths: [123], active: 0 })).toThrow(/non-empty string/)
  })

  it('rejects empty string path entries', () => {
    expect(() => validateSaveTabs({ paths: [''], active: 0 })).toThrow(/non-empty string/)
  })

  it('rejects relative path entries', () => {
    expect(() => validateSaveTabs({ paths: ['relative'], active: 0 })).toThrow(/absolute path/)
  })

  it('rejects path entries with null bytes', () => {
    expect(() => validateSaveTabs({ paths: ['/foo\0bar'], active: 0 })).toThrow(/null bytes/)
  })

  it('rejects oversized path entries', () => {
    expect(
      () => validateSaveTabs({ paths: ['/' + 'a'.repeat(1024)], active: 0 })
    ).toThrow(/1024 characters/)
  })

  it('rejects non-integer active', () => {
    expect(() => validateSaveTabs({ paths: ['/foo'], active: 1.5 })).toThrow(/integer/)
    expect(() => validateSaveTabs({ paths: ['/foo'], active: 'x' })).toThrow(/integer/)
  })

  it('rejects negative active', () => {
    expect(() => validateSaveTabs({ paths: ['/foo'], active: -1 })).toThrow(/non-negative/)
  })

  it('rejects active out of bounds', () => {
    expect(() => validateSaveTabs({ paths: ['/foo'], active: 1 })).toThrow(/at most 0/)
    expect(() => validateSaveTabs({ paths: ['/a', '/b'], active: 2 })).toThrow(/at most 1/)
  })

  it('rejects active > 0 with empty paths', () => {
    expect(() => validateSaveTabs({ paths: [], active: 1 })).toThrow(/at most 0/)
  })
})
