import { describe, it, expect } from 'vitest'
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
    expect(validateRelPath('.slashbotrc')).toBe('.slashbotrc')
    expect(validateRelPath('PROMPT.md')).toBe('PROMPT.md')
    expect(validateRelPath('AGENT.md')).toBe('AGENT.md')
  })

  it('rejects old .slashbot/ prefixed paths', () => {
    expect(() => validateRelPath('.slashbot/PROMPT.md')).toThrow(/Not an editable file/)
    expect(() => validateRelPath('.slashbot/AGENT.md')).toThrow(/Not an editable file/)
  })

  it('rejects non-allowed files', () => {
    expect(() => validateRelPath('package.json')).toThrow(/Not an editable file/)
    expect(() => validateRelPath('.env')).toThrow(/Not an editable file/)
    expect(() => validateRelPath('.slashbot/status.json')).toThrow(/Not an editable file/)
  })

  it('rejects empty string', () => {
    expect(() => validateRelPath('')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateRelPath(123)).toThrow(/non-empty string/)
    expect(() => validateRelPath(null)).toThrow(/non-empty string/)
    expect(() => validateRelPath(undefined)).toThrow(/non-empty string/)
  })
})

// ── validateContainment ──────────────────────────────────────────────────────

describe('validateContainment', () => {
  it('allows paths within project', () => {
    const resolved = validateContainment('/home/user/project', '.slashbotrc')
    expect(resolved).toBe('/home/user/project/.slashbotrc')
  })

  it('allows nested paths within project', () => {
    const resolved = validateContainment('/home/user/project', 'PROMPT.md')
    expect(resolved).toBe('/home/user/project/PROMPT.md')
  })

  it('rejects path traversal with ../', () => {
    expect(
      () => validateContainment('/home/user/project', '../../../etc/passwd')
    ).toThrow(/Path traversal detected/)
  })

  it('rejects path traversal with embedded ..', () => {
    expect(
      () => validateContainment('/home/user/project', 'sub/../../etc/passwd')
    ).toThrow(/Path traversal detected/)
  })
})

// ── validateContent ──────────────────────────────────────────────────────────

describe('validateContent', () => {
  it('accepts valid content', () => {
    expect(validateContent('hello world')).toBe('hello world')
  })

  it('accepts empty string', () => {
    expect(validateContent('')).toBe('')
  })

  it('rejects non-string', () => {
    expect(() => validateContent(123)).toThrow(/must be a string/)
    expect(() => validateContent(null)).toThrow(/must be a string/)
    expect(() => validateContent(undefined)).toThrow(/must be a string/)
  })

  it('rejects content over 1MB', () => {
    expect(() => validateContent('x'.repeat(1_000_001))).toThrow(/1000000 characters/)
  })

  it('accepts content at the limit', () => {
    const content = 'x'.repeat(1_000_000)
    expect(validateContent(content)).toBe(content)
  })
})

// ── validateConfigProjectPath ────────────────────────────────────────────────

describe('validateConfigProjectPath', () => {
  it('accepts valid paths', () => {
    expect(validateConfigProjectPath('/home/user/project')).toBe('/home/user/project')
  })

  it('rejects empty/whitespace', () => {
    expect(() => validateConfigProjectPath('')).toThrow(/non-empty/)
    expect(() => validateConfigProjectPath('   ')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateConfigProjectPath(null)).toThrow(/non-empty string/)
    expect(() => validateConfigProjectPath(undefined)).toThrow(/non-empty string/)
    expect(() => validateConfigProjectPath(42)).toThrow(/non-empty string/)
  })

  it('rejects null bytes', () => {
    expect(() => validateConfigProjectPath('/foo\0bar')).toThrow(/null bytes/)
  })
})

// ── Composite: validateConfigRead ────────────────────────────────────────────

describe('validateConfigRead', () => {
  it('validates and resolves allowed path against projectPath', () => {
    const r = validateConfigRead('/proj', '.slashbotrc')
    expect(r.projectPath).toBe('/proj')
    expect(r.relPath).toBe('.slashbotrc')
    expect(r.resolvedPath).toBe('/proj/.slashbotrc')
  })

  it('resolves against configDir when provided', () => {
    const r = validateConfigRead('/proj', 'PROMPT.md', '/home/user/.slashbot/projects/abc')
    expect(r.projectPath).toBe('/proj')
    expect(r.relPath).toBe('PROMPT.md')
    expect(r.resolvedPath).toBe('/home/user/.slashbot/projects/abc/PROMPT.md')
  })

  it('checks containment against configDir when provided', () => {
    expect(
      () => validateConfigRead('/proj', '../../../etc/passwd' as any, '/home/user/.slashbot/projects/abc')
    ).toThrow(/Not an editable file/)
  })

  it('throws on disallowed file', () => {
    expect(() => validateConfigRead('/proj', 'secret.env')).toThrow(/Not an editable file/)
  })

  it('throws on invalid projectPath', () => {
    expect(() => validateConfigRead('', '.slashbotrc')).toThrow(/non-empty/)
  })

  it('throws on non-string relPath', () => {
    expect(() => validateConfigRead('/proj', 42)).toThrow(/non-empty string/)
  })
})

// ── Composite: validateConfigWrite ───────────────────────────────────────────

describe('validateConfigWrite', () => {
  it('validates all inputs against projectPath', () => {
    const r = validateConfigWrite('/proj', 'AGENT.md', '# Agent config')
    expect(r.projectPath).toBe('/proj')
    expect(r.relPath).toBe('AGENT.md')
    expect(r.resolvedPath).toBe('/proj/AGENT.md')
    expect(r.content).toBe('# Agent config')
  })

  it('resolves against configDir when provided', () => {
    const r = validateConfigWrite('/proj', 'AGENT.md', '# Agent config', '/home/user/.slashbot/projects/abc')
    expect(r.projectPath).toBe('/proj')
    expect(r.relPath).toBe('AGENT.md')
    expect(r.resolvedPath).toBe('/home/user/.slashbot/projects/abc/AGENT.md')
    expect(r.content).toBe('# Agent config')
  })

  it('checks containment against configDir when provided', () => {
    expect(
      () => validateConfigWrite('/proj', '../../../etc/passwd' as any, 'data', '/home/user/.slashbot/projects/abc')
    ).toThrow(/Not an editable file/)
  })

  it('throws on disallowed file', () => {
    expect(
      () => validateConfigWrite('/proj', '../outside.txt', 'data')
    ).toThrow(/Not an editable file/)
  })

  it('throws on non-string content', () => {
    expect(
      () => validateConfigWrite('/proj', '.slashbotrc', 123)
    ).toThrow(/must be a string/)
  })

  it('throws on oversized content', () => {
    expect(
      () => validateConfigWrite('/proj', '.slashbotrc', 'x'.repeat(1_000_001))
    ).toThrow(/1000000 characters/)
  })

  it('throws on invalid projectPath', () => {
    expect(
      () => validateConfigWrite(null, '.slashbotrc', 'content')
    ).toThrow(/non-empty string/)
  })
})
