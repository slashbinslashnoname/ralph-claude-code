import { describe, it, expect } from 'vitest'
import {
  validateBeadId,
  validateStatusFilter,
  validatePriority,
  validateLabel,
  validateLabels,
  validateTitle,
  validateBeadType,
  validateDescription,
  validateProjectPath,
  validateBeadsList,
  validateBeadsCreate,
  validateBeadsUpdate,
  validateBeadsReorder,
} from './beadValidation'

// ── validateBeadId ──────────────────────────────────────────────────────────

describe('validateBeadId', () => {
  it('accepts simple slug IDs', () => {
    expect(validateBeadId('sb-abc.1')).toBe('sb-abc.1')
    expect(validateBeadId('task_42')).toBe('task_42')
    expect(validateBeadId('a')).toBe('a')
    expect(validateBeadId('ABC-123')).toBe('ABC-123')
  })

  it('rejects empty string', () => {
    expect(() => validateBeadId('')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateBeadId(123)).toThrow(/non-empty string/)
    expect(() => validateBeadId(null)).toThrow(/non-empty string/)
    expect(() => validateBeadId(undefined)).toThrow(/non-empty string/)
  })

  it('rejects IDs starting with non-alphanumeric', () => {
    expect(() => validateBeadId('-abc')).toThrow(/invalid characters/)
    expect(() => validateBeadId('.abc')).toThrow(/invalid characters/)
    expect(() => validateBeadId('_abc')).toThrow(/invalid characters/)
  })

  it('rejects IDs with shell metacharacters', () => {
    expect(() => validateBeadId('abc;rm')).toThrow(/invalid characters/)
    expect(() => validateBeadId('abc$(cmd)')).toThrow(/invalid characters/)
    expect(() => validateBeadId('abc`cmd`')).toThrow(/invalid characters/)
    expect(() => validateBeadId('abc|pipe')).toThrow(/invalid characters/)
    expect(() => validateBeadId('abc&bg')).toThrow(/invalid characters/)
  })

  it('rejects IDs longer than 128 chars', () => {
    expect(() => validateBeadId('a'.repeat(129))).toThrow(/invalid characters/)
  })

  it('accepts IDs up to 128 chars', () => {
    expect(validateBeadId('a'.repeat(128))).toBe('a'.repeat(128))
  })

  it('uses custom field name in error', () => {
    expect(() => validateBeadId('', 'beadId')).toThrow(/beadId/)
  })
})

// ── validateStatusFilter ────────────────────────────────────────────────────

describe('validateStatusFilter', () => {
  it('defaults to open for undefined/null', () => {
    expect(validateStatusFilter(undefined)).toBe('open')
    expect(validateStatusFilter(null)).toBe('open')
  })

  it('accepts valid filters', () => {
    expect(validateStatusFilter('open')).toBe('open')
    expect(validateStatusFilter('closed')).toBe('closed')
    expect(validateStatusFilter('in_progress')).toBe('in_progress')
    expect(validateStatusFilter('all')).toBe('all')
  })

  it('normalizes case and whitespace', () => {
    expect(validateStatusFilter('OPEN')).toBe('open')
    expect(validateStatusFilter(' All ')).toBe('all')
  })

  it('rejects invalid filter', () => {
    expect(() => validateStatusFilter('invalid')).toThrow(/Invalid filter/)
  })

  it('rejects non-string', () => {
    expect(() => validateStatusFilter(42)).toThrow(/must be a string/)
  })
})

// ── validatePriority ────────────────────────────────────────────────────────

describe('validatePriority', () => {
  it('returns undefined for undefined/null', () => {
    expect(validatePriority(undefined)).toBe(undefined)
    expect(validatePriority(null)).toBe(undefined)
  })

  it('accepts valid priorities 0–4', () => {
    for (let i = 0; i <= 4; i++) {
      expect(validatePriority(i)).toBe(i)
    }
  })

  it('rejects out-of-range', () => {
    expect(() => validatePriority(-1)).toThrow(/between 0 and 4/)
    expect(() => validatePriority(5)).toThrow(/between 0 and 4/)
    expect(() => validatePriority(100)).toThrow(/between 0 and 4/)
  })

  it('rejects non-integer', () => {
    expect(() => validatePriority(1.5)).toThrow(/must be an integer/)
    expect(() => validatePriority('abc')).toThrow(/must be an integer/)
  })

  it('coerces numeric string', () => {
    expect(validatePriority('3')).toBe(3)
  })
})

// ── validateLabel ───────────────────────────────────────────────────────────

describe('validateLabel', () => {
  it('accepts simple labels', () => {
    expect(validateLabel('frontend')).toBe('frontend')
    expect(validateLabel('high-priority')).toBe('high-priority')
    expect(validateLabel('v2.0')).toBe('v2.0')
    expect(validateLabel('my_label')).toBe('my_label')
  })

  it('rejects empty string', () => {
    expect(() => validateLabel('')).toThrow(/non-empty/)
  })

  it('rejects spaces (would break shell args in BdClient)', () => {
    expect(() => validateLabel('my label')).toThrow(/invalid/)
  })

  it('rejects commas', () => {
    expect(() => validateLabel('a,b')).toThrow(/invalid/)
  })

  it('rejects shell metacharacters', () => {
    expect(() => validateLabel('label;rm')).toThrow(/invalid/)
    expect(() => validateLabel('$(cmd)')).toThrow(/invalid/)
  })

  it('rejects labels over 64 chars', () => {
    expect(() => validateLabel('a'.repeat(65))).toThrow(/invalid/)
  })
})

// ── validateLabels ──────────────────────────────────────────────────────────

describe('validateLabels', () => {
  it('returns undefined for undefined/null', () => {
    expect(validateLabels(undefined)).toBe(undefined)
    expect(validateLabels(null)).toBe(undefined)
  })

  it('validates each label in array', () => {
    expect(validateLabels(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('rejects non-array', () => {
    expect(() => validateLabels('notarray')).toThrow(/must be an array/)
  })

  it('rejects array with invalid label', () => {
    expect(() => validateLabels(['ok', 'bad;one'])).toThrow(/invalid/)
  })
})

// ── validateTitle ───────────────────────────────────────────────────────────

describe('validateTitle', () => {
  it('accepts valid titles', () => {
    expect(validateTitle('Fix login bug')).toBe('Fix login bug')
  })

  it('rejects empty/whitespace', () => {
    expect(() => validateTitle('')).toThrow(/non-empty/)
    expect(() => validateTitle('   ')).toThrow(/non-empty/)
  })

  it('rejects non-string', () => {
    expect(() => validateTitle(42)).toThrow(/non-empty string/)
  })

  it('rejects titles over 512 chars', () => {
    expect(() => validateTitle('x'.repeat(513))).toThrow(/512 characters/)
  })

  it('accepts title at limit', () => {
    expect(validateTitle('x'.repeat(512))).toBe('x'.repeat(512))
  })
})

// ── validateBeadType ────────────────────────────────────────────────────────

describe('validateBeadType', () => {
  it('returns undefined for undefined/null', () => {
    expect(validateBeadType(undefined)).toBe(undefined)
    expect(validateBeadType(null)).toBe(undefined)
  })

  it('accepts valid types', () => {
    for (const t of ['epic', 'task', 'subtask', 'bug', 'feature']) {
      expect(validateBeadType(t)).toBe(t)
    }
  })

  it('rejects invalid type', () => {
    expect(() => validateBeadType('invalid')).toThrow(/Invalid type/)
  })
})

// ── validateDescription ─────────────────────────────────────────────────────

describe('validateDescription', () => {
  it('returns undefined for undefined/null', () => {
    expect(validateDescription(undefined)).toBe(undefined)
    expect(validateDescription(null)).toBe(undefined)
  })

  it('accepts valid description', () => {
    expect(validateDescription('Some desc')).toBe('Some desc')
  })

  it('rejects non-string', () => {
    expect(() => validateDescription(42)).toThrow(/must be a string/)
  })

  it('rejects over 10000 chars', () => {
    expect(() => validateDescription('x'.repeat(10_001))).toThrow(/10000 characters/)
  })
})

// ── validateProjectPath ─────────────────────────────────────────────────────

describe('validateProjectPath', () => {
  it('accepts valid paths', () => {
    expect(validateProjectPath('/home/user/project')).toBe('/home/user/project')
  })

  it('rejects empty/non-string', () => {
    expect(() => validateProjectPath('')).toThrow(/non-empty/)
    expect(() => validateProjectPath(null)).toThrow(/non-empty string/)
    expect(() => validateProjectPath(undefined)).toThrow(/non-empty string/)
  })

  it('rejects null bytes', () => {
    expect(() => validateProjectPath('/foo\0bar')).toThrow(/null bytes/)
  })
})

// ── Composite: validateBeadsList ────────────────────────────────────────────

describe('validateBeadsList', () => {
  it('returns validated projectPath and default filter', () => {
    const r = validateBeadsList('/proj', undefined)
    expect(r.projectPath).toBe('/proj')
    expect(r.filter).toBe('open')
  })

  it('validates custom filter', () => {
    const r = validateBeadsList('/proj', 'all')
    expect(r.filter).toBe('all')
  })

  it('throws on invalid filter', () => {
    expect(() => validateBeadsList('/proj', 'nope')).toThrow(/Invalid filter/)
  })
})

// ── Composite: validateBeadsCreate ──────────────────────────────────────────

describe('validateBeadsCreate', () => {
  it('validates a minimal create', () => {
    const r = validateBeadsCreate('/proj', { title: 'Hello' })
    expect(r.opts.title).toBe('Hello')
    expect(r.opts.priority).toBe(undefined)
  })

  it('validates full create opts', () => {
    const r = validateBeadsCreate('/proj', {
      title: 'Fix bug',
      type: 'bug',
      priority: 1,
      description: 'desc',
      labels: ['urgent'],
    })
    expect(r.opts.type).toBe('bug')
    expect(r.opts.priority).toBe(1)
    expect(r.opts.labels).toEqual(['urgent'])
  })

  it('throws on missing title', () => {
    expect(() => validateBeadsCreate('/proj', {})).toThrow(/title/)
  })

  it('throws on invalid priority', () => {
    expect(() => validateBeadsCreate('/proj', { title: 'x', priority: 9 })).toThrow(/between/)
  })

  it('throws on non-object opts', () => {
    expect(() => validateBeadsCreate('/proj', 'bad')).toThrow(/must be an object/)
    expect(() => validateBeadsCreate('/proj', null)).toThrow(/must be an object/)
  })
})

// ── Composite: validateBeadsUpdate ──────────────────────────────────────────

describe('validateBeadsUpdate', () => {
  it('validates a simple update', () => {
    const r = validateBeadsUpdate('/proj', 'bead-1', { priority: 2 })
    expect(r.id).toBe('bead-1')
    expect(r.opts.priority).toBe(2)
  })

  it('throws on invalid id', () => {
    expect(() => validateBeadsUpdate('/proj', ';rm -rf', {})).toThrow(/invalid characters/)
  })

  it('throws on invalid claim type', () => {
    expect(() => validateBeadsUpdate('/proj', 'b1', { claim: 'yes' })).toThrow(/must be a boolean/)
  })

  it('validates labels', () => {
    const r = validateBeadsUpdate('/proj', 'b1', { labelsAdd: ['ui'], labelsRemove: ['old'] })
    expect(r.opts.labelsAdd).toEqual(['ui'])
    expect(r.opts.labelsRemove).toEqual(['old'])
  })
})

// ── Composite: validateBeadsReorder ─────────────────────────────────────────

describe('validateBeadsReorder', () => {
  it('validates a list of IDs', () => {
    const r = validateBeadsReorder('/proj', ['a1', 'b2', 'c3'])
    expect(r.ids).toEqual(['a1', 'b2', 'c3'])
  })

  it('throws on non-array', () => {
    expect(() => validateBeadsReorder('/proj', 'abc')).toThrow(/must be an array/)
  })

  it('throws on empty array', () => {
    expect(() => validateBeadsReorder('/proj', [])).toThrow(/must not be empty/)
  })

  it('throws on invalid ID in array', () => {
    expect(() => validateBeadsReorder('/proj', ['ok', ';bad'])).toThrow(/invalid characters/)
  })

  it('includes index in error for invalid ID', () => {
    expect(() => validateBeadsReorder('/proj', ['ok', ';bad'])).toThrow(/ids\[1\]/)
  })
})
