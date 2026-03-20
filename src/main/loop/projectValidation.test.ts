import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateProjectPathArg, validateSaveTabs } from './projectValidation'

// ── validateProjectPathArg ──────────────────────────────────────────────────

describe('validateProjectPathArg', () => {
  it('accepts valid absolute paths', () => {
    assert.equal(validateProjectPathArg('/Users/foo/project'), '/Users/foo/project')
    assert.equal(validateProjectPathArg('/tmp'), '/tmp')
  })

  it('rejects non-string', () => {
    assert.throws(() => validateProjectPathArg(123), /non-empty string/)
    assert.throws(() => validateProjectPathArg(null), /non-empty string/)
    assert.throws(() => validateProjectPathArg(undefined), /non-empty string/)
    assert.throws(() => validateProjectPathArg({}), /non-empty string/)
  })

  it('rejects empty string', () => {
    assert.throws(() => validateProjectPathArg(''), /non-empty string/)
  })

  it('rejects relative paths', () => {
    assert.throws(() => validateProjectPathArg('relative/path'), /absolute path/)
    assert.throws(() => validateProjectPathArg('./foo'), /absolute path/)
    assert.throws(() => validateProjectPathArg('../foo'), /absolute path/)
  })

  it('rejects null bytes', () => {
    assert.throws(() => validateProjectPathArg('/foo\0bar'), /null bytes/)
  })

  it('rejects oversized paths', () => {
    assert.throws(() => validateProjectPathArg('/' + 'a'.repeat(1024)), /1024 characters/)
  })

  it('accepts path at max length', () => {
    const p = '/' + 'a'.repeat(1023)
    assert.equal(validateProjectPathArg(p), p)
  })
})

// ── validateSaveTabs ────────────────────────────────────────────────────────

describe('validateSaveTabs', () => {
  it('accepts valid tabs', () => {
    const result = validateSaveTabs({ paths: ['/foo', '/bar'], active: 1 })
    assert.deepEqual(result, { paths: ['/foo', '/bar'], active: 1 })
  })

  it('accepts empty paths with active 0', () => {
    const result = validateSaveTabs({ paths: [], active: 0 })
    assert.deepEqual(result, { paths: [], active: 0 })
  })

  it('rejects non-object', () => {
    assert.throws(() => validateSaveTabs(null), /must be an object/)
    assert.throws(() => validateSaveTabs('string'), /must be an object/)
    assert.throws(() => validateSaveTabs(42), /must be an object/)
  })

  it('rejects missing paths', () => {
    assert.throws(() => validateSaveTabs({ active: 0 }), /must be an array/)
  })

  it('rejects non-array paths', () => {
    assert.throws(() => validateSaveTabs({ paths: 'not-array', active: 0 }), /must be an array/)
  })

  it('rejects too many paths', () => {
    const paths = Array.from({ length: 51 }, (_, i) => `/p${i}`)
    assert.throws(() => validateSaveTabs({ paths, active: 0 }), /50 or fewer/)
  })

  it('rejects non-string path entries', () => {
    assert.throws(() => validateSaveTabs({ paths: [123], active: 0 }), /non-empty string/)
  })

  it('rejects empty string path entries', () => {
    assert.throws(() => validateSaveTabs({ paths: [''], active: 0 }), /non-empty string/)
  })

  it('rejects relative path entries', () => {
    assert.throws(() => validateSaveTabs({ paths: ['relative'], active: 0 }), /absolute path/)
  })

  it('rejects path entries with null bytes', () => {
    assert.throws(() => validateSaveTabs({ paths: ['/foo\0bar'], active: 0 }), /null bytes/)
  })

  it('rejects oversized path entries', () => {
    assert.throws(
      () => validateSaveTabs({ paths: ['/' + 'a'.repeat(1024)], active: 0 }),
      /1024 characters/
    )
  })

  it('rejects non-integer active', () => {
    assert.throws(() => validateSaveTabs({ paths: ['/foo'], active: 1.5 }), /integer/)
    assert.throws(() => validateSaveTabs({ paths: ['/foo'], active: 'x' }), /integer/)
  })

  it('rejects negative active', () => {
    assert.throws(() => validateSaveTabs({ paths: ['/foo'], active: -1 }), /non-negative/)
  })

  it('rejects active out of bounds', () => {
    assert.throws(() => validateSaveTabs({ paths: ['/foo'], active: 1 }), /at most 0/)
    assert.throws(() => validateSaveTabs({ paths: ['/a', '/b'], active: 2 }), /at most 1/)
  })

  it('rejects active > 0 with empty paths', () => {
    assert.throws(() => validateSaveTabs({ paths: [], active: 1 }), /at most 0/)
  })
})
