import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRelPath,
  validateContainment,
  validateContent,
  validateConfigProjectPath,
  validateConfigRead,
  validateConfigWrite,
} from './configValidation'

// ── validateRelPath ──────────────────────────────────────────────────────────

describe('validateRelPath', () => {
  it('accepts allowed config files', () => {
    assert.equal(validateRelPath('.ralphrc'), '.ralphrc')
    assert.equal(validateRelPath('.ralph/PROMPT.md'), '.ralph/PROMPT.md')
    assert.equal(validateRelPath('.ralph/AGENT.md'), '.ralph/AGENT.md')
  })

  it('rejects non-allowed files', () => {
    assert.throws(() => validateRelPath('package.json'), /Not an editable file/)
    assert.throws(() => validateRelPath('.env'), /Not an editable file/)
    assert.throws(() => validateRelPath('.ralph/status.json'), /Not an editable file/)
  })

  it('rejects empty string', () => {
    assert.throws(() => validateRelPath(''), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateRelPath(123), /non-empty string/)
    assert.throws(() => validateRelPath(null), /non-empty string/)
    assert.throws(() => validateRelPath(undefined), /non-empty string/)
  })
})

// ── validateContainment ──────────────────────────────────────────────────────

describe('validateContainment', () => {
  it('allows paths within project', () => {
    const resolved = validateContainment('/home/user/project', '.ralphrc')
    assert.equal(resolved, '/home/user/project/.ralphrc')
  })

  it('allows nested paths within project', () => {
    const resolved = validateContainment('/home/user/project', '.ralph/PROMPT.md')
    assert.equal(resolved, '/home/user/project/.ralph/PROMPT.md')
  })

  it('rejects path traversal with ../', () => {
    assert.throws(
      () => validateContainment('/home/user/project', '../../../etc/passwd'),
      /Path traversal detected/
    )
  })

  it('rejects path traversal with embedded ..', () => {
    assert.throws(
      () => validateContainment('/home/user/project', '.ralph/../../etc/passwd'),
      /Path traversal detected/
    )
  })
})

// ── validateContent ──────────────────────────────────────────────────────────

describe('validateContent', () => {
  it('accepts valid content', () => {
    assert.equal(validateContent('hello world'), 'hello world')
  })

  it('accepts empty string', () => {
    assert.equal(validateContent(''), '')
  })

  it('rejects non-string', () => {
    assert.throws(() => validateContent(123), /must be a string/)
    assert.throws(() => validateContent(null), /must be a string/)
    assert.throws(() => validateContent(undefined), /must be a string/)
  })

  it('rejects content over 1MB', () => {
    assert.throws(() => validateContent('x'.repeat(1_000_001)), /1000000 characters/)
  })

  it('accepts content at the limit', () => {
    const content = 'x'.repeat(1_000_000)
    assert.equal(validateContent(content), content)
  })
})

// ── validateConfigProjectPath ────────────────────────────────────────────────

describe('validateConfigProjectPath', () => {
  it('accepts valid paths', () => {
    assert.equal(validateConfigProjectPath('/home/user/project'), '/home/user/project')
  })

  it('rejects empty/whitespace', () => {
    assert.throws(() => validateConfigProjectPath(''), /non-empty/)
    assert.throws(() => validateConfigProjectPath('   '), /non-empty/)
  })

  it('rejects non-string', () => {
    assert.throws(() => validateConfigProjectPath(null), /non-empty string/)
    assert.throws(() => validateConfigProjectPath(undefined), /non-empty string/)
    assert.throws(() => validateConfigProjectPath(42), /non-empty string/)
  })

  it('rejects null bytes', () => {
    assert.throws(() => validateConfigProjectPath('/foo\0bar'), /null bytes/)
  })
})

// ── Composite: validateConfigRead ────────────────────────────────────────────

describe('validateConfigRead', () => {
  it('validates and resolves allowed path', () => {
    const r = validateConfigRead('/proj', '.ralphrc')
    assert.equal(r.projectPath, '/proj')
    assert.equal(r.relPath, '.ralphrc')
    assert.equal(r.resolvedPath, '/proj/.ralphrc')
  })

  it('throws on disallowed file', () => {
    assert.throws(() => validateConfigRead('/proj', 'secret.env'), /Not an editable file/)
  })

  it('throws on invalid projectPath', () => {
    assert.throws(() => validateConfigRead('', '.ralphrc'), /non-empty/)
  })

  it('throws on non-string relPath', () => {
    assert.throws(() => validateConfigRead('/proj', 42), /non-empty string/)
  })
})

// ── Composite: validateConfigWrite ───────────────────────────────────────────

describe('validateConfigWrite', () => {
  it('validates all inputs', () => {
    const r = validateConfigWrite('/proj', '.ralph/AGENT.md', '# Agent config')
    assert.equal(r.projectPath, '/proj')
    assert.equal(r.relPath, '.ralph/AGENT.md')
    assert.equal(r.resolvedPath, '/proj/.ralph/AGENT.md')
    assert.equal(r.content, '# Agent config')
  })

  it('throws on disallowed file', () => {
    assert.throws(
      () => validateConfigWrite('/proj', '../outside.txt', 'data'),
      /Not an editable file/
    )
  })

  it('throws on non-string content', () => {
    assert.throws(
      () => validateConfigWrite('/proj', '.ralphrc', 123),
      /must be a string/
    )
  })

  it('throws on oversized content', () => {
    assert.throws(
      () => validateConfigWrite('/proj', '.ralphrc', 'x'.repeat(1_000_001)),
      /1000000 characters/
    )
  })

  it('throws on invalid projectPath', () => {
    assert.throws(
      () => validateConfigWrite(null, '.ralphrc', 'content'),
      /non-empty string/
    )
  })
})
